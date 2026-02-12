# Fix Pre/Postchecks Auto-Heal AllowedFolders

## Problem
When precheck or postcheck (usually shell commands) fail and auto-heal kicks in with an agent, the agent gets "Permission denied" because:
1. The worktree directory is not explicitly included in allowedFolders
2. The auto-heal agent doesn't inherit allowedFolders from the work spec

## Current Implementation Analysis
- Auto-heal code is in `src/plan/runner.ts` around lines 2155-2191
- Currently only inherits from the original failed spec (which is null for shell/process specs)
- Worktree is supposed to be added via `cwd` parameter, but task requires explicit inclusion

## Solution
Modify the heal spec creation in `runner.ts` to:
1. **Always include worktreeDir** in allowedFolders array
2. **Inherit work spec allowedFolders** - if the work spec has allowedFolders, pass them to heal agent
3. Deduplicate the final allowedFolders array

## Implementation Steps
1. Modify the heal spec creation logic around line 2155 in `src/plan/runner.ts`
2. Add logic to extract allowedFolders from the work spec (node.job.work)  
3. Always include worktreePath in the allowedFolders array
4. Update tests if needed to reflect the new behavior

## Key Points
- The ExecutionContext already has `worktreePath` available
- Need to check if `node.job.work` is an agent spec before extracting allowedFolders
- Must deduplicate the final allowedFolders array
- Should preserve allowedUrls inheritance as well