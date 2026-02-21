/**
 * Coverage tests for src/plan/helpers.ts
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import {
  computeProgress,
  computePlanStatus,
  computeStatusCounts,
  formatLogEntry,
  formatLogEntries,
  createEmptyWorkSummary,
  appendWorkSummary,
  mergeWorkSummary,
  computeMergedLeafWorkSummary,
  getNodeOverallStartedAt,
  getNodeOverallEndedAt,
  computeEffectiveStartedAt,
  computeEffectiveEndedAt,
} from '../../../plan/helpers';
import type { NodeExecutionState, LogEntry, PlanInstance } from '../../../plan/types';

suite('helpers - coverage', () => {
  suite('computeProgress', () => {
    test('returns 0 when total is 0', () => {
      const counts = { pending: 0, ready: 0, scheduled: 0, running: 0, succeeded: 0, failed: 0, blocked: 0, canceled: 0 };
      assert.strictEqual(computeProgress(counts, 0), 0);
    });

    test('returns 0 when total is negative', () => {
      const counts = { pending: 0, ready: 0, scheduled: 0, running: 0, succeeded: 0, failed: 0, blocked: 0, canceled: 0 };
      assert.strictEqual(computeProgress(counts, -1), 0);
    });

    test('computes progress correctly', () => {
      const counts = { pending: 0, ready: 0, scheduled: 0, running: 0, succeeded: 5, failed: 3, blocked: 1, canceled: 1 };
      assert.strictEqual(computeProgress(counts, 10), 1); // 5+3+1+1 = 10 complete
    });
  });

  suite('computeStatusCounts', () => {
    test('counts all statuses correctly', () => {
      const states: NodeExecutionState[] = [
        { id: '1', nodeId: '1', status: 'pending', attempts: 0, version: 0 } as any,
        { id: '2', nodeId: '2', status: 'succeeded', attempts: 1, version: 0 } as any,
        { id: '3', nodeId: '3', status: 'failed', attempts: 1, version: 0 } as any,
        { id: '4', nodeId: '4', status: 'running', attempts: 0, version: 0 } as any,
      ];
      const counts = computeStatusCounts(states);
      assert.strictEqual(counts.pending, 1);
      assert.strictEqual(counts.succeeded, 1);
      assert.strictEqual(counts.failed, 1);
      assert.strictEqual(counts.running, 1);
    });
  });

  suite('computePlanStatus', () => {
    test('returns paused when isPaused is true and has non-terminal nodes', () => {
      const states: NodeExecutionState[] = [
        { id: '1', nodeId: '1', status: 'pending', attempts: 0, version: 0 } as any,
      ];
      assert.strictEqual(computePlanStatus(states, true, true), 'paused');
    });

    test('returns final status when paused but all terminal', () => {
      const states: NodeExecutionState[] = [
        { id: '1', nodeId: '1', status: 'succeeded', attempts: 1, version: 0 } as any,
      ];
      assert.strictEqual(computePlanStatus(states, true, true), 'succeeded');
    });

    test('returns running when hasScheduled', () => {
      const states: NodeExecutionState[] = [
        { id: '1', nodeId: '1', status: 'scheduled', attempts: 0, version: 0 } as any,
      ];
      assert.strictEqual(computePlanStatus(states, true, false), 'running');
    });

    test('returns canceled when has canceled nodes', () => {
      const states: NodeExecutionState[] = [
        { id: '1', nodeId: '1', status: 'canceled', attempts: 0, version: 0 } as any,
      ];
      assert.strictEqual(computePlanStatus(states, true, false), 'canceled');
    });

    test('returns partial when has both failed and succeeded', () => {
      const states: NodeExecutionState[] = [
        { id: '1', nodeId: '1', status: 'failed', attempts: 1, version: 0 } as any,
        { id: '2', nodeId: '2', status: 'succeeded', attempts: 1, version: 0 } as any,
      ];
      assert.strictEqual(computePlanStatus(states, true, false), 'partial');
    });

    test('returns failed when only failed nodes', () => {
      const states: NodeExecutionState[] = [
        { id: '1', nodeId: '1', status: 'failed', attempts: 1, version: 0 } as any,
      ];
      assert.strictEqual(computePlanStatus(states, true, false), 'failed');
    });

    test('returns failed for all blocked', () => {
      const states: NodeExecutionState[] = [
        { id: '1', nodeId: '1', status: 'blocked', attempts: 0, version: 0 } as any,
      ];
      assert.strictEqual(computePlanStatus(states, true, false), 'failed');
    });

    test('returns pending when not started and has pending nodes', () => {
      const states: NodeExecutionState[] = [
        { id: '1', nodeId: '1', status: 'pending', attempts: 0, version: 0 } as any,
      ];
      assert.strictEqual(computePlanStatus(states, false, false), 'pending');
    });

    test('returns running when started and has ready nodes', () => {
      const states: NodeExecutionState[] = [
        { id: '1', nodeId: '1', status: 'ready', attempts: 0, version: 0 } as any,
      ];
      assert.strictEqual(computePlanStatus(states, true, false), 'running');
    });
  });

  suite('formatLogEntry', () => {
    test('formats stdout without prefix', () => {
      const entry: LogEntry = { type: 'stdout', message: 'test', timestamp: Date.now(), phase: 'work' };
      const result = formatLogEntry(entry);
      assert.strictEqual(result, 'test');
    });

    test('formats stderr with [ERR] prefix', () => {
      const entry: LogEntry = { type: 'stderr', message: 'error', timestamp: Date.now(), phase: 'work' };
      const result = formatLogEntry(entry);
      assert.ok(result.includes('[ERR]'));
      assert.ok(result.includes('error'));
    });

    test('formats error with [ERROR] prefix', () => {
      const entry: LogEntry = { type: 'error', message: 'fatal', timestamp: Date.now(), phase: 'work' };
      const result = formatLogEntry(entry);
      assert.ok(result.includes('[ERROR]'));
      assert.ok(result.includes('fatal'));
    });

    test('formats info with [INFO] prefix', () => {
      const entry: LogEntry = { type: 'info', message: 'status', timestamp: Date.now(), phase: 'work' };
      const result = formatLogEntry(entry);
      assert.ok(result.includes('[INFO]'));
      assert.ok(result.includes('status'));
    });
  });

  suite('formatLogEntries', () => {
    test('joins multiple entries with newlines', () => {
      const entries: LogEntry[] = [
        { type: 'stdout', message: 'line1', timestamp: Date.now(), phase: 'work' },
        { type: 'stdout', message: 'line2', timestamp: Date.now(), phase: 'work' },
      ];
      const result = formatLogEntries(entries);
      assert.ok(result.includes('line1\nline2'));
    });
  });

  suite('work summary helpers', () => {
    test('createEmptyWorkSummary creates empty summary', () => {
      const summary = createEmptyWorkSummary();
      assert.strictEqual(summary.totalCommits, 0);
      assert.strictEqual(summary.totalFilesAdded, 0);
      assert.strictEqual(summary.jobSummaries.length, 0);
    });

    test('appendWorkSummary adds job summary', () => {
      const summary = createEmptyWorkSummary();
      const jobSummary = { nodeId: 'n1', nodeName: 'Node1', description: 'test', commits: 2, filesAdded: 3, filesModified: 1, filesDeleted: 0 };
      const result = appendWorkSummary(summary, jobSummary);
      assert.strictEqual(result.totalCommits, 2);
      assert.strictEqual(result.totalFilesAdded, 3);
      assert.strictEqual(result.jobSummaries.length, 1);
    });

    test('appendWorkSummary creates new summary when undefined', () => {
      const jobSummary = { nodeId: 'n1', nodeName: 'Node1', description: 'test', commits: 1, filesAdded: 1, filesModified: 0, filesDeleted: 0 };
      const result = appendWorkSummary(undefined, jobSummary);
      assert.strictEqual(result.totalCommits, 1);
    });

    test('mergeWorkSummary merges child into parent', () => {
      const parent = { totalCommits: 1, totalFilesAdded: 1, totalFilesModified: 0, totalFilesDeleted: 0, jobSummaries: [] };
      const child = { totalCommits: 2, totalFilesAdded: 2, totalFilesModified: 1, totalFilesDeleted: 0, jobSummaries: [] };
      const result = mergeWorkSummary(parent, child);
      assert.strictEqual(result.totalCommits, 3);
      assert.strictEqual(result.totalFilesAdded, 3);
    });

    test('mergeWorkSummary handles undefined child', () => {
      const parent = { totalCommits: 1, totalFilesAdded: 1, totalFilesModified: 0, totalFilesDeleted: 0, jobSummaries: [] };
      const result = mergeWorkSummary(parent, undefined);
      assert.strictEqual(result.totalCommits, 1);
    });

    test('mergeWorkSummary handles undefined parent', () => {
      const child = { totalCommits: 2, totalFilesAdded: 2, totalFilesModified: 0, totalFilesDeleted: 0, jobSummaries: [] };
      const result = mergeWorkSummary(undefined, child);
      assert.strictEqual(result.totalCommits, 2);
    });
  });

  suite('computeMergedLeafWorkSummary', () => {
    test('returns undefined when no work summary', () => {
      const plan = { workSummary: undefined, leaves: [], targetBranch: 'main' } as any;
      const result = computeMergedLeafWorkSummary(plan, new Map());
      assert.strictEqual(result, undefined);
    });

    test('returns undefined when empty job summaries', () => {
      const plan = { workSummary: { jobSummaries: [], totalCommits: 0, totalFilesAdded: 0, totalFilesModified: 0, totalFilesDeleted: 0 }, leaves: [], targetBranch: 'main' } as any;
      const result = computeMergedLeafWorkSummary(plan, new Map());
      assert.strictEqual(result, undefined);
    });

    test('returns full summary when no target branch', () => {
      const plan = { 
        workSummary: { 
          jobSummaries: [{ nodeId: 'n1', nodeName: 'Node1', description: 'test', commits: 1, filesAdded: 1, filesModified: 0, filesDeleted: 0 }], 
          totalCommits: 1, 
          totalFilesAdded: 1, 
          totalFilesModified: 0, 
          totalFilesDeleted: 0 
        }, 
        leaves: ['n1'], 
        targetBranch: undefined 
      } as any;
      const result = computeMergedLeafWorkSummary(plan, new Map());
      assert.strictEqual(result?.totalCommits, 1);
    });

    test('filters to merged leaf nodes', () => {
      const plan = { 
        workSummary: { 
          jobSummaries: [
            { nodeId: 'n1', nodeName: 'Node1', description: 'test', commits: 1, filesAdded: 1, filesModified: 0, filesDeleted: 0 },
            { nodeId: 'n2', nodeName: 'Node2', description: 'test', commits: 2, filesAdded: 2, filesModified: 0, filesDeleted: 0 }
          ], 
          totalCommits: 3, 
          totalFilesAdded: 3, 
          totalFilesModified: 0, 
          totalFilesDeleted: 0 
        }, 
        leaves: ['n1', 'n2'], 
        targetBranch: 'main' 
      } as any;
      const nodeStates = new Map<string, NodeExecutionState>([
        ['n1', { id: '1', nodeId: 'n1', status: 'succeeded', mergedToTarget: true, attempts: 1, version: 0 } as any],
        ['n2', { id: '2', nodeId: 'n2', status: 'succeeded', mergedToTarget: false, attempts: 1, version: 0 } as any],
      ]);
      const result = computeMergedLeafWorkSummary(plan, nodeStates);
      assert.strictEqual(result?.totalCommits, 1);
      assert.strictEqual(result?.jobSummaries.length, 1);
    });

    test('returns undefined when no merged leaves', () => {
      const plan = { 
        workSummary: { 
          jobSummaries: [{ nodeId: 'n1', nodeName: 'Node1', description: 'test', commits: 1, filesAdded: 1, filesModified: 0, filesDeleted: 0 }], 
          totalCommits: 1, 
          totalFilesAdded: 1, 
          totalFilesModified: 0, 
          totalFilesDeleted: 0 
        }, 
        leaves: ['n1'], 
        targetBranch: 'main' 
      } as any;
      const nodeStates = new Map<string, NodeExecutionState>([
        ['n1', { id: '1', nodeId: 'n1', status: 'succeeded', mergedToTarget: false, attempts: 1, version: 0 } as any],
      ]);
      const result = computeMergedLeafWorkSummary(plan, nodeStates);
      assert.strictEqual(result, undefined);
    });

    test('uses aggregatedWorkSummary when available', () => {
      const plan = { 
        workSummary: { 
          jobSummaries: [{ nodeId: 'n1', nodeName: 'Node1', description: 'test', commits: 1, filesAdded: 1, filesModified: 0, filesDeleted: 0 }], 
          totalCommits: 1, 
          totalFilesAdded: 1, 
          totalFilesModified: 0, 
          totalFilesDeleted: 0 
        }, 
        leaves: ['n1'], 
        targetBranch: 'main' 
      } as any;
      const nodeStates = new Map<string, NodeExecutionState>([
        ['n1', { 
          id: '1', 
          nodeId: 'n1', 
          status: 'succeeded', 
          mergedToTarget: true, 
          attempts: 1, 
          version: 0,
          aggregatedWorkSummary: { nodeId: 'n1', nodeName: 'Node1', description: 'test', commits: 5, filesAdded: 5, filesModified: 0, filesDeleted: 0 }
        } as any],
      ]);
      const result = computeMergedLeafWorkSummary(plan, nodeStates);
      assert.strictEqual(result?.totalCommits, 5);
    });
  });

  suite('timestamp helpers', () => {
    test('getNodeOverallStartedAt returns earliest from attemptHistory', () => {
      const state = {
        startedAt: 1000,
        attemptHistory: [
          { attemptNumber: 1, startedAt: 500 } as any,
          { attemptNumber: 2, startedAt: 800 } as any,
        ]
      } as any;
      assert.strictEqual(getNodeOverallStartedAt(state), 500);
    });

    test('getNodeOverallStartedAt falls back to startedAt', () => {
      const state = { startedAt: 1000 } as any;
      assert.strictEqual(getNodeOverallStartedAt(state), 1000);
    });

    test('getNodeOverallEndedAt returns latest from attemptHistory', () => {
      const state = {
        endedAt: 1000,
        attemptHistory: [
          { attemptNumber: 1, endedAt: 500 } as any,
          { attemptNumber: 2, endedAt: 800 } as any,
        ]
      } as any;
      assert.strictEqual(getNodeOverallEndedAt(state), 800);
    });

    test('getNodeOverallEndedAt falls back to endedAt', () => {
      const state = { endedAt: 1000 } as any;
      assert.strictEqual(getNodeOverallEndedAt(state), 1000);
    });

    test('computeEffectiveStartedAt returns earliest', () => {
      const states = [
        { startedAt: 1000 } as any,
        { startedAt: 500 } as any,
      ];
      assert.strictEqual(computeEffectiveStartedAt(states), 500);
    });

    test('computeEffectiveStartedAt returns undefined when no starts', () => {
      const states = [{ } as any];
      assert.strictEqual(computeEffectiveStartedAt(states), undefined);
    });

    test('computeEffectiveEndedAt returns latest', () => {
      const states = [
        { endedAt: 1000 } as any,
        { endedAt: 1500 } as any,
      ];
      assert.strictEqual(computeEffectiveEndedAt(states), 1500);
    });

    test('computeEffectiveEndedAt returns undefined when no ends', () => {
      const states = [{ } as any];
      assert.strictEqual(computeEffectiveEndedAt(states), undefined);
    });
  });
});
