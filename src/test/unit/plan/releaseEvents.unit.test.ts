/**
 * @fileoverview Unit tests for ReleaseEventEmitter
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { ReleaseEventEmitter } from '../../../plan/releaseEvents';
import type { ReleaseDefinition } from '../../../plan/types/release';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

suite('ReleaseEventEmitter', () => {
  let quiet: { restore: () => void };
  let emitter: ReleaseEventEmitter;

  setup(() => {
    quiet = silenceConsole();
    emitter = new ReleaseEventEmitter();
  });

  teardown(() => {
    quiet.restore();
    emitter.removeAllListeners();
  });

  suite('emitReleaseTaskStatusChanged', () => {
    test('should emit the correct event with args', () => {
      const spy = sinon.spy();
      emitter.on('release:taskStatusChanged', spy);

      emitter.emitReleaseTaskStatusChanged('rel-1', 'task-1', 'in-progress');

      assert.strictEqual(spy.callCount, 1, 'event should be emitted once');
      assert.strictEqual(spy.firstCall.args[0], 'rel-1');
      assert.strictEqual(spy.firstCall.args[1], 'task-1');
      assert.strictEqual(spy.firstCall.args[2], 'in-progress');
    });
  });

  suite('emitReleasePlansAdded', () => {
    test('should emit the correct event with args', () => {
      const spy = sinon.spy();
      emitter.on('release:plansAdded', spy);

      emitter.emitReleasePlansAdded('rel-1', ['plan-a', 'plan-b']);

      assert.strictEqual(spy.callCount, 1, 'event should be emitted once');
      assert.strictEqual(spy.firstCall.args[0], 'rel-1');
      assert.deepStrictEqual(spy.firstCall.args[1], ['plan-a', 'plan-b']);
    });
  });

  suite('emitReleasePrAdopted', () => {
    test('should emit the correct event with args', () => {
      const spy = sinon.spy();
      emitter.on('release:prAdopted', spy);

      emitter.emitReleasePrAdopted('rel-1', 42);

      assert.strictEqual(spy.callCount, 1, 'event should be emitted once');
      assert.strictEqual(spy.firstCall.args[0], 'rel-1');
      assert.strictEqual(spy.firstCall.args[1], 42);
    });
  });

  suite('emitReleaseTaskOutput', () => {
    test('should emit the correct event with args', () => {
      const spy = sinon.spy();
      emitter.on('release:taskOutput', spy);

      emitter.emitReleaseTaskOutput('rel-1', 'task-1', 'Test output line\n');

      assert.strictEqual(spy.callCount, 1, 'event should be emitted once');
      assert.strictEqual(spy.firstCall.args[0], 'rel-1', 'first arg should be releaseId');
      assert.strictEqual(spy.firstCall.args[1], 'task-1', 'second arg should be taskId');
      assert.strictEqual(spy.firstCall.args[2], 'Test output line\n', 'third arg should be line');
    });

    test('should emit multiple times for multiple calls', () => {
      const spy = sinon.spy();
      emitter.on('release:taskOutput', spy);

      emitter.emitReleaseTaskOutput('rel-1', 'task-1', 'Line 1\n');
      emitter.emitReleaseTaskOutput('rel-1', 'task-1', 'Line 2\n');
      emitter.emitReleaseTaskOutput('rel-1', 'task-2', 'Task 2 line\n');

      assert.strictEqual(spy.callCount, 3, 'event should be emitted three times');
      assert.strictEqual(spy.firstCall.args[2], 'Line 1\n', 'first call should have Line 1');
      assert.strictEqual(spy.secondCall.args[2], 'Line 2\n', 'second call should have Line 2');
      assert.strictEqual(spy.thirdCall.args[1], 'task-2', 'third call should have task-2');
    });

    test('should support multiple listeners', () => {
      const spy1 = sinon.spy();
      const spy2 = sinon.spy();
      emitter.on('release:taskOutput', spy1);
      emitter.on('release:taskOutput', spy2);

      emitter.emitReleaseTaskOutput('rel-1', 'task-1', 'Test output\n');

      assert.strictEqual(spy1.callCount, 1, 'first listener should be called');
      assert.strictEqual(spy2.callCount, 1, 'second listener should be called');
      assert.strictEqual(spy1.firstCall.args[2], 'Test output\n', 'both listeners should receive same args');
      assert.strictEqual(spy2.firstCall.args[2], 'Test output\n', 'both listeners should receive same args');
    });
  });

  suite('emitReleaseActionTaken', () => {
    test('should emit the correct event with args', () => {
      const spy = sinon.spy();
      emitter.on('release:actionTaken', spy);

      const action = { type: 'fix-code' as const, description: 'Fixed lint errors', success: true, timestamp: 12345 };
      emitter.emitReleaseActionTaken('rel-1', action);

      assert.strictEqual(spy.callCount, 1, 'event should be emitted once');
      assert.strictEqual(spy.firstCall.args[0], 'rel-1');
      assert.deepStrictEqual(spy.firstCall.args[1], action);
    });

    test('should include planId when provided', () => {
      const spy = sinon.spy();
      emitter.on('release:actionTaken', spy);

      const action = { type: 'fix-code' as const, description: 'Fix', success: true, planId: 'plan-42', timestamp: 0 };
      emitter.emitReleaseActionTaken('rel-1', action);

      assert.strictEqual(spy.firstCall.args[1].planId, 'plan-42');
    });
  });

  suite('emitFindingsProcessing', () => {
    test('should emit with queued status', () => {
      const spy = sinon.spy();
      emitter.on('release:findingsProcessing', spy);

      emitter.emitFindingsProcessing('rel-1', ['finding-1', 'finding-2'], 'queued');

      assert.strictEqual(spy.callCount, 1, 'event should be emitted once');
      assert.strictEqual(spy.firstCall.args[0], 'rel-1');
      assert.deepStrictEqual(spy.firstCall.args[1], ['finding-1', 'finding-2']);
      assert.strictEqual(spy.firstCall.args[2], 'queued');
    });

    test('should emit with processing status', () => {
      const spy = sinon.spy();
      emitter.on('release:findingsProcessing', spy);

      emitter.emitFindingsProcessing('rel-1', ['finding-1'], 'processing');

      assert.strictEqual(spy.firstCall.args[2], 'processing');
    });

    test('should emit with completed status', () => {
      const spy = sinon.spy();
      emitter.on('release:findingsProcessing', spy);

      emitter.emitFindingsProcessing('rel-1', ['finding-1'], 'completed');

      assert.strictEqual(spy.firstCall.args[2], 'completed');
    });

    test('should emit with failed status', () => {
      const spy = sinon.spy();
      emitter.on('release:findingsProcessing', spy);

      emitter.emitFindingsProcessing('rel-1', ['finding-1'], 'failed');

      assert.strictEqual(spy.firstCall.args[2], 'failed');
    });
  });

  suite('emitFindingsResolved', () => {
    test('should emit with correct args when commit present', () => {
      const spy = sinon.spy();
      emitter.on('release:findingsResolved', spy);

      emitter.emitFindingsResolved('rel-1', ['finding-1', 'finding-2'], true);

      assert.strictEqual(spy.callCount, 1, 'event should be emitted once');
      assert.strictEqual(spy.firstCall.args[0], 'rel-1');
      assert.deepStrictEqual(spy.firstCall.args[1], ['finding-1', 'finding-2']);
      assert.strictEqual(spy.firstCall.args[2], true);
    });

    test('should emit with hasCommit=false when no commit', () => {
      const spy = sinon.spy();
      emitter.on('release:findingsResolved', spy);

      emitter.emitFindingsResolved('rel-2', ['finding-3'], false);

      assert.strictEqual(spy.firstCall.args[0], 'rel-2');
      assert.strictEqual(spy.firstCall.args[2], false);
    });
  });

  suite('emitMonitoringStopped', () => {
    test('should emit with correct releaseId and cycleCount', () => {
      const spy = sinon.spy();
      emitter.on('release:monitoringStopped', spy);

      emitter.emitMonitoringStopped('rel-1', 5);

      assert.strictEqual(spy.callCount, 1, 'event should be emitted once');
      assert.strictEqual(spy.firstCall.args[0], 'rel-1');
      assert.strictEqual(spy.firstCall.args[1], 5);
    });

    test('should emit with zero cycles', () => {
      const spy = sinon.spy();
      emitter.on('release:monitoringStopped', spy);

      emitter.emitMonitoringStopped('rel-2', 0);

      assert.strictEqual(spy.firstCall.args[1], 0);
    });
  });

  suite('emitPollIntervalChanged', () => {
    test('should emit with correct releaseId and interval', () => {
      const spy = sinon.spy();
      emitter.on('release:pollIntervalChanged', spy);

      emitter.emitPollIntervalChanged('rel-1', 30);

      assert.strictEqual(spy.callCount, 1, 'event should be emitted once');
      assert.strictEqual(spy.firstCall.args[0], 'rel-1');
      assert.strictEqual(spy.firstCall.args[1], 30);
    });

    test('should emit updated interval on backoff', () => {
      const spy = sinon.spy();
      emitter.on('release:pollIntervalChanged', spy);

      emitter.emitPollIntervalChanged('rel-1', 60);
      emitter.emitPollIntervalChanged('rel-1', 120);

      assert.strictEqual(spy.callCount, 2);
      assert.strictEqual(spy.firstCall.args[1], 60);
      assert.strictEqual(spy.secondCall.args[1], 120);
    });
  });
});
