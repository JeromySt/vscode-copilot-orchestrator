/**
 * @fileoverview Unit tests for ReleaseStateProducer — event subscription wiring
 * and delta delivery.
 *
 * @module test/unit/ui/releaseStateProducer
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
import { ReleaseStateProducer } from '../../../ui/producers/releaseStateProducer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRelease(id: string, overrides?: any): any {
  return {
    id,
    name: `Release ${id}`,
    status: 'monitoring',
    releaseBranch: 'release/1.0',
    targetBranch: 'main',
    planIds: ['plan1'],
    prNumber: 42,
    prUrl: 'https://github.com/org/repo/pull/42',
    createdAt: 1000,
    startedAt: 2000,
    ...overrides,
  };
}

function makeMockManager(emitter: EventEmitter): any {
  return Object.assign(emitter, {
    getRelease: sinon.stub(),
    getAllReleases: sinon.stub().returns([]),
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('ReleaseStateProducer', () => {
  let sandbox: sinon.SinonSandbox;
  let emitter: EventEmitter;
  let mockManager: any;
  let producer: ReleaseStateProducer;

  setup(() => {
    sandbox = sinon.createSandbox();
    emitter = new EventEmitter();
    mockManager = makeMockManager(emitter);
  });

  teardown(() => {
    producer?.dispose();
    sandbox.restore();
  });

  suite('type', () => {
    test('should be "releaseState"', () => {
      mockManager.getRelease.returns(undefined);
      producer = new ReleaseStateProducer(mockManager);
      assert.strictEqual(producer.type, 'releaseState');
    });
  });

  suite('readFull', () => {
    test('returns null when release not found', () => {
      mockManager.getRelease.returns(undefined);
      producer = new ReleaseStateProducer(mockManager);
      assert.strictEqual(producer.readFull('r1'), null);
    });

    test('returns release content and cursor when release exists', () => {
      const release = makeRelease('r1');
      mockManager.getRelease.returns(release);
      producer = new ReleaseStateProducer(mockManager);
      const result = producer.readFull('r1');
      assert.ok(result !== null);
      assert.strictEqual(result!.content.release.id, 'r1');
      assert.deepStrictEqual(result!.content.events, []);
      assert.ok(typeof result!.cursor === 'string');
    });

    test('includes availablePlans when getAvailablePlans is provided', () => {
      const release = makeRelease('r1');
      mockManager.getRelease.returns(release);
      const plans = [{ id: 'p1', name: 'Plan 1' }];
      producer = new ReleaseStateProducer(mockManager, () => plans);
      const result = producer.readFull('r1');
      assert.ok(result !== null);
      assert.deepStrictEqual(result!.content.availablePlans, plans);
    });
  });

  // -------------------------------------------------------------------------
  // event subscriptions
  // -------------------------------------------------------------------------

  suite('event subscriptions', () => {
    test('emitting taskStatusChanged buffers a taskStatusChanged event', () => {
      const release = makeRelease('r1');
      mockManager.getRelease.returns(release);
      producer = new ReleaseStateProducer(mockManager);
      const full = producer.readFull('r1')!;

      emitter.emit('taskStatusChanged', 'r1', 'task-abc', 'running');

      const delta = producer.readDelta('r1', full.cursor);
      assert.ok(delta !== null);
      const ev = delta!.content.events.find(e => e.type === 'taskStatusChanged');
      assert.ok(ev, 'expected a taskStatusChanged event');
      assert.deepStrictEqual(ev!.data, { taskId: 'task-abc', status: 'running' });
    });

    test('emitting plansAdded buffers a plansAdded event', () => {
      const release = makeRelease('r1');
      mockManager.getRelease.returns(release);
      producer = new ReleaseStateProducer(mockManager);
      const full = producer.readFull('r1')!;

      emitter.emit('plansAdded', 'r1', ['plan2', 'plan3']);

      const delta = producer.readDelta('r1', full.cursor);
      assert.ok(delta !== null);
      const ev = delta!.content.events.find(e => e.type === 'plansAdded');
      assert.ok(ev, 'expected a plansAdded event');
      assert.deepStrictEqual(ev!.data, { planIds: ['plan2', 'plan3'] });
    });

    test('emitting prAdopted buffers a prAdopted event', () => {
      const release = makeRelease('r1');
      mockManager.getRelease.returns(release);
      producer = new ReleaseStateProducer(mockManager);
      const full = producer.readFull('r1')!;

      emitter.emit('prAdopted', 'r1', 99);

      const delta = producer.readDelta('r1', full.cursor);
      assert.ok(delta !== null);
      const ev = delta!.content.events.find(e => e.type === 'prAdopted');
      assert.ok(ev, 'expected a prAdopted event');
      assert.deepStrictEqual(ev!.data, { prNumber: 99 });
    });

    test('emitting releaseActionTaken buffers an actionTaken event (unified event name)', () => {
      const release = makeRelease('r1');
      mockManager.getRelease.returns(release);
      producer = new ReleaseStateProducer(mockManager);
      const full = producer.readFull('r1')!;

      const action = { type: 'merge', description: 'merged PR' };
      emitter.emit('releaseActionTaken', 'r1', action);

      const delta = producer.readDelta('r1', full.cursor);
      assert.ok(delta !== null);
      const ev = delta!.content.events.find(e => e.type === 'actionTaken');
      assert.ok(ev, 'expected an actionTaken event');
      assert.deepStrictEqual(ev!.data, action);
    });

    test('emitting findingsResolved buffers a findingsResolved event', () => {
      const release = makeRelease('r1');
      mockManager.getRelease.returns(release);
      producer = new ReleaseStateProducer(mockManager);
      const full = producer.readFull('r1')!;

      emitter.emit('findingsResolved', 'r1', ['f1', 'f2'], true);

      const delta = producer.readDelta('r1', full.cursor);
      assert.ok(delta !== null);
      const ev = delta!.content.events.find(e => e.type === 'findingsResolved');
      assert.ok(ev, 'expected a findingsResolved event');
      assert.deepStrictEqual(ev!.data, { findingIds: ['f1', 'f2'], hasCommit: true });
    });

    test('events for a different releaseId are not included in the delta for another id', () => {
      const release = makeRelease('r1');
      mockManager.getRelease.withArgs('r1').returns(release);
      mockManager.getRelease.withArgs('r2').returns(undefined);
      producer = new ReleaseStateProducer(mockManager);
      const full = producer.readFull('r1')!;

      // Emit for r2, not r1
      emitter.emit('taskStatusChanged', 'r2', 'task-x', 'running');

      const delta = producer.readDelta('r1', full.cursor);
      // No cursor change and no events for r1 → null
      assert.strictEqual(delta, null);
    });
  });

  // -------------------------------------------------------------------------
  // delta delivery
  // -------------------------------------------------------------------------

  suite('delta delivery', () => {
    test('readDelta returns buffered event data after an event is emitted', () => {
      const release = makeRelease('r1');
      mockManager.getRelease.returns(release);
      producer = new ReleaseStateProducer(mockManager);
      const full = producer.readFull('r1')!;

      emitter.emit('plansAdded', 'r1', ['plan9']);

      const delta = producer.readDelta('r1', full.cursor);
      assert.ok(delta !== null);
      assert.ok(delta!.content.events.length > 0);
      assert.strictEqual(delta!.content.events[0].type, 'plansAdded');
    });

    test('readDelta clears the buffer after reading', () => {
      const release = makeRelease('r1');
      mockManager.getRelease.returns(release);
      producer = new ReleaseStateProducer(mockManager);
      const full = producer.readFull('r1')!;

      emitter.emit('plansAdded', 'r1', ['plan9']);

      const delta1 = producer.readDelta('r1', full.cursor);
      assert.ok(delta1 !== null);

      // Second read with the new cursor — buffer is cleared, cursor unchanged → null
      const delta2 = producer.readDelta('r1', delta1!.cursor);
      assert.strictEqual(delta2, null);
    });

    test('multiple events are all buffered and delivered together', () => {
      const release = makeRelease('r1');
      mockManager.getRelease.returns(release);
      producer = new ReleaseStateProducer(mockManager);
      const full = producer.readFull('r1')!;

      emitter.emit('taskStatusChanged', 'r1', 'task1', 'running');
      emitter.emit('plansAdded', 'r1', ['plan2']);

      const delta = producer.readDelta('r1', full.cursor);
      assert.ok(delta !== null);
      assert.strictEqual(delta!.content.events.length, 2);
    });

    test('readDelta returns null when no events and cursor unchanged', () => {
      const release = makeRelease('r1');
      mockManager.getRelease.returns(release);
      producer = new ReleaseStateProducer(mockManager);
      const full = producer.readFull('r1')!;

      const delta = producer.readDelta('r1', full.cursor);
      assert.strictEqual(delta, null);
    });

    test('readDelta delivers events even when release was deleted', () => {
      mockManager.getRelease.returns(makeRelease('r1'));
      producer = new ReleaseStateProducer(mockManager);
      const full = producer.readFull('r1')!;

      emitter.emit('taskStatusChanged', 'r1', 'task1', 'done');

      // Now the release disappears
      mockManager.getRelease.returns(undefined);

      const delta = producer.readDelta('r1', full.cursor);
      assert.ok(delta !== null);
      assert.strictEqual(delta!.content.deleted, true);
      assert.ok(delta!.content.events.length > 0);
    });
  });

  // -------------------------------------------------------------------------
  // dispose
  // -------------------------------------------------------------------------

  suite('dispose', () => {
    test('removes all listeners so no more buffering occurs after dispose', () => {
      const release = makeRelease('r1');
      mockManager.getRelease.returns(release);
      producer = new ReleaseStateProducer(mockManager);
      const full = producer.readFull('r1')!;

      producer.dispose();

      emitter.emit('taskStatusChanged', 'r1', 'task1', 'running');

      const delta = producer.readDelta('r1', full.cursor);
      assert.strictEqual(delta, null);
    });
  });
});
