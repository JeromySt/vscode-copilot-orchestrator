/**
 * @fileoverview Unified Copilot CLI Runner — handles all Copilot CLI interactions.
 * @module agent/copilotCliRunner
 */

import * as fs from 'fs';
import * as path from 'path';
import { isCopilotCliAvailable, ensureCopilotCliChecked } from './cliCheckCore';
import type { CopilotUsageMetrics } from '../plan/types';
import type { IProcessSpawner, ChildProcessLike } from '../interfaces/IProcessSpawner';
import type { IEnvironment } from '../interfaces/IEnvironment';
import type { IConfigProvider } from '../interfaces/IConfigProvider';
import type { IManagedProcessFactory } from '../interfaces/IManagedProcessFactory';
import type { IManagedProcess } from '../interfaces/IManagedProcess';
import type { StatsHandler } from './handlers/statsHandler';
import type { SessionIdHandler } from './handlers/sessionIdHandler';
import type { TaskCompleteHandler } from './handlers/taskCompleteHandler';
import type { ContextPressureHandler } from './handlers/contextPressureHandler';
import { installOrchestratorHooks, uninstallOrchestratorHooks } from './hookInstaller';

// ── Types ──────────────────────────────────────────────────────────────

/**
 * Options for running Copilot CLI.
 */
export interface CopilotRunOptions {
  /** The working directory (typically a worktree path) */
  cwd: string;
  /** The task/prompt to execute */
  task: string;
  /** Additional instructions or context */
  instructions?: string;
  /** Label for logging purposes */
  label?: string;
  /** Resume an existing session */
  sessionId?: string;
  /** LLM model to use (e.g., 'claude-sonnet-4.5', 'gpt-5') */
  model?: string;
  /** Directory for Copilot logs */
  logDir?: string;
  /** Path to write session share file */
  sharePath?: string;
  /** Callback for output lines */
  onOutput?: (line: string) => void;
  /** Callback when process is spawned */
  onProcess?: (proc: ChildProcessLike) => void;
  /** Timeout in milliseconds (default: 5 minutes) */
  timeout?: number;
  /** Skip writing instructions file (for simple one-off prompts) */
  skipInstructionsFile?: boolean;
  /** Unique job/node ID to disambiguate instructions files across concurrent jobs */
  jobId?: string;
  /** Additional folders the agent is allowed to access (beyond cwd/worktree). Must be absolute paths. */
  allowedFolders?: string[];
  /** URLs or URL patterns the agent is allowed to access. Secure by default (none allowed). */
  allowedUrls?: string[];
  /** Maximum agent turns/iterations (e.g., 1 for single-turn augmentation calls). */
  maxTurns?: number;
  /** Override config directory for CLI session isolation. If set, used instead of worktree-derived default. */
  configDir?: string;
  /** Additional environment variables to inject into the spawned process */
  env?: Record<string, string>;
  /** Reasoning effort level hint for the AI model (low/medium/high/xhigh). Requires CLI support. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Plan ID for output bus handler context (threaded to IManagedProcessFactory). */
  planId?: string;
  /**
   * Optional spawner override for integration testing.
   * When set, the runner uses this spawner instead of the DI-injected one,
   * enabling scripted process output while keeping all real handler/bus/metrics logic.
   */
  spawnerOverride?: import('../interfaces/IProcessSpawner').IProcessSpawner;
}

/**
 * Result from running Copilot CLI.
 */
export interface CopilotRunResult {
  success: boolean;
  sessionId?: string;
  error?: string;
  exitCode?: number;
  /** Usage metrics parsed from Copilot CLI stdout (premium requests, tokens, model breakdown, etc.) */
  metrics?: CopilotUsageMetrics;
}

/** Logger interface for dependency injection. */
export interface CopilotCliLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

// ── Default Logger ─────────────────────────────────────────────────────

const noopLogger: CopilotCliLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** @internal Lazy-loaded process spawner for backward compatibility. Production code must inject via DI. */
function getFallbackSpawner(): IProcessSpawner {
  const mod = require('../interfaces/IProcessSpawner');
  return new mod.DefaultProcessSpawner();
}

/** @internal Inline environment fallback. Production code must inject via DI. */
const fallbackEnvironment: IEnvironment = {
  get env() { return process.env; },
  get platform() { return process.platform; },
  cwd() { return process.cwd(); },
};

// ── Transient Failure Detection ────────────────────────────────────────

/** Patterns in CLI output that indicate a transient (retryable) failure. */
const TRANSIENT_FAILURE_PATTERNS = [
  /failed to list models:\s*429/i,
  /failed to list models:\s*5\d{2}/i,
  /rate limit/i,
  /too many requests/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ECONNREFUSED/i,
  /socket hang up/i,
];

/** Max duration in ms for a run to be considered "early exit" (eligible for transient retry). */
const TRANSIENT_MAX_DURATION_MS = 30_000;

