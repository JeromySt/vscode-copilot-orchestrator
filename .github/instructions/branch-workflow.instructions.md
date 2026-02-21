---
applyTo: "**"
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

## Rule: Squash before pushing

Before `git push` or `gh pr create`, check how many local commits are ahead of origin:

```bash
git log --oneline origin/main..HEAD | wc -l        # Linux/macOS
git log --oneline origin/main..HEAD | Measure-Object -Line   # PowerShell
```

If the branch has **more than 5 local commits** ahead of origin (or has never been pushed):
1. Squash them into a single commit: `git reset --soft origin/main && git commit -m "feat: <summary>"`
2. Write a comprehensive commit message covering all changes (see the commit message in step 3 below)
3. Then push

This keeps the PR clean — one logical commit per feature/release branch.

## Workflow

1. `git checkout -b feat/my-feature` (from main)
2. Make changes, commit to feature branch
3. **Before pushing**: if >5 local commits, squash to 1 (see rule above)
4. `git push -u origin feat/my-feature`
5. Create PR via `gh pr create --base main`
6. Wait for CI, check review feedback (see `pr-release-gatekeeper` instructions)
7. Merge via `gh pr merge --squash --admin --delete-branch`

## Anti-Patterns

- ❌ `git commit` while on `main`
- ❌ `git push origin main` directly
- ❌ Committing to main then trying to reset when push is rejected
- ❌ Using `--force` to push to protected branches
