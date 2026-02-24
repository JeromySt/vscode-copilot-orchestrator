/**
 * Coverage tests for src/plan/scheduler.ts
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { PlanScheduler } from '../../../plan/scheduler';
import type { PlanInstance, PlanNode } from '../../../plan/types';

suite('scheduler - coverage', () => {
  let sandbox: sinon.SinonSandbox;
  let scheduler: PlanScheduler;

  setup(() => {
    sandbox = sinon.createSandbox();
    scheduler = new PlanScheduler({ globalMaxParallel: 8 });
  });

  teardown(() => {
    sandbox.restore();
  });

  test('selectNodes returns empty when no ready nodes', () => {
    const plan = {
      id: 'p1',
      jobs: new Map(),
      nodeStates: new Map(),
      maxParallel: 4
    } as any as PlanInstance;
    
    const stateMachine: any = {
      getReadyNodes: sandbox.stub().returns([])
    };
    
    const result = scheduler.selectNodes(plan, stateMachine, 0);
    assert.deepStrictEqual(result, []);
  });

  test('selectNodes returns empty when no capacity', () => {
    const plan = {
      id: 'p1',
      jobs: new Map([
        ['n1', { id: 'n1', type: 'job', name: 'Job1', dependencies: [], dependents: [], producerId: 'p1', work: 'echo test' } as any]
      ]),
      nodeStates: new Map([
        ['n1', { id: '1', nodeId: 'n1', status: 'ready', attempts: 0, version: 0 }],
        ['n2', { id: '2', nodeId: 'n2', status: 'running', attempts: 0, version: 0 }],
        ['n3', { id: '3', nodeId: 'n3', status: 'running', attempts: 0, version: 0 }],
        ['n4', { id: '4', nodeId: 'n4', status: 'running', attempts: 0, version: 0 }],
        ['n5', { id: '5', nodeId: 'n5', status: 'running', attempts: 0, version: 0 }],
      ]),
      maxParallel: 4
    } as any as PlanInstance;
    
    for (const [id, node] of [['n2', 'Job2'], ['n3', 'Job3'], ['n4', 'Job4'], ['n5', 'Job5']]) {
      plan.jobs.set(id, { id, type: 'job', name: node, dependencies: [], dependents: [], producerId: id, work: 'echo' } as any);
    }
    
    const stateMachine: any = {
      getReadyNodes: sandbox.stub().returns(['n1'])
    };
    
    const result = scheduler.selectNodes(plan, stateMachine, 0);
    assert.deepStrictEqual(result, []);
  });

  test('selectNodes respects plan maxParallel', () => {
    const plan = {
      id: 'p1',
      jobs: new Map([
        ['n1', { id: 'n1', type: 'job', name: 'Job1', dependencies: [], dependents: [], producerId: 'p1', work: 'echo' } as any],
        ['n2', { id: 'n2', type: 'job', name: 'Job2', dependencies: [], dependents: [], producerId: 'p2', work: 'echo' } as any],
        ['n3', { id: 'n3', type: 'job', name: 'Job3', dependencies: [], dependents: [], producerId: 'p3', work: 'echo' } as any],
      ]),
      nodeStates: new Map([
        ['n1', { id: '1', nodeId: 'n1', status: 'ready', attempts: 0, version: 0 }],
        ['n2', { id: '2', nodeId: 'n2', status: 'ready', attempts: 0, version: 0 }],
        ['n3', { id: '3', nodeId: 'n3', status: 'ready', attempts: 0, version: 0 }],
      ]),
      maxParallel: 2
    } as any as PlanInstance;
    
    const stateMachine: any = {
      getReadyNodes: sandbox.stub().returns(['n1', 'n2', 'n3'])
    };
    
    const result = scheduler.selectNodes(plan, stateMachine, 0);
    assert.strictEqual(result.length, 2);
  });

  test('selectNodes respects global maxParallel', () => {
    const plan = {
      id: 'p1',
      jobs: new Map([
        ['n1', { id: 'n1', type: 'job', name: 'Job1', dependencies: [], dependents: [], producerId: 'p1', work: 'echo' } as any],
        ['n2', { id: 'n2', type: 'job', name: 'Job2', dependencies: [], dependents: [], producerId: 'p2', work: 'echo' } as any],
      ]),
      nodeStates: new Map([
        ['n1', { id: '1', nodeId: 'n1', status: 'ready', attempts: 0, version: 0 }],
        ['n2', { id: '2', nodeId: 'n2', status: 'ready', attempts: 0, version: 0 }],
      ]),
      maxParallel: 0 // unlimited plan-level
    } as any as PlanInstance;
    
    const stateMachine: any = {
      getReadyNodes: sandbox.stub().returns(['n1', 'n2'])
    };
    
    const smallScheduler = new PlanScheduler({ globalMaxParallel: 1 });
    const result = smallScheduler.selectNodes(plan, stateMachine, 0);
    assert.strictEqual(result.length, 1);
  });

  test('selectNodes only counts running work nodes', () => {
    const plan = {
      id: 'p1',
      jobs: new Map([
        ['n1', { id: 'n1', type: 'job', name: 'Job1', dependencies: [], dependents: [], producerId: 'p1', work: 'echo' } as any],
        ['n2', { id: 'n2', type: 'job', name: 'Job2', dependencies: [], dependents: [], producerId: 'p2', work: 'echo' } as any],
        ['n3', { id: 'n3', type: 'sub-plan-coordination', name: 'SubPlan', dependencies: [], dependents: [], producerId: 'p3' } as any],
      ]),
      nodeStates: new Map([
        ['n1', { id: '1', nodeId: 'n1', status: 'ready', attempts: 0, version: 0 }],
        ['n2', { id: '2', nodeId: 'n2', status: 'running', attempts: 0, version: 0 }],
        ['n3', { id: '3', nodeId: 'n3', status: 'running', attempts: 0, version: 0 }], // coordination node shouldn't count
      ]),
      maxParallel: 2
    } as any as PlanInstance;
    
    const stateMachine: any = {
      getReadyNodes: sandbox.stub().returns(['n1'])
    };
    
    const result = scheduler.selectNodes(plan, stateMachine, 0);
    assert.strictEqual(result.length, 1); // Should allow n1 since n3 doesn't count
  });

  test('selectNodes prioritizes nodes by dependent count', () => {
    const plan = {
      id: 'p1',
      jobs: new Map([
        ['n1', { id: 'n1', type: 'job', name: 'Job1', dependencies: [], dependents: ['n3', 'n4', 'n5'], producerId: 'p1', work: 'echo' } as any],
        ['n2', { id: 'n2', type: 'job', name: 'Job2', dependencies: [], dependents: ['n3'], producerId: 'p2', work: 'echo' } as any],
        ['n3', { id: 'n3', type: 'job', name: 'Job3', dependencies: ['n1', 'n2'], dependents: [], producerId: 'p3', work: 'echo' } as any],
      ]),
      nodeStates: new Map([
        ['n1', { id: '1', nodeId: 'n1', status: 'ready', attempts: 0, version: 0 }],
        ['n2', { id: '2', nodeId: 'n2', status: 'ready', attempts: 0, version: 0 }],
      ]),
      maxParallel: 0
    } as any as PlanInstance;
    
    const stateMachine: any = {
      getReadyNodes: sandbox.stub().returns(['n1', 'n2'])
    };
    
    const result = scheduler.selectNodes(plan, stateMachine, 0);
    assert.strictEqual(result[0], 'n1'); // n1 has more dependents
  });

  test('selectNodes uses alphabetical order as tiebreaker', () => {
    const plan = {
      id: 'p1',
      jobs: new Map([
        ['n2', { id: 'n2', type: 'job', name: 'Zebra', dependencies: [], dependents: [], producerId: 'p2', work: 'echo' } as any],
        ['n1', { id: 'n1', type: 'job', name: 'Alpha', dependencies: [], dependents: [], producerId: 'p1', work: 'echo' } as any],
      ]),
      nodeStates: new Map([
        ['n1', { id: '1', nodeId: 'n1', status: 'ready', attempts: 0, version: 0 }],
        ['n2', { id: '2', nodeId: 'n2', status: 'ready', attempts: 0, version: 0 }],
      ]),
      maxParallel: 0
    } as any as PlanInstance;
    
    const stateMachine: any = {
      getReadyNodes: sandbox.stub().returns(['n2', 'n1'])
    };
    
    const result = scheduler.selectNodes(plan, stateMachine, 0);
    assert.strictEqual(result[0], 'n1'); // Alpha comes before Zebra
  });

  test('selectNodes counts scheduled nodes', () => {
    const plan = {
      id: 'p1',
      jobs: new Map([
        ['n1', { id: 'n1', type: 'job', name: 'Job1', dependencies: [], dependents: [], producerId: 'p1', work: 'echo' } as any],
        ['n2', { id: 'n2', type: 'job', name: 'Job2', dependencies: [], dependents: [], producerId: 'p2', work: 'echo' } as any],
      ]),
      nodeStates: new Map([
        ['n1', { id: '1', nodeId: 'n1', status: 'ready', attempts: 0, version: 0 }],
        ['n2', { id: '2', nodeId: 'n2', status: 'scheduled', attempts: 0, version: 0 }],
      ]),
      maxParallel: 1
    } as any as PlanInstance;
    
    const stateMachine: any = {
      getReadyNodes: sandbox.stub().returns(['n1'])
    };
    
    const result = scheduler.selectNodes(plan, stateMachine, 0);
    assert.deepStrictEqual(result, []); // n2 is scheduled, so capacity is full
  });

  test('setGlobalMaxParallel updates limit', () => {
    scheduler.setGlobalMaxParallel(4);
    assert.strictEqual(scheduler.getGlobalMaxParallel(), 4);
  });

  test('getGlobalMaxParallel returns current limit', () => {
    assert.strictEqual(scheduler.getGlobalMaxParallel(), 8);
  });

  test('defaults to 8 when no options provided', () => {
    const defaultScheduler = new PlanScheduler();
    assert.strictEqual(defaultScheduler.getGlobalMaxParallel(), 8);
  });

  test('handles missing node in prioritizeNodes', () => {
    const plan = {
      id: 'p1',
      jobs: new Map([
        ['n1', { id: 'n1', type: 'job', name: 'Job1', dependencies: [], dependents: [], producerId: 'p1', work: 'echo' } as any],
      ]),
      nodeStates: new Map([
        ['n1', { id: '1', nodeId: 'n1', status: 'ready', attempts: 0, version: 0 }],
        ['n2', { id: '2', nodeId: 'n2', status: 'ready', attempts: 0, version: 0 }],
      ]),
      maxParallel: 0
    } as any as PlanInstance;
    
    const stateMachine: any = {
      getReadyNodes: sandbox.stub().returns(['n1', 'n2']) // n2 doesn't exist in jobs
    };
    
    const result = scheduler.selectNodes(plan, stateMachine, 0);
    assert.ok(result.includes('n1'));
  });
});