/** Max transient retries before treating as permanent failure. */
const MAX_TRANSIENT_RETRIES = 3;

/** Base backoff delay in ms (doubles each attempt: 30s, 60s, 120s). */
const TRANSIENT_BACKOFF_BASE_MS = 30_000;

/**
 * Check if a CLI failure looks transient based on captured output lines.
 */
function isTransientFailure(outputLines: string[], durationMs: number): boolean {
  if (durationMs > TRANSIENT_MAX_DURATION_MS) return false;
  const combined = outputLines.join('\n');
  return TRANSIENT_FAILURE_PATTERNS.some(p => p.test(combined));
}

// ── CopilotCliRunner ───────────────────────────────────────────────────

/** Unified runner for Copilot CLI operations. */
export class CopilotCliRunner {
  private logger: CopilotCliLogger;
  private spawner: IProcessSpawner;
  private environment: IEnvironment;
  private configProvider?: IConfigProvider;
  private managedFactory?: IManagedProcessFactory;
  
  constructor(logger?: CopilotCliLogger, spawner?: IProcessSpawner, environment?: IEnvironment, configProvider?: IConfigProvider, managedFactory?: IManagedProcessFactory) {
    this.logger = logger ?? noopLogger;
    this.spawner = spawner ?? getFallbackSpawner();
    this.environment = environment ?? fallbackEnvironment;
    this.configProvider = configProvider;
    this.managedFactory = managedFactory;
  }
  
  /**
   * Check if Copilot CLI is available (sync, cached).
   */
  isAvailable(): boolean {
    return isCopilotCliAvailable();
  }

  /**
   * Await any pending CLI detection and return definitive result.
   * Unlike isAvailable(), this never returns a stale false.
   */
  async ensureAvailable(): Promise<boolean> {
    return ensureCopilotCliChecked();
  }
  
  /**
   * Run Copilot CLI with the given options.
   */
  async run(options: CopilotRunOptions): Promise<CopilotRunResult> {
    const {
      cwd,
      task,
      instructions,
      label = 'copilot',
      sessionId,
      model,
      logDir,
      sharePath,
      onOutput,
      onProcess,
      timeout = 300000, // 5 minutes default
      skipInstructionsFile = false,
    } = options;
    
    // Check if Copilot CLI is available — await any pending detection.
    // Skip when spawnerOverride is set (integration test with scripted process output).
    if (!options.spawnerOverride) {
      const cliAvailable = await this.ensureAvailable();
      if (!cliAvailable) {
        this.logger.warn(`[${label}] Copilot CLI not available`);
        return {
          success: false,
          error: 'Copilot CLI not available. Install via "npm install -g @github/copilot" or "gh extension install github/gh-copilot", then run "Copilot Orchestrator: Refresh Copilot CLI" from the Command Palette.',
          exitCode: 127,
        };
      }
    }
    
    // Setup instructions file if not skipped
    let instructionsFile: string | undefined;
    let instructionsDir: string | undefined;
    
    if (!skipInstructionsFile) {
      const instructionsSetup = this.writeInstructionsFile(cwd, task, instructions, label, options.jobId, options.allowedFolders);
      instructionsFile = instructionsSetup.filePath;
      instructionsDir = instructionsSetup.dirPath;
    }

    // Install orchestrator hooks (preToolUse checkpoint gate). The CLI loads
    // .github/hooks/*.json from the worktree at session start, so this must
    // happen before the process spawns. Context-pressure enforcement requires
    // this — the agent ignores in-prompt instructions, but cannot bypass a
    // preToolUse denial because the CLI blocks the tool call itself.
    let hooksInstalled = false;
    if (this.configProvider) {
      const contextPressureEnabled = this.configProvider.getConfig<boolean>(
        'copilotOrchestrator.contextPressure', 'enabled', false
      );
      if (contextPressureEnabled) {
        try {
          // installOrchestratorHooks() is fail-open: on internal failure it returns
          // an empty configPath rather than throwing. Only mark hooks as installed
          // when the hook config was actually written, otherwise checkpoint enforcement
          // is silently disabled while the runner believes it is active.
          const hookInstallResult = installOrchestratorHooks(cwd, this.logger);
          hooksInstalled = hookInstallResult.configPath.trim().length > 0;
          if (!hooksInstalled) {
            this.logger.warn(`[${label}] Orchestrator hooks were not installed; checkpoint enforcement remains disabled.`);
          }
        } catch (e) {
          this.logger.warn(`[${label}] Failed to install orchestrator hooks: ${e}`);
        }
      }
    }
    
    // Build the command
    // Auto-derive configDir from cwd for session isolation.
    // Every CLI invocation gets its own config dir so sessions don't leak
    // into the VS Code Sessions UI or collide between concurrent nodes.
    const copilotCmd = this.buildCommand({
      task: skipInstructionsFile ? task : `Complete the task described in the instructions file at ${instructionsFile}.`,
      sessionId,
      model,
      logDir,
      sharePath,
      cwd,
      configDir: options.configDir,
      allowedFolders: options.allowedFolders,
      allowedUrls: options.allowedUrls,
      maxTurns: options.maxTurns,
    });
    
    this.logger.info(`[${label}] Running: ${copilotCmd.commandString.substring(0, 100)}...`);
    
    // Execute with transient failure retry
    try {
      let lastResult: CopilotRunResult | undefined;
      for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
        const capturedLines: string[] = [];
        const startTime = Date.now();

        try {
          lastResult = await this.execute({
            command: copilotCmd,
            cwd,
            label: attempt > 0 ? `${label} (retry ${attempt}/${MAX_TRANSIENT_RETRIES})` : label,
            sessionId,
            timeout,
            onOutput: (line: string) => {
              capturedLines.push(line);
              onOutput?.(line);
            },
            onProcess,
            env: options.env,
            planId: options.planId,
            jobId: options.jobId,
            logDir: options.logDir,
            spawnerOverride: options.spawnerOverride,
          });

          if (lastResult.success) {
            return lastResult;
          }

          // Check if this is a transient failure worth retrying
          const durationMs = Date.now() - startTime;
          if (attempt < MAX_TRANSIENT_RETRIES && isTransientFailure(capturedLines, durationMs)) {
            const backoffMs = TRANSIENT_BACKOFF_BASE_MS * Math.pow(2, attempt);
            const backoffSec = Math.round(backoffMs / 1000);
            this.logger.warn(`[${label}] Transient CLI failure detected (attempt ${attempt + 1}/${MAX_TRANSIENT_RETRIES + 1}), retrying in ${backoffSec}s...`);
            onOutput?.(`⚠ Transient failure detected (${lastResult.error}). Retrying in ${backoffSec}s... (attempt ${attempt + 1}/${MAX_TRANSIENT_RETRIES + 1})`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            continue;
          }

          // Not transient or max retries exceeded — return failure
          return lastResult;
        } catch (error: any) {
          // Execute threw unexpectedly — not retryable
          return { success: false, error: error.message } as CopilotRunResult;
        }
      }

      // Should not reach here, but return last result as safety net
      return lastResult ?? { success: false, error: 'Max transient retries exceeded' };
    } finally {
      // Cleanup instructions file
      if (instructionsFile) {
        this.cleanupInstructionsFile(instructionsFile, instructionsDir, label);
      }
      // Cleanup orchestrator hooks (best-effort; keeps worktrees clean between
      // sessions so a resumed session doesn't see stale hook state).
      if (hooksInstalled) {
        try { uninstallOrchestratorHooks(cwd, this.logger); } catch { /* ignore */ }
      }
    }
  }
  
