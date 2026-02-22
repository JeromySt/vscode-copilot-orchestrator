---
applyTo: "**"
---

# Local Build & Test Workflow

## When to Use

Whenever you need to **locally test**, **locally build**, or **verify changes work end-to-end** in VS Code, you MUST run the local install pipeline. This prevents deploying broken code and catches issues early.

## The Command

```bash
npm run local-install
```

This single command does everything:
1. **Bumps the patch version** (`npm version patch --no-git-tag-version`)
2. **Packages a VSIX** (`npx @vscode/vsce package --no-dependencies`)
3. **Installs the extension** into VS Code (`code --install-extension <vsix> --force`)

After the command completes, **reload the VS Code window** (`Developer: Reload Window`) to pick up the newly installed extension.

## When to Run This

Run `npm run local-install` whenever:
- You want to test a change in the real VS Code extension host
- You're validating a fix before pushing
- You're asked to "build locally" or "test locally"
- You want to verify MCP tools, UI panels, or agent behavior end-to-end
- You need to confirm the extension activates without errors

## Pre-Requisites

Before running `npm run local-install`, ensure:
1. **TypeScript compiles cleanly**: `npm run compile` should pass without errors
2. **Unit tests pass**: `npm run test:unit` should be green
3. **No uncommitted experimental debris**: the build uses the current working tree state

## Quick Validation Sequence

For a thorough local validation:

```bash
# 1. Compile and catch type errors
npm run compile

# 2. Run unit tests
npm run test:unit

# 3. Build, package, and install locally
npm run local-install
```

Then reload VS Code and exercise the feature you changed.

## Troubleshooting

| Problem | Solution |
|---|---|
| `tsc` errors during compile | Fix TypeScript errors first — `npm run compile` |
| VSIX packaging fails | Check `package.json` is valid, run `npm run package:vsix` standalone |
| `code` command not found | Ensure VS Code is in PATH (`Shell Command: Install 'code' command in PATH`) |
| Extension doesn't reload | Run `Developer: Reload Window` from the command palette |
| Version conflict | The patch bump is `--no-git-tag-version`, so discard the `package.json` version change if unwanted |

## Important Notes

- The version bump modifies `package.json` locally — **do not commit this version change** unless intentional
- If you're on a feature branch and want to keep a clean diff, run `git checkout -- package.json package-lock.json` after testing to revert the version bump
- This command is for local development only — CI/CD uses separate packaging workflows
