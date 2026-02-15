/**
 * @fileoverview Unit tests for helpers.ts (coverage for uncovered portions)
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
import type { LogEntry, NodeExecutionState, PlanInstance, JobWorkSummary, WorkSummary } from '../../../plan/types';

suite('Plan Helpers (extended coverage)', () => {
  suite('formatLogEntry', () => {
    test('stdout returns raw message', () => {
      const entry: LogEntry = { timestamp: Date.now(), phase: 'work', type: 'stdout', message: 'output line' };
      assert.strictEqual(formatLogEntry(entry), 'output line');
    });

    test('stderr includes [ERR] prefix', () => {
      const entry: LogEntry = { timestamp: Date.now(), phase: 'work', type: 'stderr', message: 'error line' };
      const result = formatLogEntry(entry);
      assert.ok(result.includes('[ERR]'));
      assert.ok(result.includes('error line'));
    });

    test('error includes [ERROR] prefix', () => {
      const entry: LogEntry = { timestamp: Date.now(), phase: 'work', type: 'error', message: 'fail' };
      const result = formatLogEntry(entry);
      assert.ok(result.includes('[ERROR]'));
    });

    test('info includes [INFO] prefix', () => {
      const entry: LogEntry = { timestamp: Date.now(), phase: 'work', type: 'info', message: 'informational' };
      const result = formatLogEntry(entry);
      assert.ok(result.includes('[INFO]'));
    });
  });

  suite('formatLogEntries', () => {
    test('formats multiple entries joined by newlines', () => {
      const entries: LogEntry[] = [
        { timestamp: Date.now(), phase: 'work', type: 'stdout', message: 'line1' },
        { timestamp: Date.now(), phase: 'work', type: 'stdout', message: 'line2' },
      ];
      const result = formatLogEntries(entries);
      assert.ok(result.includes('line1'));
      assert.ok(result.includes('line2'));
      assert.ok(result.includes('\n'));
    });

    test('empty array returns empty string', () => {
      assert.strictEqual(formatLogEntries([]), '');
    });
  });

  suite('computeProgress', () => {
    test('returns 0 for zero total', () => {
      const counts = { pending: 0, ready: 0, scheduled: 0, running: 0, succeeded: 0, failed: 0, blocked: 0, canceled: 0 };
      assert.strictEqual(computeProgress(counts, 0), 0);
    });

    test('returns 0 for negative total', () => {
      const counts = { pending: 0, ready: 0, scheduled: 0, running: 0, succeeded: 0, failed: 0, blocked: 0, canceled: 0 };
      assert.strictEqual(computeProgress(counts, -1), 0);
    });

    test('computes ratio correctly', () => {
      const counts = { pending: 0, ready: 0, scheduled: 0, running: 0, succeeded: 3, failed: 1, blocked: 0, canceled: 0 };
      assert.strictEqual(computeProgress(counts, 4), 1.0);
    });

    test('partial progress', () => {
      const counts = { pending: 1, ready: 0, scheduled: 0, running: 0, succeeded: 1, failed: 0, blocked: 0, canceled: 0 };
      assert.strictEqual(computeProgress(counts, 2), 0.5);
    });
  });

  suite('computePlanStatus', () => {
    function makeStates(statuses: string[]): NodeExecutionState[] {
      return statuses.map(s => ({ status: s as any, version: 0, attempts: 0 }));
    }

    test('returns pending when not started', () => {
      assert.strictEqual(computePlanStatus(makeStates(['pending', 'pending']), false), 'pending');
    });

    test('returns running when started with pending nodes', () => {
      assert.strictEqual(computePlanStatus(makeStates(['pending', 'ready']), true), 'running');
    });

    test('returns running when running nodes exist', () => {
      assert.strictEqual(computePlanStatus(makeStates(['running', 'pending']), true), 'running');
    });

    test('returns running when scheduled nodes exist', () => {
      assert.strictEqual(computePlanStatus(makeStates(['scheduled', 'pending']), true), 'running');
    });

    test('returns succeeded when all succeeded', () => {
      assert.strictEqual(computePlanStatus(makeStates(['succeeded', 'succeeded']), true), 'succeeded');
    });

    test('returns failed when all failed', () => {
      assert.strictEqual(computePlanStatus(makeStates(['failed']), true), 'failed');
    });

    test('returns partial when mixed success/failure', () => {
      assert.strictEqual(computePlanStatus(makeStates(['succeeded', 'failed']), true), 'partial');
    });

    test('returns canceled when any canceled', () => {
      assert.strictEqual(computePlanStatus(makeStates(['canceled']), true), 'canceled');
    });

    test('returns failed for all blocked', () => {
      assert.strictEqual(computePlanStatus(makeStates(['blocked']), true), 'failed');
    });

    test('returns paused when isPaused and non-terminal nodes exist', () => {
      assert.strictEqual(computePlanStatus(makeStates(['pending', 'succeeded']), true, true), 'paused');
    });

    test('returns final status when paused but all terminal', () => {
      assert.strictEqual(computePlanStatus(makeStates(['succeeded', 'succeeded']), true, true), 'succeeded');
    });

    test('returns failed when paused and all blocked/failed', () => {
      assert.strictEqual(computePlanStatus(makeStates(['failed', 'blocked']), true, true), 'failed');
    });
  });

  suite('computeEffectiveEndedAt', () => {
    test('returns undefined for no ended nodes', () => {
      const states: NodeExecutionState[] = [{ status: 'running', version: 0, attempts: 0 }];
      assert.strictEqual(computeEffectiveEndedAt(states), undefined);
    });

    test('returns max endedAt', () => {
      const states: NodeExecutionState[] = [
        { status: 'succeeded', version: 0, attempts: 0, endedAt: 100 },
        { status: 'succeeded', version: 0, attempts: 0, endedAt: 200 },
      ];
      assert.strictEqual(computeEffectiveEndedAt(states), 200);
    });
  });

  suite('appendWorkSummary', () => {
    test('creates new summary when undefined', () => {
      const js: JobWorkSummary = { nodeId: 'n1', nodeName: 'Job', commits: 1, filesAdded: 2, filesModified: 3, filesDeleted: 0, description: 'test' };
      const result = appendWorkSummary(undefined, js);
      assert.strictEqual(result.totalCommits, 1);
      assert.strictEqual(result.totalFilesAdded, 2);
      assert.strictEqual(result.jobSummaries.length, 1);
    });

    test('appends to existing summary', () => {
      const existing = createEmptyWorkSummary();
      existing.totalCommits = 5;
      const js: JobWorkSummary = { nodeId: 'n1', nodeName: 'Job', commits: 3, filesAdded: 0, filesModified: 0, filesDeleted: 0, description: 'test' };
      const result = appendWorkSummary(existing, js);
      assert.strictEqual(result.totalCommits, 8);
      assert.strictEqual(result.jobSummaries.length, 1);
    });
  });

  suite('mergeWorkSummary', () => {
    test('creates new summary when parent is undefined and child is undefined', () => {
      const result = mergeWorkSummary(undefined, undefined);
      assert.strictEqual(result.totalCommits, 0);
    });

    test('creates new summary when parent is undefined', () => {
      const child: WorkSummary = { totalCommits: 5, totalFilesAdded: 2, totalFilesModified: 1, totalFilesDeleted: 0, jobSummaries: [] };
      const result = mergeWorkSummary(undefined, child);
      assert.strictEqual(result.totalCommits, 5);
    });

    test('merges child into parent', () => {
      const parent: WorkSummary = { totalCommits: 3, totalFilesAdded: 1, totalFilesModified: 0, totalFilesDeleted: 0, jobSummaries: [] };
      const child: WorkSummary = { totalCommits: 2, totalFilesAdded: 1, totalFilesModified: 1, totalFilesDeleted: 1, jobSummaries: [] };
      const result = mergeWorkSummary(parent, child);
      assert.strictEqual(result.totalCommits, 5);
      assert.strictEqual(result.totalFilesDeleted, 1);
    });
  });

  suite('computeMergedLeafWorkSummary', () => {
    function makeMergedPlan(opts: {
      targetBranch?: string;
      jobSummaries?: JobWorkSummary[];
      leaves?: string[];
      nodeStates?: Map<string, NodeExecutionState>;
    }): { plan: PlanInstance; nodeStates: Map<string, NodeExecutionState> } {
      const nodeStates = opts.nodeStates || new Map<string, NodeExecutionState>();
      const plan = {
        leaves: opts.leaves || [],
        targetBranch: opts.targetBranch,
        workSummary: opts.jobSummaries ? {
          totalCommits: 0, totalFilesAdded: 0, totalFilesModified: 0, totalFilesDeleted: 0,
          jobSummaries: opts.jobSummaries,
        } : undefined,
        nodeStates,
      } as any as PlanInstance;
      return { plan, nodeStates };
    }

    test('returns undefined when no workSummary', () => {
      const { plan, nodeStates } = makeMergedPlan({});
      assert.strictEqual(computeMergedLeafWorkSummary(plan, nodeStates), undefined);
    });

    test('returns undefined when workSummary has empty jobSummaries', () => {
      const { plan, nodeStates } = makeMergedPlan({ jobSummaries: [] });
      assert.strictEqual(computeMergedLeafWorkSummary(plan, nodeStates), undefined);
    });

    test('returns full summary when no targetBranch', () => {
      const js: JobWorkSummary = { nodeId: 'n1', nodeName: 'J', commits: 1, filesAdded: 0, filesModified: 0, filesDeleted: 0, description: '' };
      const { plan, nodeStates } = makeMergedPlan({ jobSummaries: [js] });
      const result = computeMergedLeafWorkSummary(plan, nodeStates);
      assert.ok(result);
      assert.strictEqual(result!.jobSummaries.length, 1);
    });

    test('filters to merged leaf nodes', () => {
      const js: JobWorkSummary = { nodeId: 'n1', nodeName: 'J', commits: 2, filesAdded: 1, filesModified: 1, filesDeleted: 0, description: '' };
      const ns = new Map<string, NodeExecutionState>();
      ns.set('n1', { status: 'succeeded', version: 1, attempts: 1, mergedToTarget: true } as any);
      const { plan, nodeStates } = makeMergedPlan({ targetBranch: 'main', jobSummaries: [js], leaves: ['n1'], nodeStates: ns });
      const result = computeMergedLeafWorkSummary(plan, nodeStates);
      assert.ok(result);
      assert.strictEqual(result!.totalCommits, 2);
      assert.strictEqual(result!.totalFilesAdded, 1);
    });

    test('returns undefined when no leaf nodes merged', () => {
      const js: JobWorkSummary = { nodeId: 'n1', nodeName: 'J', commits: 2, filesAdded: 0, filesModified: 0, filesDeleted: 0, description: '' };
      const ns = new Map<string, NodeExecutionState>();
      ns.set('n1', { status: 'succeeded', version: 1, attempts: 1 } as any);
      const { plan, nodeStates } = makeMergedPlan({ targetBranch: 'main', jobSummaries: [js], leaves: ['n1'], nodeStates: ns });
      assert.strictEqual(computeMergedLeafWorkSummary(plan, nodeStates), undefined);
    });

    test('uses aggregatedWorkSummary when available', () => {
      const js: JobWorkSummary = { nodeId: 'n1', nodeName: 'J', commits: 1, filesAdded: 1, filesModified: 0, filesDeleted: 0, description: '' };
      const agg: JobWorkSummary = { nodeId: 'n1', nodeName: 'J', commits: 5, filesAdded: 3, filesModified: 2, filesDeleted: 1, description: '' };
      const ns = new Map<string, NodeExecutionState>();
      ns.set('n1', { status: 'succeeded', version: 1, attempts: 1, mergedToTarget: true, aggregatedWorkSummary: agg } as any);
      const { plan, nodeStates } = makeMergedPlan({ targetBranch: 'main', jobSummaries: [js], leaves: ['n1'], nodeStates: ns });
      const result = computeMergedLeafWorkSummary(plan, nodeStates);
      assert.ok(result);
      assert.strictEqual(result!.totalCommits, 5);
      assert.strictEqual(result!.totalFilesAdded, 3);
    });

    test('filters out non-leaf nodes', () => {
      const js1: JobWorkSummary = { nodeId: 'n1', nodeName: 'A', commits: 1, filesAdded: 0, filesModified: 0, filesDeleted: 0, description: '' };
      const js2: JobWorkSummary = { nodeId: 'n2', nodeName: 'B', commits: 2, filesAdded: 0, filesModified: 0, filesDeleted: 0, description: '' };
      const ns = new Map<string, NodeExecutionState>();
      ns.set('n1', { status: 'succeeded', version: 1, attempts: 1, mergedToTarget: true } as any);
      ns.set('n2', { status: 'succeeded', version: 1, attempts: 1, mergedToTarget: true } as any);
      // Only n2 is a leaf
      const { plan, nodeStates } = makeMergedPlan({ targetBranch: 'main', jobSummaries: [js1, js2], leaves: ['n2'], nodeStates: ns });
      const result = computeMergedLeafWorkSummary(plan, nodeStates);
      assert.ok(result);
      assert.strictEqual(result!.totalCommits, 2);
    });
  });
});
