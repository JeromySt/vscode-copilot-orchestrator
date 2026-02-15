# Skill: Test Writer

You are writing tests for a TypeScript VS Code extension that uses dependency injection.

## Framework

- **Mocha TDD** style: use `suite()`, `test()`, `setup()`, `teardown()` — never `describe`/`it`
- **Sinon** for mocking: stubs, spies, sandboxes, fake timers
- **Assert**: Node.js `assert` module (`assert.strictEqual`, `assert.ok`, `assert.deepStrictEqual`, `assert.throws`)
- **Coverage**: 95% line coverage enforced. Every new source line needs a test.

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

## VS Code Mocking

Unit tests automatically mock `vscode` via `register-vscode-mock.js`. Import normally:
```typescript
import * as vscode from 'vscode';  // Gets mock in unit tests
```

## File Naming

- `src/foo/bar.ts` → `src/test/unit/foo/bar.unit.test.ts`
- Coverage gaps: `*.coverage.unit.test.ts`

## Checklist Before Committing

- [ ] All tests use `suite`/`test` (not `describe`/`it`)
- [ ] `sandbox.restore()` called in `teardown`
- [ ] No concrete class imports for DI services
- [ ] Error paths and edge cases covered
- [ ] Run `npm run test:unit` passes
