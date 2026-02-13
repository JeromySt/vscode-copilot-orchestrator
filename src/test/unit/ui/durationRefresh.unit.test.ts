/**
 * @fileoverview Unit tests for Duration Refresh Timer functionality
 * 
 * @module test/unit/ui/durationRefresh
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { PlanTreeViewManager } from '../../../ui/planTreeProvider';
import { PulseEmitter } from '../../../core/pulse';
import { formatDurationMs } from '../../../ui/templates/helpers';

// Mock PlanRunner for testing
class MockPlanRunner {
  private listeners: { [event: string]: Function[] } = {};
  private mockPlans: Array<{ id: string; status: string; startedAt?: number }> = [];

  on(event: string, listener: Function) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(listener);
  }

  emit(event: string, ...args: any[]) {
    this.listeners[event]?.forEach(listener => listener(...args));
  }

  getAll() {
    return this.mockPlans.map(plan => ({
      id: plan.id,
      nodes: new Map(),
      spec: { name: `Plan ${plan.id}` },
      startedAt: plan.startedAt
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

  setMockPlans(plans: Array<{ id: string; status: string; startedAt?: number }>) {
    this.mockPlans = plans;
  }
}

suite('Plan Tree Duration Refresh', () => {
  let mockPlanRunner: MockPlanRunner;
  let clock: sinon.SinonFakeTimers;

  setup(() => {
    mockPlanRunner = new MockPlanRunner();
    clock = sinon.useFakeTimers();
  });

  teardown(() => {
    clock.restore();
  });

  suite('Duration refresh timer', () => {
    test('should start pulse subscription on construction when plans are running', () => {
      mockPlanRunner.setMockPlans([{ id: '1', status: 'running', startedAt: Date.now() }]);
      const pulse = new PulseEmitter();
      const manager = new PlanTreeViewManager(mockPlanRunner as any, pulse);
      
      const mockContext = { subscriptions: [] };
      manager.createTreeView(mockContext as any);
      
      // Pulse should be running since onPulse auto-starts it
      assert.strictEqual(pulse.isRunning, true, 'Pulse should be running after createTreeView');
      
      manager.dispose();
    });

    test('should subscribe to pulse on construction even when no plans running', () => {
      mockPlanRunner.setMockPlans([{ id: '1', status: 'completed' }]);
      const pulse = new PulseEmitter();
      const manager = new PlanTreeViewManager(mockPlanRunner as any, pulse);
      
      const mockContext = { subscriptions: [] };
      manager.createTreeView(mockContext as any);
      
      // Pulse is still running (subscriber exists), but tree won't refresh without running plans
      assert.strictEqual(pulse.isRunning, true, 'Pulse should be running (subscriber exists)');
      
      manager.dispose();
    });
    
    test('should fire tree data change event every second when plans running', () => {
      mockPlanRunner.setMockPlans([{ id: '1', status: 'running', startedAt: Date.now() }]);
      
      const pulse = new PulseEmitter();
      const manager = new PlanTreeViewManager(mockPlanRunner as any, pulse);
      const mockContext = { subscriptions: [] };
      manager.createTreeView(mockContext as any);
      
      const provider = (manager as any).treeDataProvider;
      const fireSpy = sinon.spy(provider._onDidChangeTreeData, 'fire');
      
      // Advance timer by 3 seconds
      clock.tick(3000);
      
      // Should have fired 3 times
      assert.strictEqual(fireSpy.callCount, 3, 'Should fire tree data change event 3 times');
      
      manager.dispose();
    });
    
    test('should not fire event when no plans are running', () => {
      mockPlanRunner.setMockPlans([{ id: '1', status: 'completed' }]);
      
      const pulse = new PulseEmitter();
      const manager = new PlanTreeViewManager(mockPlanRunner as any, pulse);
      const mockContext = { subscriptions: [] };
      manager.createTreeView(mockContext as any);
      
      const provider = (manager as any).treeDataProvider;
      const fireSpy = sinon.spy(provider._onDidChangeTreeData, 'fire');
      
      // Advance timer by 3 seconds
      clock.tick(3000);
      
      // Should not have fired (no running plans)
      assert.strictEqual(fireSpy.callCount, 0, 'Should not fire tree data change event when no plans running');
      
      manager.dispose();
    });
    
    test('should stop pulse subscription when disposed', () => {
      mockPlanRunner.setMockPlans([{ id: '1', status: 'running', startedAt: Date.now() }]);
      const pulse = new PulseEmitter();
      const manager = new PlanTreeViewManager(mockPlanRunner as any, pulse);
      const mockContext = { subscriptions: [] };
      manager.createTreeView(mockContext as any);
      
      manager.dispose();
      
      // After dispose, pulse should auto-stop (no subscribers)
      assert.strictEqual(pulse.isRunning, false, 'Pulse should stop after manager dispose');
    });
    
    test('should check hasRunningPlans correctly', () => {
      const pulse = new PulseEmitter();
      const manager = new PlanTreeViewManager(mockPlanRunner as any, pulse);
      
      // No running plans
      mockPlanRunner.setMockPlans([
        { id: '1', status: 'completed' },
        { id: '2', status: 'completed' }
      ]);
      assert.strictEqual((manager as any).hasRunningPlans(), false, 'Should return false when no plans running');
      
      // One running plan
      mockPlanRunner.setMockPlans([
        { id: '1', status: 'completed' },
        { id: '2', status: 'running', startedAt: Date.now() }
      ]);
      assert.strictEqual((manager as any).hasRunningPlans(), true, 'Should return true when one plan running');
      
      // One pending plan
      mockPlanRunner.setMockPlans([
        { id: '1', status: 'pending', startedAt: Date.now() }
      ]);
      assert.strictEqual((manager as any).hasRunningPlans(), true, 'Should return true when one plan pending');
      
      manager.dispose();
    });
  });
  
  suite('Duration display', () => {
    test('should calculate duration from startedAt to now', () => {
      const startedAt = new Date(Date.now() - 125000);  // 2m 5s ago
      
      const duration = formatDurationMs(Date.now() - startedAt.getTime());
      
      assert.strictEqual(duration, '2m 5s', 'Should format 125 seconds as 2m 5s');
    });
    
    test('should show final duration for completed plans', () => {
      const startedAt = new Date('2026-02-12T10:00:00Z');
      const completedAt = new Date('2026-02-12T10:05:30Z');
      
      const duration = formatDurationMs(completedAt.getTime() - startedAt.getTime());
      
      assert.strictEqual(duration, '5m 30s', 'Should format 330 seconds as 5m 30s');
    });
    
    test('should handle hour+ durations', () => {
      const startedAt = new Date(Date.now() - 3725000);  // 1h 2m 5s
      
      const duration = formatDurationMs(Date.now() - startedAt.getTime());
      
      assert.strictEqual(duration, '1h 2m', 'Should format 3725 seconds as 1h 2m');
    });
    
    test('should handle short durations', () => {
      const duration = formatDurationMs(500);  // 500ms
      
      assert.strictEqual(duration, '< 1s', 'Should show < 1s for sub-second durations');
    });
    
    test('should handle exact minute durations', () => {
      const duration = formatDurationMs(60000);  // 60s
      
      assert.strictEqual(duration, '1m 0s', 'Should format 60 seconds as 1m 0s');
    });
  });
});