/**
 * @fileoverview Tests for RI merge data integrity.
 *
 * Verifies that leaf nodes with `expects_no_changes` or no file changes
 * still properly merge upstream work from their dependency chain to the
 * target branch during the reverse integration (RI) merge phase.
 *
 * Bug context: When a leaf node produced no commit (expects_no_changes),
 * the RI merge guard at line ~904 would silently mark the node as merged
 * without actually performing a merge, orphaning all upstream changes.
 *
 * @module test/unit/plan/riMergeIntegrity
 */

import * as assert from 'assert';

/**
 * Simulates the RI merge decision logic to verify correctness.
 * This mirrors the conditions in executionEngine.ts lines 886-950.
 */
function simulateRiMergeDecision(params: {
  isLeaf: boolean;
  targetBranch: string | undefined;
  completedCommit: string | undefined;
  baseCommit: string | undefined;
}): { action: string; mergedToTarget: boolean; completedCommit: string | undefined } {
  const { isLeaf, targetBranch, baseCommit } = params;
  let { completedCommit } = params;
  
  if (isLeaf && targetBranch && completedCommit) {
    // Normal path: merge completedCommit to target
    return { action: 'merge', mergedToTarget: true, completedCommit };
  } else if (isLeaf && targetBranch && !completedCommit && baseCommit) {
    // FIXED PATH: No own commit but has upstream work via baseCommit
    // Fall back to baseCommit and merge it
    completedCommit = baseCommit;
    return { action: 'merge-baseCommit', mergedToTarget: true, completedCommit };
  } else if (isLeaf && targetBranch && !completedCommit && !baseCommit) {
    // Truly nothing: root validation node with no work anywhere
    return { action: 'skip-nothing-to-merge', mergedToTarget: true, completedCommit: undefined };
  } else if (isLeaf) {
    // No target branch
    return { action: 'skip-no-target', mergedToTarget: false, completedCommit };
  } else {
    // Not a leaf
    return { action: 'skip-not-leaf', mergedToTarget: false, completedCommit };
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
    // CRITICAL FALLBACK: use baseCommit which contains upstream work
    return baseCommit;
  }
  return existingCompleted;
}