  /**
   * Write instructions to .github/instructions/ in the working directory.
   * Public so callers with custom execution needs can still use standardized instructions.
   */
  writeInstructionsFile(
    cwd: string,
    task: string,
    instructions: string | undefined,
    label: string,
    jobId?: string,
    allowedFolders?: string[]
  ): { filePath: string; dirPath: string } {
    const instructionsDir = path.join(cwd, '.github', 'instructions');
    const suffix = jobId ? `-${jobId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-12)}` : '';
    const instructionsFile = path.join(instructionsDir, `orchestrator-job${suffix}.instructions.md`);
    
    // Get the worktree folder name for scoping
    const worktreeName = path.basename(cwd);
    const worktreeParent = path.basename(path.dirname(cwd));
    const applyToScope = `${worktreeParent}/${worktreeName}/**`;
    
    // Build sandbox/environment section
    const tmpDir = path.join(cwd, '.orchestrator', 'tmp');
    let sandboxSection = `## Environment

- **Working directory**: \`${cwd}\`
- **Temp directory**: Use \`${tmpDir}\` for any temporary files (do NOT use \\$env:TEMP, %TMP%, or /tmp — you don't have access)
`;
    if (allowedFolders && allowedFolders.length > 0) {
      sandboxSection += `- **Allowed directories** (you can read/write/execute in these paths):\n`;
      for (const f of allowedFolders) {
        sandboxSection += `  - \`${f}\`\n`;
      }
      sandboxSection += `- Do NOT attempt to access directories outside this list — commands will fail with "Permission denied"\n`;
    }

    // Build checkpoint protocol preamble if context pressure is enabled
    let checkpointPreamble = '';
    if (this.configProvider) {
      const contextPressureEnabled = this.configProvider.getConfig<boolean>(
        'copilotOrchestrator.contextPressure', 'enabled', false
      );
      if (contextPressureEnabled) {
        checkpointPreamble = `## CHECKPOINT PROTOCOL — READ THIS FIRST

If \`.orchestrator/CHECKPOINT_REQUIRED\` exists at any time, your context window is critical and you must hand off. **Do these steps IN THIS EXACT ORDER. Do not skip step 1.**

1. **WRITE THE MANIFEST FIRST** (this is your handoff to the next agent — without it your work is lost):
   \`\`\`bash
   cat > .orchestrator/checkpoint-manifest.json << 'EOF'
   {
     "status": "checkpointed",
     "completed": [{"file": "<path>", "summary": "<what you finished>"}],
     "remaining": [{"file": "<path>", "description": "<what still needs to be done>"}],
     "summary": "<one sentence: what's done, what's left>"
   }
   EOF
   \`\`\`
2. \`git add -A && git commit -m "[checkpoint] <summary>"\`
3. \`git add --force .orchestrator/checkpoint-manifest.json && git commit --amend --no-edit\`
4. Print \`[ORCHESTRATOR:CHECKPOINT_COMPLETE]\` and exit.

A \`preToolUse\` hook in \`.github/hooks/\` enforces this — once the sentinel exists, most tools return \`ORCHESTRATOR_CHECKPOINT_REQUIRED\` errors. When you see that error, jump to step 1 immediately. Do NOT retry the denied tool.

**Never commit without writing the manifest first.** A commit with no manifest = orchestrator fails the job and your work is discarded. Take 30 seconds to fill in the manifest richly (more \`completed\` and \`remaining\` entries = better handoff).

Check for the sentinel periodically with \`test -f .orchestrator/CHECKPOINT_REQUIRED\` (PowerShell: \`Test-Path .orchestrator/CHECKPOINT_REQUIRED\`).

`;
      }
    }

    // Build instructions content with frontmatter
    const content = `---
applyTo: '${applyToScope}'
---

${checkpointPreamble}# CRITICAL RULES (read before doing ANYTHING)

## Command Output Rule
**NEVER use \`Select-Object -Last\`, \`Select-Object -First\`, \`| head\`, or \`| tail\` to truncate command output.**
Instead, ALWAYS capture full output to a file, then search it:

\`\`\`powershell
# CORRECT: capture full output, then search
npm run test 2>&1 | Tee-Object -FilePath "${tmpDir}\\test-output.txt"
Select-String -Path "${tmpDir}\\test-output.txt" -Pattern "FAIL|error"

# WRONG: truncating output loses critical information
npm run test 2>&1 | Select-Object -Last 40
\`\`\`

This applies to ALL commands that run builds, tests, coverage, or linting.
Short commands (<10 seconds) like \`git status\` or \`ls\` are exempt.

# Current Task

${task}

${sandboxSection}
${instructions ? `## Additional Context\n\n${instructions}` : ''}

## Guidelines

- Focus only on the task described above
- Make minimal, targeted changes
- Follow existing code patterns and conventions in this repository
- Commit your changes when complete
`;
    
    try {
      fs.mkdirSync(instructionsDir, { recursive: true });
      // Also ensure the orchestrator tmp dir exists for the agent to use
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(instructionsFile, content, 'utf8');
      this.logger.info(`[${label}] Wrote instructions to: ${instructionsFile}`);
    } catch (e) {
      this.logger.warn(`[${label}] Failed to write instructions file: ${e}`);
    }
    
    return { filePath: instructionsFile, dirPath: instructionsDir };
  }
  
  /** Delegates to the standalone {@link sanitizeUrl} pure function. */
  sanitizeUrl(raw: string): string | null {
    return sanitizeUrl(raw, this.logger);
  }

  /** Delegates to the standalone {@link buildCommand} pure function. */
  buildCommand(options: BuildCommandOptions): BuiltCommand {
    return buildCommand(options, {
      logger: this.logger,
      fallbackCwd: this.environment.cwd(),
    });
  }
  
  /**
   * Execute the Copilot CLI command.
   */
  private execute(options: {
    command: BuiltCommand | string; cwd: string; label: string; sessionId?: string;
    timeout: number; onOutput?: (line: string) => void;
    onProcess?: (proc: ChildProcessLike) => void;
    env?: Record<string, string>;
    planId?: string; jobId?: string; logDir?: string;
    spawnerOverride?: import('../interfaces/IProcessSpawner').IProcessSpawner;
  }): Promise<CopilotRunResult> {
    const builtCmd = typeof options.command === 'string'
      ? { executable: options.command, args: [] as string[], logDir: undefined as string | undefined, commandString: options.command }
      : options.command;
    const { cwd, label, sessionId, timeout, onOutput, onProcess } = options;
    
    return new Promise((resolve) => {
      // Clean environment: remove NODE_OPTIONS to avoid passing VS Code flags to CLI
      const cleanEnv = { ...this.environment.env, ...options.env };
      delete cleanEnv.NODE_OPTIONS;
      
      // Log the full invocation for diagnostics (to both logger AND onOutput for node log visibility)
      this.logger.info(`[${label}] Spawning: ${builtCmd.commandString}`);
      this.logger.info(`[${label}] CWD: ${cwd}`);
      const defaultKeyPrefixes = ['PATH', 'SYSTEM', 'WIN', 'COM', 'TEMP', 'TMP', 'HOME', 'USER', 'APP', 'LOCAL', 'PROGRAM', 'OS', 'PROCESSOR', 'NUMBER_OF', 'COMPUTER', 'VSCODE', 'ELECTRON', 'CHROME', 'NO_COLOR', 'PROMPT', 'PUBLIC', 'DRIVER', 'SESSION', 'LOGON', 'FPS_', 'GIT_TR', 'WVD_', 'NUGET', 'CONDA', 'PSModule', 'WSLENV', 'WT_', 'YARN', 'npm_', 'MACE', 'UATDATA', 'APPLICATION_INS', 'POWERSHELL_D', 'OneDrive', 'ESPMRepo', 'Chocolatey', 'IsDevBox', 'CLIENTNAME', 'CommonProgram'];
      const envLines: string[] = [];
      for (const [key, value] of Object.entries(cleanEnv)) {
        if (value && !defaultKeyPrefixes.some(p => key.toUpperCase().startsWith(p.toUpperCase()))) {
          const redacted = /token|key|secret|password|auth/i.test(key) ? '***' : value;
          envLines.push(`  ${key}=${redacted}`);
        }
      }
      
      // Emit to onOutput so it appears in the node execution log
      if (onOutput) {
        onOutput(`Spawning: ${builtCmd.commandString}`);
        onOutput(`CWD: ${cwd}`);
        if (envLines.length > 0) {
          onOutput(`Environment (non-default):`);
          for (const line of envLines) { onOutput(line); }
        }
      }
      // Also emit to component logger for extension output channel
      if (envLines.length > 0) {
        this.logger.debug(`[${label}] Environment (non-default keys):`);
        for (const line of envLines) { this.logger.debug(`[${label}] ${line}`); }
      }
      
      const effectiveSpawner = options.spawnerOverride ?? this.spawner;
      // Use shell: false with structured args to prevent command injection.
      // Each argument is passed as a separate argv entry — no shell metacharacter interpretation.
      const rawProc = effectiveSpawner.spawn(builtCmd.executable, builtCmd.args, { cwd, shell: false, env: cleanEnv });
      let timeoutHandle: NodeJS.Timeout | undefined;
      let wasKilledByTimeout = false;
      let statsHangTimer: NodeJS.Timeout | undefined;
      let wasKilledByStatsHang = false;
      
      // timeout === 0 means no timeout (agent work can run indefinitely)
      const effectiveTimeout = timeout > 0 ? Math.min(timeout, 2147483647) : 0;

      // ── Managed process path (bus-based handlers) ──
      const effectiveLogDir = builtCmd.logDir ?? options.logDir ?? path.join(cwd, '.orchestrator', '.copilot-cli', 'logs');
      const managed = this.managedFactory?.create(rawProc, {
        label: 'copilot',
        planId: options.planId,
        nodeId: options.jobId,
        worktreePath: cwd,
        logSources: [{
          name: 'debug-log',
          type: 'directory' as const,
          path: effectiveLogDir,
        }],
      });

      if (!managed) {
        this.logger.error(`[${label}] IManagedProcessFactory not available — cannot execute without process output bus`);
        resolve({ success: false, error: 'IManagedProcessFactory not available. Ensure DI is configured correctly.' });
        return;
      }

      // ── Bus-based path: handlers do the parsing ──
      if (effectiveTimeout > 0) {
          timeoutHandle = setTimeout(() => {
            wasKilledByTimeout = true;
            this.logger.error(`[${label}] Process timed out after ${effectiveTimeout}ms, killing PID ${managed.pid}`);
            try { managed.kill(); } catch { /* ignore */ }
          }, effectiveTimeout);
        }

        if (managed.pid) {
          this.logger.info(`[${label}] Copilot PID: ${managed.pid}`);
          onProcess?.(rawProc);
        }

        // ── Context-pressure escalation: kill if agent ignores the sentinel ──
        // The ContextPressureHandler writes the CHECKPOINT_REQUIRED sentinel when
        // pressure goes critical. If the agent doesn't honor it within the grace
        // window, we force-kill the process to free the worktree for splitting.
        let pressureKillTimer: NodeJS.Timeout | undefined;
        let wasKilledByPressure = false;
        const pressureHandler = managed.bus.getHandler<ContextPressureHandler>('context-pressure');
        if (pressureHandler && options.planId && options.jobId) {
          pressureHandler.monitor.onPressureChange((level) => {
            if (level !== 'critical' || pressureKillTimer) { return; }
            this.logger.warn(`[${label}] Context pressure CRITICAL — sentinel written, granting agent 30s to checkpoint before force-kill (PID ${managed.pid})`);
            pressureKillTimer = setTimeout(() => {
              this.logger.error(`[${label}] Agent did not checkpoint within 30s of critical pressure — force-killing PID ${managed.pid}`);
              wasKilledByPressure = true;
              try { managed.kill(); } catch { /* ignore */ }
            }, 30_000);
          });
        }

        // Forward output lines and drive the stats hang timer
        managed.on('line', (line: string, source) => {
          if (source.type === 'stdout' || source.type === 'stderr') {
            this.logger.debug(`[${label}] ${line}`);
            onOutput?.(line);
          }
          // Start grace timer when stats summary is detected but process hasn't exited
          // Stats may appear on stdout (older CLI) or stderr (CLI v1.0.31+)
          if (source.type === 'stdout' || source.type === 'stderr') {
            const stats = managed.bus.getHandler<StatsHandler>('stats');
            if (stats?.getStatsStartedAt() && !statsHangTimer) {
              this.logger.info(`[${label}] Stats summary detected — starting 30s grace timer for process exit`);
              statsHangTimer = setTimeout(() => {
                this.logger.warn(`[${label}] CLI process hung after stats summary (30s grace expired) — force-killing PID ${managed.pid}`);
                wasKilledByStatsHang = true;
                try { managed.kill(); } catch { /* ignore */ }
              }, 30_000);
            }
          }
        });

        managed.on('exit', (code: number | null, signal: string | null) => {
          if (timeoutHandle) { clearTimeout(timeoutHandle); }
          if (statsHangTimer) { clearTimeout(statsHangTimer); }
          if (pressureKillTimer) { clearTimeout(pressureKillTimer); }

          // Log bus diagnostics on every exit (success or failure) for observability
          const diag = managed.diagnostics();
          this.logger.info(`[${label}] Bus diagnostics: handlers=[${diag.handlerNames.join(', ')}], lines=${JSON.stringify(diag.busMetrics.linesBySource)}, invocations=${diag.busMetrics.handlerInvocations}, errors=${diag.busMetrics.handlerErrors}`);
          for (const tm of diag.tailerMetrics) {
            this.logger.info(`[${label}] Tailer: file=${tm.currentFile ?? '(none)'}, bytes=${tm.bytesRead}, lines=${tm.linesFed}, polls=${tm.pollReadsPerformed}, watchEvents=${tm.watchEventsReceived}, errors=${tm.readErrors}`);
          }

          const sessionIdHandler = managed.bus.getHandler<SessionIdHandler>('session-id');
          const taskCompleteHandler = managed.bus.getHandler<TaskCompleteHandler>('task-complete');
          const statsHandler = managed.bus.getHandler<StatsHandler>('stats');

          const capturedSessionId = sessionIdHandler?.getSessionId() ?? sessionId;
          const sawTaskComplete = taskCompleteHandler?.sawTaskComplete() ?? false;

          // Windows: code=null & signal=null after normal completion → treat as 0 if marker seen
          const effectiveCode = (code === null && signal === null && sawTaskComplete) ? 0
            // Stats-hang kill: the work completed, only the process hung — treat as success
            : (wasKilledByStatsHang && statsHandler?.getMetrics()) ? 0
            // Pressure-kill: agent ignored sentinel → treat as success so commit/reshape can proceed
            : wasKilledByPressure ? 0
            : code;
          const metrics = statsHandler?.getMetrics();
          if (metrics && !metrics.tokenUsage && metrics.modelBreakdown?.length) {
            const totals = metrics.modelBreakdown.reduce(
              (acc, m) => ({ input: acc.input + m.inputTokens, output: acc.output + m.outputTokens }),
              { input: 0, output: 0 }
            );
            metrics.tokenUsage = {
              inputTokens: totals.input, outputTokens: totals.output,
              totalTokens: totals.input + totals.output, model: metrics.modelBreakdown[0].model,
            };
          }

          if (effectiveCode !== 0) {
            let reason: string;
            if (wasKilledByTimeout) {
              reason = `Copilot CLI killed by signal TIMEOUT after ${effectiveTimeout}ms (PID ${managed.pid})`;
            } else if (wasKilledByStatsHang) {
              reason = `Copilot CLI hung after stats summary, force-killed after 30s grace (PID ${managed.pid})`;
            } else if (signal) {
              reason = `Copilot CLI was killed by signal ${signal} (PID ${managed.pid})`;
            } else {
              reason = `Copilot CLI exited with code ${effectiveCode}`;
            }
            this.logger.error(`[${label}] ${reason}, code=${code}, signal=${signal}, sawTaskComplete=${sawTaskComplete}`);
            this.logger.error(`[${label}] Process diagnostics: ${JSON.stringify(managed.diagnostics())}`);
            resolve({ success: false, sessionId: capturedSessionId, error: reason, exitCode: effectiveCode ?? undefined, metrics });
          } else {
            if (code === null) {
              this.logger.info(`[${label}] Copilot CLI completed (exit code null coerced to 0 — task completion marker was present)`);
            } else if (wasKilledByStatsHang) {
              this.logger.warn(`[${label}] Copilot CLI completed (stats-hang force-kill → treated as success since work finished)`);
            } else if (wasKilledByPressure) {
              this.logger.warn(`[${label}] Copilot CLI force-killed due to context pressure escalation (agent ignored sentinel) — treating as success so checkpoint reshape can proceed`);
            } else {
              this.logger.info(`[${label}] Copilot CLI completed successfully`);
            }
            resolve({ success: true, sessionId: capturedSessionId, exitCode: 0, metrics });
          }
        });

        managed.on('error', (err: Error) => {
          if (timeoutHandle) { clearTimeout(timeoutHandle); }
          if (statsHangTimer) { clearTimeout(statsHangTimer); }
          if (pressureKillTimer) { clearTimeout(pressureKillTimer); }
          this.logger.error(`[${label}] Copilot CLI error: ${err.message}`);
          this.logger.error(`[${label}] Process diagnostics: ${JSON.stringify(managed.diagnostics())}`);
          resolve({ success: false, error: err.message });
        });

    });
  }
  
  /**
   * Clean up the instructions file after execution.
   * Public so callers with custom execution can clean up properly.
   */
  cleanupInstructionsFile(
    filePath: string,
    dirPath: string | undefined,
    label: string
  ): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.logger.debug(`[${label}] Cleaned up instructions file`);
        
        // Try to remove directory if empty
        if (dirPath) {
          try {
            const files = fs.readdirSync(dirPath);
            if (files.length === 0) {
              fs.rmdirSync(dirPath);
            }
          } catch { /* ignore */ }
        }
      }
    } catch (e) {
      this.logger.warn(`[${label}] Failed to cleanup instructions file: ${e}`);
    }
  }
}

// ============================================================================
// PURE FUNCTIONS (exported for direct testing)
// ============================================================================

/**
 * Sanitize and validate a URL string from untrusted user input.
 * Pure function — no side effects. Returns the sanitized URL or null.
 *
 * @param raw - The raw URL string to validate
 * @param logger - Optional logger for security audit messages
 */
export function sanitizeUrl(raw: string, logger?: CopilotCliLogger): string | null {
  const log = logger ?? noopLogger;
  if (!raw || typeof raw !== 'string') {
    log.warn(`[SECURITY] Rejected URL: empty or non-string input`);
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    log.warn(`[SECURITY] Rejected URL: empty after trim`);
    return null;
  }
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    log.warn(`[SECURITY] Rejected URL containing control characters`);
    return null;
  }
  if (/[`|;\n\r\\]/.test(trimmed) || /\$\(/.test(trimmed)) {
    log.warn(`[SECURITY] Rejected URL containing shell metacharacters: ${trimmed.substring(0, 50)}`);
    return null;
  }
  if (trimmed.includes('&&')) {
    log.warn(`[SECURITY] Rejected URL containing '&&' shell operator: ${trimmed.substring(0, 50)}`);
    return null;
  }
  if (trimmed.startsWith('-')) {
    log.warn(`[SECURITY] Rejected URL starting with dash (argument injection): ${trimmed.substring(0, 50)}`);
    return null;
  }
  const isWildcard = trimmed.startsWith('*.');
  const urlToTest = isWildcard ? `https://${trimmed.slice(2)}` : trimmed;
  let parsed: URL;
  try {
    parsed = new URL(urlToTest.includes('://') ? urlToTest : `https://${urlToTest}`);
  } catch {
    log.warn(`[SECURITY] Rejected URL: invalid URL format: ${trimmed.substring(0, 50)}`);
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    log.warn(`[SECURITY] Rejected URL with disallowed scheme: ${parsed.protocol}`);
    return null;
  }
  if (parsed.username || parsed.password) {
    log.warn(`[SECURITY] Rejected URL containing embedded credentials`);
    return null;
  }
  return trimmed;
}

