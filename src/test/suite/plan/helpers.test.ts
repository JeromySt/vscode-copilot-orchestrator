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
} from '../../../plan/helpers';
import { NodeExecutionState, LogEntry, JobWorkSummary, ExecutionPhase } from '../../../plan/types';

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
});
