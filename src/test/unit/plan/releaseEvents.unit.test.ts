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
});
