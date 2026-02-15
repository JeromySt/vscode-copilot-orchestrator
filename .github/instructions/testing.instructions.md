---
applyTo: "src/test/**/*.ts"
---

# Testing Patterns

> **Detailed guide**: See `.github/skills/test-writer/SKILL.md` for full examples, mock patterns, and verification steps.

## Framework & Style

- **Mocha TDD**: Use `suite()`, `test()`, `setup()`, `teardown()` — never `describe`/`it`
- **Sinon**: Stubs, spies, fake timers, sandboxes
- **Assert**: Node.js `assert` module (`assert.strictEqual`, `assert.ok`, `assert.throws`)
- **No Jest**: This project does not use Jest

## File Naming

- Unit tests: `*.unit.test.ts` in `src/test/unit/`
- Suite/integration tests: `*.test.ts` in `src/test/suite/`
- Coverage gap tests: `*.coverage.unit.test.ts`
- Comprehensive tests: `*.comprehensive.test.ts`

Mirror the source directory structure:
```
src/core/logger.ts           → src/test/unit/core/logger.unit.test.ts
src/plan/executor.ts         → src/test/unit/plan/executor.unit.test.ts
src/mcp/handlers/plan/*.ts   → src/test/unit/mcp/planHandlers.full.test.ts
```

## Test Structure Template

```typescript
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';

suite('ComponentName', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('methodName', () => {
    test('should do expected thing', () => {
      // Arrange
      const mockDep = { method: sandbox.stub().returns('value') };

      // Act
      const result = doSomething(mockDep);

      // Assert
      assert.strictEqual(result, 'expected');
      assert.ok(mockDep.method.calledOnce);
    });
  });
});
```

## DI Mocking Pattern

Always mock dependencies via interfaces, never import concrete implementations:

```typescript
// ✅ Good: Mock via interface
const mockLogger: any = {
  info: sandbox.stub(),
  warn: sandbox.stub(),
  error: sandbox.stub(),
  debug: sandbox.stub(),
};

const mockConfig: any = {
  getConfig: sandbox.stub().returns('default'),
  setConfig: sandbox.stub(),
};

// ❌ Bad: Import and stub concrete class
import { Logger } from '../../../core/logger';
sandbox.stub(Logger, 'for');
```

For MCP handler tests, use the `makeMockPlanRunner` pattern:
```typescript
function makeMockPlanRunner(overrides?: Record<string, any>): any {
  return {
    enqueue: sinon.stub().returns(makeMockPlan()),
    get: sinon.stub().returns(undefined),
    getPlan: sinon.stub().returns(undefined),
    getAll: sinon.stub().returns([]),
    cancel: sinon.stub().returns(true),
    delete: sinon.stub().returns(true),
    pause: sinon.stub().returns(true),
    resume: sinon.stub().resolves(true),
    savePlan: sinon.stub(),
    retryNode: sinon.stub().resolves({ success: true }),
    forceFailNode: sinon.stub().resolves(),
    ...overrides,
  };
}
```

## VS Code Mocking

Unit tests use `register-vscode-mock.js` which hooks Node's module resolution to intercept `require('vscode')`. This is automatic — just import as normal:
```typescript
import * as vscode from 'vscode';  // Gets the mock in unit tests
```

The mock provides stubs for: `commands`, `window`, `workspace`, `Uri`, `EventEmitter`, `Disposable`, etc.

## Async & Timer Testing

```typescript
// Fake timers for time-dependent code
let clock: sinon.SinonFakeTimers;
setup(() => { clock = sinon.useFakeTimers(); });
teardown(() => { clock.restore(); });

// Use tickAsync (not tick) for async code with timers
test('debounces events', async () => {
  triggerEvent();
  await clock.tickAsync(1000);  // Settles Promises + advances time
  assert.ok(handler.calledOnce);
});
```

## Console Silencing

Suppress noisy console output in tests:
```typescript
function silenceConsole(): { restore: () => void } {
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  return { restore() { console.log = origLog; console.warn = origWarn; } };
}
```

## Coverage Rules

- **95% line coverage required** — checked by `npm run test:coverage`
- c8 measures coverage on `src/**/*.ts` excluding `src/test/**`
- When adding new source code, always add corresponding tests
- `npm run test:unit` for fast iteration; `npm run test:coverage` before pushing

## Spawn Stubbing (Important)

TypeScript `__importStar` creates getter-only bindings. Stub `child_process.spawn` by replacing it directly on the module object:
```typescript
const cpModule = require('child_process');
const origSpawn = cpModule.spawn;
cpModule.spawn = sandbox.stub().returns(mockProcess);
teardown(() => { cpModule.spawn = origSpawn; });
```
