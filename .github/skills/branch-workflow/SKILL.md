---
name: branch-workflow
description: Enforce feature branch workflow — never commit directly to main
---

# Branch Workflow

## Rule: NEVER commit directly to main

Before every `git commit`, check the current branch:

```bash
git branch --show-current
```

If on `main`:
1. **STOP** — do not commit
2. Create a feature branch first: `git checkout -b <branch-name>`
3. Then commit to the feature branch

## Branch Naming

Use descriptive branch names:
- `fix/<description>` — bug fixes
- `feat/<description>` — new features
- `chore/<description>` — maintenance, lint, docs
- `release/v<X.Y.Z>` — release branches aggregating multiple changes

## Workflow

1. `git checkout -b feat/my-feature` (from main)
2. Make changes, commit to feature branch
3. `git push -u origin feat/my-feature`
4. Create PR via `gh pr create --base main`
5. Wait for CI, check review feedback (see `pr-release-gatekeeper` skill)
6. Merge via `gh pr merge --squash --admin --delete-branch`

## Anti-Patterns

- ❌ `git commit` while on `main`
- ❌ `git push origin main` directly
- ❌ Committing to main then trying to reset when push is rejected
- ❌ Using `--force` to push to protected branches
