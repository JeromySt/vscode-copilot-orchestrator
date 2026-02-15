---
name: test-writer
description: Writing unit tests for this TypeScript VS Code extension. Use when asked to write tests, add coverage, create test files, or fix failing tests. Knows Mocha TDD style, sinon mocking, DI mock patterns, and 95% coverage requirements.
---

# Test Writing Conventions

## Framework

- **Mocha TDD** style: use `suite()`, `test()`, `setup()`, `teardown()` — never `describe`/`it`
- **Sinon** for mocking: stubs, spies, sandboxes, fake timers
- **Assert**: Node.js `assert` module (`assert.strictEqual`, `assert.ok`, `assert.deepStrictEqual`, `assert.throws`)
- **Coverage**: 95% line coverage enforced via c8. Every new source line needs a test.

## Test File Structure

```typescript
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';

suite('ClassName', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('methodName', () => {
    test('should handle expected case', () => {
      // Arrange → Act → Assert
    });

    test('should handle error case', () => {
      // Test failure paths too
    });
  });
});
```

## File Naming

- `src/foo/bar.ts` → `src/test/unit/foo/bar.unit.test.ts`
- Coverage gaps: `*.coverage.unit.test.ts`
- Comprehensive: `*.comprehensive.test.ts`

## Mocking DI Dependencies

This project uses symbol-based DI. In tests, mock dependencies as plain objects — do NOT import concrete implementations:

```typescript
// ✅ Correct
const mockLogger: any = {
  info: sandbox.stub(),
  warn: sandbox.stub(),
  error: sandbox.stub(),
  debug: sandbox.stub(),
};

const mockConfig: any = {
  getConfig: sandbox.stub().returns('default'),
};

// ❌ Wrong — never stub concrete classes in unit tests
import { Logger } from '../../../core/logger';
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

Unit tests automatically mock `vscode` via `register-vscode-mock.js`. Import normally:
```typescript
import * as vscode from 'vscode';  // Gets mock in unit tests
```

## Async & Timer Testing

Use `sinon.useFakeTimers()` with `clock.tickAsync()` (not `clock.tick()`) for async code:

```typescript
let clock: sinon.SinonFakeTimers;
setup(() => { clock = sinon.useFakeTimers(); });
teardown(() => { clock.restore(); });

test('debounces', async () => {
  trigger();
  await clock.tickAsync(1000);
  assert.ok(handler.calledOnce);
});
```

## Spawn Stubbing

TypeScript `__importStar` creates getter-only bindings. Stub `child_process.spawn` directly:

```typescript
const cpModule = require('child_process');
const origSpawn = cpModule.spawn;
cpModule.spawn = sandbox.stub().returns(mockProcess);
teardown(() => { cpModule.spawn = origSpawn; });
```

## Verification

- Run `npm run test:unit` — all tests must pass
- Run `npm run test:coverage` — must meet 95% line coverage
