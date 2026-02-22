/**
 * @fileoverview Coverage tests for handleRefreshCopilotCli in utilityCommandLogic.ts
 */
import * as assert from 'assert';
import { suite, test, setup, teardown } from 'mocha';
import * as sinon from 'sinon';
import { Module } from 'module';
import { handleRefreshCopilotCli } from '../../../commands/utilityCommandLogic';
import { MockDialogService } from '../../../vscode/testAdapters';

suite('handleRefreshCopilotCli', () => {
  let mockDialog: MockDialogService;
  let sandbox: sinon.SinonSandbox;
  let originalRequire: typeof Module.prototype.require;

  setup(() => {
    mockDialog = new MockDialogService();
    sandbox = sinon.createSandbox();
    originalRequire = Module.prototype.require;
  });

  teardown(() => {
    mockDialog.reset();
    sandbox.restore();
    Module.prototype.require = originalRequire;
  });

  test('should return available when CLI is detected', async () => {
    Module.prototype.require = sandbox.stub().callsFake((id: string) => {
      if (id === '../agent/cliCheckCore') {
        return {
          resetCliCache: sandbox.stub(),
          checkCopilotCliAsync: sandbox.stub().resolves(true),
        };
      }
      return originalRequire.call(this, id);
    });

    const result = await handleRefreshCopilotCli({ dialog: mockDialog });

    assert.strictEqual(result.status, 'available');
    const calls = mockDialog.getCalls();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'showInfo');
    assert.ok(calls[0].args[0].includes('detected successfully'));
  });

  test('should return not-found when CLI is not available', async () => {
    Module.prototype.require = sandbox.stub().callsFake((id: string) => {
      if (id === '../agent/cliCheckCore') {
        return {
          resetCliCache: sandbox.stub(),
          checkCopilotCliAsync: sandbox.stub().resolves(false),
        };
      }
      return originalRequire.call(this, id);
    });

    const result = await handleRefreshCopilotCli({ dialog: mockDialog });

    assert.strictEqual(result.status, 'not-found');
    const calls = mockDialog.getCalls();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'showWarning');
    assert.ok(calls[0].args[0].includes('not found'));
  });

  test('should return error on exception', async () => {
    Module.prototype.require = sandbox.stub().callsFake((id: string) => {
      if (id === '../agent/cliCheckCore') {
        throw new Error('import failed');
      }
      return originalRequire.call(this, id);
    });

    const result = await handleRefreshCopilotCli({ dialog: mockDialog });

    assert.strictEqual(result.status, 'error');
    assert.strictEqual((result as any).error, 'import failed');
  });

  test('should handle error without message property', async () => {
    Module.prototype.require = sandbox.stub().callsFake((id: string) => {
      if (id === '../agent/cliCheckCore') {
        throw { code: 'ENOENT' }; // eslint-disable-line no-throw-literal
      }
      return originalRequire.call(this, id);
    });

    const result = await handleRefreshCopilotCli({ dialog: mockDialog });

    assert.strictEqual(result.status, 'error');
    assert.strictEqual((result as any).error, 'Unknown error');
  });
});
