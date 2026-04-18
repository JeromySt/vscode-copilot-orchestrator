/**
 * @fileoverview Installs Copilot CLI hooks into a worktree before agent launch.
 *
 * Copilot CLI loads hooks from `.github/hooks/*.json` in the CWD at session
 * start. We use this mechanism to enforce orchestrator policies that the agent
 * cannot ignore — most importantly the context-pressure checkpoint protocol.
 *
 * The `preToolUse` hook runs synchronously before every tool call. It checks
 * for the `.orchestrator/CHECKPOINT_REQUIRED` sentinel and, if present, denies
 * any tool call that isn't part of the checkpoint/commit/exit flow. The denial
 * reason is injected into the agent's context as a tool-call error, forcing
 * the model to read the sentinel and pivot.
 *
 * @module agent/hookInstaller
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CopilotCliLogger } from './copilotCliRunner';
import type { IFileSystem } from '../interfaces/IFileSystem';

const HOOKS_DIR_REL = path.join('.github', 'hooks');
const HOOKS_CONFIG_FILE = 'orchestrator-hooks.json';
const PS1_SCRIPT = 'orchestrator-pressure-gate.ps1';
const SH_SCRIPT = 'orchestrator-pressure-gate.sh';
const POST_PS1_SCRIPT = 'orchestrator-post-tool.ps1';
const POST_SH_SCRIPT = 'orchestrator-post-tool.sh';

/**
 * Minimal sync FS surface used by hookInstaller. Production wires the
 * orchestrator's IFileSystem (see composition.ts → CopilotCliRunner). When no
 * filesystem is supplied we fall back to a thin direct-fs adapter so the
 * function remains usable from contexts that don't have DI plumbed (e.g.
 * legacy unit tests, ad-hoc scripts).
 */
function directFsAdapter(): Pick<IFileSystem,
    'mkdirSync' | 'writeFileSync' | 'existsSync' | 'unlinkSync' |
    'readdirSync' | 'rmdirSync' | 'chmodSync'> {
    return {
        mkdirSync: (p, opts) => { fs.mkdirSync(p, opts); },
        writeFileSync: (p, content) => { fs.writeFileSync(p, content, { encoding: 'utf8' }); },
        existsSync: (p) => fs.existsSync(p),
        unlinkSync: (p) => { fs.unlinkSync(p); },
        readdirSync: (p) => fs.readdirSync(p) as string[],
        rmdirSync: (p) => { fs.rmdirSync(p); },
        chmodSync: (p, mode) => { try { fs.chmodSync(p, mode); } catch { /* Windows: no-op */ } },
    };
}

/**
 * Resolve a fixed hook-file name inside the worktree's `.github/hooks` dir
 * and verify that the result stays within that directory. Prevents path
 * traversal and satisfies CodeQL's `js/insecure-temporary-file` rule by
 * proving containment of every write target. Returns `undefined` if the
 * resolved path escapes `hooksDir` (which is impossible for the fixed
 * filename constants but cheap to verify).
 */
function safeHookPath(hooksDir: string, name: string): string | undefined {
    const resolvedBase = path.resolve(hooksDir);
    const resolved = path.resolve(resolvedBase, name);
    if (resolved !== path.join(resolvedBase, name) ||
        !(resolved === resolvedBase || resolved.startsWith(resolvedBase + path.sep))) {
        return undefined;
    }
    return resolved;
}

/**
 * Write the preToolUse gate scripts + hooks.json into the worktree.
 * Idempotent: overwrites existing files.
 *
 * Returns the absolute paths of files written (for optional cleanup).
 *
 * Security: `cwd` is the orchestrator-owned worktree path supplied by the
 * caller (never user input). All write targets are constructed from fixed
 * filename constants and validated to lie within `<cwd>/.github/hooks` via
 * `safeHookPath()` — this satisfies CodeQL's `js/insecure-temporary-file`
 * rule even when callers pass tmpdir-derived paths in unit tests.
 *
 * Filesystem access goes through the injected `IFileSystem` adapter so the
 * function is testable without touching the real disk and consistent with
 * the rest of the codebase's DI boundaries.
 */
