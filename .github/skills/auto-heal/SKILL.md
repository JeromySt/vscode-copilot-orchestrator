---
name: auto-heal
description: Fixing a failed execution phase in the orchestrator pipeline. Use when asked to fix build errors, test failures, merge conflicts, or any phase failure in a plan node. Do NOT re-execute the original task — only fix the error.
---

# Auto-Heal: Fix Failed Phase

Do NOT re-execute the original task. Your only job is to diagnose and fix the error.

## Diagnosis Process

1. **Read the log file** provided in the instructions — focus on ERROR and ERR lines
2. **Identify the phase** that failed (merge-fi, prechecks, work, commit, postchecks, merge-ri)
3. **Apply the phase-specific fix** below

## Phase-Specific Strategies

### merge-fi (Forward Integration) Failures
- **Cause**: Merge conflicts from dependency node commits
- **Fix**: Resolve conflicts in the worktree, `git add` resolved files, then `git commit`
- **Key**: Check `git status` for conflicted files, look at `<<<<<<<` markers

### prechecks Failures
- **Cause**: Pre-condition validation failed (usually `npx tsc --noEmit` or lint)
- **Fix**: Read the compiler/linter errors, fix the source code, re-run the check command
- **Key**: The check command is in the job spec — run it to verify your fix

### work Phase Failures
- **Cause**: The AI agent errored out (killed by signal, timeout, bad output)
- **Fix**: Check if the agent left partial changes. If so, complete them. If not, start fresh.
- **Key**: `error: killed by signal` means the process was OOM-killed or timed out

### commit Phase Failures
- **Cause**: Nothing to commit (no changes made), or git config issues
- **Fix**: If no changes, the work phase didn't produce output — check worktree state
- **Key**: Run `git status` and `git diff` to see what's there

### postchecks Failures
- **Cause**: Post-condition validation failed after work was done
- **Fix**: Read the specific check that failed, fix it, re-run
- **Common**: TypeScript compilation errors from changes the agent made
- **Command**: Usually `npx tsc --noEmit` — run it, read errors, fix them

### merge-ri (Reverse Integration) Failures
- **Cause**: Squash-merge back to target branch failed (conflicts)
- **Fix**: This is rare — usually means target branch diverged. Rebase or resolve.

## Error Patterns

| Error | Likely Cause | Fix |
|---|---|---|
| `killed by signal` | OOM or timeout | Reduce scope, increase timeout |
| `tsc: error TS` | Type errors | Fix the TypeScript errors |
| `ENOENT` | Missing file/dir | Check paths, create directories |
| `EACCES` / `EPERM` | Permission denied | Check file permissions, avoid system dirs |
| `merge conflict` | Diverged branches | Resolve conflicts manually |
| `nothing to commit` | Work phase produced no changes | Investigate work phase logs |

## Rules

1. **Fix only the error** — don't refactor, don't add features
2. **Make minimal changes** — smallest diff that fixes the problem
3. **Re-run the failing command** to verify before committing
4. **Commit your fix** when done
