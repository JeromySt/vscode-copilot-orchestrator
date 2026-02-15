/**
 * @fileoverview Unit tests for workSummaryHelper
 */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { computeWorkSummary, computeAggregatedWorkSummary } from '../../../plan/workSummaryHelper';
import type { JobNode } from '../../../plan/types';

function makeNode(overrides?: Partial<JobNode>): JobNode {
  return {
    id: 'n1',
    producerId: 'n1',
    name: 'Test Node',
    type: 'job',
    task: 'do something',
    dependencies: [],
    dependents: [],
    ...overrides,
  } as JobNode;
}

function makeMockGit() {
  return {
    branches: {} as any,
    worktrees: {
      getHeadCommit: sinon.stub(),
    } as any,
    merge: {} as any,
    repository: {
      resolveRef: sinon.stub(),
      getDiffStats: sinon.stub(),
      getCommitCount: sinon.stub(),
      getFileChangesBetween: sinon.stub(),
    } as any,
    gitignore: {} as any,
  };
}

suite('workSummaryHelper', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => { sandbox.restore(); });

  suite('computeWorkSummary', () => {
    test('returns empty summary when HEAD is null', async () => {
      const git = makeMockGit();
      git.worktrees.getHeadCommit.resolves(null);
      const node = makeNode();
      const result = await computeWorkSummary(node, '/wt', 'base123', git as any);
      assert.strictEqual(result.nodeId, 'n1');
      assert.strictEqual(result.commits, 0);
      assert.strictEqual(result.filesAdded, 0);
      assert.strictEqual(result.filesModified, 0);
      assert.strictEqual(result.filesDeleted, 0);
      assert.strictEqual(result.commitDetails, undefined);
    });

    test('returns expectsNoChanges summary when head equals base and expectsNoChanges is true', async () => {
      const git = makeMockGit();
      git.worktrees.getHeadCommit.resolves('base123');
      const node = makeNode({ expectsNoChanges: true });
      const result = await computeWorkSummary(node, '/wt', 'base123', git as any);
      assert.strictEqual(result.description, 'Node declared expectsNoChanges');
      assert.deepStrictEqual(result.commitDetails, []);
      assert.strictEqual(result.commits, 0);
    });

    test('returns expectsNoChanges summary when head is null and expectsNoChanges is true', async () => {
      const git = makeMockGit();
      git.worktrees.getHeadCommit.resolves(null);
      const node = makeNode({ expectsNoChanges: true });
      const result = await computeWorkSummary(node, '/wt', 'base123', git as any);
      // null head with expectsNoChanges => first branch (!head) returns emptyWorkSummary
      assert.strictEqual(result.nodeId, 'n1');
      assert.strictEqual(result.commits, 0);
    });

    test('returns summary with commit details when there are changes', async () => {
      const git = makeMockGit();
      git.worktrees.getHeadCommit.resolves('head456');
      git.repository.getFileChangesBetween.resolves([
        { status: 'added', path: 'a.ts' },
        { status: 'modified', path: 'b.ts' },
        { status: 'deleted', path: 'c.ts' },
        { status: 'modified', path: 'd.ts' },
      ]);
      const node = makeNode();
      const result = await computeWorkSummary(node, '/wt', 'base123', git as any);
      assert.strictEqual(result.commits, 1);
      assert.strictEqual(result.filesAdded, 1);
      assert.strictEqual(result.filesModified, 2);
      assert.strictEqual(result.filesDeleted, 1);
      assert.ok(result.commitDetails);
      assert.strictEqual(result.commitDetails!.length, 1);
      assert.strictEqual(result.commitDetails![0].shortHash, 'head456'.slice(0, 8));
    });

    test('returns summary with zero counts when getFileChangesBetween returns empty', async () => {
      const git = makeMockGit();
      git.worktrees.getHeadCommit.resolves('head456');
      git.repository.getFileChangesBetween.resolves([]);
      const node = makeNode();
      const result = await computeWorkSummary(node, '/wt', 'base123', git as any);
      assert.strictEqual(result.commits, 0);
      assert.strictEqual(result.filesAdded, 0);
      assert.ok(result.commitDetails);
      assert.strictEqual(result.commitDetails!.length, 0);
    });

    test('returns empty summary when getHeadCommit throws', async () => {
      const git = makeMockGit();
      git.worktrees.getHeadCommit.rejects(new Error('git error'));
      const node = makeNode();
      const result = await computeWorkSummary(node, '/wt', 'base123', git as any);
      assert.strictEqual(result.commits, 0);
      assert.strictEqual(result.filesAdded, 0);
      assert.strictEqual(result.commitDetails, undefined);
    });

    test('returns summary with zero file counts when getFileChangesBetween throws', async () => {
      const git = makeMockGit();
      git.worktrees.getHeadCommit.resolves('head456');
      git.repository.getFileChangesBetween.rejects(new Error('diff error'));
      const node = makeNode();
      const result = await computeWorkSummary(node, '/wt', 'base123', git as any);
      // getCommitDetails catches and returns [], so commits=0
      assert.strictEqual(result.commits, 0);
      assert.strictEqual(result.filesAdded, 0);
    });
  });

  suite('computeAggregatedWorkSummary', () => {
    test('returns empty summary when HEAD is null', async () => {
      const git = makeMockGit();
      git.worktrees.getHeadCommit.resolves(null);
      const node = makeNode();
      const result = await computeAggregatedWorkSummary(node, '/wt', 'main', '/repo', git as any);
      assert.strictEqual(result.nodeId, 'n1');
      assert.strictEqual(result.commits, 0);
    });

    test('returns empty summary when resolveRef throws', async () => {
      const git = makeMockGit();
      git.worktrees.getHeadCommit.resolves('head456');
      git.repository.resolveRef.rejects(new Error('ref not found'));
      const node = makeNode();
      const result = await computeAggregatedWorkSummary(node, '/wt', 'main', '/repo', git as any);
      assert.strictEqual(result.commits, 0);
      assert.strictEqual(result.filesAdded, 0);
    });

    test('returns aggregated summary with diff stats', async () => {
      const git = makeMockGit();
      git.worktrees.getHeadCommit.resolves('head456');
      git.repository.resolveRef.resolves('baseCommitSha');
      git.repository.getDiffStats.resolves({ added: 3, modified: 5, deleted: 1 });
      git.repository.getCommitCount.resolves(7);
      const node = makeNode();
      const result = await computeAggregatedWorkSummary(node, '/wt', 'main', '/repo', git as any);
      assert.strictEqual(result.commits, 7);
      assert.strictEqual(result.filesAdded, 3);
      assert.strictEqual(result.filesModified, 5);
      assert.strictEqual(result.filesDeleted, 1);
      assert.ok(result.description.includes('main'));
    });

    test('returns empty summary when getDiffStats throws', async () => {
      const git = makeMockGit();
      git.worktrees.getHeadCommit.resolves('head456');
      git.repository.resolveRef.resolves('baseCommitSha');
      git.repository.getDiffStats.rejects(new Error('diff failed'));
      const node = makeNode();
      const result = await computeAggregatedWorkSummary(node, '/wt', 'main', '/repo', git as any);
      assert.strictEqual(result.commits, 0);
      assert.strictEqual(result.filesAdded, 0);
    });

    test('passes correct arguments to git methods', async () => {
      const git = makeMockGit();
      git.worktrees.getHeadCommit.resolves('headABC');
      git.repository.resolveRef.resolves('baseSHA');
      git.repository.getDiffStats.resolves({ added: 0, modified: 0, deleted: 0 });
      git.repository.getCommitCount.resolves(0);
      const node = makeNode();
      await computeAggregatedWorkSummary(node, '/wt', 'main', '/repo', git as any);
      assert.ok(git.worktrees.getHeadCommit.calledWith('/wt'));
      assert.ok(git.repository.resolveRef.calledWith('main', '/repo'));
      assert.ok(git.repository.getDiffStats.calledWith('baseSHA', 'headABC', '/wt'));
      assert.ok(git.repository.getCommitCount.calledWith('baseSHA', 'headABC', '/wt'));
    });
  });
});