export function installOrchestratorHooks(
    cwd: string,
    logger?: CopilotCliLogger,
    fileSystem?: IFileSystem,
): { configPath: string; scriptPaths: string[] } {
    if (!cwd || !path.isAbsolute(cwd)) {
        logger?.warn(`[hooks] Refusing to install: cwd must be an absolute path (${cwd})`);
        return { configPath: '', scriptPaths: [] };
    }
    const fsx = fileSystem ?? directFsAdapter();
    const hooksDir = path.resolve(path.join(cwd, HOOKS_DIR_REL));
    try {
        fsx.mkdirSync(hooksDir, { recursive: true });
    } catch (e) {
        logger?.warn(`[hooks] Failed to create hooks dir ${hooksDir}: ${e}`);
        return { configPath: '', scriptPaths: [] };
    }

    const ps1Path = safeHookPath(hooksDir, PS1_SCRIPT);
    const shPath = safeHookPath(hooksDir, SH_SCRIPT);
    const postPs1Path = safeHookPath(hooksDir, POST_PS1_SCRIPT);
    const postShPath = safeHookPath(hooksDir, POST_SH_SCRIPT);
    const configPath = safeHookPath(hooksDir, HOOKS_CONFIG_FILE);
    if (!ps1Path || !shPath || !postPs1Path || !postShPath || !configPath) {
        logger?.warn(`[hooks] Refusing to install: hooks dir resolution escaped base (${hooksDir})`);
        return { configPath: '', scriptPaths: [] };
    }

    try {
        // CodeQL: js/insecure-temporary-file — false positive. Each path is constructed
        // from a fixed filename constant and validated by safeHookPath() above to lie
        // within hooksDir = <cwd>/.github/hooks where cwd is an orchestrator-owned
        // worktree path (never user input).
        fsx.writeFileSync(ps1Path, PRESSURE_GATE_PS1);
        fsx.writeFileSync(shPath, PRESSURE_GATE_SH);
        fsx.writeFileSync(postPs1Path, POST_TOOL_PS1);
        fsx.writeFileSync(postShPath, POST_TOOL_SH);
        // Best-effort: mark bash scripts executable on POSIX. The IFileSystem
        // implementation swallows EPERM on Windows.
        fsx.chmodSync(shPath, 0o755);
        fsx.chmodSync(postShPath, 0o755);

        const config = {
            version: 1,
            hooks: {
                preToolUse: [
                    {
                        type: 'command',
                        bash: `bash ${HOOKS_DIR_REL.replace(/\\/g, '/')}/${SH_SCRIPT}`,
                        powershell: `powershell -NoProfile -ExecutionPolicy Bypass -File ${path.join(HOOKS_DIR_REL, PS1_SCRIPT)}`,
                        cwd: '.',
                        timeoutSec: 5,
                    },
                ],
                postToolUse: [
                    {
                        type: 'command',
                        bash: `bash ${HOOKS_DIR_REL.replace(/\\/g, '/')}/${POST_SH_SCRIPT}`,
                        powershell: `powershell -NoProfile -ExecutionPolicy Bypass -File ${path.join(HOOKS_DIR_REL, POST_PS1_SCRIPT)}`,
                        cwd: '.',
                        timeoutSec: 5,
                    },
                ],
            },
        };
        fsx.writeFileSync(configPath, JSON.stringify(config, null, 2));
        logger?.debug(`[hooks] Installed orchestrator hooks in ${hooksDir}`);
    } catch (e) {
        logger?.warn(`[hooks] Failed to write hook files: ${e}`);
        return { configPath: '', scriptPaths: [] };
    }

    return { configPath, scriptPaths: [ps1Path, shPath, postPs1Path, postShPath] };
}

/**
 * Remove the orchestrator hook files (and the hooks dir if empty).
 * Best-effort; swallows all errors. Filesystem access goes through the
 * injected `IFileSystem` adapter; falls back to a direct-fs adapter for
 * callers that don't have DI plumbed.
 */
export function uninstallOrchestratorHooks(
    cwd: string,
    logger?: CopilotCliLogger,
    fileSystem?: IFileSystem,
): void {
    if (!cwd || !path.isAbsolute(cwd)) { return; }
    const fsx = fileSystem ?? directFsAdapter();
    const hooksDir = path.resolve(path.join(cwd, HOOKS_DIR_REL));
    for (const name of [HOOKS_CONFIG_FILE, PS1_SCRIPT, SH_SCRIPT, POST_PS1_SCRIPT, POST_SH_SCRIPT]) {
        const p = safeHookPath(hooksDir, name);
        if (!p) { continue; }
        try {
            if (fsx.existsSync(p)) { fsx.unlinkSync(p); }
        } catch (e) {
            logger?.debug(`[hooks] Failed to remove ${p}: ${e}`);
        }
    }
    try {
        const entries = fsx.readdirSync(hooksDir);
        if (entries.length === 0) { fsx.rmdirSync(hooksDir); }
    } catch { /* ignore */ }
}

