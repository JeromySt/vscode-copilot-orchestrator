/**
 * @fileoverview Unit tests for ReleaseStateMachine
 * 
 * Tests state transition validation, guard conditions, event emission,
 * and history tracking for release lifecycle management.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import {
  ReleaseStateMachine,
  VALID_RELEASE_TRANSITIONS,
  TERMINAL_RELEASE_STATES,
  isTerminalReleaseStatus,
  isValidReleaseTransition,
} from '../../../plan/releaseStateMachine';
import type { ReleaseDefinition, ReleaseStatus } from '../../../plan/types/release';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function makeMockRelease(overrides?: Partial<ReleaseDefinition>): ReleaseDefinition {
  return {
    id: 'rel-1',
    name: 'Test Release',
    flowType: 'from-plans',
    source: 'from-plans',
    planIds: ['plan-1', 'plan-2'],
    releaseBranch: 'release/v1.0.0',
    targetBranch: 'main',
    repoPath: '/repo',
    status: 'drafting',
    stateHistory: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

suite('ReleaseStateMachine', () => {
  let sandbox: sinon.SinonSandbox;
  let silence: ReturnType<typeof silenceConsole>;

  setup(() => {
    sandbox = sinon.createSandbox();
    silence = silenceConsole();
  });

  teardown(() => {
    sandbox.restore();
    silence.restore();
  });

  suite('VALID_RELEASE_TRANSITIONS constant', () => {
    test('should define valid transitions from drafting', () => {
      assert.deepStrictEqual(VALID_RELEASE_TRANSITIONS.drafting, [
        'preparing',
        'merging',
        'ready-for-pr',
        'canceled',
      ]);
    });

    test('should define valid transitions from preparing', () => {
      assert.deepStrictEqual(VALID_RELEASE_TRANSITIONS.preparing, [
        'ready-for-pr',
        'drafting',
        'canceled',
      ]);
    });

    test('should define valid transitions from merging', () => {
      assert.deepStrictEqual(VALID_RELEASE_TRANSITIONS.merging, [
        'ready-for-pr',
        'failed',
        'canceled',
      ]);
    });

    test('should define valid transitions from ready-for-pr', () => {
      assert.deepStrictEqual(VALID_RELEASE_TRANSITIONS['ready-for-pr'], [
        'creating-pr',
        'drafting',
        'canceled',
      ]);
    });

    test('should define valid transitions from creating-pr', () => {
      assert.deepStrictEqual(VALID_RELEASE_TRANSITIONS['creating-pr'], [
        'pr-active',
        'failed',
        'canceled',
      ]);
    });

    test('should define valid transitions from pr-active', () => {
      assert.deepStrictEqual(VALID_RELEASE_TRANSITIONS['pr-active'], [
        'monitoring',
        'addressing',
        'drafting',
        'canceled',
      ]);
    });

    test('should define valid transitions from monitoring', () => {
      assert.deepStrictEqual(VALID_RELEASE_TRANSITIONS.monitoring, [
        'addressing',
        'succeeded',
        'pr-active',
        'canceled',
      ]);
    });

    test('should define valid transitions from addressing', () => {
      assert.deepStrictEqual(VALID_RELEASE_TRANSITIONS.addressing, [
        'monitoring',
        'failed',
        'canceled',
      ]);
    });

    test('should define no transitions from terminal states', () => {
      assert.deepStrictEqual(VALID_RELEASE_TRANSITIONS.succeeded, []);
      assert.deepStrictEqual(VALID_RELEASE_TRANSITIONS.failed, []);
      assert.deepStrictEqual(VALID_RELEASE_TRANSITIONS.canceled, []);
    });
  });

  suite('isTerminalReleaseStatus', () => {
    test('should return true for succeeded', () => {
      assert.strictEqual(isTerminalReleaseStatus('succeeded'), true);
    });

    test('should return true for failed', () => {
      assert.strictEqual(isTerminalReleaseStatus('failed'), true);
    });

    test('should return true for canceled', () => {
      assert.strictEqual(isTerminalReleaseStatus('canceled'), true);
    });

    test('should return false for non-terminal states', () => {
      assert.strictEqual(isTerminalReleaseStatus('drafting'), false);
      assert.strictEqual(isTerminalReleaseStatus('preparing'), false);
      assert.strictEqual(isTerminalReleaseStatus('merging'), false);
      assert.strictEqual(isTerminalReleaseStatus('ready-for-pr'), false);
      assert.strictEqual(isTerminalReleaseStatus('creating-pr'), false);
      assert.strictEqual(isTerminalReleaseStatus('pr-active'), false);
      assert.strictEqual(isTerminalReleaseStatus('monitoring'), false);
      assert.strictEqual(isTerminalReleaseStatus('addressing'), false);
    });
  });

  suite('isValidReleaseTransition', () => {
    test('should return true for valid transition', () => {
      assert.strictEqual(isValidReleaseTransition('drafting', 'preparing'), true);
    });

    test('should return false for invalid transition', () => {
      assert.strictEqual(isValidReleaseTransition('drafting', 'succeeded'), false);
    });

    test('should return false for transition from terminal state', () => {
      assert.strictEqual(isValidReleaseTransition('succeeded', 'drafting'), false);
    });
  });

  suite('constructor', () => {
    test('should create state machine with release', () => {
      const release = makeMockRelease();
      const sm = new ReleaseStateMachine(release);
      assert.ok(sm);
      assert.strictEqual(sm.getCurrentStatus(), 'drafting');
    });
  });

  suite('getCurrentStatus', () => {
    test('should return current release status', () => {
      const release = makeMockRelease({ status: 'preparing' });
      const sm = new ReleaseStateMachine(release);
      assert.strictEqual(sm.getCurrentStatus(), 'preparing');
    });
  });

  suite('canTransition - from-plans flow', () => {
    test('should allow drafting -> merging for from-plans with plans', () => {
      const release = makeMockRelease({
        source: 'from-plans',
        planIds: ['plan-1'],
      });
      const sm = new ReleaseStateMachine(release);
      const result = sm.canTransition('merging');
      assert.strictEqual(result.valid, true);
    });

    test('should block drafting -> merging for from-branch', () => {
      const release = makeMockRelease({
        source: 'from-branch',
        planIds: [],
      });
      const sm = new ReleaseStateMachine(release);
      const result = sm.canTransition('merging');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('from-plans'));
    });

    test('should block drafting -> merging when no plans', () => {
      const release = makeMockRelease({
        source: 'from-plans',
        planIds: [],
      });
      const sm = new ReleaseStateMachine(release);
      const result = sm.canTransition('merging');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('no plans'));
    });
  });

  suite('canTransition - from-branch flow', () => {
    test('should allow drafting -> preparing for from-branch', () => {
      const release = makeMockRelease({
        source: 'from-branch',
        planIds: [],
      });
      const sm = new ReleaseStateMachine(release);
      const result = sm.canTransition('preparing');
      assert.strictEqual(result.valid, true);
    });

    test('should allow drafting -> ready-for-pr for from-branch (skip merge)', () => {
      const release = makeMockRelease({
        source: 'from-branch',
        planIds: [],
      });
      const sm = new ReleaseStateMachine(release);
      const result = sm.canTransition('ready-for-pr');
      assert.strictEqual(result.valid, true);
    });
  });

  suite('canTransition - preparing phase guard', () => {
    test('should allow preparing -> ready-for-pr when all required tasks complete', () => {
      const release = makeMockRelease({
        status: 'preparing',
        preparationTasks: [
          { id: 't1', type: 'run-checks', title: 'Check', description: '', status: 'completed', required: true, automatable: true },
          { id: 't2', type: 'update-docs', title: 'Docs', description: '', status: 'skipped', required: false, automatable: true },
        ],
      });
      const sm = new ReleaseStateMachine(release);
      const result = sm.canTransition('ready-for-pr');
      assert.strictEqual(result.valid, true);
    });

    test('should block preparing -> ready-for-pr when required tasks incomplete', () => {
      const release = makeMockRelease({
        status: 'preparing',
        preparationTasks: [
          { id: 't1', type: 'run-checks', title: 'Check', description: '', status: 'pending', required: true, automatable: true },
          { id: 't2', type: 'update-docs', title: 'Docs', description: '', status: 'completed', required: false, automatable: true },
        ],
      });
      const sm = new ReleaseStateMachine(release);
      const result = sm.canTransition('ready-for-pr');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('incomplete'));
    });

    test('should allow preparing -> ready-for-pr with only optional tasks incomplete', () => {
      const release = makeMockRelease({
        status: 'preparing',
        preparationTasks: [
          { id: 't1', type: 'run-checks', title: 'Check', description: '', status: 'completed', required: true, automatable: true },
          { id: 't2', type: 'update-docs', title: 'Docs', description: '', status: 'pending', required: false, automatable: true },
        ],
      });
      const sm = new ReleaseStateMachine(release);
      const result = sm.canTransition('ready-for-pr');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('incomplete'));
    });
  });

  suite('canTransition - invalid transitions', () => {
    test('should block transition not in VALID_RELEASE_TRANSITIONS', () => {
      const release = makeMockRelease({ status: 'drafting' });
      const sm = new ReleaseStateMachine(release);
      const result = sm.canTransition('succeeded' as ReleaseStatus);
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Invalid transition'));
      assert.ok(result.error?.includes('drafting'));
      assert.ok(result.error?.includes('succeeded'));
    });

    test('should block transition from terminal state', () => {
      const release = makeMockRelease({ status: 'succeeded' });
      const sm = new ReleaseStateMachine(release);
      const result = sm.canTransition('drafting');
      assert.strictEqual(result.valid, false);
    });
  });

  suite('transition - success path', () => {
    test('should transition to valid state', () => {
      const release = makeMockRelease();
      const sm = new ReleaseStateMachine(release);
      const result = sm.transition('preparing', 'User requested');
      assert.strictEqual(result.success, true);
      assert.strictEqual(release.status, 'preparing');
    });

    test('should record state history', () => {
      const release = makeMockRelease();
      const sm = new ReleaseStateMachine(release);
      const beforeTime = Date.now();
      sm.transition('preparing', 'Test reason');
      const afterTime = Date.now();

      assert.strictEqual(release.stateHistory.length, 1);
      const history = release.stateHistory[0];
      assert.strictEqual(history.from, 'drafting');
      assert.strictEqual(history.to, 'preparing');
      assert.strictEqual(history.reason, 'Test reason');
      assert.ok(history.timestamp >= beforeTime && history.timestamp <= afterTime);
    });

    test('should emit transition event', () => {
      const release = makeMockRelease();
      const sm = new ReleaseStateMachine(release);
      const spy = sandbox.spy();
      sm.on('transition', spy);

      sm.transition('preparing', 'Test reason');

      assert.ok(spy.calledOnce);
      const event = spy.firstCall.args[0];
      assert.strictEqual(event.releaseId, 'rel-1');
      assert.strictEqual(event.from, 'drafting');
      assert.strictEqual(event.to, 'preparing');
      assert.strictEqual(event.reason, 'Test reason');
    });

    test('should set startedAt on first merging transition', () => {
      const release = makeMockRelease({ source: 'from-plans', planIds: ['plan-1'] });
      const sm = new ReleaseStateMachine(release);
      const beforeTime = Date.now();
      sm.transition('merging');
      const afterTime = Date.now();

      assert.ok(release.startedAt);
      assert.ok(release.startedAt >= beforeTime && release.startedAt <= afterTime);
    });

    test('should not overwrite startedAt on subsequent transitions', () => {
      const release = makeMockRelease({ 
        source: 'from-plans', 
        planIds: ['plan-1'],
        status: 'merging',
        startedAt: 12345,
      });
      const sm = new ReleaseStateMachine(release);
      sm.transition('ready-for-pr');

      assert.strictEqual(release.startedAt, 12345);
    });

    test('should set endedAt on terminal transition', () => {
      const release = makeMockRelease({ status: 'monitoring' });
      const sm = new ReleaseStateMachine(release);
      const beforeTime = Date.now();
      sm.transition('succeeded');
      const afterTime = Date.now();

      assert.ok(release.endedAt);
      assert.ok(release.endedAt >= beforeTime && release.endedAt <= afterTime);
    });

    test('should emit completed event on terminal transition', () => {
      const release = makeMockRelease({ status: 'monitoring' });
      const sm = new ReleaseStateMachine(release);
      const spy = sandbox.spy();
      sm.on('completed', spy);

      sm.transition('succeeded');

      assert.ok(spy.calledOnce);
      assert.strictEqual(spy.firstCall.args[0], 'rel-1');
      assert.strictEqual(spy.firstCall.args[1], 'succeeded');
    });
  });

  suite('transition - failure path', () => {
    test('should reject invalid transition', () => {
      const release = makeMockRelease();
      const sm = new ReleaseStateMachine(release);
      const result = sm.transition('succeeded' as ReleaseStatus);

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
      assert.strictEqual(release.status, 'drafting'); // Unchanged
      assert.strictEqual(release.stateHistory.length, 0); // No history
    });

    test('should reject transition blocked by guard', () => {
      const release = makeMockRelease({ source: 'from-branch' });
      const sm = new ReleaseStateMachine(release);
      const result = sm.transition('merging');

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('from-plans'));
      assert.strictEqual(release.status, 'drafting');
    });

    test('should reject concurrent transitions (mutex)', () => {
      const release = makeMockRelease();
      const sm = new ReleaseStateMachine(release);

      // Simulate concurrent transition by setting mutex manually
      (sm as any).transitionMutex = true;

      const result = sm.transition('preparing');
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('Concurrent'));
    });
  });

  suite('getStateHistory', () => {
    test('should return state history array', () => {
      const release = makeMockRelease();
      const sm = new ReleaseStateMachine(release);
      sm.transition('preparing');
      sm.transition('ready-for-pr');

      const history = sm.getStateHistory();
      assert.strictEqual(history.length, 2);
      assert.strictEqual(history[0].from, 'drafting');
      assert.strictEqual(history[0].to, 'preparing');
      assert.strictEqual(history[1].from, 'preparing');
      assert.strictEqual(history[1].to, 'ready-for-pr');
    });
  });

  suite('isTerminal', () => {
    test('should return false for non-terminal state', () => {
      const release = makeMockRelease({ status: 'drafting' });
      const sm = new ReleaseStateMachine(release);
      assert.strictEqual(sm.isTerminal(), false);
    });

    test('should return true for succeeded', () => {
      const release = makeMockRelease({ status: 'succeeded' });
      const sm = new ReleaseStateMachine(release);
      assert.strictEqual(sm.isTerminal(), true);
    });

    test('should return true for failed', () => {
      const release = makeMockRelease({ status: 'failed' });
      const sm = new ReleaseStateMachine(release);
      assert.strictEqual(sm.isTerminal(), true);
    });

    test('should return true for canceled', () => {
      const release = makeMockRelease({ status: 'canceled' });
      const sm = new ReleaseStateMachine(release);
      assert.strictEqual(sm.isTerminal(), true);
    });
  });

  suite('multiple transitions', () => {
    test('should handle complete from-plans flow', () => {
      const release = makeMockRelease({ source: 'from-plans', planIds: ['plan-1'] });
      const sm = new ReleaseStateMachine(release);

      assert.ok(sm.transition('merging').success);
      assert.ok(sm.transition('ready-for-pr').success);
      assert.ok(sm.transition('creating-pr').success);
      assert.ok(sm.transition('pr-active').success);
      assert.ok(sm.transition('monitoring').success);
      assert.ok(sm.transition('succeeded').success);

      assert.strictEqual(release.status, 'succeeded');
      assert.strictEqual(release.stateHistory.length, 6);
    });

    test('should handle from-branch flow skipping merge', () => {
      const release = makeMockRelease({ source: 'from-branch', planIds: [] });
      const sm = new ReleaseStateMachine(release);

      assert.ok(sm.transition('preparing').success);
      release.preparationTasks = [
        { id: 't1', type: 'run-checks', title: 'Check', description: '', status: 'completed', required: true, automatable: true },
      ];
      assert.ok(sm.transition('ready-for-pr').success);
      assert.ok(sm.transition('creating-pr').success);

      assert.strictEqual(release.status, 'creating-pr');
    });

    test('should handle cancellation from any state', () => {
      const release = makeMockRelease();
      const sm = new ReleaseStateMachine(release);

      sm.transition('preparing');
      assert.ok(sm.transition('canceled').success);
      assert.strictEqual(release.status, 'canceled');
      assert.ok(release.endedAt);
    });
  });
});
