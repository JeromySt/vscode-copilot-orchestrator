/**
 * @fileoverview Unit tests for PlanArchiver service
 * Tests plan archiving functionality including worktree cleanup,
 * branch deletion, and status validation.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { PlanArchiver } from '../../../plan/planArchiver';

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

suite('PlanArchiver', () => {
  let sandbox: sinon.SinonSandbox;
  let mockPlanRunner: any;
  let mockPlanRepo: any;
  let mockGit: any;
  let archiver: PlanArchiver;

  setup(() => {
    sandbox = sinon.createSandbox();
    
    mockPlanRunner = {
      get: sandbox.stub(),
      getStatus: sandbox.stub(),
      getAll: sandbox.stub(),
    };
    
    mockPlanRepo = {
      saveState: sandbox.stub().resolves(),
    };
    
    mockGit = {
      worktrees: {
        isValid: sandbox.stub().resolves(true),
        removeSafe: sandbox.stub().resolves(true),
        prune: sandbox.stub().resolves(),
      },
      branches: {
        exists: sandbox.stub().resolves(true),
        isDefaultBranch: sandbox.stub().resolves(false),
        deleteLocal: sandbox.stub().resolves(true),
        remoteExists: sandbox.stub().resolves(false),
        deleteRemote: sandbox.stub().resolves(true),
      },
    };
    
    archiver = new PlanArchiver(mockPlanRunner, mockPlanRepo, mockGit);
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('canArchive', () => {
    test('returns true for succeeded plans', () => {
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      assert.strictEqual(archiver.canArchive('plan-1'), true);
    });

    test('returns true for partial plans', () => {
      mockPlanRunner.getStatus.returns({ status: 'partial' });
      assert.strictEqual(archiver.canArchive('plan-1'), true);
    });

    test('returns true for canceled plans', () => {
      mockPlanRunner.getStatus.returns({ status: 'canceled' });
      assert.strictEqual(archiver.canArchive('plan-1'), true);
    });

    test('returns true for failed plans', () => {
      mockPlanRunner.getStatus.returns({ status: 'failed' });
      assert.strictEqual(archiver.canArchive('plan-1'), true);
    });

    test('returns false for running plans', () => {
      mockPlanRunner.getStatus.returns({ status: 'running' });
      assert.strictEqual(archiver.canArchive('plan-1'), false);
    });

    test('returns false for paused plans', () => {
      mockPlanRunner.getStatus.returns({ status: 'paused' });
      assert.strictEqual(archiver.canArchive('plan-1'), false);
    });

    test('returns false for scaffolding plans', () => {
      mockPlanRunner.getStatus.returns({ status: 'scaffolding' });
      assert.strictEqual(archiver.canArchive('plan-1'), false);
    });

    test('returns false for already archived plans', () => {
      mockPlanRunner.getStatus.returns({ status: 'archived' });
      assert.strictEqual(archiver.canArchive('plan-1'), false);
    });

    test('returns false for non-existent plans (getStatus returns undefined)', () => {
      mockPlanRunner.getStatus.returns(undefined);
      assert.strictEqual(archiver.canArchive('plan-1'), false);
    });
  });

  suite('_markAsArchived', () => {
    test('persists archivedAt timestamp and stateHistory entry via saveState', async () => {
      const plan = makeMockPlan();
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      mockGit.branches.exists.resolves(false);

      const result = await archiver.archive('plan-1');

      assert.strictEqual(result.success, true);
      // archivedAt must be set on the plan
      assert.ok(typeof plan.archivedAt === 'number', 'archivedAt should be a timestamp');
      // stateHistory should include an 'archived' entry
      const archivedEntry = plan.stateHistory.find((e: any) => e.to === 'archived');
      assert.ok(archivedEntry, 'stateHistory should contain archived transition');
      assert.strictEqual(archivedEntry.reason, 'user-archived');
      // saveState must have been called to persist
      assert.ok(mockPlanRepo.saveState.calledOnce, 'saveState should be called once');
      assert.ok(mockPlanRepo.saveState.calledWith(plan), 'saveState should be called with the plan');
    });

    test('initializes stateHistory when undefined before adding archived entry', async () => {
      const plan = makeMockPlan();
      delete plan.stateHistory; // Remove to trigger lazy-init
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      mockGit.branches.exists.resolves(false);

      await archiver.archive('plan-1');

      assert.ok(Array.isArray(plan.stateHistory), 'stateHistory should be initialized');
      assert.strictEqual(plan.stateHistory.length, 1);
    });
  });

  suite('archive', () => {
    test('returns error for non-existent plan', async () => {
      mockPlanRunner.get.returns(undefined);
      const result = await archiver.archive('nonexistent');
      
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'Plan not found');
      assert.strictEqual(result.cleanedWorktrees.length, 0);
      assert.strictEqual(result.cleanedBranches.length, 0);
    });

    test('returns error for non-archivable status', async () => {
      const plan = makeMockPlan();
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'running' });
      
      const result = await archiver.archive('plan-1');
      
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('running'));
      assert.ok(result.error?.includes('does not support archiving'));
    });

    test('removes all valid worktrees for plan jobs', async () => {
      const plan = makeMockPlan();
      plan.jobs.set('node-1', { id: 'node-1', name: 'Job 1' });
      plan.jobs.set('node-2', { id: 'node-2', name: 'Job 2' });
      plan.nodeStates.set('node-1', { worktreePath: '/repo/.worktrees/plan-1/node-1' });
      plan.nodeStates.set('node-2', { worktreePath: '/repo/.worktrees/plan-1/node-2' });
      
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      
      const result = await archiver.archive('plan-1');
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.cleanedWorktrees.length, 2);
      assert.ok(mockGit.worktrees.removeSafe.calledTwice);
    });

    test('deletes local target branch', async () => {
      const plan = makeMockPlan();
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      
      const result = await archiver.archive('plan-1');
      
      assert.strictEqual(result.success, true);
      assert.ok(mockGit.branches.deleteLocal.calledWith('/repo', 'copilot_plan/test'));
      assert.ok(result.cleanedBranches.includes('copilot_plan/test'));
    });

    test('does not delete default branch', async () => {
      const plan = makeMockPlan();
      plan.targetBranch = 'main';
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      mockGit.branches.isDefaultBranch.resolves(true);
      
      const result = await archiver.archive('plan-1');
      
      assert.strictEqual(result.success, true);
      assert.ok(mockGit.branches.deleteLocal.notCalled);
      assert.strictEqual(result.cleanedBranches.length, 0);
    });

    test('handles worktree removal failure gracefully', async () => {
      const plan = makeMockPlan();
      plan.jobs.set('node-1', { id: 'node-1', name: 'Job 1' });
      plan.nodeStates.set('node-1', { worktreePath: '/repo/.worktrees/plan-1/node-1' });
      
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      mockGit.worktrees.removeSafe.rejects(new Error('Permission denied'));
      
      const result = await archiver.archive('plan-1');
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.cleanedWorktrees.length, 0);
    });

    test('handles branch deletion failure gracefully', async () => {
      const plan = makeMockPlan();
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      mockGit.branches.deleteLocal.rejects(new Error('Branch in use'));
      
      const result = await archiver.archive('plan-1');
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.cleanedBranches.length, 0);
    });

    test('marks plan as archived after cleanup', async () => {
      const plan = makeMockPlan();
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      
      await archiver.archive('plan-1');
      
      assert.ok(mockPlanRepo.saveState.calledOnce);
      assert.strictEqual(plan.stateHistory.length, 1);
      assert.strictEqual(plan.stateHistory[0].to, 'archived');
      assert.strictEqual(plan.stateHistory[0].reason, 'user-archived');
    });

    test('prunes worktree references after removal', async () => {
      const plan = makeMockPlan();
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      
      await archiver.archive('plan-1');
      
      assert.ok(mockGit.worktrees.prune.calledWith('/repo'));
    });

    test('optionally deletes remote branches', async () => {
      const plan = makeMockPlan();
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      mockGit.branches.remoteExists.resolves(true);
      
      await archiver.archive('plan-1', { deleteRemoteBranches: true });
      
      assert.ok(mockGit.branches.deleteRemote.calledWith('/repo', 'copilot_plan/test'));
    });

    test('logs structured context for each operation', async () => {
      const plan = makeMockPlan();
      plan.jobs.set('node-1', { id: 'node-1', name: 'Job 1' });
      plan.nodeStates.set('node-1', { worktreePath: '/repo/.worktrees/plan-1/node-1' });
      
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      
      await archiver.archive('plan-1');
      
      assert.ok(mockGit.worktrees.removeSafe.called);
      assert.ok(mockGit.branches.deleteLocal.called);
      assert.ok(mockPlanRepo.saveState.called);
    });

    test('returns correct cleanup counts', async () => {
      const plan = makeMockPlan();
      plan.jobs.set('node-1', { id: 'node-1', name: 'Job 1' });
      plan.jobs.set('node-2', { id: 'node-2', name: 'Job 2' });
      plan.nodeStates.set('node-1', { worktreePath: '/repo/.worktrees/plan-1/node-1' });
      plan.nodeStates.set('node-2', { worktreePath: '/repo/.worktrees/plan-1/node-2' });
      
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      
      const result = await archiver.archive('plan-1');
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.cleanedWorktrees.length, 2);
      assert.strictEqual(result.cleanedBranches.length, 1);
    });

    test('validates paths before git operations (security)', async () => {
      const plan = makeMockPlan();
      plan.jobs.set('node-1', { id: 'node-1', name: 'Job 1' });
      // Worktree path outside the repo (path traversal attempt)
      plan.nodeStates.set('node-1', { worktreePath: '/etc/passwd' });
      
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      
      const result = await archiver.archive('plan-1');
      
      // Should succeed but skip the dangerous worktree
      assert.strictEqual(result.success, true);
      assert.ok(mockGit.worktrees.removeSafe.notCalled);
    });

    test('passes force option to worktree removal', async () => {
      const plan = makeMockPlan();
      plan.jobs.set('node-1', { id: 'node-1', name: 'Job 1' });
      plan.nodeStates.set('node-1', { worktreePath: '/repo/.worktrees/plan-1/node-1' });
      
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      
      await archiver.archive('plan-1', { force: true });
      
      assert.ok(mockGit.worktrees.removeSafe.calledWith('/repo', sinon.match.string, { force: true }));
    });

    test('cleans up snapshot worktree if present', async () => {
      const plan = makeMockPlan();
      plan.snapshot = { 
        worktreePath: '/repo/.worktrees/plan-1/snapshot',
        branch: 'copilot_plan/test-snapshot'
      };
      
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      
      const result = await archiver.archive('plan-1');
      
      assert.strictEqual(result.success, true);
      assert.ok(result.cleanedWorktrees.includes('/repo/.worktrees/plan-1/snapshot'));
      assert.ok(mockGit.worktrees.removeSafe.calledWith('/repo', '/repo/.worktrees/plan-1/snapshot'));
    });

    test('cleans up snapshot branch if present', async () => {
      const plan = makeMockPlan();
      plan.snapshot = { 
        branch: 'copilot_plan/test-snapshot'
      };
      
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      
      const result = await archiver.archive('plan-1');
      
      assert.strictEqual(result.success, true);
      assert.ok(result.cleanedBranches.includes('copilot_plan/test-snapshot'));
      assert.ok(mockGit.branches.deleteLocal.calledWith('/repo', 'copilot_plan/test-snapshot', { force: true }));
    });

    test('skips worktree removal if not valid', async () => {
      const plan = makeMockPlan();
      plan.jobs.set('node-1', { id: 'node-1', name: 'Job 1' });
      plan.nodeStates.set('node-1', { worktreePath: '/repo/.worktrees/plan-1/node-1' });
      
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      mockGit.worktrees.isValid.resolves(false);
      
      const result = await archiver.archive('plan-1');
      
      assert.strictEqual(result.success, true);
      assert.ok(mockGit.worktrees.removeSafe.notCalled);
      assert.strictEqual(result.cleanedWorktrees.length, 0);
    });

    test('skips branch deletion if branch does not exist', async () => {
      const plan = makeMockPlan();
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      mockGit.branches.exists.resolves(false);
      
      const result = await archiver.archive('plan-1');
      
      assert.strictEqual(result.success, true);
      assert.ok(mockGit.branches.deleteLocal.notCalled);
      assert.strictEqual(result.cleanedBranches.length, 0);
    });

    test('uses derived worktree path when nodeState has no worktreePath', async () => {
      const plan = makeMockPlan();
      plan.jobs.set('node-1', { id: 'node-1', name: 'Job 1' });
      // nodeState exists but without worktreePath — falls through to _getWorktreePath
      plan.nodeStates.set('node-1', { status: 'succeeded' }); // no worktreePath
      
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      
      const result = await archiver.archive('plan-1');
      
      assert.strictEqual(result.success, true);
      // Should have tried to use the derived worktree path
      assert.ok(mockGit.worktrees.isValid.called);
    });

    test('uses derived worktree path when no nodeState at all', async () => {
      const plan = makeMockPlan();
      plan.jobs.set('node-1', { id: 'node-1', name: 'Job 1' });
      // No nodeState entry for node-1
      
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      
      const result = await archiver.archive('plan-1');
      
      assert.strictEqual(result.success, true);
      assert.ok(mockGit.worktrees.isValid.called);
    });

    test('initializes stateHistory when plan has no stateHistory', async () => {
      const plan = makeMockPlan();
      delete plan.stateHistory; // Remove stateHistory to trigger initialization
      
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      
      await archiver.archive('plan-1');
      
      // stateHistory should have been initialized and populated
      assert.ok(Array.isArray(plan.stateHistory));
      assert.strictEqual(plan.stateHistory.length, 1);
      assert.strictEqual(plan.stateHistory[0].to, 'archived');
    });

    test('does not delete remote default branch', async () => {
      const plan = makeMockPlan();
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      mockGit.branches.remoteExists.resolves(true);
      mockGit.branches.isDefaultBranch.resolves(true); // Both local and remote are default
      
      await archiver.archive('plan-1', { deleteRemoteBranches: true });
      
      assert.ok(mockGit.branches.deleteRemote.notCalled);
    });

    test('skips remote deletion if remote branch does not exist', async () => {
      const plan = makeMockPlan();
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      mockGit.branches.remoteExists.resolves(false);
      
      await archiver.archive('plan-1', { deleteRemoteBranches: true });
      
      assert.ok(mockGit.branches.deleteRemote.notCalled);
    });

    test('handles prune failure gracefully', async () => {
      const plan = makeMockPlan();
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      mockGit.worktrees.prune.rejects(new Error('Prune failed'));
      
      const result = await archiver.archive('plan-1');
      
      assert.strictEqual(result.success, true);
    });

    test('plan with relative worktreeRoot uses repoPath as base', async () => {
      const plan = makeMockPlan();
      plan.worktreeRoot = '.custom-worktrees'; // relative path
      plan.jobs.set('node-1', { id: 'node-1', name: 'Job 1' });
      plan.nodeStates.set('node-1', { worktreePath: '/repo/.custom-worktrees/plan-1/node-1' });
      
      mockPlanRunner.get.returns(plan);
      mockPlanRunner.getStatus.returns({ status: 'succeeded' });
      
      const result = await archiver.archive('plan-1');
      
      assert.strictEqual(result.success, true);
    });
  });

  suite('getArchivedPlans', () => {
    test('returns only archived plans', () => {
      const plan1 = makeMockPlan({ id: 'plan-1' });
      const plan2 = makeMockPlan({ id: 'plan-2' });
      const plan3 = makeMockPlan({ id: 'plan-3' });
      
      mockPlanRunner.getAll.returns([plan1, plan2, plan3]);
      mockPlanRunner.getStatus.withArgs('plan-1').returns({ status: 'archived' });
      mockPlanRunner.getStatus.withArgs('plan-2').returns({ status: 'succeeded' });
      mockPlanRunner.getStatus.withArgs('plan-3').returns({ status: 'archived' });
      
      const result = archiver.getArchivedPlans();
      
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].id, 'plan-1');
      assert.strictEqual(result[1].id, 'plan-3');
    });

    test('returns empty array when no archived plans', () => {
      mockPlanRunner.getAll.returns([]);
      const result = archiver.getArchivedPlans();
      
      assert.strictEqual(result.length, 0);
    });
  });

  suite('isArchived', () => {
    test('returns true for archived plans', () => {
      mockPlanRunner.getStatus.returns({ status: 'archived' });
      assert.strictEqual(archiver.isArchived('plan-1'), true);
    });

    test('returns false for active plans', () => {
      mockPlanRunner.getStatus.returns({ status: 'running' });
      assert.strictEqual(archiver.isArchived('plan-1'), false);
    });
  });
});