// ── Script payloads ────────────────────────────────────────────────────
//
// These scripts read the preToolUse input JSON from stdin and, if the
// CHECKPOINT_REQUIRED sentinel exists, return a "deny" decision for any tool
// that isn't part of the allowed checkpoint flow.
//
// Allowed tools during checkpoint: bash/shell (for `git add`, `git commit`,
// `cat > manifest.json`), write/edit/create (for writing the manifest),
// and view (so the agent can read the sentinel itself).
//
// Tools BLOCKED during checkpoint include: fetch/browser/webSearch/mcp_*
// and any tool the model might invoke to continue its original task.
//
// Rationale: we allow bash even though it's the most powerful tool because
// the agent needs it to commit. The denial reason for OTHER tools tells the
// model what to do. If the model calls bash for non-checkpoint work, the
// sentinel text inside the reason will still reach it on the next preToolUse.
// To be extra strict we could inspect toolArgs.command for allowed git/echo
// patterns, but that risks false positives that jam a legitimate checkpoint.

const PRESSURE_GATE_PS1 = `# Orchestrator preToolUse gate — enforces context-pressure checkpoints.
# Reads JSON from stdin, writes a deny decision if the sentinel exists.
$ErrorActionPreference = 'SilentlyContinue'
try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
    $input = $raw | ConvertFrom-Json
    $cwd = $input.cwd
    if (-not $cwd) { exit 0 }
    $sentinel = Join-Path $cwd '.orchestrator\\CHECKPOINT_REQUIRED'
    if (-not (Test-Path $sentinel)) { exit 0 }
    $manifest = Join-Path $cwd '.orchestrator\\checkpoint-manifest.json'
    if (Test-Path $manifest) { exit 0 }  # already checkpointed — let the agent exit

    $tool = [string]$input.toolName
    # Allow the tools needed to read the sentinel and write/commit the manifest
    $allowed = @('view','read','bash','shell','write','edit','create','str_replace_editor','str_replace','multi_tool_use')
    if ($allowed -contains $tool) { exit 0 }

    $reason = 'ORCHESTRATOR_CHECKPOINT_REQUIRED: Context window is critical. Stop current work. ' +
              'Read .orchestrator/CHECKPOINT_REQUIRED, write .orchestrator/checkpoint-manifest.json with your split plan, ' +
              'commit with "git add -A && git commit", force-add the manifest, print [ORCHESTRATOR:CHECKPOINT_COMPLETE], and exit. ' +
              'No other tools are allowed until the manifest is written.'
    $decision = @{ permissionDecision = 'deny'; permissionDecisionReason = $reason }
    $decision | ConvertTo-Json -Compress
    exit 0
} catch {
    # Never block on hook errors — fail open
    exit 0
}
`;

const PRESSURE_GATE_SH = `#!/bin/bash
# Orchestrator preToolUse gate — enforces context-pressure checkpoints.
# Reads JSON from stdin, writes a deny decision if the sentinel exists.
set +e
INPUT="$(cat)"
[ -z "$INPUT" ] && exit 0

# Extract cwd and toolName without requiring jq (best-effort regex)
CWD=$(printf '%s' "$INPUT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)
TOOL=$(printf '%s' "$INPUT" | sed -n 's/.*"toolName"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)
[ -z "$CWD" ] && exit 0

SENTINEL="$CWD/.orchestrator/CHECKPOINT_REQUIRED"
MANIFEST="$CWD/.orchestrator/checkpoint-manifest.json"
[ ! -f "$SENTINEL" ] && exit 0
[ -f "$MANIFEST" ] && exit 0  # already checkpointed

case "$TOOL" in
    view|read|bash|shell|write|edit|create|str_replace_editor|str_replace|multi_tool_use)
        exit 0 ;;
esac

# Emit deny decision as a single-line JSON literal (no embedded quotes/backslashes
# in the reason string, so we can safely inline it).
cat <<'JSON_EOF'
{"permissionDecision":"deny","permissionDecisionReason":"ORCHESTRATOR_CHECKPOINT_REQUIRED: Context window is critical. Stop current work. Read .orchestrator/CHECKPOINT_REQUIRED, write .orchestrator/checkpoint-manifest.json with your split plan, commit with git add -A and git commit, force-add the manifest, print [ORCHESTRATOR:CHECKPOINT_COMPLETE], and exit. No other tools are allowed until the manifest is written."}
JSON_EOF
exit 0
`;

