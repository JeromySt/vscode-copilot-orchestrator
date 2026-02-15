---
applyTo: "**"
---

# Code Review Standards

When reviewing pull requests in this repository, enforce these critical rules:

## Must-Fix (Block PR)

1. **DI violation**: Any `new ConcreteClass()` outside `src/composition.ts` for DI-managed services
2. **Direct vscode import**: Any `import * as vscode from 'vscode'` in business logic (only allowed in `src/vscode/`, `src/extension.ts`, `src/composition.ts`, `src/ui/`)
3. **Missing interface**: New service without corresponding `src/interfaces/I*.ts` file
4. **Missing token**: New DI service without Symbol token in `src/core/tokens.ts`
5. **Path traversal**: User-provided paths not validated with `path.resolve()` + `startsWith()` check
6. **Test coverage gap**: New source lines without corresponding unit tests (95% threshold enforced)
7. **Wrong test style**: Using `describe`/`it` instead of `suite`/`test` (Mocha TDD style)

## Should-Fix (Strong Recommendation)

1. **Missing error logging**: External operations (fs, git, spawn) without try/catch and `log.error()`
2. **Untyped event emission**: Raw string events instead of typed helper methods
3. **Concrete dependency**: Function accepting concrete class instead of interface
4. **Console.log in production code**: Use `Logger.for()` instead
5. **Synchronous fs in hot path**: Use `fs.promises.*` for async operations

## Acceptable Patterns

- `Logger.for('component')` static factory (singleton, initialized in composition root)
- `as any` in test mocks (mock objects don't need full interface implementation)
- Direct `fs` calls in `src/plan/logFileHelper.ts` (performance-critical path)
- `child_process` import in `src/agent/copilotCliRunner.ts` (wrapped by IProcessSpawner)
