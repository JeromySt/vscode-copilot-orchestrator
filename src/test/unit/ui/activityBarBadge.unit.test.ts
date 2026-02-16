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

  on(event: string, listener: Function) {
    if (!this.listeners[event]) {this.listeners[event] = [];}
    this.listeners[event].push(listener);
  }

  emit(event: string, ...args: any[]) {
    this.listeners[event]?.forEach(listener => listener(...args));
  }

  getAll() {
    return this.mockPlans;
  }

  getByStatus(status: string) {
    return this.mockPlans.filter(plan => plan.status === status);
  }

  getStateMachine(planId: string) {
    const plan = this.mockPlans.find(p => p.id === planId);
    return plan ? {
      computePlanStatus: () => plan.status
    } : undefined;
  }

  setMockPlans(plans: Array<{ id: string; status: string }>) {
    this.mockPlans = plans;
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

  suite('Badge updates on events', () => {
    test('should update when node starts', () => {
      const cleanup = setup();
      
      mockPlanRunner.setMockPlans([]);
      manager.createTreeView({
        subscriptions: { push: () => {} }
      } as any);

      // Create spy on updateBadge method by inspecting call count
      let badgeUpdateCount = 0;
      const _originalBadgeSetter = Object.getOwnPropertyDescriptor(mockTreeView, 'badge')?.set;
      Object.defineProperty(mockTreeView, 'badge', {
        set: function(value) {
          badgeUpdateCount++;
          this._badge = value;
        },
        get: function() {
          return this._badge;
        },
        configurable: true
      });

      const initialUpdateCount = badgeUpdateCount;
      
      // Emit planUpdated event (covers node-started, node-completed, node-crashed scenarios)
      mockPlanRunner.emit('planUpdated', { type: 'node-started', planId: '1' });
      
      assert.ok(badgeUpdateCount > initialUpdateCount, 'Badge should be updated when node starts');
      
      cleanup();
    });

    test('should update when node completes', () => {
      const cleanup = setup();
      
      mockPlanRunner.setMockPlans([]);
      manager.createTreeView({
        subscriptions: { push: () => {} }
      } as any);

      let badgeUpdateCount = 0;
      Object.defineProperty(mockTreeView, 'badge', {
        set: function(value) {
          badgeUpdateCount++;
          this._badge = value;
        },
        get: function() {
          return this._badge;
        },
        configurable: true
      });

      const initialUpdateCount = badgeUpdateCount;
      
      mockPlanRunner.emit('planCompleted', { type: 'node-completed', planId: '1' });
      
      assert.ok(badgeUpdateCount > initialUpdateCount, 'Badge should be updated when node completes');
      
      cleanup();
    });

    test('should update when plan is deleted', () => {
      const cleanup = setup();
      
      mockPlanRunner.setMockPlans([]);
      manager.createTreeView({
        subscriptions: { push: () => {} }
      } as any);

      let badgeUpdateCount = 0;
      Object.defineProperty(mockTreeView, 'badge', {
        set: function(value) {
          badgeUpdateCount++;
          this._badge = value;
        },
        get: function() {
          return this._badge;
        },
        configurable: true
      });

      const initialUpdateCount = badgeUpdateCount;
      
      mockPlanRunner.emit('planDeleted', { planId: '1' });
      
      assert.ok(badgeUpdateCount > initialUpdateCount, 'Badge should be updated when plan is deleted');
      
      cleanup();
    });

    test('should update when node crashes', () => {
      const cleanup = setup();
      
      mockPlanRunner.setMockPlans([]);
      manager.createTreeView({
        subscriptions: { push: () => {} }
      } as any);

      let badgeUpdateCount = 0;
      Object.defineProperty(mockTreeView, 'badge', {
        set: function(value) {
          badgeUpdateCount++;
          this._badge = value;
        },
        get: function() {
          return this._badge;
        },
        configurable: true
      });

      const initialUpdateCount = badgeUpdateCount;
      
      // Use nodeTransition event which is listened to by the manager
      mockPlanRunner.emit('nodeTransition', { type: 'node-crashed', planId: '1' });
      
      assert.ok(badgeUpdateCount > initialUpdateCount, 'Badge should be updated when node crashes');
      
      cleanup();
    });
  });

  suite('Initial badge on activation', () => {
    test('should set badge after loading persisted plans', () => {
      const cleanup = setup();
      
      mockPlanRunner.setMockPlans([
        { id: '1', status: 'running' }  // Recovered running plan
      ]);

      // Create tree view which will set initial badge
      manager.createTreeView({
        subscriptions: { push: () => {} }
      } as any);

      assert.strictEqual(mockTreeView.badge?.value, 1);
      
      cleanup();
    });
  });
});