# Agent Execution AllowedDirs Analysis

## Problem Statement
Agent execution logs don't show `--add-dir` arguments being passed. The worktree directory should ALWAYS be included so the agent can access files in the worktree.

## Data Flow Analysis

### 1. Executor → AgentDelegator
**Location**: `src/plan/executor.ts:1065-1076`

```typescript
const result = await this.agentDelegator.delegate({
  task: spec.instructions,
  instructions: node.instructions || spec.context,
  worktreePath,
  model: spec.model,
  contextFiles: spec.contextFiles,
  maxTurns: spec.maxTurns,
  sessionId,
  jobId: node.id,
  configDir,
  allowedFolders: spec.allowedFolders,  // ← Pass through from AgentSpec
  allowedUrls: spec.allowedUrls,
  // ... other options
});
```

**Key Finding**: Executor passes `spec.allowedFolders` directly from the `AgentSpec`, but does NOT add the `worktreePath` to the `allowedFolders` array.

### 2. AgentDelegator Processing
**Location**: `src/agent/agentDelegator.ts:332-336`

```typescript
// Log security configuration
if (allowedFolders && allowedFolders.length > 0) {
  this.logger.log(`[${label}] Agent allowed folders: ${allowedFolders.join(', ')}`);
} else {
  this.logger.log(`[${label}] Agent restricted to worktree: ${worktreePath}`);
}
```

**Key Finding**: AgentDelegator logs allowed folders IF any exist. If none exist, it logs that agent is "restricted to worktree", but it doesn't explicitly show that worktree will be added as an `--add-dir` argument.

### 3. CopilotCliRunner - Automatic Worktree Addition
**Location**: `src/agent/copilotCliRunner.ts:406-418`

```typescript
// Build allowed paths list: worktree + any additional folders
const allowedPaths: string[] = [];
if (cwd) {
  // Normalize and validate the working directory path (usually the worktree)
  const normalizedCwd = path.resolve(cwd);
  if (fs.existsSync(normalizedCwd)) {
    allowedPaths.push(normalizedCwd);
    this.logger.debug(`[SECURITY] Added worktree to allowed paths: ${normalizedCwd}`);
  }
}
```

**Key Finding**: CopilotCliRunner AUTOMATICALLY adds the `cwd` (worktree path) to the `allowedPaths` array, regardless of whether `allowedFolders` is empty or not.

### 4. CLI Argument Construction
**Location**: `src/agent/copilotCliRunner.ts:442-454`

```typescript
// Build --add-dir arguments to grant file access to specific directories
let pathsArg: string;
if (allowedPaths.length === 0) {
  const fallbackPath = cwd || process.cwd();
  pathsArg = `--add-dir ${JSON.stringify(fallbackPath)}`;
} else {
  // Use multiple --add-dir flags for each path
  pathsArg = allowedPaths.map(p => `--add-dir ${JSON.stringify(p)}`).join(' ');
}
```

**Key Finding**: The worktree directory IS included in the `--add-dir` arguments through the `allowedPaths` array.

### 5. Logging of Final Arguments
**Location**: `src/agent/copilotCliRunner.ts:437-440` and `518`

```typescript
// Log final allowed directories for security audit
this.logger.info(`[SECURITY] Copilot CLI allowed directories (${allowedPaths.length}):`);
for (const p of allowedPaths) {
  this.logger.info(`[SECURITY]   - ${p}`);
}

// Debug log the final command for troubleshooting
this.logger.debug(`[SECURITY] Final Copilot command: ${cmd}`);
```

**Key Finding**: CopilotCliRunner DOES log all allowed directories and the final command with `--add-dir` arguments.

## Root Cause Analysis

The issue described in the problem statement appears to be **incorrect**. The analysis shows that:

1. ✅ **Worktree IS automatically included**: `CopilotCliRunner` adds `cwd` (worktree) to `allowedPaths` automatically
2. ✅ **--add-dir arguments ARE generated**: `pathsArg` includes `--add-dir` for each path in `allowedPaths`
3. ✅ **Logging DOES happen**: Both allowed directories and final command are logged

## Potential Issues

### 1. Log Level Configuration
The detailed `--add-dir` logging happens at different levels:
- `this.logger.info()` for allowed directories (lines 437-440)
- `this.logger.debug()` for final command (line 518)

**Possible Issue**: The debug-level logging of the final command might not be visible if log level is set to INFO or higher.

### 2. AgentSpec allowedFolders Structure
**Location**: `src/plan/types/specs.ts:156`

```typescript
allowedFolders?: string[];
```

**Finding**: `AgentSpec` has `allowedFolders` field, but there's no automatic inclusion of worktree in the spec itself.

### 3. Empty allowedFolders Logging
When `spec.allowedFolders` is empty/undefined, the delegator logs:
```
Agent restricted to worktree: {worktreePath}
```

But it doesn't explicitly say:
```
Agent allowed folders: {worktreePath}
--add-dir: {worktreePath}
```

## Recommendations

1. **Verify log levels**: Ensure debug logging is enabled to see the full command with `--add-dir`
2. **Enhance delegator logging**: Show worktree explicitly in allowed folders even when no additional folders are specified
3. **Check actual execution logs**: The problem might be in a different execution path or the logs being examined might be from a different component

## Status
The claimed issue does not appear to exist based on code analysis. The worktree directory IS included via `--add-dir` and IS logged. Further investigation needed to verify actual runtime behavior.