// ── postToolUse safety net ─────────────────────────────────────────────
//
// If the agent runs `git commit` while the sentinel exists but no manifest
// has been written, the orchestrator's commit phase will fail. To rescue
// this, the postToolUse hook detects that condition and writes a minimal
// stub manifest so the commit phase can proceed and the orchestrator-side
// fallback synthesis path can enrich it. This is defense-in-depth — the
// orchestrator also synthesizes a manifest at commit-phase time, but writing
// it inside the worktree before the commit lands gives downstream phases
// the manifest in a consistent location.

const POST_TOOL_PS1 = `# Orchestrator postToolUse safety net.
# If sentinel exists, manifest missing, and the just-completed tool was a
# git commit, write a stub manifest so the commit phase doesn't fail.
$ErrorActionPreference = 'SilentlyContinue'
try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
    $input = $raw | ConvertFrom-Json
    $cwd = $input.cwd
    if (-not $cwd) { exit 0 }
    $sentinel = Join-Path $cwd '.orchestrator\\CHECKPOINT_REQUIRED'
    if (-not (Test-Path $sentinel)) { exit 0 }
    $manifest = Join-Path $cwd '.orchestrator\\checkpoint-manifest.json'
    if (Test-Path $manifest) { exit 0 }

    $tool = [string]$input.toolName
    if ($tool -ne 'bash' -and $tool -ne 'shell') { exit 0 }
    $args = [string]$input.toolArgs
    if (-not ($args -match 'git\\s+commit')) { exit 0 }

    # Write a stub manifest. The orchestrator will enrich it from git diff
    # during the commit phase; this just ensures the sentinel/manifest matrix
    # resolves to "checkpointing" instead of "failed".
    $stub = @{
        status = 'checkpointed'
        completed = @()
        remaining = @(@{ file = '<unknown>'; description = 'Auto-stub written by postToolUse hook because the agent committed without writing a manifest. Orchestrator will enrich from git diff.' })
        summary = 'Auto-stub: agent committed under context pressure without writing manifest.'
    }
    $manifestDir = Split-Path $manifest -Parent
    if (-not (Test-Path $manifestDir)) { New-Item -ItemType Directory -Path $manifestDir -Force | Out-Null }
    $stub | ConvertTo-Json -Depth 5 | Set-Content -Path $manifest -Encoding UTF8
    exit 0
} catch {
    exit 0
}
`;

const POST_TOOL_SH = `#!/bin/bash
# Orchestrator postToolUse safety net.
# If sentinel exists, manifest missing, and the just-completed tool was a
# git commit, write a stub manifest so the commit phase doesn't fail.
set +e
INPUT="$(cat)"
[ -z "$INPUT" ] && exit 0

CWD=$(printf '%s' "$INPUT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)
TOOL=$(printf '%s' "$INPUT" | sed -n 's/.*"toolName"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)
[ -z "$CWD" ] && exit 0

SENTINEL="$CWD/.orchestrator/CHECKPOINT_REQUIRED"
MANIFEST="$CWD/.orchestrator/checkpoint-manifest.json"
[ ! -f "$SENTINEL" ] && exit 0
[ -f "$MANIFEST" ] && exit 0

# Only act on git commit invocations
case "$TOOL" in
    bash|shell) ;;
    *) exit 0 ;;
esac

if ! printf '%s' "$INPUT" | grep -q 'git[^"]*commit'; then
    exit 0
fi

mkdir -p "$CWD/.orchestrator"
cat > "$MANIFEST" <<'JSON_EOF'
{
  "status": "checkpointed",
  "completed": [],
  "remaining": [{"file": "<unknown>", "description": "Auto-stub written by postToolUse hook because the agent committed without writing a manifest. Orchestrator will enrich from git diff."}],
  "summary": "Auto-stub: agent committed under context pressure without writing manifest."
}
JSON_EOF
exit 0
`;

