/**
 * @fileoverview Unit tests for PulseEmitter
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { PulseEmitter } from '../../../core/pulse';

suite('PulseEmitter', () => {
  let clock: sinon.SinonFakeTimers;
  let pulse: PulseEmitter;

  setup(() => {
    clock = sinon.useFakeTimers();
    pulse = new PulseEmitter();
  });

  teardown(() => {
    pulse.stop();
    clock.restore();
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  test('isRunning is false initially', () => {
    assert.strictEqual(pulse.isRunning, false);
  });

  test('start() begins the interval', () => {
    pulse.start();
    assert.strictEqual(pulse.isRunning, true);
  });

  test('stop() clears the interval', () => {
    pulse.start();
    pulse.stop();
    assert.strictEqual(pulse.isRunning, false);
  });

  test('start() is idempotent', () => {
    pulse.start();
    pulse.start(); // should not throw or create second timer
    assert.strictEqual(pulse.isRunning, true);
  });

  test('stop() is idempotent', () => {
    pulse.stop(); // no-op on already-stopped
    assert.strictEqual(pulse.isRunning, false);
  });

  // ── Auto-start / auto-stop ────────────────────────────────────────────

  test('auto-starts when first subscriber added', () => {
    assert.strictEqual(pulse.isRunning, false);
    const sub = pulse.onPulse(() => {});
    assert.strictEqual(pulse.isRunning, true);
    sub.dispose();
  });

  test('auto-stops when last subscriber removed', () => {
    const sub1 = pulse.onPulse(() => {});
    const sub2 = pulse.onPulse(() => {});
    assert.strictEqual(pulse.isRunning, true);

    sub1.dispose();
    assert.strictEqual(pulse.isRunning, true, 'still running with one subscriber');

    sub2.dispose();
    assert.strictEqual(pulse.isRunning, false, 'stopped after last subscriber removed');
  });

  test('dispose is idempotent', () => {
    const sub = pulse.onPulse(() => {});
    sub.dispose();
    sub.dispose(); // should not decrement below zero
    assert.strictEqual(pulse.isRunning, false);

    // Adding a new subscriber should still auto-start
    const sub2 = pulse.onPulse(() => {});
    assert.strictEqual(pulse.isRunning, true);
    sub2.dispose();
  });

  // ── Pulse firing ──────────────────────────────────────────────────────

  test('fires callback at 1-second intervals', () => {
    let count = 0;
    const sub = pulse.onPulse(() => count++);

    clock.tick(999);
    assert.strictEqual(count, 0, 'not fired before 1000ms');

    clock.tick(1);
    assert.strictEqual(count, 1, 'fired at 1000ms');

    clock.tick(1000);
    assert.strictEqual(count, 2, 'fired at 2000ms');

    clock.tick(3000);
    assert.strictEqual(count, 5, 'fired 5 times after 5000ms');

    sub.dispose();
  });

  test('multiple subscribers all receive pulse', () => {
    let a = 0;
    let b = 0;
    const sub1 = pulse.onPulse(() => a++);
    const sub2 = pulse.onPulse(() => b++);

    clock.tick(1000);
    assert.strictEqual(a, 1);
    assert.strictEqual(b, 1);

    sub1.dispose();
    sub2.dispose();
  });

  test('disposed subscriber no longer receives pulse', () => {
    let count = 0;
    const sub = pulse.onPulse(() => count++);

    clock.tick(1000);
    assert.strictEqual(count, 1);

    sub.dispose();

    // Re-subscribe so pulse stays alive
    const sub2 = pulse.onPulse(() => {});
    clock.tick(1000);
    assert.strictEqual(count, 1, 'old subscriber not called after dispose');

    sub2.dispose();
  });

  test('no pulses fire after stop()', () => {
    let count = 0;
    pulse.start();
    pulse.on('pulse', () => count++);

    clock.tick(2000);
    assert.strictEqual(count, 2);

    pulse.stop();
    clock.tick(5000);
    assert.strictEqual(count, 2, 'no more pulses after stop');
  });

  // ── Returned Disposable ───────────────────────────────────────────────

  test('onPulse returns a Disposable with dispose()', () => {
    const sub = pulse.onPulse(() => {});
    assert.strictEqual(typeof sub.dispose, 'function');
    sub.dispose();
  });

  test('dispose cleans up properly', () => {
    let callCount = 0;
    const callback = () => callCount++;
    
    const sub = pulse.onPulse(callback);
    assert.strictEqual(pulse.isRunning, true, 'pulse should be running');
    
    // Verify callback works
    clock.tick(1000);
    assert.strictEqual(callCount, 1);
    
    // Dispose and verify cleanup
    sub.dispose();
    assert.strictEqual(pulse.isRunning, false, 'pulse should stop after dispose');
    
    // Verify no more callbacks
    clock.tick(2000);
    assert.strictEqual(callCount, 1, 'no callbacks after dispose');
    
    // Verify the specific callback is removed from listeners
    assert.strictEqual(pulse.listenerCount('pulse'), 0, 'no listeners remain');
  });

  test('handles edge case: dispose before first pulse', () => {
    let callCount = 0;
    const sub = pulse.onPulse(() => callCount++);
    
    // Dispose immediately without waiting for pulse
    sub.dispose();
    assert.strictEqual(pulse.isRunning, false);
    
    // Advance time and ensure no pulses fire
    clock.tick(2000);
    assert.strictEqual(callCount, 0, 'no callbacks should fire');
  });

  test('maintains correct subscriber count with multiple add/remove cycles', () => {
    // Test multiple subscription cycles
    const sub1 = pulse.onPulse(() => {});
    assert.strictEqual(pulse.isRunning, true);
    
    const sub2 = pulse.onPulse(() => {});
    const sub3 = pulse.onPulse(() => {});
    assert.strictEqual(pulse.isRunning, true, 'still running with multiple subscribers');
    
    sub2.dispose();
    assert.strictEqual(pulse.isRunning, true, 'still running after disposing middle subscriber');
    
    sub1.dispose();
    assert.strictEqual(pulse.isRunning, true, 'still running with one subscriber');
    
    sub3.dispose();
    assert.strictEqual(pulse.isRunning, false, 'stopped after last subscriber');
    
    // Test immediate restart
    const sub4 = pulse.onPulse(() => {});
    assert.strictEqual(pulse.isRunning, true, 'restarted with new subscriber');
    sub4.dispose();
  });

  test('implements IPulseEmitter interface correctly', () => {
    // Verify interface compliance
    assert.strictEqual(typeof pulse.onPulse, 'function', 'has onPulse method');
    assert.strictEqual(typeof pulse.isRunning, 'boolean', 'has isRunning property');
    
    // Verify onPulse returns Disposable
    const sub = pulse.onPulse(() => {});
    assert.strictEqual(typeof sub.dispose, 'function', 'returns object with dispose method');
    
    // Verify isRunning reflects actual state
    assert.strictEqual(pulse.isRunning, true, 'isRunning is true when interval is active');
    
    sub.dispose();
    assert.strictEqual(pulse.isRunning, false, 'isRunning is false when interval is stopped');
  });
});