/** Options for {@link buildCommand}. */
export interface BuildCommandOptions {
  task: string;
  sessionId?: string;
  model?: string;
  logDir?: string;
  sharePath?: string;
  cwd?: string;
  configDir?: string;
  allowedFolders?: string[];
  allowedUrls?: string[];
  maxTurns?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
}

/** Structured command result for parameterized execution (no shell injection). */
export interface BuiltCommand {
  /** The executable name (e.g., 'copilot') */
  executable: string;
  /** Argument array — each element is a separate argv entry */
  args: string[];
  /** Resolved log directory path (for ManagedProcessFactory logSources) */
  logDir: string | undefined;
  /** Legacy: full command string for logging/display only */
  commandString: string;
}

/**
 * Build a Copilot CLI command as a structured executable + args array.
 * 
 * Returns parameterized args (no shell metacharacter interpretation) to
 * prevent command injection. The caller should use `shell: false`.
 *
 * @param options  - Command options
 * @param deps     - Optional dependency overrides for testing
 */
export function buildCommand(
  options: BuildCommandOptions,
  deps?: {
    logger?: CopilotCliLogger;
    existsSync?: (p: string) => boolean;
    fallbackCwd?: string;
    urlSanitizer?: (raw: string) => string | null;
  },
): BuiltCommand {
  const log = deps?.logger ?? noopLogger;
  const exists = deps?.existsSync ?? fs.existsSync;
  const { task, sessionId, model, logDir, sharePath, cwd, allowedFolders, allowedUrls, maxTurns, effort } = options;

  const allowedPaths: string[] = [];
  if (cwd) {
    const normalizedCwd = path.resolve(cwd);
    if (exists(normalizedCwd)) {
      allowedPaths.push(normalizedCwd);
      log.debug(`[SECURITY] Added worktree to allowed paths: ${normalizedCwd}`);
    } else {
      log.error(`[SECURITY] Working directory does not exist: ${cwd} (normalized: ${normalizedCwd})`);
      allowedPaths.push(normalizedCwd);
    }
  }
  if (allowedFolders && allowedFolders.length > 0) {
    for (const folder of allowedFolders) {
      if (!path.isAbsolute(folder)) {
        log.warn(`[SECURITY] Skipping relative allowed folder (must be absolute): ${folder}`);
        continue;
      }
      const normalized = path.resolve(folder);
      if (exists(normalized)) {
        allowedPaths.push(normalized);
      } else {
        log.warn(`[SECURITY] Allowed folder does not exist: ${folder}`);
      }
    }
  }

  log.info(`[SECURITY] Copilot CLI allowed directories (${allowedPaths.length}):`);
  for (const p of allowedPaths) {
    log.info(`[SECURITY]   - ${p}`);
  }

  const resolvedConfigDir = options.configDir || (cwd ? path.join(cwd, '.orchestrator', '.copilot-cli') : undefined);

  const doSanitize = deps?.urlSanitizer ?? ((raw: string) => sanitizeUrl(raw, log));
  const sanitizedUrls: string[] = [];
  if (allowedUrls && allowedUrls.length > 0) {
    for (const rawUrl of allowedUrls) {
      const validated = doSanitize(rawUrl);
      if (validated) { sanitizedUrls.push(validated); }
    }
    if (sanitizedUrls.length > 0) {
      log.info(`[SECURITY] Copilot CLI allowed URLs (${sanitizedUrls.length} of ${allowedUrls.length} passed validation):`);
      for (const url of sanitizedUrls) {
        try { log.info(`[SECURITY]   - ${new URL(url).origin}${new URL(url).pathname}`); }
        catch { log.info(`[SECURITY]   - ${url.split('?')[0].split('#')[0]}`); }
      }
    } else {
      log.warn(`[SECURITY] All ${allowedUrls.length} provided URLs failed validation — network access disabled`);
    }
  } else {
    log.info(`[SECURITY] Copilot CLI allowed URLs: none (network access disabled)`);
  }

  // Build args array — each value is a separate argv entry, no shell quoting needed
  const cmdArgs: string[] = [
    '-p', task,
    '--stream', 'off',
  ];

  // --add-dir for each allowed path
  if (allowedPaths.length === 0) {
    const fallbackPath = cwd || deps?.fallbackCwd || process.cwd();
    log.warn(`[SECURITY] No allowed paths specified, using explicit cwd: ${fallbackPath}`);
    cmdArgs.push('--add-dir', fallbackPath);
  } else {
    for (const p of allowedPaths) { cmdArgs.push('--add-dir', p); }
  }

  cmdArgs.push('--allow-all-tools', '--no-auto-update', '--no-ask-user');

  // --allow-url for each sanitized URL
  for (const url of sanitizedUrls) { cmdArgs.push('--allow-url', url); }

  if (resolvedConfigDir) { cmdArgs.push('--config-dir', resolvedConfigDir); }
  if (model) { cmdArgs.push('--model', model); }

  // Resolve effective log dir
  let effectiveLogDir = logDir;
  if (!effectiveLogDir && resolvedConfigDir) {
    effectiveLogDir = path.join(resolvedConfigDir, 'logs');
    log.info(`[cli] No explicit logDir — using fallback: ${effectiveLogDir}`);
  }
  if (effectiveLogDir) {
    cmdArgs.push('--log-dir', effectiveLogDir, '--log-level', 'debug');
  }

  if (sharePath) { cmdArgs.push('--share', sharePath); }
  if (sessionId) { cmdArgs.push('--resume', sessionId); }
  // --max-turns was removed in CLI v1.0.31 — skip if not supported
  // TODO: version-gate via getCachedModels().capabilities when buildCommand gains access
  if (maxTurns && maxTurns > 0) {
    log.warn(`--max-turns ${maxTurns} requested but may not be supported by CLI v1.0.31+. Skipping.`);
  }
  if (effort) { cmdArgs.push('--effort', effort); }

  const commandString = `copilot ${cmdArgs.map(a => a.includes(' ') ? JSON.stringify(a) : a).join(' ')}`;
  log.info(`[SECURITY] Copilot CLI command: ${commandString}`);

  return { executable: 'copilot', args: cmdArgs, logDir: effectiveLogDir, commandString };
}
