/**
 * @fileoverview Unit tests for node utilities (src/plan/types/nodes.ts)
 */

import * as assert from 'assert';
import { suite, test } from 'mocha';
import {
  nodePerformsWork,
  isTerminal,
  isValidTransition,
  TERMINAL_STATES,
  type PlanNode,
  type NodeStatus
} from '../../../plan/types/nodes';

suite('nodes.ts utilities', () => {
  suite('nodePerformsWork', () => {
    test('returns true when node has work spec', () => {
      const node: PlanNode = {
        id: '1',
        producerId: 'test',
        name: 'Test',
        type: 'job',
        task: 'Test task',
        dependencies: [],
        dependents: [],
        work: { type: 'shell', command: 'npm test' }
      };
      
      assert.strictEqual(nodePerformsWork(node), true);
    });

    test('returns false when node has no work spec', () => {
      const node: PlanNode = {
        id: '1',
        producerId: 'test',
        name: 'Test',
        type: 'job',
        task: 'Test task',
        dependencies: [],
        dependents: []
      };
      
      assert.strictEqual(nodePerformsWork(node), false);
    });

    test('returns true when work is string', () => {
      const node: PlanNode = {
        id: '1',
        producerId: 'test',
        name: 'Test',
        type: 'job',
        task: 'Test task',
        dependencies: [],
        dependents: [],
        work: 'npm test'
      };
      
      assert.strictEqual(nodePerformsWork(node), true);
    });

    test('returns true when work is agent spec', () => {
      const node: PlanNode = {
        id: '1',
        producerId: 'test',
        name: 'Test',
        type: 'job',
        task: 'Test task',
        dependencies: [],
        dependents: [],
        work: { type: 'agent', instructions: 'Fix it' }
      };
      
      assert.strictEqual(nodePerformsWork(node), true);
    });

    test('returns true when work is process spec', () => {
      const node: PlanNode = {
        id: '1',
        producerId: 'test',
        name: 'Test',
        type: 'job',
        task: 'Test task',
        dependencies: [],
        dependents: [],
        work: { type: 'process', executable: 'node', args: ['test.js'] }
      };
      
      assert.strictEqual(nodePerformsWork(node), true);
    });

    test('returns false for node with only prechecks', () => {
      const node: PlanNode = {
        id: '1',
        producerId: 'test',
        name: 'Test',
        type: 'job',
        task: 'Test task',
        dependencies: [],
        dependents: [],
        prechecks: 'npm run lint'
      };
      
      assert.strictEqual(nodePerformsWork(node), false);
    });

    test('returns false for node with only postchecks', () => {
      const node: PlanNode = {
        id: '1',
        producerId: 'test',
        name: 'Test',
        type: 'job',
        task: 'Test task',
        dependencies: [],
        dependents: [],
        postchecks: 'npm run verify'
      };
      
      assert.strictEqual(nodePerformsWork(node), false);
    });
  });

  suite('isTerminal', () => {
    test('returns true for succeeded status', () => {
      assert.strictEqual(isTerminal('succeeded'), true);
    });

    test('returns true for failed status', () => {
      assert.strictEqual(isTerminal('failed'), true);
    });

    test('returns true for blocked status', () => {
      assert.strictEqual(isTerminal('blocked'), true);
    });

    test('returns true for canceled status', () => {
      assert.strictEqual(isTerminal('canceled'), true);
    });

    test('returns false for pending status', () => {
      assert.strictEqual(isTerminal('pending'), false);
    });

    test('returns false for ready status', () => {
      assert.strictEqual(isTerminal('ready'), false);
    });

    test('returns false for scheduled status', () => {
      assert.strictEqual(isTerminal('scheduled'), false);
    });

    test('returns false for running status', () => {
      assert.strictEqual(isTerminal('running'), false);
    });

    test('TERMINAL_STATES constant contains all terminal states', () => {
      assert.deepStrictEqual(
        [...TERMINAL_STATES].sort(),
        ['blocked', 'canceled', 'failed', 'succeeded'].sort()
      );
    });
  });

  suite('isValidTransition', () => {
    test('allows pending -> ready transition', () => {
      assert.strictEqual(isValidTransition('pending', 'ready'), true);
    });

    test('allows pending -> blocked transition', () => {
      assert.strictEqual(isValidTransition('pending', 'blocked'), true);
    });

    test('allows pending -> canceled transition', () => {
      assert.strictEqual(isValidTransition('pending', 'canceled'), true);
    });

    test('disallows pending -> running transition', () => {
      assert.strictEqual(isValidTransition('pending', 'running'), false);
    });

    test('disallows pending -> succeeded transition', () => {
      assert.strictEqual(isValidTransition('pending', 'succeeded'), false);
    });

    test('allows ready -> scheduled transition', () => {
      assert.strictEqual(isValidTransition('ready', 'scheduled'), true);
    });

    test('allows ready -> blocked transition', () => {
      assert.strictEqual(isValidTransition('ready', 'blocked'), true);
    });

    test('allows ready -> canceled transition', () => {
      assert.strictEqual(isValidTransition('ready', 'canceled'), true);
    });

    test('disallows ready -> running transition', () => {
      assert.strictEqual(isValidTransition('ready', 'running'), false);
    });

    test('allows scheduled -> running transition', () => {
      assert.strictEqual(isValidTransition('scheduled', 'running'), true);
    });

    test('allows scheduled -> failed transition', () => {
      assert.strictEqual(isValidTransition('scheduled', 'failed'), true);
    });

    test('allows scheduled -> canceled transition', () => {
      assert.strictEqual(isValidTransition('scheduled', 'canceled'), true);
    });

    test('disallows scheduled -> succeeded transition', () => {
      assert.strictEqual(isValidTransition('scheduled', 'succeeded'), false);
    });

    test('allows running -> succeeded transition', () => {
      assert.strictEqual(isValidTransition('running', 'succeeded'), true);
    });

    test('allows running -> failed transition', () => {
      assert.strictEqual(isValidTransition('running', 'failed'), true);
    });

    test('allows running -> canceled transition', () => {
      assert.strictEqual(isValidTransition('running', 'canceled'), true);
    });

    test('disallows running -> pending transition', () => {
      assert.strictEqual(isValidTransition('running', 'pending'), false);
    });

    test('disallows succeeded -> any transition', () => {
      assert.strictEqual(isValidTransition('succeeded', 'pending'), false);
      assert.strictEqual(isValidTransition('succeeded', 'ready'), false);
      assert.strictEqual(isValidTransition('succeeded', 'running'), false);
      assert.strictEqual(isValidTransition('succeeded', 'failed'), false);
    });

    test('disallows failed -> any transition', () => {
      assert.strictEqual(isValidTransition('failed', 'pending'), false);
      assert.strictEqual(isValidTransition('failed', 'ready'), false);
      assert.strictEqual(isValidTransition('failed', 'running'), false);
      assert.strictEqual(isValidTransition('failed', 'succeeded'), false);
    });

    test('disallows blocked -> any transition', () => {
      assert.strictEqual(isValidTransition('blocked', 'pending'), false);
      assert.strictEqual(isValidTransition('blocked', 'ready'), false);
      assert.strictEqual(isValidTransition('blocked', 'running'), false);
    });

    test('disallows canceled -> any transition', () => {
      assert.strictEqual(isValidTransition('canceled', 'pending'), false);
      assert.strictEqual(isValidTransition('canceled', 'ready'), false);
      assert.strictEqual(isValidTransition('canceled', 'running'), false);
    });
  });
});
