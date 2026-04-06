/**
 * @fileoverview Coverage tests for BulkPlanActions – retry action paths.
 * Covers: retry with plan found/not found (uncovered lines in executeBulkAction).
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { BulkPlanActions } from '../../../plan/bulkPlanActions';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

suite('BulkPlanActions coverage', () => {
  let sandbox: sinon.SinonSandbox;
  let quiet: { restore: () => void };
  let mockPlanRunner: any;
  let mockDialog: any;
  let bulkActions: BulkPlanActions;

  setup(() => {
    sandbox = sinon.createSandbox();
    quiet = silenceConsole();

    mockPlanRunner = {
      delete: sandbox.stub().returns(true),
      cancel: sandbox.stub().returns(true),
      pause: sandbox.stub().returns(true),
      resume: sandbox.stub().resolves(true),
      get: sandbox.stub().returns({ id: 'plan-1', status: 'failed' }),
      getStatus: sandbox.stub().returns({ status: 'failed' }),
    };

    mockDialog = {
      showInfo: sandbox.stub(),
      showWarning: sandbox.stub(),
      showError: sandbox.stub(),
    };

    bulkActions = new BulkPlanActions(mockPlanRunner);
  });

  teardown(() => {
    quiet.restore();
    sandbox.restore();
  });

  suite('executeBulkAction – retry', () => {
    test('retry: plan found, resume succeeds', async () => {
      mockPlanRunner.get.returns({ id: 'plan-1' });
      mockPlanRunner.resume.resolves(true);

      const results = await bulkActions.executeBulkAction('retry', ['plan-1']);

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].success, true);
      assert.strictEqual(results[0].error, undefined);
      assert.ok(mockPlanRunner.get.calledWith('plan-1'));
      assert.ok(mockPlanRunner.resume.calledWith('plan-1'));
    });

    test('retry: plan found, resume fails', async () => {
      mockPlanRunner.get.returns({ id: 'plan-1' });
      mockPlanRunner.resume.resolves(false);

      const results = await bulkActions.executeBulkAction('retry', ['plan-1']);

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].success, false);
      assert.strictEqual(results[0].error, 'Retry failed');
    });

    test('retry: plan not found returns plan-not-found error', async () => {
      mockPlanRunner.get.returns(undefined);

      const results = await bulkActions.executeBulkAction('retry', ['plan-999']);

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].success, false);
      assert.strictEqual(results[0].error, 'Plan not found');
      // resume should NOT be called
      assert.ok(mockPlanRunner.resume.notCalled);
    });

    test('retry: handles multiple plan IDs with mixed found/not-found', async () => {
      mockPlanRunner.get
        .onFirstCall().returns({ id: 'plan-1' })
        .onSecondCall().returns(undefined)
        .onThirdCall().returns({ id: 'plan-3' });
      mockPlanRunner.resume
        .onFirstCall().resolves(true)
        .onSecondCall().resolves(true);

      const results = await bulkActions.executeBulkAction('retry', ['plan-1', 'plan-2', 'plan-3']);

      assert.strictEqual(results.length, 3);
      assert.strictEqual(results[0].success, true);
      assert.strictEqual(results[1].success, false);
      assert.strictEqual(results[1].error, 'Plan not found');
      assert.strictEqual(results[2].success, true);
    });

    test('retry: handles exception thrown by resume', async () => {
      mockPlanRunner.get.returns({ id: 'plan-1' });
      mockPlanRunner.resume.rejects(new Error('resume crashed'));

      const results = await bulkActions.executeBulkAction('retry', ['plan-1']);

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].success, false);
      assert.ok(results[0].error?.includes('resume crashed'));
    });
  });

  suite('executeBulkAction – finalize coverage', () => {
    test('finalize: returns error for each plan without planRepository', async () => {
      const results = await bulkActions.executeBulkAction('finalize', ['plan-a', 'plan-b']);

      assert.strictEqual(results.length, 2);
      results.forEach(r => {
        assert.strictEqual(r.success, false);
        assert.ok(r.error?.includes('not found') || r.error?.includes('PlanRepository'));
      });
    });
  });

  suite('executeBulkAction – exception handling', () => {
    test('exception in delete is caught and recorded per plan', async () => {
      mockPlanRunner.delete
        .onFirstCall().throws(new Error('delete exploded'))
        .onSecondCall().returns(true);

      const results = await bulkActions.executeBulkAction('delete', ['plan-1', 'plan-2']);

      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].success, false);
      assert.ok(results[0].error?.includes('delete exploded'));
      assert.strictEqual(results[1].success, true);
    });

    test('exception in cancel is caught per plan', async () => {
      mockPlanRunner.cancel.throws(new Error('cancel error'));

      const results = await bulkActions.executeBulkAction('cancel', ['plan-1']);

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].success, false);
      assert.ok(results[0].error?.includes('cancel error'));
    });
  });

  suite('getValidActions – status edge cases', () => {
    test('pending-start status enables cancel only', () => {
      mockPlanRunner.get.returns({ id: 'plan-1' });
      mockPlanRunner.getStatus.returns({ status: 'pending-start' });

      const actions = bulkActions.getValidActions(['plan-1']);

      assert.strictEqual(actions.get('cancel'), true);
      assert.strictEqual(actions.get('pause'), false);
      assert.strictEqual(actions.get('resume'), false);
      assert.strictEqual(actions.get('retry'), false);
    });

    test('pausing status enables cancel and pause', () => {
      mockPlanRunner.get.returns({ id: 'plan-1' });
      mockPlanRunner.getStatus.returns({ status: 'pausing' });

      const actions = bulkActions.getValidActions(['plan-1']);

      assert.strictEqual(actions.get('cancel'), true);
      assert.strictEqual(actions.get('pause'), true);
    });

    test('partial status enables retry', () => {
      mockPlanRunner.get.returns({ id: 'plan-1' });
      mockPlanRunner.getStatus.returns({ status: 'partial' });

      const actions = bulkActions.getValidActions(['plan-1']);

      assert.strictEqual(actions.get('retry'), true);
    });
  });
});
