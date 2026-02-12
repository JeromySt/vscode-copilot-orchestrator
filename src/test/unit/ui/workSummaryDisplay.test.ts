/**
 * @fileoverview Unit tests for work summary display behavior
 *
 * Tests verify that the UI layer correctly handles undefined from computeMergedLeafWorkSummary
 * and does NOT fall back to showing all work when no leaves have merged to target.
 */

import * as assert from 'assert';
import { planDetailPanel } from '../../../ui/panels/planDetailPanel';
import type { PlanInstance, JobNode, NodeExecutionState } from '../../../plan/types';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Suppress Logger console output to avoid hanging test workers. */
function silenceConsole(): { restore: () => void } {
  const origLog = console.log;
  const origDebug = console.debug;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = () => {};
  console.debug = () => {};
  console.warn = () => {};
  console.error = () => {};

  return {
    restore: () => {
      console.log = origLog;
      console.debug = origDebug;
      console.warn = origWarn;
      console.error = origError;
    }
  };
}

/**
 * Initialize helper methods on a panel instance for testing
 */
function initializePanelHelpers(panel: any): void {
  panel._sanitizeId = (id: string) => 'n' + id.replace(/-/g, '');
  panel._escapeForMermaid = (str: string) => str.replace(/"/g, "'").replace(/[<>{}|:#]/g, '').replace(/\[/g, '(').replace(/\]/g, ')');
  panel._getStatusIcon = () => '⏸';
  panel._truncateLabel = (name: string, durationLabel: string, maxLen: number): string => {
    const totalLen = 2 + name.length + durationLabel.length;
    if (totalLen <= maxLen) {
      return name;
    }
    const available = maxLen - 2 - durationLabel.length - 3;
    if (available <= 0) {
      return name;
    }
    return name.slice(0, available) + '...';
  };
}

/** Create a minimal plan for testing work summary display. */
function createMockPlan(opts: {
  targetBranch?: string;
  leaves?: string[];
  workSummary?: any;
}): PlanInstance {
  return {
    id: uuidv4(),
    leaves: opts.leaves || [],
    workSummary: opts.workSummary,
    targetBranch: opts.targetBranch,
    // Required fields (minimal stubs)
    spec: { name: 'test-plan', jobs: [] },
    nodes: new Map<string, JobNode>(),
    nodeStates: new Map<string, NodeExecutionState>(),
    producerIdToNodeId: new Map(),
    roots: [],
    groups: new Map(),
    groupStates: new Map(),
    groupPathToId: new Map(),
    repoPath: '/test',
    baseBranch: 'main',
    worktreeRoot: '/test/worktrees',
    createdAt: Date.now(),
    stateVersion: 0,
    cleanUpSuccessfulWork: true,
    maxParallel: 4,
  } as PlanInstance;
}

// ---------------------------------------------------------------------------
// Tests  
// ---------------------------------------------------------------------------

suite('Work Summary Display', () => {
  let consoleSilencer: { restore: () => void };

  setup(() => {
    consoleSilencer = silenceConsole();
  });

  teardown(() => {
    consoleSilencer.restore();
  });

  suite('_buildWorkSummaryHtml', () => {
    test('returns empty string when computeMergedLeafWorkSummary returns undefined', () => {
      const plan = createMockPlan({
        targetBranch: 'main',
        leaves: ['leaf-1'],
        workSummary: {
          totalCommits: 5,
          totalFilesAdded: 10,
          totalFilesModified: 3,
          totalFilesDeleted: 1,
          jobSummaries: [
            { nodeId: 'ancestor', nodeName: 'Ancestor', commits: 2, filesAdded: 3, filesModified: 1, filesDeleted: 0, description: 'ancestor work' },
            { nodeId: 'leaf-1', nodeName: 'Leaf1', commits: 3, filesAdded: 7, filesModified: 2, filesDeleted: 1, description: 'leaf work' },
          ],
        }
      });
      
      // Set up nodeStates so that leaf is NOT merged to target
      plan.nodeStates.set('ancestor', { status: 'succeeded', version: 1, attempts: 1, mergedToTarget: false });
      plan.nodeStates.set('leaf-1', { status: 'running', version: 1, attempts: 1, mergedToTarget: false });
      
      // Create a panel instance to access the private method (using same pattern as group tests)
      const panel = Object.create(planDetailPanel.prototype);
      initializePanelHelpers(panel);
      const result = panel._buildWorkSummaryHtml(plan);
      
      // Should return empty string, NOT fall back to showing all work from plan.workSummary
      assert.strictEqual(result, '');
    });

    test('shows work when some leaves have merged to target', () => {
      const plan = createMockPlan({
        targetBranch: 'main',
        leaves: ['leaf-1', 'leaf-2'],
        workSummary: {
          totalCommits: 10,
          totalFilesAdded: 15,
          totalFilesModified: 8,
          totalFilesDeleted: 3,
          jobSummaries: [
            { nodeId: 'ancestor', nodeName: 'Ancestor', commits: 3, filesAdded: 5, filesModified: 2, filesDeleted: 1, description: 'ancestor work' },
            { nodeId: 'leaf-1', nodeName: 'Leaf1', commits: 4, filesAdded: 6, filesModified: 3, filesDeleted: 1, description: 'merged leaf work' },
            { nodeId: 'leaf-2', nodeName: 'Leaf2', commits: 3, filesAdded: 4, filesModified: 3, filesDeleted: 1, description: 'not merged leaf work' },
          ],
        }
      });
      
      // Set up nodeStates so that only leaf-1 is merged to target
      plan.nodeStates.set('ancestor', { status: 'succeeded', version: 1, attempts: 1, mergedToTarget: false });
      plan.nodeStates.set('leaf-1', { status: 'succeeded', version: 1, attempts: 1, mergedToTarget: true });
      plan.nodeStates.set('leaf-2', { status: 'running', version: 1, attempts: 1, mergedToTarget: false });
      
      // Create a panel instance to access the private method
      const panel = Object.create(planDetailPanel.prototype);
      initializePanelHelpers(panel);
      const result = panel._buildWorkSummaryHtml(plan);
      
      // Should show only leaf-1's work (4 commits, 6 added files)
      assert.ok(result.length > 0, 'Should return non-empty HTML when merged work exists');
      assert.ok(result.includes('4'), 'Should include commit count from merged leaf only');
      // Should NOT include the total counts from plan.workSummary (10 commits, 15 files)
      assert.ok(!result.includes('10'), 'Should NOT show total commit count from plan.workSummary');
    });

    test('shows all work when no target branch (backward compatible)', () => {
      const plan = createMockPlan({
        targetBranch: undefined, // No target branch
        leaves: ['leaf-1'],
        workSummary: {
          totalCommits: 5,
          totalFilesAdded: 10,
          totalFilesModified: 3,
          totalFilesDeleted: 1,
          jobSummaries: [
            { nodeId: 'leaf-1', nodeName: 'Leaf1', commits: 5, filesAdded: 10, filesModified: 3, filesDeleted: 1, description: 'all work' },
          ],
        }
      });
      
      // Create a panel instance to access the private method
      const panel = Object.create(planDetailPanel.prototype);
      initializePanelHelpers(panel);
      const result = panel._buildWorkSummaryHtml(plan);
      
      // Should show all work when no target branch
      assert.ok(result.length > 0, 'Should return non-empty HTML when no target branch');
      assert.ok(result.includes('5'), 'Should include all commits when no target branch');
      assert.ok(result.includes('10'), 'Should include all files when no target branch');
    });

    test('returns empty string when no work summary at all', () => {
      const plan = createMockPlan({
        targetBranch: 'main',
        leaves: ['leaf-1'],
        workSummary: undefined
      });
      
      // Create a panel instance to access the private method
      const panel = Object.create(planDetailPanel.prototype);
      initializePanelHelpers(panel);
      const result = panel._buildWorkSummaryHtml(plan);
      
      // Should return empty string when no work summary exists
      assert.strictEqual(result, '');
    });
  });
});