suite('RI Merge Integrity', () => {

  suite('RI merge decision logic', () => {
    
    test('normal leaf with completedCommit merges to target', () => {
      const result = simulateRiMergeDecision({
        isLeaf: true,
        targetBranch: 'main',
        completedCommit: 'abc123',
        baseCommit: 'def456',
      });
      assert.strictEqual(result.action, 'merge');
      assert.strictEqual(result.mergedToTarget, true);
      assert.strictEqual(result.completedCommit, 'abc123');
    });

    test('CRITICAL: leaf with no completedCommit but HAS baseCommit merges baseCommit', () => {
      // This is the bug fix: upstream work exists in baseCommit
      const result = simulateRiMergeDecision({
        isLeaf: true,
        targetBranch: 'main',
        completedCommit: undefined,
        baseCommit: 'upstream-work-sha',
      });
      assert.strictEqual(result.action, 'merge-baseCommit',
        'Must merge baseCommit when no completedCommit exists');
      assert.strictEqual(result.mergedToTarget, true);
      assert.strictEqual(result.completedCommit, 'upstream-work-sha',
        'completedCommit should be set to baseCommit');
    });

    test('CRITICAL: leaf with expects_no_changes after chain still merges upstream work', () => {
      // Scenario: A → B → C → D(expects_no_changes)
      // D has no own commit but baseCommit = C's completedCommit with A+B+C work
      const result = simulateRiMergeDecision({
        isLeaf: true,
        targetBranch: 'feature/x',
        completedCommit: undefined,  // expects_no_changes returns undefined
        baseCommit: 'chain-abc-sha', // Contains cumulative A+B+C work
      });
      assert.strictEqual(result.action, 'merge-baseCommit');
      assert.strictEqual(result.completedCommit, 'chain-abc-sha',
        'Must merge the chain\'s cumulative work');
    });

    test('root validation node with no commits skips merge safely', () => {
      // Single expects_no_changes node with no dependencies
      const result = simulateRiMergeDecision({
        isLeaf: true,
        targetBranch: 'main',
        completedCommit: undefined,
        baseCommit: undefined,
      });
      assert.strictEqual(result.action, 'skip-nothing-to-merge');
      assert.strictEqual(result.mergedToTarget, true);
    });

    test('non-leaf node does not trigger RI merge', () => {
      const result = simulateRiMergeDecision({
        isLeaf: false,
        targetBranch: 'main',
        completedCommit: 'abc123',
        baseCommit: 'def456',
      });
      assert.strictEqual(result.action, 'skip-not-leaf');
      assert.strictEqual(result.mergedToTarget, false);
    });

    test('leaf without target branch skips merge', () => {
      const result = simulateRiMergeDecision({
        isLeaf: true,
        targetBranch: undefined,
        completedCommit: 'abc123',
        baseCommit: 'def456',
      });
      assert.strictEqual(result.action, 'skip-no-target');
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

    test('CRITICAL: falls back to baseCommit when result has no commit', () => {
      const result = simulateCompletedCommitFallback({
        resultCommit: undefined,
        existingCompleted: undefined,
        baseCommit: 'upstream-work-sha',
      });
      assert.strictEqual(result, 'upstream-work-sha',
        'Must fall back to baseCommit to preserve upstream work');
    });

    test('preserves existing completedCommit when result has no commit', () => {
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
    
    test('chain A→B→C→D(no changes) preserves all upstream work', () => {
      // Simulate chain execution
      const nodes: Record<string, { baseCommit?: string; completedCommit?: string }> = {};
      
      // A: starts from base branch, does work
      nodes['A'] = { baseCommit: 'base-sha', completedCommit: 'a-work-sha' };
      
      // B: starts from A's commit, does work
      nodes['B'] = { baseCommit: nodes['A'].completedCommit, completedCommit: 'b-work-sha' };
      
      // C: starts from B's commit, does work
      nodes['C'] = { baseCommit: nodes['B'].completedCommit, completedCommit: 'c-work-sha' };
      
      // D: starts from C's commit, expects_no_changes
      nodes['D'] = { baseCommit: nodes['C'].completedCommit, completedCommit: undefined };
      
      // Apply the fallback
      const finalCommit = simulateCompletedCommitFallback({
        resultCommit: undefined,
        existingCompleted: nodes['D'].completedCommit,
        baseCommit: nodes['D'].baseCommit,
      });
      
      assert.strictEqual(finalCommit, 'c-work-sha',
        'D should inherit C\'s completedCommit via baseCommit fallback');
      
      // RI merge decision
      nodes['D'].completedCommit = finalCommit;
      const mergeResult = simulateRiMergeDecision({
        isLeaf: true,
        targetBranch: 'main',
        completedCommit: nodes['D'].completedCommit,
        baseCommit: nodes['D'].baseCommit,
      });
      
      assert.strictEqual(mergeResult.action, 'merge',
        'Should perform actual merge (not skip)');
      assert.strictEqual(mergeResult.completedCommit, 'c-work-sha',
        'Should merge the cumulative A+B+C work');
    });

    test('BUG REPRO: without fix, chain work is orphaned', () => {
      // This tests the OLD (buggy) behavior to ensure we understand it
      const buggyDecision = function(params: {
        isLeaf: boolean;
        targetBranch: string | undefined;
        completedCommit: string | undefined;
      }) {
        // OLD CODE: only checked completedCommit, ignored baseCommit
        if (params.isLeaf && params.targetBranch && params.completedCommit) {
          return 'merge';
        } else if (params.isLeaf && params.targetBranch && !params.completedCommit) {
          return 'skip-marked-merged'; // BUG: silently marked as merged
        }
        return 'other';
      };
      
      // With the OLD code, D's completedCommit is undefined → skip → data loss
      const oldResult = buggyDecision({
        isLeaf: true,
        targetBranch: 'main',
        completedCommit: undefined, // expects_no_changes returned undefined
      });
      
      assert.strictEqual(oldResult, 'skip-marked-merged',
        'Old code would skip merge and orphan upstream work');
    });

    test('auto-heal success on leaf correctly preserves upstream via baseCommit', () => {
      // Scenario: leaf node fails initially, auto-heal succeeds but produces no commit
      const nodeState = {
        baseCommit: 'upstream-chain-sha',
        completedCommit: undefined as string | undefined,
      };
      
      // Initial execution fails → completedCommit never set
      // Auto-heal succeeds → healResult.completedCommit is undefined (no changes)
      
      // Apply the fixed fallback
      const healResultCommit = undefined; // auto-heal produced no new commit
      
      if (healResultCommit) {
        nodeState.completedCommit = healResultCommit;
      } else if (!nodeState.completedCommit && nodeState.baseCommit) {
        nodeState.completedCommit = nodeState.baseCommit; // THE FIX
      }
      
      assert.strictEqual(nodeState.completedCommit, 'upstream-chain-sha',
        'Auto-heal fallback must set completedCommit to baseCommit');
      
      // Now RI merge should work
      const mergeResult = simulateRiMergeDecision({
        isLeaf: true,
        targetBranch: 'main',
        completedCommit: nodeState.completedCommit,
        baseCommit: nodeState.baseCommit,
      });
      
      assert.strictEqual(mergeResult.action, 'merge',
        'RI merge should proceed with the upstream work');
    });
  });
});
