---
name: security-hardener
description: Reviewing and hardening security in this VS Code extension that spawns isolated AI agents. Use when asked about path validation, agent sandboxing, URL sanitization, input validation, or security review.
---

# Security Hardening Guide

## Path Traversal Prevention

All user-provided directory/file paths must be validated:

```typescript
const repoPathNorm = path.resolve(repoPath);
const resolved = path.resolve(repoPath, userInput);

// Must be strictly inside repo (not equal to root, not outside)
if (!resolved.startsWith(repoPathNorm + path.sep)) {
  log?.(`Blocked path traversal: '${userInput}'`);
  return; // reject
}
```

### Reject dangerous names explicitly
```typescript
if (dirName === '.' || dirName === '..' || dirName === '.git' ||
    dirName.startsWith(`.git${path.sep}`)) {
  // Block
}
```

### Never mutate arrays while iterating
```typescript
// ❌ Wrong: splice during for..of skips entries
for (const dir of dirs) {
  if (bad(dir)) dirs.splice(dirs.indexOf(dir), 1);
}

// ✅ Correct: build filtered array
const validated: string[] = [];
for (const dir of dirs) {
  if (!bad(dir)) validated.push(dir);
}
```

## Agent Sandbox Model

Each Copilot CLI agent is sandboxed:
- **`--add-dir <path>`**: Only these directories are accessible (worktree + explicit allowedFolders)
- **No default network**: `--allow-url` must be explicit per URL
- **Worktree isolation**: Agent works in its own git worktree, never the user's checkout

When adding new agent invocation paths, ensure:
1. The worktree path is always included via `--add-dir`
2. Additional folders come from validated `allowedFolders` only
3. URLs are sanitized (no file:// or javascript:// schemes)

## URL Sanitization

```typescript
function sanitizeUrl(raw: string): string | null {
  // Reject non-http(s) schemes
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // Reject localhost/internal
  if (hostname === 'localhost' || hostname === '127.0.0.1') return null;
  // Return normalized URL
  return url.toString();
}
```

## MCP Nonce Authentication

The MCP stdio↔IPC bridge uses nonce-based 1:1 pairing:
- Nonce generated on server start, passed to stdio child via env var
- Child must present nonce in handshake
- Prevents unauthorized tool calls from other processes

## Input Validation in MCP Handlers

Every MCP handler must validate inputs before use:
```typescript
export async function handleTool(args: ToolArgs, ctx: McpContext): Promise<McpResult> {
  if (!args.planId || typeof args.planId !== 'string') {
    return { content: [{ type: 'text', text: 'Error: planId is required' }] };
  }
  // Proceed only after validation
}
```

## Checklist

- [ ] All user-provided paths validated with resolve + startsWith
- [ ] Dangerous names (`.git`, `..`, `.`, empty) explicitly rejected
- [ ] No array mutation during iteration in validation loops
- [ ] Agent sandbox flags (`--add-dir`, `--allow-url`) properly scoped
- [ ] URLs sanitized (http/https only, no localhost)
- [ ] MCP handler inputs validated before use
