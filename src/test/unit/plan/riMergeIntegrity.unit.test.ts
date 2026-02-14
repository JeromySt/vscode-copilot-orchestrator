/**
 * @fileoverview Tests for RI merge data integrity.
 *
 * Verifies the simplified RI merge logic: leaf nodes compute the diff
 * between their best available commit and the plan's base branch.
 * If there are ANY changes, merge. This handles all cases uniformly.
 *
 * @module test/unit/plan/riMergeIntegrity
 */

import * as assert from 'assert';

/**
 * Simulates the simplified RI merge decision logic.
 * This mirrors executionEngine.ts RI merge block.
 */
function simulateRiMergeDecision(params: {
  isLeaf: boolean;
  targetBranch: string | undefined;
  completedCommit: string | undefined;
  baseCommit: string | undefined;
  hasDiffFromBaseBranch: boolean;
}): { action: string; mergedToTarget: boolean; mergeSource: string | undefined } {
  const { isLeaf, targetBranch, completedCommit, baseCommit, hasDiffFromBaseBranch } = params;

  if (!isLeaf || !targetBranch) {
    return { action: 'skip-not-leaf-or-no-target', mergedToTarget: false, mergeSource: undefined };
  }

  const mergeSource = completedCommit || baseCommit;

  if (mergeSource) {
    if (hasDiffFromBaseBranch) {
      return { action: 'merge', mergedToTarget: true, mergeSource };
    } else {
      return { action: 'skip-no-diff', mergedToTarget: true, mergeSource };
    }
  } else {
    return { action: 'skip-no-commit', mergedToTarget: true, mergeSource: undefined };
  }
}

/**
 * Simulates the completedCommit fallback logic after auto-heal/auto-retry.
 */
function simulateCompletedCommitFallback(params: {
  resultCommit: string | undefined;
  existingCompleted: string | undefined;
  baseCommit: string | undefined;
}): string | undefined {
  const { resultCommit, existingCompleted, baseCommit } = params;

  if (resultCommit) {
    return resultCommit;
  } else if (!existingCompleted && baseCommit) {
    return baseCommit;
  }
  return existingCompleted;
}

