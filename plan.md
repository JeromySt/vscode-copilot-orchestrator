# Worktree Path Debugging Plan

## Issue Analysis
The logs show "Permission denied" when the agent tries to read files in the worktree. The worktree should always be in allowed paths.

## Key Findings
1. **Call chain is correct**: executor → agentDelegator → copilotCliRunner
   - executor passes `worktreePath` 
   - agentDelegator passes `worktreePath` as `cwd`
   - copilotCliRunner adds `cwd` to `allowedPaths`

2. **Root cause identified**:
   - cwd (worktree path) was added without path normalization
   - cwd was added without existence check
   - allowedFolders get normalized with `path.resolve()` but cwd didn't

## Solution Applied
Added normalization and existence validation for the cwd path, similar to allowedFolders.

## Implementation Complete ✅
1. **Modified `buildCommand` in `copilotCliRunner.ts`**:
   - Added path normalization: `const normalizedCwd = path.resolve(cwd);`
   - Added existence check: `fs.existsSync(normalizedCwd)`
   - Added debug logging for worktree path addition
   - Added error logging if worktree doesn't exist (but still add to prevent fallback)

2. **Added debug logging**:
   - Track worktree path being added: `[SECURITY] Added worktree to allowed paths: ${normalizedCwd}`
   - Log final command for troubleshooting: `[SECURITY] Final Copilot command: ${cmd}`

## Changes Made
- Lines 408-419: Enhanced cwd handling with normalization and validation
- Line 413: Added debug logging for successful worktree addition  
- Line 415: Added error logging for missing worktree
- Line 518: Added debug logging for final command

## Expected Result
- The worktree path should now be properly normalized before being added to allowedPaths
- Debug logs should show the exact path being used
- This should resolve "Permission denied" issues when accessing worktree files
- Logs will now clearly show if the worktree path exists and how it's being passed to Copilot CLI