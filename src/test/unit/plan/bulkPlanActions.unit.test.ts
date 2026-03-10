/**
 * @fileoverview Unit tests for BulkPlanActions
 * 
 * @module test/unit/plan/bulkPlanActions
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { BulkPlanActions } from '../../../plan/bulkPlanActions';

suite('BulkPlanActions', () => {
  let sandbox: sinon.SinonSandbox;
  let bulkActions: BulkPlanActions;
  let mockPlanRunner: any;
  let mockDialog: any;

  setup(() => {
    sandbox = sinon.createSandbox();
    
    mockPlanRunner = {
      delete: sandbox.stub().returns(true),
      cancel: sandbox.stub().returns(true),
      pause: sandbox.stub().returns(true),
      resume: sandbox.stub().resolves(true),
      get: sandbox.stub(),
      getStatus: sandbox.stub(),
    };
    
    mockDialog = {
      showInfo: sandbox.stub(),
      showWarning: sandbox.stub(),
      showError: sandbox.stub(),
    };
    
    bulkActions = new BulkPlanActions(mockPlanRunner);
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('executeBulkAction', () => {
    test('delete: calls planRunner.delete for each plan', async () => {
      const planIds = ['plan1', 'plan2', 'plan3'];
      
      const results = await bulkActions.executeBulkAction('delete', planIds);

      assert.strictEqual(results.length, 3);
      assert.strictEqual(mockPlanRunner.delete.callCount, 3);
      assert.ok(mockPlanRunner.delete.calledWith('plan1'));
      assert.ok(mockPlanRunner.delete.calledWith('plan2'));
      assert.ok(mockPlanRunner.delete.calledWith('plan3'));
      
      results.forEach(r => {
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.error, undefined);
      });
    });

    test('cancel: calls planRunner.cancel for each plan', async () => {
      const planIds = ['plan1', 'plan2'];
      
      const results = await bulkActions.executeBulkAction('cancel', planIds);

      assert.strictEqual(results.length, 2);
      assert.strictEqual(mockPlanRunner.cancel.callCount, 2);
      assert.ok(mockPlanRunner.cancel.calledWith('plan1'));
      assert.ok(mockPlanRunner.cancel.calledWith('plan2'));
      
      results.forEach(r => {
        assert.strictEqual(r.success, true);
      });
    });

    test('pause: calls planRunner.pause for each plan', async () => {
      const planIds = ['plan1', 'plan2'];
      
      const results = await bulkActions.executeBulkAction('pause', planIds);

      assert.strictEqual(results.length, 2);
      assert.strictEqual(mockPlanRunner.pause.callCount, 2);
      assert.ok(mockPlanRunner.pause.calledWith('plan1'));
      assert.ok(mockPlanRunner.pause.calledWith('plan2'));
      
      results.forEach(r => {
        assert.strictEqual(r.success, true);
      });
    });

    test('resume: calls planRunner.resume for each plan', async () => {
      const planIds = ['plan1', 'plan2'];
      
      const results = await bulkActions.executeBulkAction('resume', planIds);

      assert.strictEqual(results.length, 2);
      assert.strictEqual(mockPlanRunner.resume.callCount, 2);
      assert.ok(mockPlanRunner.resume.calledWith('plan1'));
      assert.ok(mockPlanRunner.resume.calledWith('plan2'));
      
      results.forEach(r => {
        assert.strictEqual(r.success, true);
      });
    });

    test('continues processing after individual failure', async () => {
      mockPlanRunner.delete.onFirstCall().returns(true);
      mockPlanRunner.delete.onSecondCall().returns(false);
      mockPlanRunner.delete.onThirdCall().returns(true);
      
      const planIds = ['plan1', 'plan2', 'plan3'];
      const results = await bulkActions.executeBulkAction('delete', planIds);

      assert.strictEqual(results.length, 3);
      assert.strictEqual(mockPlanRunner.delete.callCount, 3);
      
      assert.strictEqual(results[0].success, true);
      assert.strictEqual(results[1].success, false);
      assert.strictEqual(results[1].error, 'Delete failed');
      assert.strictEqual(results[2].success, true);
    });

    test('returns results for each plan', async () => {
      const planIds = ['plan1', 'plan2'];
      mockPlanRunner.delete.onFirstCall().returns(true);
      mockPlanRunner.delete.onSecondCall().returns(false);
      
      const results = await bulkActions.executeBulkAction('delete', planIds);

      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].planId, 'plan1');
      assert.strictEqual(results[0].success, true);
      assert.strictEqual(results[1].planId, 'plan2');
      assert.strictEqual(results[1].success, false);
      assert.strictEqual(results[1].error, 'Delete failed');
    });

    test('logs structured context for each operation', async () => {
      const planIds = ['plan1', 'plan2'];
      
      await bulkActions.executeBulkAction('delete', planIds);

      // Verify all operations completed (no exceptions thrown)
      assert.strictEqual(mockPlanRunner.delete.callCount, 2);
    });

    test('finalize: reports not supported in bulk', async () => {
      const planIds = ['plan1', 'plan2'];
      
      const results = await bulkActions.executeBulkAction('finalize', planIds);

      assert.strictEqual(results.length, 2);
      results.forEach(r => {
        assert.strictEqual(r.success, false);
        assert.ok(r.error?.includes('Finalize not supported'));
      });
    });

    test('handles errors thrown by planRunner methods', async () => {
      mockPlanRunner.delete.onFirstCall().throws(new Error('Storage error'));
      mockPlanRunner.delete.onSecondCall().returns(true);
      
      const planIds = ['plan1', 'plan2'];
      const results = await bulkActions.executeBulkAction('delete', planIds);

      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].success, false);
      assert.ok(results[0].error?.includes('Storage error'));
      assert.strictEqual(results[1].success, true);
    });
  });

  suite('getValidActions', () => {
    test('delete is always valid', () => {
      mockPlanRunner.get.returns({ id: 'plan1' });
      mockPlanRunner.getStatus.returns({ status: 'scaffolding' });
      
      const actions = bulkActions.getValidActions(['plan1']);

      assert.strictEqual(actions.get('delete'), true);
    });

    test('cancel is valid when any plan is running', () => {
      mockPlanRunner.get.onFirstCall().returns({ id: 'plan1' });
      mockPlanRunner.get.onSecondCall().returns({ id: 'plan2' });
      mockPlanRunner.getStatus.onFirstCall().returns({ status: 'running' });
      mockPlanRunner.getStatus.onSecondCall().returns({ status: 'paused' });
      
      const actions = bulkActions.getValidActions(['plan1', 'plan2']);

      assert.strictEqual(actions.get('cancel'), true);
    });

    test('pause is valid when any plan is running', () => {
      mockPlanRunner.get.onFirstCall().returns({ id: 'plan1' });
      mockPlanRunner.get.onSecondCall().returns({ id: 'plan2' });
      mockPlanRunner.getStatus.onFirstCall().returns({ status: 'running' });
      mockPlanRunner.getStatus.onSecondCall().returns({ status: 'paused' });
      
      const actions = bulkActions.getValidActions(['plan1', 'plan2']);

      assert.strictEqual(actions.get('pause'), true);
    });

    test('resume is valid when any plan is paused', () => {
      mockPlanRunner.get.onFirstCall().returns({ id: 'plan1' });
      mockPlanRunner.get.onSecondCall().returns({ id: 'plan2' });
      mockPlanRunner.getStatus.onFirstCall().returns({ status: 'running' });
      mockPlanRunner.getStatus.onSecondCall().returns({ status: 'paused' });
      
      const actions = bulkActions.getValidActions(['plan1', 'plan2']);

      assert.strictEqual(actions.get('resume'), true);
    });

    test('handles mixed plan states correctly', () => {
      mockPlanRunner.get.onCall(0).returns({ id: 'plan1' });
      mockPlanRunner.get.onCall(1).returns({ id: 'plan2' });
      mockPlanRunner.get.onCall(2).returns({ id: 'plan3' });
      mockPlanRunner.get.onCall(3).returns({ id: 'plan4' });
      
      mockPlanRunner.getStatus.onCall(0).returns({ status: 'running' });
      mockPlanRunner.getStatus.onCall(1).returns({ status: 'paused' });
      mockPlanRunner.getStatus.onCall(2).returns({ status: 'failed' });
      mockPlanRunner.getStatus.onCall(3).returns({ status: 'scaffolding' });
      
      const actions = bulkActions.getValidActions(['plan1', 'plan2', 'plan3', 'plan4']);

      assert.strictEqual(actions.get('delete'), true);
      assert.strictEqual(actions.get('cancel'), true); // has running
      assert.strictEqual(actions.get('pause'), true); // has running
      assert.strictEqual(actions.get('resume'), true); // has paused
      assert.strictEqual(actions.get('retry'), true); // has failed
      assert.strictEqual(actions.get('finalize'), true); // has scaffolding
    });

    test('cancel is valid when any plan is pending', () => {
      mockPlanRunner.get.returns({ id: 'plan1' });
      mockPlanRunner.getStatus.returns({ status: 'pending' });
      
      const actions = bulkActions.getValidActions(['plan1']);
      
      assert.strictEqual(actions.get('cancel'), true);
    });

    test('cancel is valid when any plan is pending-start', () => {
      mockPlanRunner.get.returns({ id: 'plan1' });
      mockPlanRunner.getStatus.returns({ status: 'pending-start' });
      
      const actions = bulkActions.getValidActions(['plan1']);
      
      assert.strictEqual(actions.get('cancel'), true);
    });

    test('retry is valid when any plan has partial status', () => {
      mockPlanRunner.get.returns({ id: 'plan1' });
      mockPlanRunner.getStatus.returns({ status: 'partial' });
      
      const actions = bulkActions.getValidActions(['plan1']);
      
      assert.strictEqual(actions.get('retry'), true);
    });

    test('skips plans that do not exist in runner', () => {
      mockPlanRunner.get.returns(undefined);
      
      const actions = bulkActions.getValidActions(['plan1', 'plan2']);
      
      assert.strictEqual(actions.get('delete'), true);
      assert.strictEqual(actions.get('cancel'), false);
      assert.strictEqual(actions.get('pause'), false);
      assert.strictEqual(actions.get('resume'), false);
    });

    test('pending-start status sets hasPending true', () => {
      mockPlanRunner.get.returns({ id: 'plan1' });
      mockPlanRunner.getStatus.returns({ status: 'pending-start' });

      const actions = bulkActions.getValidActions(['plan1']);

      assert.strictEqual(actions.get('cancel'), true);
      assert.strictEqual(actions.get('pause'), false);
      assert.strictEqual(actions.get('resume'), false);
    });

    test('pausing status is treated as running', () => {
      mockPlanRunner.get.returns({ id: 'plan1' });
      mockPlanRunner.getStatus.returns({ status: 'pausing' });

      const actions = bulkActions.getValidActions(['plan1']);

      assert.strictEqual(actions.get('pause'), true);
      assert.strictEqual(actions.get('cancel'), true);
    });

    test('skips plans that have no status info', () => {
      mockPlanRunner.get.returns({ id: 'plan1' });
      mockPlanRunner.getStatus.returns(undefined);
      
      const actions = bulkActions.getValidActions(['plan1']);
      
      assert.strictEqual(actions.get('delete'), true);
      assert.strictEqual(actions.get('cancel'), false);
    });
  });
});