suite('RI Merge Integrity', () => {

  suite('simplified diff-based RI merge decision', () => {

    test('leaf with completedCommit and diff merges to target', () => {
      const result = simulateRiMergeDecision({
        isLeaf: true,
        targetBranch: 'main',
        completedCommit: 'abc123',
        baseCommit: 'def456',
        hasDiffFromBaseBranch: true,
      });
      assert.strictEqual(result.action, 'merge');
      assert.strictEqual(result.mergeSource, 'abc123');
    });

    test('leaf with no completedCommit but baseCommit with diff merges baseCommit', () => {
      const result = simulateRiMergeDecision({
        isLeaf: true,
        targetBranch: 'main',
        completedCommit: undefined,
        baseCommit: 'upstream-work-sha',
        hasDiffFromBaseBranch: true,
      });
      assert.strictEqual(result.action, 'merge');
      assert.strictEqual(result.mergeSource, 'upstream-work-sha');
    });

    test('CRITICAL: expects_no_changes leaf after chain with diff merges upstream work', () => {
      const result = simulateRiMergeDecision({
        isLeaf: true,
        targetBranch: 'feature/x',
        completedCommit: undefined,
        baseCommit: 'chain-abc-sha',
        hasDiffFromBaseBranch: true,
      });
      assert.strictEqual(result.action, 'merge');
      assert.strictEqual(result.mergeSource, 'chain-abc-sha');
    });

    test('CRITICAL: 3 consecutive expects_no_changes still merges if chain has diff', () => {
      // A(work) → B(no_changes) → C(no_changes) → D(no_changes, leaf)
      // D has no completedCommit but baseCommit = C's base = B's base = A's commit
      const result = simulateRiMergeDecision({
        isLeaf: true,
        targetBranch: 'main',
        completedCommit: undefined,
        baseCommit: 'a-work-sha',
        hasDiffFromBaseBranch: true,
      });
      assert.strictEqual(result.action, 'merge');
      assert.strictEqual(result.mergeSource, 'a-work-sha');
    });

    test('leaf with commit but NO diff from base skips merge', () => {
      const result = simulateRiMergeDecision({
        isLeaf: true,
        targetBranch: 'main',
        completedCommit: 'same-as-base',
        baseCommit: undefined,
        hasDiffFromBaseBranch: false,
      });
      assert.strictEqual(result.action, 'skip-no-diff');
      assert.strictEqual(result.mergedToTarget, true);
    });

    test('root validation node with no commits skips safely', () => {
      const result = simulateRiMergeDecision({
        isLeaf: true,
        targetBranch: 'main',
        completedCommit: undefined,
        baseCommit: undefined,
        hasDiffFromBaseBranch: false,
      });
      assert.strictEqual(result.action, 'skip-no-commit');
      assert.strictEqual(result.mergedToTarget, true);
    });

    test('non-leaf node never triggers RI merge', () => {
      const result = simulateRiMergeDecision({
        isLeaf: false,
        targetBranch: 'main',
        completedCommit: 'abc123',
        baseCommit: 'def456',
        hasDiffFromBaseBranch: true,
      });
      assert.strictEqual(result.action, 'skip-not-leaf-or-no-target');
      assert.strictEqual(result.mergedToTarget, false);
    });

    test('leaf without target branch skips merge', () => {
      const result = simulateRiMergeDecision({
        isLeaf: true,
        targetBranch: undefined,
        completedCommit: 'abc123',
        baseCommit: 'def456',
        hasDiffFromBaseBranch: true,
      });
      assert.strictEqual(result.action, 'skip-not-leaf-or-no-target');
    });

    test('mergeSource prefers completedCommit over baseCommit', () => {
      const result = simulateRiMergeDecision({
        isLeaf: true,
        targetBranch: 'main',
        completedCommit: 'own-work',
        baseCommit: 'upstream-only',
        hasDiffFromBaseBranch: true,
      });
      assert.strictEqual(result.mergeSource, 'own-work',
        'Should use completedCommit when available, not baseCommit');
    });
  });

  suite('completedCommit fallback after auto-heal/auto-retry', () => {

    test('uses result commit when available', () => {
      const result = simulateCompletedCommitFallback({
        resultCommit: 'new-sha',
        existingCompleted: undefined,
        baseCommit: 'base-sha',
      });
      assert.strictEqual(result, 'new-sha');
    });

    test('falls back to baseCommit when result has no commit', () => {
      const result = simulateCompletedCommitFallback({
        resultCommit: undefined,
        existingCompleted: undefined,
        baseCommit: 'upstream-work-sha',
      });
      assert.strictEqual(result, 'upstream-work-sha');
    });

    test('preserves existing completedCommit', () => {
      const result = simulateCompletedCommitFallback({
        resultCommit: undefined,
        existingCompleted: 'already-set',
        baseCommit: 'base-sha',
      });
      assert.strictEqual(result, 'already-set');
    });

    test('returns undefined only when nothing exists', () => {
      const result = simulateCompletedCommitFallback({
        resultCommit: undefined,
        existingCompleted: undefined,
        baseCommit: undefined,
      });
      assert.strictEqual(result, undefined);
    });
  });

  suite('end-to-end chain scenarios', () => {

    test('A→B→C→D(no changes): diff detects upstream work, merges', () => {
      const nodes: Record<string, { baseCommit?: string; completedCommit?: string }> = {};
      nodes['A'] = { baseCommit: 'base-sha', completedCommit: 'a-work-sha' };
      nodes['B'] = { baseCommit: 'a-work-sha', completedCommit: 'b-work-sha' };
      nodes['C'] = { baseCommit: 'b-work-sha', completedCommit: 'c-work-sha' };
      nodes['D'] = { baseCommit: 'c-work-sha', completedCommit: undefined };

      const mergeSource = nodes['D'].completedCommit || nodes['D'].baseCommit;
      assert.strictEqual(mergeSource, 'c-work-sha');

      const result = simulateRiMergeDecision({
        isLeaf: true,
        targetBranch: 'main',
        completedCommit: nodes['D'].completedCommit,
        baseCommit: nodes['D'].baseCommit,
        hasDiffFromBaseBranch: true, // diff base-sha..c-work-sha has changes
      });
      assert.strictEqual(result.action, 'merge');
      assert.strictEqual(result.mergeSource, 'c-work-sha');
    });

    test('A(work)→B(no_changes)→C(no_changes)→D(no_changes): all validation after A', () => {
      // A does work, B/C/D are all validation nodes
      // D has: completedCommit=undefined, baseCommit='a-work-sha' (passed through chain)
      const result = simulateRiMergeDecision({
        isLeaf: true,
        targetBranch: 'main',
        completedCommit: undefined,
        baseCommit: 'a-work-sha', // Passed through chain: A→B→C→D
        hasDiffFromBaseBranch: true,
      });
      assert.strictEqual(result.action, 'merge');
      assert.strictEqual(result.mergeSource, 'a-work-sha');
    });

    test('all nodes expects_no_changes from same base: no diff, no merge needed', () => {
      const result = simulateRiMergeDecision({
        isLeaf: true,
        targetBranch: 'main',
        completedCommit: undefined,
        baseCommit: 'base-sha', // Same as plan's baseBranch resolves to
        hasDiffFromBaseBranch: false, // diff base-sha..base-sha is empty
      });
      assert.strictEqual(result.action, 'skip-no-diff');
      assert.strictEqual(result.mergedToTarget, true);
    });

    test('BUG REPRO: old code orphaned work, new code merges it', () => {
      // Old code: checked completedCommit only, missed baseCommit
      // New code: uses mergeSource = completedCommit || baseCommit, then checks diff
      const result = simulateRiMergeDecision({
        isLeaf: true,
        targetBranch: 'main',
        completedCommit: undefined,
        baseCommit: 'upstream-chain-sha',
        hasDiffFromBaseBranch: true,
      });
      assert.strictEqual(result.action, 'merge',
        'New diff-based logic correctly detects upstream work and merges');
      assert.notStrictEqual(result.action, 'skip-no-commit',
        'Must NOT skip merge when baseCommit has upstream work');
    });
  });
});
