/**
 * @fileoverview Unit tests for bulk command logic
 * 
 * @module test/unit/commands/bulkCommandLogic
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { confirmBulkAction, executeBulkCommand } from '../../../commands/bulkCommandLogic';

suite('confirmBulkAction', () => {
  let sandbox: sinon.SinonSandbox;
  let mockDialog: any;

  setup(() => {
    sandbox = sinon.createSandbox();
    
    mockDialog = {
      showInfo: sandbox.stub(),
      showWarning: sandbox.stub(),
      showError: sandbox.stub(),
    };
  });

  teardown(() => {
    sandbox.restore();
  });

  test('prompts for delete confirmation', async () => {
    mockDialog.showWarning.resolves('Delete');
    
    const result = await confirmBulkAction(mockDialog, 'delete', 3);

    assert.strictEqual(result, true);
    assert.ok(mockDialog.showWarning.calledOnce);
    const callArgs = mockDialog.showWarning.getCall(0).args;
    assert.ok(callArgs[0].includes('Delete 3 plans'));
    assert.ok(callArgs[0].includes('cannot be undone'));
  });

  test('prompts for cancel confirmation', async () => {
    mockDialog.showWarning.resolves('Cancel Plans');
    
    const result = await confirmBulkAction(mockDialog, 'cancel', 2);

    assert.strictEqual(result, true);
    assert.ok(mockDialog.showWarning.calledOnce);
    const callArgs = mockDialog.showWarning.getCall(0).args;
    assert.ok(callArgs[0].includes('Cancel 2 running plans'));
  });

  test('auto-confirms non-destructive actions', async () => {
    const pauseResult = await confirmBulkAction(mockDialog, 'pause', 1);
    assert.strictEqual(pauseResult, true);
    assert.ok(!mockDialog.showWarning.called);
    
    const resumeResult = await confirmBulkAction(mockDialog, 'resume', 1);
    assert.strictEqual(resumeResult, true);
    
    const retryResult = await confirmBulkAction(mockDialog, 'retry', 1);
    assert.strictEqual(retryResult, true);
    
    const finalizeResult = await confirmBulkAction(mockDialog, 'finalize', 1);
    assert.strictEqual(finalizeResult, true);
  });

  test('returns false when user cancels', async () => {
    mockDialog.showWarning.resolves('Cancel');
    
    const result = await confirmBulkAction(mockDialog, 'delete', 1);

    assert.strictEqual(result, false);
  });
});

suite('executeBulkCommand', () => {
  let sandbox: sinon.SinonSandbox;
  let mockBulkActions: any;
  let mockDialog: any;

  setup(() => {
    sandbox = sinon.createSandbox();
    
    mockBulkActions = {
      executeBulkAction: sandbox.stub(),
    };
    
    mockDialog = {
      showInfo: sandbox.stub(),
      showWarning: sandbox.stub(),
      showError: sandbox.stub(),
    };
  });

  teardown(() => {
    sandbox.restore();
  });

  test('skips execution on empty planIds', async () => {
    await executeBulkCommand(mockBulkActions, mockDialog, 'delete', []);

    assert.ok(mockDialog.showWarning.calledOnce);
    assert.ok(mockDialog.showWarning.calledWith('No plans selected'));
    assert.ok(!mockBulkActions.executeBulkAction.called);
  });

  test('skips execution when user declines confirmation', async () => {
    mockDialog.showWarning.resolves('Cancel');
    
    await executeBulkCommand(mockBulkActions, mockDialog, 'delete', ['plan1', 'plan2']);

    assert.ok(!mockBulkActions.executeBulkAction.called);
  });

  test('shows warning dialog when some actions fail', async () => {
    mockDialog.showWarning.resolves('Delete');
    mockBulkActions.executeBulkAction.resolves([
      { planId: 'plan1', success: true },
      { planId: 'plan2', success: false, error: 'Failed to delete' },
      { planId: 'plan3', success: true },
    ]);
    
    await executeBulkCommand(mockBulkActions, mockDialog, 'delete', ['plan1', 'plan2', 'plan3']);

    assert.ok(mockBulkActions.executeBulkAction.calledOnce);
    assert.ok(mockDialog.showWarning.calledTwice); // confirmation + result
    const resultCall = mockDialog.showWarning.getCall(1).args;
    assert.ok(resultCall[0].includes('2 succeeded'));
    assert.ok(resultCall[0].includes('1 failed'));
  });

  test('does not show error dialog on full success', async () => {
    mockDialog.showWarning.resolves('Delete');
    mockBulkActions.executeBulkAction.resolves([
      { planId: 'plan1', success: true },
      { planId: 'plan2', success: true },
    ]);
    
    await executeBulkCommand(mockBulkActions, mockDialog, 'delete', ['plan1', 'plan2']);

    assert.ok(mockBulkActions.executeBulkAction.calledOnce);
    assert.ok(mockDialog.showInfo.calledOnce);
    const callArgs = mockDialog.showInfo.getCall(0).args;
    assert.ok(callArgs[0].includes('2 plans succeeded'));
  });

  test('shows error dialog when all actions fail', async () => {
    mockDialog.showWarning.resolves('Delete');
    mockBulkActions.executeBulkAction.resolves([
      { planId: 'plan1', success: false, error: 'Failed 1' },
      { planId: 'plan2', success: false, error: 'Failed 2' },
    ]);

    await executeBulkCommand(mockBulkActions, mockDialog, 'delete', ['plan1', 'plan2']);

    assert.ok(mockBulkActions.executeBulkAction.calledOnce);
    assert.ok(mockDialog.showError.calledOnce);
    const callArgs = mockDialog.showError.getCall(0).args;
    assert.ok(callArgs[0].includes('All 2'));
  });
});
