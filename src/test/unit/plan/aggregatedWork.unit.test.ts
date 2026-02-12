/**
 * @fileoverview Unit tests for computeAggregatedWorkSummary
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { DefaultJobExecutor } from '../../../plan/executor';
import type { JobNode } from '../../../plan/types';
// git module used transitively via executor

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

suite('computeAggregatedWorkSummary', () => {
  let quiet: { restore: () => void };
  let executor: DefaultJobExecutor;
  let gitWorktreesStub: sinon.SinonStub;
  let gitExecutorStub: sinon.SinonStub;

  const createJobNode = (id: string, name: string, task: string): JobNode => ({
    id,
    name,
    producerId: id,
    task,
    type: 'job',
    dependencies: [],
    dependents: [],
    work: { type: 'agent', instructions: task },
  });

  setup(() => {
    quiet = silenceConsole();
    executor = new DefaultJobExecutor();
    
    // Stub git module functions
    const gitModule = require('../../../git');
    gitWorktreesStub = sinon.stub(gitModule.worktrees, 'getHeadCommit');
    gitExecutorStub = sinon.stub(gitModule.executor, 'execAsync');
  });

  teardown(() => {
    quiet.restore();
    sinon.restore();
  });

  test('returns empty summary when HEAD equals baseBranch', async () => {
    const node = createJobNode('j1', 'Job1', 'Test task');
    const worktreePath = '/test/worktree';
    const baseBranch = 'origin/main';
    const repoPath = '/test/repo';
    
    const headCommit = 'abc123';
    gitWorktreesStub.resolves(headCommit);
    
    // Return same commit for baseBranch
    gitExecutorStub.withArgs(['rev-parse', baseBranch], sinon.match.any)
      .resolves({ success: true, stdout: headCommit + '\n', stderr: '' });
    
    // Diff returns empty (no changes)
    gitExecutorStub.withArgs(
      sinon.match.array.contains(['diff']),
      sinon.match.any
    ).resolves({ success: true, stdout: '', stderr: '' });
    
    // Commit count is 0
    gitExecutorStub.withArgs(
      sinon.match.array.contains(['rev-list']),
      sinon.match.any
    ).resolves({ success: true, stdout: '0\n', stderr: '' });
    
    const result = await executor.computeAggregatedWorkSummary(node, worktreePath, baseBranch, repoPath);
    
    assert.strictEqual(result.commits, 0);
    assert.strictEqual(result.filesAdded, 0);
    assert.strictEqual(result.filesModified, 0);
    assert.strictEqual(result.filesDeleted, 0);
    assert.strictEqual(result.nodeId, 'j1');
    assert.strictEqual(result.nodeName, 'Job1');
  });

  test('counts commits from baseBranch to HEAD', async () => {
    const node = createJobNode('j1', 'Job1', 'Test task');
    const worktreePath = '/test/worktree';
    const baseBranch = 'origin/main';
    const repoPath = '/test/repo';
    
    const headCommit = 'def456';
    const baseCommit = 'abc123';
    
    gitWorktreesStub.resolves(headCommit);
    
    gitExecutorStub.withArgs(['rev-parse', baseBranch], sinon.match.any)
      .resolves({ success: true, stdout: baseCommit + '\n', stderr: '' });
    
    gitExecutorStub.withArgs(
      sinon.match.array.contains(['diff']),
      sinon.match.any
    ).resolves({ success: true, stdout: '', stderr: '' });
    
    // 3 commits in range
    gitExecutorStub.withArgs(
      sinon.match.array.contains(['rev-list']),
      sinon.match.any
    ).resolves({ success: true, stdout: '3\n', stderr: '' });
    
    const result = await executor.computeAggregatedWorkSummary(node, worktreePath, baseBranch, repoPath);
    
    assert.strictEqual(result.commits, 3);
    assert.ok(result.description.includes('origin/main'));
  });

  test('includes all file changes across commits', async () => {
    const node = createJobNode('j1', 'Job1', 'Test task');
    const worktreePath = '/test/worktree';
    const baseBranch = 'origin/main';
    const repoPath = '/test/repo';
    
    const headCommit = 'def456';
    const baseCommit = 'abc123';
    
    gitWorktreesStub.resolves(headCommit);
    
    gitExecutorStub.withArgs(['rev-parse', baseBranch], sinon.match.any)
      .resolves({ success: true, stdout: baseCommit + '\n', stderr: '' });
    
    // Diff with file changes: 2 added, 1 modified
    const diffOutput = 'A\tfile1.ts\nA\tfile2.ts\nM\tfile3.ts\n';
    gitExecutorStub.withArgs(
      sinon.match.array.contains(['diff']),
      sinon.match.any
    ).resolves({ success: true, stdout: diffOutput, stderr: '' });
    
    gitExecutorStub.withArgs(
      sinon.match.array.contains(['rev-list']),
      sinon.match.any
    ).resolves({ success: true, stdout: '2\n', stderr: '' });
    
    const result = await executor.computeAggregatedWorkSummary(node, worktreePath, baseBranch, repoPath);
    
    assert.strictEqual(result.commits, 2);
    assert.strictEqual(result.filesAdded, 2);
    assert.strictEqual(result.filesModified, 1);
    assert.strictEqual(result.filesDeleted, 0);
  });

  test('handles renamed files correctly', async () => {
    const node = createJobNode('j1', 'Job1', 'Test task');
    const worktreePath = '/test/worktree';
    const baseBranch = 'origin/main';
    const repoPath = '/test/repo';
    
    const headCommit = 'def456';
    const baseCommit = 'abc123';
    
    gitWorktreesStub.resolves(headCommit);
    
    gitExecutorStub.withArgs(['rev-parse', baseBranch], sinon.match.any)
      .resolves({ success: true, stdout: baseCommit + '\n', stderr: '' });
    
    // Diff with renamed file (R status) - should not count in added/modified/deleted
    const diffOutput = 'R\told.ts\tnew.ts\nM\tfile.ts\n';
    gitExecutorStub.withArgs(
      sinon.match.array.contains(['diff']),
      sinon.match.any
    ).resolves({ success: true, stdout: diffOutput, stderr: '' });
    
    gitExecutorStub.withArgs(
      sinon.match.array.contains(['rev-list']),
      sinon.match.any
    ).resolves({ success: true, stdout: '1\n', stderr: '' });
    
    const result = await executor.computeAggregatedWorkSummary(node, worktreePath, baseBranch, repoPath);
    
    // Renamed files (R status) are not counted as A, M, or D
    assert.strictEqual(result.filesAdded, 0);
    assert.strictEqual(result.filesModified, 1);
    assert.strictEqual(result.filesDeleted, 0);
  });

  test('returns job-specific description', async () => {
    const node = createJobNode('test-job-id', 'Test Job Name', 'Test task');
    const worktreePath = '/test/worktree';
    const baseBranch = 'origin/develop';
    const repoPath = '/test/repo';
    
    const headCommit = 'def456';
    const baseCommit = 'abc123';
    
    gitWorktreesStub.resolves(headCommit);
    
    gitExecutorStub.withArgs(['rev-parse', baseBranch], sinon.match.any)
      .resolves({ success: true, stdout: baseCommit + '\n', stderr: '' });
    
    gitExecutorStub.withArgs(
      sinon.match.array.contains(['diff']),
      sinon.match.any
    ).resolves({ success: true, stdout: '', stderr: '' });
    
    gitExecutorStub.withArgs(
      sinon.match.array.contains(['rev-list']),
      sinon.match.any
    ).resolves({ success: true, stdout: '1\n', stderr: '' });
    
    const result = await executor.computeAggregatedWorkSummary(node, worktreePath, baseBranch, repoPath);
    
    assert.strictEqual(result.nodeId, 'test-job-id');
    assert.strictEqual(result.nodeName, 'Test Job Name');
    assert.ok(result.description.includes('origin/develop'));
  });

  test('handles deleted files correctly', async () => {
    const node = createJobNode('j1', 'Job1', 'Test task');
    const worktreePath = '/test/worktree';
    const baseBranch = 'origin/main';
    const repoPath = '/test/repo';
    
    const headCommit = 'def456';
    const baseCommit = 'abc123';
    
    gitWorktreesStub.resolves(headCommit);
    
    gitExecutorStub.withArgs(['rev-parse', baseBranch], sinon.match.any)
      .resolves({ success: true, stdout: baseCommit + '\n', stderr: '' });
    
    // Diff with deleted files
    const diffOutput = 'D\tfile1.ts\nD\tfile2.ts\nA\tfile3.ts\n';
    gitExecutorStub.withArgs(
      sinon.match.array.contains(['diff']),
      sinon.match.any
    ).resolves({ success: true, stdout: diffOutput, stderr: '' });
    
    gitExecutorStub.withArgs(
      sinon.match.array.contains(['rev-list']),
      sinon.match.any
    ).resolves({ success: true, stdout: '2\n', stderr: '' });
    
    const result = await executor.computeAggregatedWorkSummary(node, worktreePath, baseBranch, repoPath);
    
    assert.strictEqual(result.filesAdded, 1);
    assert.strictEqual(result.filesModified, 0);
    assert.strictEqual(result.filesDeleted, 2);
  });

  test('returns empty summary when getHeadCommit fails', async () => {
    const node = createJobNode('j1', 'Job1', 'Test task');
    const worktreePath = '/test/worktree';
    const baseBranch = 'origin/main';
    const repoPath = '/test/repo';
    
    gitWorktreesStub.resolves(null);
    
    const result = await executor.computeAggregatedWorkSummary(node, worktreePath, baseBranch, repoPath);
    
    assert.strictEqual(result.commits, 0);
    assert.strictEqual(result.filesAdded, 0);
    assert.strictEqual(result.filesModified, 0);
    assert.strictEqual(result.filesDeleted, 0);
  });

  test('returns empty summary when rev-parse fails', async () => {
    const node = createJobNode('j1', 'Job1', 'Test task');
    const worktreePath = '/test/worktree';
    const baseBranch = 'origin/main';
    const repoPath = '/test/repo';
    
    gitWorktreesStub.resolves('abc123');
    
    gitExecutorStub.withArgs(['rev-parse', baseBranch], sinon.match.any)
      .resolves({ success: false, stdout: '', stderr: 'branch not found' });
    
    const result = await executor.computeAggregatedWorkSummary(node, worktreePath, baseBranch, repoPath);
    
    assert.strictEqual(result.commits, 0);
    assert.strictEqual(result.filesAdded, 0);
  });

  test('handles git diff failure gracefully', async () => {
    const node = createJobNode('j1', 'Job1', 'Test task');
    const worktreePath = '/test/worktree';
    const baseBranch = 'origin/main';
    const repoPath = '/test/repo';
    
    const headCommit = 'def456';
    const baseCommit = 'abc123';
    
    gitWorktreesStub.resolves(headCommit);
    
    gitExecutorStub.withArgs(['rev-parse', baseBranch], sinon.match.any)
      .resolves({ success: true, stdout: baseCommit + '\n', stderr: '' });
    
    // Diff fails
    gitExecutorStub.withArgs(
      sinon.match.array.contains(['diff']),
      sinon.match.any
    ).resolves({ success: false, stdout: '', stderr: 'diff error' });
    
    gitExecutorStub.withArgs(
      sinon.match.array.contains(['rev-list']),
      sinon.match.any
    ).resolves({ success: true, stdout: '1\n', stderr: '' });
    
    const result = await executor.computeAggregatedWorkSummary(node, worktreePath, baseBranch, repoPath);
    
    // Should still return commit count but no file stats
    assert.strictEqual(result.commits, 1);
    assert.strictEqual(result.filesAdded, 0);
    assert.strictEqual(result.filesModified, 0);
    assert.strictEqual(result.filesDeleted, 0);
  });

  test('handles mixed file status types', async () => {
    const node = createJobNode('j1', 'Job1', 'Test task');
    const worktreePath = '/test/worktree';
    const baseBranch = 'origin/main';
    const repoPath = '/test/repo';
    
    const headCommit = 'def456';
    const baseCommit = 'abc123';
    
    gitWorktreesStub.resolves(headCommit);
    
    gitExecutorStub.withArgs(['rev-parse', baseBranch], sinon.match.any)
      .resolves({ success: true, stdout: baseCommit + '\n', stderr: '' });
    
    // Diff with mixed statuses
    const diffOutput = 'A\tnew1.ts\nA\tnew2.ts\nM\tmodified1.ts\nM\tmodified2.ts\nM\tmodified3.ts\nD\tdeleted.ts\n';
    gitExecutorStub.withArgs(
      sinon.match.array.contains(['diff']),
      sinon.match.any
    ).resolves({ success: true, stdout: diffOutput, stderr: '' });
    
    gitExecutorStub.withArgs(
      sinon.match.array.contains(['rev-list']),
      sinon.match.any
    ).resolves({ success: true, stdout: '5\n', stderr: '' });
    
    const result = await executor.computeAggregatedWorkSummary(node, worktreePath, baseBranch, repoPath);
    
    assert.strictEqual(result.commits, 5);
    assert.strictEqual(result.filesAdded, 2);
    assert.strictEqual(result.filesModified, 3);
    assert.strictEqual(result.filesDeleted, 1);
  });
});
