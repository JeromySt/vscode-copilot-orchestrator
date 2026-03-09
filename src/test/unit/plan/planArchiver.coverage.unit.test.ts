/**
 * @fileoverview Coverage tests for PlanArchiver.
 * Covers: _getStatus null return (line 260), _getWorktreePath absolute path (272),
 * _markAsArchived plan-not-found path (284-285).
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { PlanArchiver } from '../../../plan/planArchiver';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function makeMockPlan(overrides?: Record<string, any>): any {
  return {
    id: 'plan-1',
    spec: {
      name: 'Test Plan',
      repoPath: '/repo',
      worktreeRoot: '/repo/.worktrees',
      targetBranch: 'copilot_plan/test',
    },
    repoPath: '/repo',
    worktreeRoot: '/repo/.worktrees',
    targetBranch: 'copilot_plan/test',
    baseBranch: 'main',
    jobs: new Map(),
    nodeStates: new Map(),
    stateHistory: [],
    ...overrides,
  };
}

suite('PlanArchiver coverage', () => {
  let sandbox: sinon.SinonSandbox;
  let quiet: { restore: () => void };
  let mockPlanRunner: any;
  let mockPlanRepo: any;
  let mockGit: any;
  let archiver: PlanArchiver;

  setup(() => {
    sandbox = sinon.createSandbox();
    quiet = silenceConsole();

    mockPlanRunner = {
      get: sandbox.stub(),
      getStatus: sandbox.stub(),
      getAll: sandbox.stub().returns([]),
    };

    mockPlanRepo = {
      saveState: sandbox.stub().resolves(),
    };

    mockGit = {
      worktrees: {
        isValid: sandbox.stub().resolves(false),
        removeSafe: sandbox.stub().resolves(true),
        prune: sandbox.stub().resolves(),
      },
      branches: {
        exists: sandbox.stub().resolves(false),
        isDefaultBranch: sandbox.stub().resolves(false),
        deleteLocal: sandbox.stub().resolves(true),
        remoteExists: sandbox.stub().resolves(false),
        deleteRemote: sandbox.stub().resolves(true),
      },
    };

    archiver = new PlanArchiver(mockPlanRunner, mockPlanRepo, mockGit);
  });

  teardown(() => {
    quiet.restore();
    sandbox.restore();
  });

  // ── _getStatus null return (line 260) ─────────────────────────────────────

  suite('_getStatus null/undefined statusInfo', () => {
    test('canArchive returns true when getStatus returns undefined (treated as canceled)', () => {
      mockPlanRunner.getStatus.returns(undefined);

      // 'canceled' is in the archivable set, so should return true
      const result = archiver.canArchive('plan-x');

      assert.strictEqual(result, true);
    });

    test('isArchived returns false when getStatus returns undefined (treated as canceled)', () => {
      mockPlanRunner.getStatus.returns(undefined);

      const result = archiver.isArchived('plan-x');

      assert.strictEqual(result, false);
    });

    test('getArchivedPlans excludes plans with undefined status (treated as canceled)', () => {
      const plan1 = makeMockPlan({ id: 'plan-1' });
      const plan2 = makeMockPlan({ id: 'plan-2' });

      mockPlanRunner.getAll.returns([plan1, plan2]);
      // plan-1 has status undefined → treated as 'canceled' → not 'archived'
      mockPlanRunner.getStatus.withArgs('plan-1').returns(undefined);
      // plan-2 has status 'archived'
      mockPlanRunner.getStatus.withArgs('plan-2').returns({ status: 'archived' });

      const result = archiver.getArchivedPlans();

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, 'plan-2');
    });
  });

  // ── _getWorktreePath (lines 269-274) ──────────────────────────────────────

  suite('_getWorktreePath', () => {
    test('uses absolute worktreeRoot directly without joining repoPath', () => {
      const plan = makeMockPlan({
        worktreeRoot: '/absolute/worktrees',
        spec: { repoPath: '/repo', worktreeRoot: '/absolute/worktrees', targetBranch: 'copilot_plan/test', name: 'Test', status: 'succeeded' },
      });

      const result: string = (archiver as any)._getWorktreePath(plan, 'node-1');

      // Absolute worktreeRoot should be used directly as base
      const pathModule = require('path');
      const expected = pathModule.join('/absolute/worktrees', 'plan-1', 'node-1');
      assert.strictEqual(result, expected);
    });

    test('uses relative worktreeRoot joined with repoPath', () => {
      const plan = makeMockPlan({
        worktreeRoot: '.custom-worktrees',
        spec: { repoPath: '/repo', worktreeRoot: '.custom-worktrees', targetBranch: 'copilot_plan/test', name: 'Test', status: 'succeeded' },
      });

      const result: string = (archiver as any)._getWorktreePath(plan, 'node-1');

      // Use path.join (not path.resolve) to match platform-consistent path building
      const pathModule = require('path');
      const expected = pathModule.join('/repo', '.custom-worktrees', 'plan-1', 'node-1');
      assert.strictEqual(result, expected);
    });

    test('falls back to spec.worktreeRoot when plan.worktreeRoot is undefined', () => {
      const plan = makeMockPlan({
        worktreeRoot: undefined,
        spec: { repoPath: '/repo', worktreeRoot: '.spec-worktrees', targetBranch: 'copilot_plan/test', name: 'Test', status: 'succeeded' },
      });

      const result: string = (archiver as any)._getWorktreePath(plan, 'node-1');

      // When plan.worktreeRoot is undefined, falls to spec.worktreeRoot
      assert.ok(result.includes('node-1'));
    });

    test('falls back to .worktrees default when neither plan nor spec has worktreeRoot', () => {
      const plan = makeMockPlan({
        worktreeRoot: undefined,
        spec: { repoPath: '/repo', worktreeRoot: undefined, targetBranch: 'copilot_plan/test', name: 'Test', status: 'succeeded' },
      });

      const result: string = (archiver as any)._getWorktreePath(plan, 'node-1');

      assert.ok(result.includes('node-1'));
      assert.ok(result.includes('.worktrees'));
    });

    test('uses plan.repoPath fallback when spec.repoPath is not set', () => {
      const plan = makeMockPlan({
        repoPath: '/fallback-repo',
        spec: { repoPath: undefined, worktreeRoot: '.worktrees', targetBranch: 'copilot_plan/test', name: 'Test', status: 'succeeded' },
      });

      const result: string = (archiver as any)._getWorktreePath(plan, 'node-99');

      assert.ok(result.includes('node-99'));
    });
  });

  // ── _markAsArchived plan-not-found path (lines 284-285) ──────────────────

  suite('_markAsArchived error path', () => {
    test('archive catches error when _markAsArchived plan.get returns undefined on second call', async () => {
      const plan = makeMockPlan();
      // First call (in archive()): returns plan
      // Second call (in _markAsArchived): returns undefined → throws Error
      mockPlanRunner.get
        .onFirstCall().returns(plan)
        .onSecondCall().returns(undefined);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      mockGit.branches.exists.resolves(false);

      const result = await archiver.archive('plan-1');

      // The error from _markAsArchived is caught by the try/catch in archive()
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('not found') || result.error !== undefined);
    });
  });

  // ── stateHistory initialization (lines 288-290) ──────────────────────────

  suite('stateHistory initialization', () => {
    test('initializes stateHistory when it is undefined on plan', async () => {
      const plan = makeMockPlan();
      delete plan.stateHistory; // Remove to trigger initialization

      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      mockGit.branches.exists.resolves(false);

      await archiver.archive('plan-1');

      assert.ok(Array.isArray(plan.stateHistory));
      assert.strictEqual(plan.stateHistory.length, 1);
      assert.strictEqual(plan.stateHistory[0].to, 'archived');
    });
  });

  // ── archive catches error from saveState ─────────────────────────────────

  suite('archive error from saveState', () => {
    test('archive returns success=false when saveState throws', async () => {
      const plan = makeMockPlan();
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      mockGit.branches.exists.resolves(false);
      mockPlanRepo.saveState.rejects(new Error('disk full'));

      const result = await archiver.archive('plan-1');

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('disk full'));
    });
  });

  // ── Snapshot worktree removal failure (lines 139-145) ────────────────────

  suite('snapshot worktree removal failure', () => {
    test('handles snapshot worktree removeSafe failure gracefully (lines 139-145)', async () => {
      const plan = makeMockPlan();
      plan.snapshot = {
        worktreePath: '/repo/.worktrees/plan-1/snapshot',
        branch: undefined,
      };

      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      mockGit.worktrees.isValid.resolves(true);
      mockGit.worktrees.removeSafe.rejects(new Error('snapshot worktree locked'));
      mockGit.branches.exists.resolves(false);

      const result = await archiver.archive('plan-1');

      // Should succeed even though snapshot worktree removal failed
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.cleanedWorktrees.length, 0);
    });
  });

  // ── Snapshot branch deletion failure (lines 193-194) ─────────────────────

  suite('snapshot branch deletion failure', () => {
    test('handles snapshot branch deleteLocal failure gracefully (lines 193-194)', async () => {
      const plan = makeMockPlan();
      plan.snapshot = {
        branch: 'copilot_plan/test-snapshot',
      };

      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      // Regular target branch deletion works fine
      mockGit.branches.exists.callsFake((branch: string) => {
        return Promise.resolve(true);
      });
      mockGit.branches.deleteLocal.callsFake((_repoPath: string, branch: string) => {
        if (branch === 'copilot_plan/test-snapshot') {
          return Promise.reject(new Error('snapshot branch in use'));
        }
        return Promise.resolve(true);
      });

      const result = await archiver.archive('plan-1');

      // Should succeed even though snapshot branch deletion failed
      assert.strictEqual(result.success, true);
      // The target branch should still be cleaned up
      assert.ok(result.cleanedBranches.includes('copilot_plan/test'));
      // But not the snapshot branch
      assert.ok(!result.cleanedBranches.includes('copilot_plan/test-snapshot'));
    });
  });

  // ── Remote branch deletion failure (lines 212-213) ───────────────────────

  suite('remote branch deletion failure', () => {
    test('handles deleteRemote failure gracefully (lines 212-213)', async () => {
      const plan = makeMockPlan();

      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      mockGit.branches.exists.resolves(false);
      mockGit.branches.remoteExists.resolves(true);
      mockGit.branches.deleteRemote.rejects(new Error('remote branch locked'));

      const result = await archiver.archive('plan-1', { deleteRemoteBranches: true });

      // Should succeed even though remote branch deletion failed
      assert.strictEqual(result.success, true);
    });
  });
});
