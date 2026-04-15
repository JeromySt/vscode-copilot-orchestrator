/**
 * @fileoverview Unit tests for Activity Bar Badge functionality
 * 
 * @module test/unit/ui/activityBarBadge
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { PlanTreeViewManager } from '../../../ui/planTreeProvider';
import { PulseEmitter } from '../../../core/pulse';

// Mock PlanRunner for testing
class MockPlanRunner {
  private listeners: { [event: string]: Function[] } = {};
  private mockPlans: Array<{ id: string; status: string }> = [];
  private _version = 1;

  on(event: string, listener: Function) {
    if (!this.listeners[event]) {this.listeners[event] = [];}
    this.listeners[event].push(listener);
  }

  emit(event: string, ...args: any[]) {
    this.listeners[event]?.forEach(listener => listener(...args));
  }

  getAll() {
    return this.mockPlans.map(p => ({
      ...p,
      spec: { name: `Plan ${p.id}` },
      jobs: new Map(),
      stateVersion: this._version,
      createdAt: Date.now(),
    }));
  }

  getByStatus(status: string) {
    return this.getAll().filter(plan => {
      const sm = this.getStateMachine(plan.id);
      return sm?.computePlanStatus() === status;
    });
  }

  getStateMachine(planId: string) {
    const plan = this.mockPlans.find(p => p.id === planId);
    return plan ? {
      computePlanStatus: () => plan.status
    } : undefined;
  }

  getStatus(planId: string) {
    const plan = this.mockPlans.find(p => p.id === planId);
    if (!plan) { return undefined; }
    return {
      status: plan.status,
      counts: { pending: 0, ready: 0, scheduled: 0, running: 0, succeeded: 0, failed: 0, blocked: 0, canceled: 0 },
      progress: plan.status === 'succeeded' ? 100 : 50,
    };
  }

  getEffectiveStartedAt(_planId: string) { return undefined; }
  getEffectiveEndedAt(_planId: string) { return undefined; }
  removeListener() {}

  setMockPlans(plans: Array<{ id: string; status: string }>) {
    this.mockPlans = plans;
    this._version++; // Increment version so PlanListProducer detects the change
  }
}

suite('Activity Bar Badge', () => {
  let mockPlanRunner: MockPlanRunner;
  let manager: PlanTreeViewManager;
  let mockTreeView: any;

  function setup() {
    mockPlanRunner = new MockPlanRunner();
    manager = new PlanTreeViewManager(mockPlanRunner as any, new PulseEmitter());
    
    // Mock TreeView
    mockTreeView = {
      badge: undefined
    };

    // Mock vscode.window.createTreeView to return our mock
    sinon.stub(require('vscode').window, 'createTreeView').returns(mockTreeView);

    return () => {
      require('vscode').window.createTreeView.restore?.();
    };
  }

  suite('Badge value', () => {
    test('should show count of running plans', () => {
      const cleanup = setup();
      
      // Setup: 2 running plans, 1 completed
      mockPlanRunner.setMockPlans([
        { id: '1', status: 'running' },
        { id: '2', status: 'running' },
        { id: '3', status: 'completed' }
      ]);

      // Create tree view (this will call updateBadge internally)
      manager.createTreeView({
        subscriptions: { push: () => {} }
      } as any);

      assert.strictEqual(mockTreeView.badge.value, 2);
      assert.strictEqual(mockTreeView.badge.tooltip, '2 plans running');
      
      cleanup();
    });

    test('should show singular tooltip for 1 running plan', () => {
      const cleanup = setup();
      
      mockPlanRunner.setMockPlans([
        { id: '1', status: 'running' }
      ]);

      manager.createTreeView({
        subscriptions: { push: () => {} }
      } as any);

      assert.strictEqual(mockTreeView.badge?.tooltip, '1 plan running');
      
      cleanup();
    });

    test('should hide badge when no plans running', () => {
      const cleanup = setup();
      
      mockPlanRunner.setMockPlans([
        { id: '1', status: 'completed' },
        { id: '2', status: 'failed' }
      ]);

      manager.createTreeView({
        subscriptions: { push: () => {} }
      } as any);

      assert.strictEqual(mockTreeView.badge, undefined);
      
      cleanup();
    });

    test('should hide badge when no plans exist', () => {
      const cleanup = setup();
      
      mockPlanRunner.setMockPlans([]);

      manager.createTreeView({
        subscriptions: { push: () => {} }
      } as any);

      assert.strictEqual(mockTreeView.badge, undefined);
      
      cleanup();
    });
  });

  suite('Badge updates via pulse tick', () => {
    test('should update when plan state changes on next tick', () => {
      const cleanup = setup();
      
      mockPlanRunner.setMockPlans([]);
      manager.createTreeView({ subscriptions: { push: () => {} } } as any);

      // No plans running — badge should be undefined
      assert.strictEqual(mockTreeView.badge, undefined);

      // Add a running plan and trigger pulse tick
      mockPlanRunner.setMockPlans([{ id: '1', status: 'running' }]);
      (manager as any)._onPulseTick();

      // Badge should now show 1
      assert.strictEqual(mockTreeView.badge?.value, 1);
      
      cleanup();
    });

    test('should clear badge when plan completes on next tick', () => {
      const cleanup = setup();
      
      mockPlanRunner.setMockPlans([{ id: '1', status: 'running' }]);
      manager.createTreeView({ subscriptions: { push: () => {} } } as any);

      assert.strictEqual(mockTreeView.badge?.value, 1);

      // Plan completes → trigger pulse tick
      mockPlanRunner.setMockPlans([{ id: '1', status: 'succeeded' }]);
      (manager as any)._onPulseTick();

      assert.strictEqual(mockTreeView.badge, undefined);
      
      cleanup();
    });

    test('should update when plan deleted on next tick', () => {
      const cleanup = setup();
      
      mockPlanRunner.setMockPlans([{ id: '1', status: 'running' }]);
      manager.createTreeView({ subscriptions: { push: () => {} } } as any);

      assert.strictEqual(mockTreeView.badge?.value, 1);

      // Plan removed → trigger pulse tick
      mockPlanRunner.setMockPlans([]);
      (manager as any)._onPulseTick();

      assert.strictEqual(mockTreeView.badge, undefined);
      
      cleanup();
    });

    test('should handle multiple running plans', () => {
      const cleanup = setup();
      
      mockPlanRunner.setMockPlans([
        { id: '1', status: 'running' },
        { id: '2', status: 'running' },
      ]);
      manager.createTreeView({ subscriptions: { push: () => {} } } as any);

      assert.strictEqual(mockTreeView.badge?.value, 2);

      // One finishes
      mockPlanRunner.setMockPlans([
        { id: '1', status: 'running' },
        { id: '2', status: 'succeeded' },
      ]);
      (manager as any)._onPulseTick();

      assert.strictEqual(mockTreeView.badge?.value, 1);
      
      cleanup();
    });
  });

  suite('Initial badge on activation', () => {
    test('should set badge after loading persisted plans', () => {
      const cleanup = setup();
      
      mockPlanRunner.setMockPlans([
        { id: '1', status: 'running' }
      ]);

      manager.createTreeView({
        subscriptions: { push: () => {} }
      } as any);

      assert.strictEqual(mockTreeView.badge?.value, 1);
      
      cleanup();
    });
  });
});