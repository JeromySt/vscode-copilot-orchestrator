# Contributing to Copilot Orchestrator

Thank you for your interest in contributing! This document gets you started quickly. For the full contributor guide with architecture details, DI conventions, and PR requirements, see [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

## Quick Start

```bash
git clone https://github.com/JeromySt/vscode-copilot-orchestrator.git
cd vscode-copilot-orchestrator
npm install
npm run compile
npm run test:unit
code .          # Then press F5 to launch Extension Dev Host
```

## Build Commands

| Command | Description |
|---------|-------------|
| `npm run compile` | Type-check + esbuild bundle |
| `npm run test:unit` | Run all unit tests (headless) |
| `npm run test:coverage` | Tests + 95% line coverage enforcement |
| `npm run watch` | Compile in watch mode |
| `npm run lint` | ESLint |
| `npm run local-install` | Package VSIX + install locally |

## Key Rules

1. **Never `new ConcreteClass()` outside `src/composition.ts`** — use dependency injection
2. **Never `import * as vscode` in business logic** — only allowed in `src/vscode/`, `src/extension.ts`, `src/composition.ts`, `src/ui/`
3. **Use Mocha TDD style** — `suite()` / `test()`, never `describe()` / `it()`
4. **95% line coverage** — enforced via c8
5. **Branch workflow** — always create a feature branch, never commit to `main` directly

## Making a PR

1. `git checkout -b feat/my-feature` (from main)
2. Make changes + write tests
3. `npm run compile && npm run test:unit`
4. `git push -u origin feat/my-feature`
5. Create PR via `gh pr create --base main`

## Documentation

| Guide | Focus |
|-------|-------|
| [Architecture](docs/ARCHITECTURE.md) | System design, class diagrams, sequence diagrams |
| [Contributing (full)](docs/CONTRIBUTING.md) | Workflow, common tasks, PR checklist |
| [DI Guide](docs/DI_GUIDE.md) | Adding services, tokens, mocking |
| [Testing](docs/TESTING.md) | Test framework, patterns, coverage |
| [Copilot Integration](docs/COPILOT_INTEGRATION.md) | MCP tools and agent delegation |
| [Worktrees & Merging](docs/WORKTREES_AND_MERGING.md) | Git isolation strategies |
| [Groups](docs/GROUPS.md) | Visual hierarchy and namespacing |

## License

By contributing, you agree that your contributions will be licensed under the [GPL-3.0 License](LICENSE).
