/**
 * @fileoverview Tests for plan helpers (src/plan/helpers.ts).
 */

import * as assert from 'assert';
import {
  formatLogEntry,
  formatLogEntries,
  computeStatusCounts,
  computeProgress,
  computePlanStatus,
  computeEffectiveEndedAt,
  createEmptyWorkSummary,
  appendWorkSummary,
  mergeWorkSummary,
  computeMergedLeafWorkSummary,
} from '../../../plan/helpers';
import { NodeExecutionState, LogEntry, JobWorkSummary, PlanInstance } from '../../../plan/types';

suite('Plan Helpers', () => {
  // =========================================================================
  // formatLogEntry
  // =========================================================================

  suite('formatLogEntry', () => {
    test('formats stdout entry without prefix', () => {
      const entry: LogEntry = { type: 'stdout', message: 'hello', timestamp: Date.now(), phase: 'work' };
      assert.strictEqual(formatLogEntry(entry), 'hello');
    });

    test('formats stderr entry with ERR prefix', () => {
      const entry: LogEntry = { type: 'stderr', message: 'error msg', timestamp: Date.now(), phase: 'work' };
      const result = formatLogEntry(entry);
      assert.ok(result.includes('[ERR]'));
      assert.ok(result.includes('error msg'));
    });

    test('formats error entry with ERROR prefix', () => {
      const entry: LogEntry = { type: 'error', message: 'big error', timestamp: Date.now(), phase: 'work' };
      const result = formatLogEntry(entry);
      assert.ok(result.includes('[ERROR]'));
    });

    test('formats info entry with INFO prefix', () => {
      const entry: LogEntry = { type: 'info', message: 'info msg', timestamp: Date.now(), phase: 'work' };
      const result = formatLogEntry(entry);
      assert.ok(result.includes('[INFO]'));
    });
  });

  suite('formatLogEntries', () => {
    test('joins multiple entries with newlines', () => {
      const entries: LogEntry[] = [
        { type: 'stdout', message: 'line1', timestamp: Date.now(), phase: 'work' },
        { type: 'stdout', message: 'line2', timestamp: Date.now(), phase: 'work' },
      ];
      const result = formatLogEntries(entries);
      assert.strictEqual(result, 'line1\nline2');
    });
  });

  // =========================================================================
  // computeStatusCounts
  // =========================================================================

  suite('computeStatusCounts', () => {
    test('counts empty iterable', () => {
      const counts = computeStatusCounts([]);
      assert.strictEqual(counts.pending, 0);
      assert.strictEqual(counts.succeeded, 0);
    });

    test('counts various statuses', () => {
      const states: NodeExecutionState[] = [
        { status: 'pending', version: 0, attempts: 0 },
        { status: 'running', version: 0, attempts: 0 },
        { status: 'succeeded', version: 0, attempts: 0 },
        { status: 'failed', version: 0, attempts: 0 },
      ];
      const counts = computeStatusCounts(states);
      assert.strictEqual(counts.pending, 1);
      assert.strictEqual(counts.running, 1);
      assert.strictEqual(counts.succeeded, 1);
      assert.strictEqual(counts.failed, 1);
    });
  });

  // =========================================================================
  // computeProgress
  // =========================================================================

  suite('computeProgress', () => {
    test('returns 0 for zero total', () => {
      const counts = computeStatusCounts([]);
      assert.strictEqual(computeProgress(counts, 0), 0);
    });

    test('returns 0 when nothing completed', () => {
      const states: NodeExecutionState[] = [
        { status: 'pending', version: 0, attempts: 0 },
        { status: 'running', version: 0, attempts: 0 },
      ];
      const counts = computeStatusCounts(states);
      assert.strictEqual(computeProgress(counts, 2), 0);
    });

    test('returns 1 when all succeeded', () => {
      const states: NodeExecutionState[] = [
        { status: 'succeeded', version: 0, attempts: 0 },
        { status: 'succeeded', version: 0, attempts: 0 },
      ];
      const counts = computeStatusCounts(states);
      assert.strictEqual(computeProgress(counts, 2), 1);
    });

    test('returns partial progress', () => {
      const states: NodeExecutionState[] = [
        { status: 'succeeded', version: 0, attempts: 0 },
        { status: 'pending', version: 0, attempts: 0 },
      ];
      const counts = computeStatusCounts(states);
      assert.strictEqual(computeProgress(counts, 2), 0.5);
    });

    test('counts failed/blocked/canceled as completed', () => {
      const states: NodeExecutionState[] = [
        { status: 'failed', version: 0, attempts: 0 },
        { status: 'blocked', version: 0, attempts: 0 },
        { status: 'canceled', version: 0, attempts: 0 },
        { status: 'pending', version: 0, attempts: 0 },
      ];
      const counts = computeStatusCounts(states);
      assert.strictEqual(computeProgress(counts, 4), 0.75);
    });
  });

  // =========================================================================
  // computePlanStatus
  // =========================================================================

  suite('computePlanStatus', () => {
    test('returns pending when not started', () => {
      const states: NodeExecutionState[] = [
        { status: 'pending', version: 0, attempts: 0 },
      ];
      assert.strictEqual(computePlanStatus(states, false), 'pending');
    });

    test('returns running when has running nodes', () => {
      const states: NodeExecutionState[] = [
        { status: 'running', version: 0, attempts: 0 },
        { status: 'pending', version: 0, attempts: 0 },
      ];
      assert.strictEqual(computePlanStatus(states, true), 'running');
    });

    test('returns running when scheduled', () => {
      const states: NodeExecutionState[] = [
        { status: 'scheduled', version: 0, attempts: 0 },
      ];
      assert.strictEqual(computePlanStatus(states, true), 'running');
    });

    test('returns succeeded when all succeeded', () => {
      const states: NodeExecutionState[] = [
        { status: 'succeeded', version: 0, attempts: 0 },
      ];
      assert.strictEqual(computePlanStatus(states, true), 'succeeded');
    });

    test('returns failed when all failed', () => {
      const states: NodeExecutionState[] = [
        { status: 'failed', version: 0, attempts: 0 },
      ];
      assert.strictEqual(computePlanStatus(states, true), 'failed');
    });

    test('returns partial when mixed succeeded/failed', () => {
      const states: NodeExecutionState[] = [
        { status: 'succeeded', version: 0, attempts: 0 },
        { status: 'failed', version: 0, attempts: 0 },
      ];
      assert.strictEqual(computePlanStatus(states, true), 'partial');
    });

    test('returns canceled when any canceled', () => {
      const states: NodeExecutionState[] = [
        { status: 'canceled', version: 0, attempts: 0 },
      ];
      assert.strictEqual(computePlanStatus(states, true), 'canceled');
    });

    test('returns failed when all blocked', () => {
      const states: NodeExecutionState[] = [
        { status: 'blocked', version: 0, attempts: 0 },
      ];
      assert.strictEqual(computePlanStatus(states, true), 'failed');
    });

    test('returns paused when isPaused and has non-terminal nodes', () => {
      const states: NodeExecutionState[] = [
        { status: 'pending', version: 0, attempts: 0 },
        { status: 'succeeded', version: 0, attempts: 0 },
      ];
      assert.strictEqual(computePlanStatus(states, true, true), 'paused');
    });

    test('returns final status when paused but all nodes terminal', () => {
      const states: NodeExecutionState[] = [
        { status: 'succeeded', version: 0, attempts: 0 },
      ];
      assert.strictEqual(computePlanStatus(states, true, true), 'succeeded');
    });

    test('returns running when has ready nodes and started', () => {
      const states: NodeExecutionState[] = [
        { status: 'ready', version: 0, attempts: 0 },
      ];
      assert.strictEqual(computePlanStatus(states, true), 'running');
    });
  });

  // =========================================================================
  // computeEffectiveEndedAt
  // =========================================================================

  suite('computeEffectiveEndedAt', () => {
    test('returns undefined for empty states', () => {
      assert.strictEqual(computeEffectiveEndedAt([]), undefined);
    });

    test('returns undefined when no endedAt', () => {
      const states: NodeExecutionState[] = [
        { status: 'running', version: 0, attempts: 0 },
      ];
      assert.strictEqual(computeEffectiveEndedAt(states), undefined);
    });

    test('returns max endedAt', () => {
      const states: NodeExecutionState[] = [
        { status: 'succeeded', version: 0, attempts: 0, endedAt: 100 },
        { status: 'succeeded', version: 0, attempts: 0, endedAt: 200 },
        { status: 'succeeded', version: 0, attempts: 0, endedAt: 150 },
      ];
      assert.strictEqual(computeEffectiveEndedAt(states), 200);
    });
  });

  // =========================================================================
  // Work Summary helpers
  // =========================================================================

  suite('createEmptyWorkSummary', () => {
    test('creates summary with all zeros', () => {
      const ws = createEmptyWorkSummary();
      assert.strictEqual(ws.totalCommits, 0);
      assert.strictEqual(ws.totalFilesAdded, 0);
      assert.strictEqual(ws.totalFilesModified, 0);
      assert.strictEqual(ws.totalFilesDeleted, 0);
      assert.deepStrictEqual(ws.jobSummaries, []);
    });
  });

  suite('appendWorkSummary', () => {
    test('appends to existing summary', () => {
      const ws = createEmptyWorkSummary();
      const job: JobWorkSummary = {
        nodeId: 'n1',
        nodeName: 'Job1',
        commits: 2,
        filesAdded: 3,
        filesModified: 1,
        filesDeleted: 0,
        description: 'test job',
      };
      const result = appendWorkSummary(ws, job);
      assert.strictEqual(result.totalCommits, 2);
      assert.strictEqual(result.totalFilesAdded, 3);
      assert.strictEqual(result.jobSummaries.length, 1);
    });

    test('creates new summary when undefined', () => {
      const job: JobWorkSummary = {
        nodeId: 'n1',
        nodeName: 'Job1',
        commits: 1,
        filesAdded: 0,
        filesModified: 5,
        filesDeleted: 2,
        description: 'test job 2',
      };
      const result = appendWorkSummary(undefined, job);
      assert.strictEqual(result.totalCommits, 1);
      assert.strictEqual(result.totalFilesModified, 5);
      assert.strictEqual(result.totalFilesDeleted, 2);
    });
  });

  suite('mergeWorkSummary', () => {
    test('merges child into parent', () => {
      const parent = createEmptyWorkSummary();
      parent.totalCommits = 5;
      const child = createEmptyWorkSummary();
      child.totalCommits = 3;
      child.totalFilesAdded = 2;
      child.jobSummaries.push({
        nodeId: 'c1',
        nodeName: 'Child',
        commits: 3,
        filesAdded: 2,
        filesModified: 0,
        filesDeleted: 0,
        description: 'child job',
      });

      const result = mergeWorkSummary(parent, child);
      assert.strictEqual(result.totalCommits, 8);
      assert.strictEqual(result.totalFilesAdded, 2);
      assert.strictEqual(result.jobSummaries.length, 1);
    });

    test('returns new summary when parent undefined', () => {
      const child = createEmptyWorkSummary();
      child.totalCommits = 1;
      const result = mergeWorkSummary(undefined, child);
      assert.strictEqual(result.totalCommits, 1);
    });

    test('returns parent when child undefined', () => {
      const parent = createEmptyWorkSummary();
      parent.totalCommits = 5;
      const result = mergeWorkSummary(parent, undefined);
      assert.strictEqual(result.totalCommits, 5);
    });
  });

  // =========================================================================
  // computeMergedLeafWorkSummary
  // =========================================================================

  suite('computeMergedLeafWorkSummary', () => {
    // Helper to create a minimal PlanInstance for testing
    function createTestPlan(
      leaves: string[],
      workSummary: any,
      targetBranch?: string
    ): PlanInstance {
      return {
        id: 'test-plan',
        leaves,
        workSummary,
        targetBranch,
        // Other required fields (minimal stubs)
        spec: { name: 'test', jobs: [] },
        nodes: new Map(),
        producerIdToNodeId: new Map(),
        roots: [],
        nodeStates: new Map(),
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

    test('returns undefined when plan has no work summary', () => {
      const plan = createTestPlan(['n1'], undefined);
      const nodeStates = new Map<string, NodeExecutionState>();
      
      const result = computeMergedLeafWorkSummary(plan, nodeStates);
      assert.strictEqual(result, undefined);
    });

    test('returns undefined when work summary has no job summaries', () => {
      const plan = createTestPlan(['n1'], createEmptyWorkSummary());
      const nodeStates = new Map<string, NodeExecutionState>();
      
      const result = computeMergedLeafWorkSummary(plan, nodeStates);
      assert.strictEqual(result, undefined);
    });

    test('returns full work summary when no target branch', () => {
      const workSummary = {
        totalCommits: 5,
        totalFilesAdded: 3,
        totalFilesModified: 2,
        totalFilesDeleted: 1,
        jobSummaries: [
          { nodeId: 'n1', nodeName: 'Job1', commits: 5, filesAdded: 3, filesModified: 2, filesDeleted: 1, description: 'test' },
        ],
      };
      const plan = createTestPlan(['n1'], workSummary, undefined);
      const nodeStates = new Map<string, NodeExecutionState>();
      
      const result = computeMergedLeafWorkSummary(plan, nodeStates);
      assert.strictEqual(result, workSummary);
    });

    test('filters out non-leaf nodes', () => {
      const workSummary = {
        totalCommits: 7,
        totalFilesAdded: 5,
        totalFilesModified: 3,
        totalFilesDeleted: 2,
        jobSummaries: [
          { nodeId: 'n1', nodeName: 'Job1', commits: 3, filesAdded: 2, filesModified: 1, filesDeleted: 0, description: 'leaf' },
          { nodeId: 'n2', nodeName: 'Job2', commits: 4, filesAdded: 3, filesModified: 2, filesDeleted: 2, description: 'non-leaf' },
        ],
      };
      const plan = createTestPlan(['n1'], workSummary, 'main');
      const nodeStates = new Map<string, NodeExecutionState>([
        ['n1', { status: 'succeeded', version: 1, attempts: 1, mergedToTarget: true }],
        ['n2', { status: 'succeeded', version: 1, attempts: 1, mergedToTarget: true }],
      ]);
      
      const result = computeMergedLeafWorkSummary(plan, nodeStates);
      assert.ok(result);
      assert.strictEqual(result.totalCommits, 3);
      assert.strictEqual(result.totalFilesAdded, 2);
      assert.strictEqual(result.totalFilesModified, 1);
      assert.strictEqual(result.totalFilesDeleted, 0);
      assert.strictEqual(result.jobSummaries.length, 1);
      assert.strictEqual(result.jobSummaries[0].nodeId, 'n1');
    });

    test('filters out leaf nodes not merged to target', () => {
      const workSummary = {
        totalCommits: 7,
        totalFilesAdded: 5,
        totalFilesModified: 3,
        totalFilesDeleted: 2,
        jobSummaries: [
          { nodeId: 'n1', nodeName: 'Job1', commits: 3, filesAdded: 2, filesModified: 1, filesDeleted: 0, description: 'merged' },
          { nodeId: 'n2', nodeName: 'Job2', commits: 4, filesAdded: 3, filesModified: 2, filesDeleted: 2, description: 'not merged' },
        ],
      };
      const plan = createTestPlan(['n1', 'n2'], workSummary, 'main');
      const nodeStates = new Map<string, NodeExecutionState>([
        ['n1', { status: 'succeeded', version: 1, attempts: 1, mergedToTarget: true }],
        ['n2', { status: 'succeeded', version: 1, attempts: 1, mergedToTarget: false }],
      ]);
      
      const result = computeMergedLeafWorkSummary(plan, nodeStates);
      assert.ok(result);
      assert.strictEqual(result.totalCommits, 3);
      assert.strictEqual(result.totalFilesAdded, 2);
      assert.strictEqual(result.jobSummaries.length, 1);
      assert.strictEqual(result.jobSummaries[0].nodeId, 'n1');
    });

    test('returns undefined when no leaf nodes are merged', () => {
      const workSummary = {
        totalCommits: 4,
        totalFilesAdded: 3,
        totalFilesModified: 2,
        totalFilesDeleted: 2,
        jobSummaries: [
          { nodeId: 'n1', nodeName: 'Job1', commits: 4, filesAdded: 3, filesModified: 2, filesDeleted: 2, description: 'not merged' },
        ],
      };
      const plan = createTestPlan(['n1'], workSummary, 'main');
      const nodeStates = new Map<string, NodeExecutionState>([
        ['n1', { status: 'succeeded', version: 1, attempts: 1, mergedToTarget: false }],
      ]);
      
      const result = computeMergedLeafWorkSummary(plan, nodeStates);
      assert.strictEqual(result, undefined);
    });

    test('includes multiple merged leaf nodes', () => {
      const workSummary = {
        totalCommits: 10,
        totalFilesAdded: 8,
        totalFilesModified: 5,
        totalFilesDeleted: 3,
        jobSummaries: [
          { nodeId: 'n1', nodeName: 'Job1', commits: 3, filesAdded: 2, filesModified: 1, filesDeleted: 0, description: 'leaf1' },
          { nodeId: 'n2', nodeName: 'Job2', commits: 4, filesAdded: 3, filesModified: 2, filesDeleted: 1, description: 'leaf2' },
          { nodeId: 'n3', nodeName: 'Job3', commits: 3, filesAdded: 3, filesModified: 2, filesDeleted: 2, description: 'leaf3' },
        ],
      };
      const plan = createTestPlan(['n1', 'n2', 'n3'], workSummary, 'main');
      const nodeStates = new Map<string, NodeExecutionState>([
        ['n1', { status: 'succeeded', version: 1, attempts: 1, mergedToTarget: true }],
        ['n2', { status: 'succeeded', version: 1, attempts: 1, mergedToTarget: true }],
        ['n3', { status: 'succeeded', version: 1, attempts: 1, mergedToTarget: true }],
      ]);
      
      const result = computeMergedLeafWorkSummary(plan, nodeStates);
      assert.ok(result);
      assert.strictEqual(result.totalCommits, 10);
      assert.strictEqual(result.totalFilesAdded, 8);
      assert.strictEqual(result.totalFilesModified, 5);
      assert.strictEqual(result.totalFilesDeleted, 3);
      assert.strictEqual(result.jobSummaries.length, 3);
    });

    test('handles mixed leaf and non-leaf, merged and unmerged', () => {
      const workSummary = {
        totalCommits: 20,
        totalFilesAdded: 15,
        totalFilesModified: 10,
        totalFilesDeleted: 5,
        jobSummaries: [
          { nodeId: 'n1', nodeName: 'Job1', commits: 5, filesAdded: 4, filesModified: 3, filesDeleted: 1, description: 'leaf merged' },
          { nodeId: 'n2', nodeName: 'Job2', commits: 5, filesAdded: 4, filesModified: 3, filesDeleted: 1, description: 'non-leaf merged' },
          { nodeId: 'n3', nodeName: 'Job3', commits: 5, filesAdded: 4, filesModified: 2, filesDeleted: 2, description: 'leaf not merged' },
          { nodeId: 'n4', nodeName: 'Job4', commits: 5, filesAdded: 3, filesModified: 2, filesDeleted: 1, description: 'leaf merged' },
        ],
      };
      const plan = createTestPlan(['n1', 'n3', 'n4'], workSummary, 'main');
      const nodeStates = new Map<string, NodeExecutionState>([
        ['n1', { status: 'succeeded', version: 1, attempts: 1, mergedToTarget: true }],
        ['n2', { status: 'succeeded', version: 1, attempts: 1, mergedToTarget: true }],
        ['n3', { status: 'succeeded', version: 1, attempts: 1, mergedToTarget: false }],
        ['n4', { status: 'succeeded', version: 1, attempts: 1, mergedToTarget: true }],
      ]);
      
      const result = computeMergedLeafWorkSummary(plan, nodeStates);
      assert.ok(result);
      assert.strictEqual(result.totalCommits, 10);
      assert.strictEqual(result.totalFilesAdded, 7);
      assert.strictEqual(result.totalFilesModified, 5);
      assert.strictEqual(result.totalFilesDeleted, 2);
      assert.strictEqual(result.jobSummaries.length, 2);
      assert.strictEqual(result.jobSummaries[0].nodeId, 'n1');
      assert.strictEqual(result.jobSummaries[1].nodeId, 'n4');
    });

    test('handles node state without mergedToTarget field', () => {
      const workSummary = {
        totalCommits: 3,
        totalFilesAdded: 2,
        totalFilesModified: 1,
        totalFilesDeleted: 0,
        jobSummaries: [
          { nodeId: 'n1', nodeName: 'Job1', commits: 3, filesAdded: 2, filesModified: 1, filesDeleted: 0, description: 'leaf' },
        ],
      };
      const plan = createTestPlan(['n1'], workSummary, 'main');
      const nodeStates = new Map<string, NodeExecutionState>([
        ['n1', { status: 'succeeded', version: 1, attempts: 1 }], // no mergedToTarget field
      ]);
      
      const result = computeMergedLeafWorkSummary(plan, nodeStates);
      assert.strictEqual(result, undefined);
    });

    test('uses aggregatedWorkSummary when available', () => {
      const workSummary = {
        totalCommits: 1,
        totalFilesAdded: 1,
        totalFilesModified: 0,
        totalFilesDeleted: 0,
        jobSummaries: [
          { nodeId: 'leaf1', nodeName: 'Job1', commits: 1, filesAdded: 1, filesModified: 0, filesDeleted: 0, description: 'job work' },
        ],
      };
      const plan = createTestPlan(['leaf1'], workSummary, 'main');
      
      // Node has aggregatedWorkSummary (shows total DAG work)
      const nodeStates = new Map<string, NodeExecutionState>([
        ['leaf1', {
          status: 'succeeded',
          version: 1,
          attempts: 1,
          mergedToTarget: true,
          workSummary: { nodeId: 'leaf1', nodeName: 'Job1', commits: 1, filesAdded: 1, filesModified: 0, filesDeleted: 0, description: 'job work' },
          aggregatedWorkSummary: { nodeId: 'leaf1', nodeName: 'Job1', commits: 5, filesAdded: 10, filesModified: 3, filesDeleted: 1, description: 'aggregated work' }
        }],
      ]);
      
      const result = computeMergedLeafWorkSummary(plan, nodeStates);
      assert.ok(result);
      // Should use aggregated (10 files) not job-specific (1 file)
      assert.strictEqual(result.totalFilesAdded, 10);
      assert.strictEqual(result.totalFilesModified, 3);
      assert.strictEqual(result.totalFilesDeleted, 1);
      assert.strictEqual(result.totalCommits, 5);
      assert.strictEqual(result.jobSummaries.length, 1);
      assert.strictEqual(result.jobSummaries[0].description, 'aggregated work');
    });

    test('prefers aggregatedWorkSummary over workSummary when both present', () => {
      const workSummary = {
        totalCommits: 20,
        totalFilesAdded: 20,
        totalFilesModified: 20,
        totalFilesDeleted: 20,
        jobSummaries: [
          { nodeId: 'leaf1', nodeName: 'Job1', commits: 10, filesAdded: 10, filesModified: 10, filesDeleted: 10, description: 'wrong' },
          { nodeId: 'leaf2', nodeName: 'Job2', commits: 10, filesAdded: 10, filesModified: 10, filesDeleted: 10, description: 'wrong' },
        ],
      };
      const plan = createTestPlan(['leaf1', 'leaf2'], workSummary, 'main');
      
      const nodeStates = new Map<string, NodeExecutionState>([
        ['leaf1', {
          status: 'succeeded',
          version: 1,
          attempts: 1,
          mergedToTarget: true,
          workSummary: { nodeId: 'leaf1', nodeName: 'Job1', commits: 10, filesAdded: 10, filesModified: 10, filesDeleted: 10, description: 'wrong' },
          aggregatedWorkSummary: { nodeId: 'leaf1', nodeName: 'Job1', commits: 3, filesAdded: 5, filesModified: 2, filesDeleted: 1, description: 'correct1' }
        }],
        ['leaf2', {
          status: 'succeeded',
          version: 1,
          attempts: 1,
          mergedToTarget: true,
          workSummary: { nodeId: 'leaf2', nodeName: 'Job2', commits: 10, filesAdded: 10, filesModified: 10, filesDeleted: 10, description: 'wrong' },
          aggregatedWorkSummary: { nodeId: 'leaf2', nodeName: 'Job2', commits: 2, filesAdded: 3, filesModified: 1, filesDeleted: 0, description: 'correct2' }
        }],
      ]);
      
      const result = computeMergedLeafWorkSummary(plan, nodeStates);
      assert.ok(result);
      // Should use aggregated summaries from nodeStates
      assert.strictEqual(result.totalCommits, 5); // 3 + 2
      assert.strictEqual(result.totalFilesAdded, 8); // 5 + 3
      assert.strictEqual(result.totalFilesModified, 3); // 2 + 1
      assert.strictEqual(result.totalFilesDeleted, 1); // 1 + 0
      assert.strictEqual(result.jobSummaries.length, 2);
    });

    test('falls back to workSummary when aggregatedWorkSummary not present', () => {
      const workSummary = {
        totalCommits: 2,
        totalFilesAdded: 3,
        totalFilesModified: 1,
        totalFilesDeleted: 0,
        jobSummaries: [
          { nodeId: 'leaf1', nodeName: 'Job1', commits: 2, filesAdded: 3, filesModified: 1, filesDeleted: 0, description: 'fallback' },
        ],
      };
      const plan = createTestPlan(['leaf1'], workSummary, 'main');
      
      // Node without aggregatedWorkSummary
      const nodeStates = new Map<string, NodeExecutionState>([
        ['leaf1', {
          status: 'succeeded',
          version: 1,
          attempts: 1,
          mergedToTarget: true,
          workSummary: { nodeId: 'leaf1', nodeName: 'Job1', commits: 2, filesAdded: 3, filesModified: 1, filesDeleted: 0, description: 'fallback' },
          // No aggregatedWorkSummary
        }],
      ]);
      
      const result = computeMergedLeafWorkSummary(plan, nodeStates);
      assert.ok(result);
      // Should fall back to workSummary
      assert.strictEqual(result.totalCommits, 2);
      assert.strictEqual(result.totalFilesAdded, 3);
      assert.strictEqual(result.totalFilesModified, 1);
      assert.strictEqual(result.totalFilesDeleted, 0);
    });
  });
});
