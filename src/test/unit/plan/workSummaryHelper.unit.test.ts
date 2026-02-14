/**
 * @fileoverview Unit tests for workSummaryHelper - covers computeWorkSummary & computeAggregatedWorkSummary
 */
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as git from '../../../git';
import { computeWorkSummary, computeAggregatedWorkSummary } from '../../../plan/workSummaryHelper';
import type { JobNode } from '../../../plan/types';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function makeJobNode(opts?: Partial<JobNode>): JobNode {
  return {
    id: 'node-1', producerId: 'node-1', name: 'Test Job', type: 'job',
    task: 'test task', dependencies: [], dependents: [], ...opts,
  };
}

suite('workSummaryHelper', () => {
  let quiet: { restore: () => void };
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    quiet = silenceConsole();
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    quiet.restore();
    sandbox.restore();
  });

  suite('computeWorkSummary', () => {
    test('returns empty summary on getHeadCommit failure', async () => {
      sandbox.stub(git.worktrees, 'getHeadCommit').resolves(undefined);
      const result = await computeWorkSummary(makeJobNode(), '/wt', 'abc123');
      assert.strictEqual(result.commits, 0);
      assert.strictEqual(result.nodeId, 'node-1');
    });

    test('returns expectsNoChanges summary when head === base and expectsNoChanges', async () => {
      sandbox.stub(git.worktrees, 'getHeadCommit').resolves('abc123');
      const node = makeJobNode({ expectsNoChanges: true });
      const result = await computeWorkSummary(node, '/wt', 'abc123');
      assert.ok(result.description!.includes('expectsNoChanges'));
      assert.strictEqual(result.commits, 0);
    });

    test('returns empty summary when head === base without expectsNoChanges', async () => {
      sandbox.stub(git.worktrees, 'getHeadCommit').resolves('abc123');
      const result = await computeWorkSummary(makeJobNode(), '/wt', 'abc123');
      assert.strictEqual(result.commits, 0);
    });

    test('computes summary with diff stats', async () => {
      sandbox.stub(git.worktrees, 'getHeadCommit').resolves('def456');
      sandbox.stub(git.repository, 'getFileChangesBetween').resolves([
        { status: 'added', path: 'new-file.ts' },
        { status: 'modified', path: 'existing.ts' },
        { status: 'deleted', path: 'old.ts' },
      ]);
      const result = await computeWorkSummary(makeJobNode(), '/wt', 'abc123');
      assert.strictEqual(result.commits, 1);
      assert.strictEqual(result.filesAdded, 1);
      assert.strictEqual(result.filesModified, 1);
      assert.strictEqual(result.filesDeleted, 1);
    });

    test('handles diff failure gracefully', async () => {
      sandbox.stub(git.worktrees, 'getHeadCommit').resolves('def456');
      sandbox.stub(git.repository, 'getFileChangesBetween').resolves([]);
      const result = await computeWorkSummary(makeJobNode(), '/wt', 'abc123');
      assert.strictEqual(result.commits, 0);
    });

    test('catches and returns empty on exception', async () => {
      sandbox.stub(git.worktrees, 'getHeadCommit').rejects(new Error('git error'));
      const result = await computeWorkSummary(makeJobNode(), '/wt', 'abc123');
      assert.strictEqual(result.commits, 0);
    });
  });

  suite('computeAggregatedWorkSummary', () => {
    test('returns empty when no HEAD commit', async () => {
      sandbox.stub(git.worktrees, 'getHeadCommit').resolves(undefined);
      const result = await computeAggregatedWorkSummary(makeJobNode(), '/wt', 'main', '/repo');
      assert.strictEqual(result.commits, 0);
    });

    test('returns empty when baseBranch resolution fails', async () => {
      sandbox.stub(git.worktrees, 'getHeadCommit').resolves('head123');
      sandbox.stub(git.repository, 'resolveRef').rejects(new Error('unknown ref'));
      const result = await computeAggregatedWorkSummary(makeJobNode(), '/wt', 'main', '/repo');
      assert.strictEqual(result.commits, 0);
    });

    test('computes aggregated summary from baseBranch', async () => {
      sandbox.stub(git.worktrees, 'getHeadCommit').resolves('head123');
      sandbox.stub(git.repository, 'resolveRef').resolves('base123');
      sandbox.stub(git.repository, 'getDiffStats').resolves({ added: 1, modified: 1, deleted: 0 });
      sandbox.stub(git.repository, 'getCommitCount').resolves(3);

      const result = await computeAggregatedWorkSummary(makeJobNode(), '/wt', 'main', '/repo');
      assert.strictEqual(result.commits, 3);
      assert.strictEqual(result.filesAdded, 1);
      assert.strictEqual(result.filesModified, 1);
      assert.ok(result.description!.includes('Aggregated'));
    });

    test('handles rev-list failure gracefully', async () => {
      sandbox.stub(git.worktrees, 'getHeadCommit').resolves('head123');
      sandbox.stub(git.repository, 'resolveRef').resolves('base123');
      sandbox.stub(git.repository, 'getDiffStats').resolves({ added: 0, modified: 0, deleted: 0 });
      sandbox.stub(git.repository, 'getCommitCount').resolves(0);

      const result = await computeAggregatedWorkSummary(makeJobNode(), '/wt', 'main', '/repo');
      assert.strictEqual(result.commits, 0);
    });

    test('catches exception and returns empty', async () => {
      sandbox.stub(git.worktrees, 'getHeadCommit').rejects(new Error('fail'));
      const result = await computeAggregatedWorkSummary(makeJobNode(), '/wt', 'main', '/repo');
      assert.strictEqual(result.commits, 0);
    });

    test('handles diff failure with zero counts', async () => {
      sandbox.stub(git.worktrees, 'getHeadCommit').resolves('head123');
      sandbox.stub(git.repository, 'resolveRef').resolves('base123');
      sandbox.stub(git.repository, 'getDiffStats').resolves({ added: 0, modified: 0, deleted: 0 });
      sandbox.stub(git.repository, 'getCommitCount').resolves(1);

      const result = await computeAggregatedWorkSummary(makeJobNode(), '/wt', 'main', '/repo');
      assert.strictEqual(result.filesAdded, 0);
      assert.strictEqual(result.commits, 1);
    });
  });
});
