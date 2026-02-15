/**
 * @fileoverview Unit tests for computeAggregatedWorkSummary
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { DefaultJobExecutor } from '../../../plan/executor';
import { DefaultProcessSpawner } from '../../../interfaces/IProcessSpawner';
import { DefaultEvidenceValidator } from '../../../plan/evidenceValidator';
import { ProcessMonitor } from '../../../process';
import type { JobNode } from '../../../plan/types';
import type { ICopilotRunner } from '../../../interfaces/ICopilotRunner';

// Mock ICopilotRunner for tests
const mockCopilotRunner: ICopilotRunner = {
  run: async () => ({ success: true, sessionId: 'test', metrics: { requestCount: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.01, durationMs: 1000 } }),
  isAvailable: () => true,
  writeInstructionsFile: (cwd: string, task: string, instructions: string | undefined, label: string, jobId?: string) => ({ filePath: '/tmp/instructions.md', dirPath: '/tmp' }),
  buildCommand: (options: any) => 'copilot --help',
  cleanupInstructionsFile: (filePath: string, dirPath: string | undefined, label: string) => {}
};

function createMockGitOps() {
  return {
    worktrees: {
      createOrReuseDetached: sinon.stub().resolves({ path: '/tmp/wt', created: true }),
      getHeadCommit: sinon.stub().resolves('abc123'),
      removeSafe: sinon.stub().resolves(),
      list: sinon.stub().resolves([]),
    },
    repository: {
      resolveRef: sinon.stub().resolves('abc123'),
      getDiffStats: sinon.stub().resolves({ added: 0, modified: 0, deleted: 0 }),
      getCommitCount: sinon.stub().resolves(1),
      getFileChangesBetween: sinon.stub().resolves([]),
      revParse: sinon.stub().resolves('abc123'),
    },
    merge: {
      mergeWithoutCheckout: sinon.stub().resolves({ success: true, mergeCommit: 'abc123' }),
    },
    branches: {
      exists: sinon.stub().resolves(true),
    },
    gitignore: {
      ensureGitignoreEntries: sinon.stub().resolves(),
    },
  } as any;
}

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

suite('computeAggregatedWorkSummary', () => {
  let quiet: { restore: () => void };
  let executor: DefaultJobExecutor;
  let mockGitOps: ReturnType<typeof createMockGitOps>;

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
    mockGitOps = createMockGitOps();
    executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), mockGitOps, mockCopilotRunner);
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
    mockGitOps.worktrees.getHeadCommit.resolves(headCommit);
    
    mockGitOps.repository.resolveRef.resolves(headCommit);
    mockGitOps.repository.getDiffStats.resolves({ added: 0, modified: 0, deleted: 0 });
    mockGitOps.repository.getCommitCount.resolves(0);
    
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
    
    mockGitOps.worktrees.getHeadCommit.resolves('def456');
    mockGitOps.repository.resolveRef.resolves('abc123');
    mockGitOps.repository.getDiffStats.resolves({ added: 0, modified: 0, deleted: 0 });
    mockGitOps.repository.getCommitCount.resolves(3);
    
    const result = await executor.computeAggregatedWorkSummary(node, worktreePath, baseBranch, repoPath);
    
    assert.strictEqual(result.commits, 3);
    assert.ok(result.description.includes('origin/main'));
  });

  test('includes all file changes across commits', async () => {
    const node = createJobNode('j1', 'Job1', 'Test task');
    const worktreePath = '/test/worktree';
    const baseBranch = 'origin/main';
    const repoPath = '/test/repo';
    
    mockGitOps.worktrees.getHeadCommit.resolves('def456');
    mockGitOps.repository.resolveRef.resolves('abc123');
    mockGitOps.repository.getDiffStats.resolves({ added: 2, modified: 1, deleted: 0 });
    mockGitOps.repository.getCommitCount.resolves(2);
    
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
    
    mockGitOps.worktrees.getHeadCommit.resolves('def456');
    mockGitOps.repository.resolveRef.resolves('abc123');
    // getDiffStats counts renames as modified
    mockGitOps.repository.getDiffStats.resolves({ added: 0, modified: 2, deleted: 0 });
    mockGitOps.repository.getCommitCount.resolves(1);
    
    const result = await executor.computeAggregatedWorkSummary(node, worktreePath, baseBranch, repoPath);
    
    assert.strictEqual(result.filesAdded, 0);
    assert.strictEqual(result.filesModified, 2);
    assert.strictEqual(result.filesDeleted, 0);
  });

  test('returns job-specific description', async () => {
    const node = createJobNode('test-job-id', 'Test Job Name', 'Test task');
    const worktreePath = '/test/worktree';
    const baseBranch = 'origin/develop';
    const repoPath = '/test/repo';
    
    mockGitOps.worktrees.getHeadCommit.resolves('def456');
    mockGitOps.repository.resolveRef.resolves('abc123');
    mockGitOps.repository.getDiffStats.resolves({ added: 0, modified: 0, deleted: 0 });
    mockGitOps.repository.getCommitCount.resolves(1);
    
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
    
    mockGitOps.worktrees.getHeadCommit.resolves('def456');
    mockGitOps.repository.resolveRef.resolves('abc123');
    mockGitOps.repository.getDiffStats.resolves({ added: 1, modified: 0, deleted: 2 });
    mockGitOps.repository.getCommitCount.resolves(2);
    
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
    
    mockGitOps.worktrees.getHeadCommit.resolves(null);
    
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
    
    mockGitOps.worktrees.getHeadCommit.resolves('abc123');
    mockGitOps.repository.resolveRef.rejects(new Error('branch not found'));
    
    const result = await executor.computeAggregatedWorkSummary(node, worktreePath, baseBranch, repoPath);
    
    assert.strictEqual(result.commits, 0);
    assert.strictEqual(result.filesAdded, 0);
  });

  test('handles git diff failure gracefully', async () => {
    const node = createJobNode('j1', 'Job1', 'Test task');
    const worktreePath = '/test/worktree';
    const baseBranch = 'origin/main';
    const repoPath = '/test/repo';
    
    mockGitOps.worktrees.getHeadCommit.resolves('def456');
    mockGitOps.repository.resolveRef.resolves('abc123');
    // getDiffStats returns zeros on failure
    mockGitOps.repository.getDiffStats.resolves({ added: 0, modified: 0, deleted: 0 });
    mockGitOps.repository.getCommitCount.resolves(1);
    
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
    
    mockGitOps.worktrees.getHeadCommit.resolves('def456');
    mockGitOps.repository.resolveRef.resolves('abc123');
    mockGitOps.repository.getDiffStats.resolves({ added: 2, modified: 3, deleted: 1 });
    mockGitOps.repository.getCommitCount.resolves(5);
    
    const result = await executor.computeAggregatedWorkSummary(node, worktreePath, baseBranch, repoPath);
    
    assert.strictEqual(result.commits, 5);
    assert.strictEqual(result.filesAdded, 2);
    assert.strictEqual(result.filesModified, 3);
    assert.strictEqual(result.filesDeleted, 1);
  });
});


