---
applyTo: '.worktrees/c10e5039/**'
---

# Current Task

# Auto-Heal: Fix Failed postchecks Phase

## Task Context
This node's task: Verify executor not exported, IGitRepository updated, all tests pass, VSIX builds.

## Original Command
```
cd C:\src\repos\vscode-copilot-orchestrator && npm run compile 2>&1 | Select-Object -Last 5; npm run test:coverage 2>&1 | Select-Object -Last 20
```

## Failure Details
- Phase: postchecks
- Exit code: unknown

## Execution Logs
The following are the full stdout/stderr logs from the failed execution:

```
No logs available.
```

## Instructions
1. Analyze the logs above to diagnose the root cause of the failure
2. Fix the issue in the worktree (edit files, fix configs, etc.)
3. Re-run the original command to verify it now passes:
   ```
   cd C:\src\repos\vscode-copilot-orchestrator && npm run compile 2>&1 | Select-Object -Last 5; npm run test:coverage 2>&1 | Select-Object -Last 20
   ```



## Guidelines

- Focus only on the task described above
- Make minimal, targeted changes
- Follow existing code patterns and conventions in this repository
- Commit your changes when complete
