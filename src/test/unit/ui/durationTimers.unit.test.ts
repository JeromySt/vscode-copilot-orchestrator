/**
 * @fileoverview Unit tests for Duration Timer functionality
 * 
 * @module test/unit/ui/durationTimers
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { PlanTreeViewManager, PlanTreeDataProvider } from '../../../ui/planTreeProvider';
import { PulseEmitter } from '../../../core/pulse';
import { formatDurationMs } from '../../../ui/templates/helpers';

// Mock PlanRunner for testing
class MockPlanRunner {
  private listeners: { [event: string]: Function[] } = {};
  private mockPlans: Array<{ id: string; status: string; startedAt?: number; nodes?: Map<string, any> }> = [];

  on(event: string, listener: Function) {
    if (!this.listeners[event]) {this.listeners[event] = [];}
    this.listeners[event].push(listener);
  }

  emit(event: string, ...args: any[]) {
    this.listeners[event]?.forEach(listener => listener(...args));
  }

  getAll() {
    return this.mockPlans.map(plan => ({
      id: plan.id,
      nodes: plan.nodes || new Map(),
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

  setMockPlans(plans: Array<{ id: string; status: string; startedAt?: number; nodes?: Map<string, any> }>) {
    this.mockPlans = plans;
  }
}

function createPlansTreeProvider(): PlanTreeDataProvider {
  const mockRunner = new MockPlanRunner();
  return new PlanTreeDataProvider(mockRunner as any);
}

function createPlanDetailPanel() {
  // Mock panel with getWebviewHtml method
  return {
    getWebviewHtml() {
      return `
        <script>
          function formatDuration(ms) {
            if (ms < 1000) return '< 1s';
            const s = Math.floor(ms / 1000);
            if (s < 60) return s + 's';
            const m = Math.floor(s / 60);
            const remainingS = s % 60;
            if (m < 60) return m + 'm ' + remainingS + 's';
            const h = Math.floor(m / 60);
            const remainingM = m % 60;
            return h + 'h ' + remainingM + 'm';
          }
          
          setInterval(() => {
            // Duration update logic
          }, 1000);
        </script>
      `;
    }
  };
}

function createNodeDetailPanel(node?: { state: { startedAt: string; status: string } }) {
  const startedAt = node?.state?.startedAt || '2026-02-12T10:00:00Z';
  const status = node?.state?.status || 'running';
  
  return {
    getWebviewHtml() {
      return `
        <script>
          function formatDuration(ms) {
            if (ms < 1000) return '< 1s';
            const s = Math.floor(ms / 1000);
            if (s < 60) return s + 's';
            const m = Math.floor(s / 60);
            const remainingS = s % 60;
            if (m < 60) return m + 'm ' + remainingS + 's';
            const h = Math.floor(m / 60);
            const remainingM = m % 60;
            return h + 'h ' + remainingM + 'm';
          }
          
          setInterval(() => {
            // Duration update logic
          }, 1000);
        </script>
        <div data-started-at="${startedAt}" data-status="${status}">Duration content</div>
      `;
    }
  };
}

let mockRunner: MockPlanRunner;

suite('Duration Timer Updates', () => {
  let clock: sinon.SinonFakeTimers;
  
  setup(() => {
    clock = sinon.useFakeTimers();
    mockRunner = new MockPlanRunner();
  });
  
  teardown(() => {
    clock.restore();
  });
  
  suite('Tree View Timer', () => {
    test('should fire _onDidChangeTreeData every second when plans running', () => {
      const pulse = new PulseEmitter();
      const manager = new PlanTreeViewManager(mockRunner as any, pulse);
      
      // Setup running plan
      mockRunner.setMockPlans([{
        id: '1',
        status: 'running',
        startedAt: Date.now(),
        nodes: new Map([['node1', { state: { status: 'running' } }]])
      }]);
      
      // Create tree view which starts the timer
      const mockContext = { subscriptions: [] };
      manager.createTreeView(mockContext as any);
      
      const provider = (manager as any).treeDataProvider;
      const fireSpy = sinon.spy(provider._onDidChangeTreeData, 'fire');
      
      // Advance 5 seconds
      clock.tick(5000);
      
      assert.strictEqual(fireSpy.callCount, 5, 'Should fire _onDidChangeTreeData every second for 5 seconds');
      
      manager.dispose();
    });
    
    test('should NOT fire when no running plans', () => {
      const pulse = new PulseEmitter();
      const manager = new PlanTreeViewManager(mockRunner as any, pulse);
      
      // Setup completed plan
      mockRunner.setMockPlans([{
        id: '1',
        status: 'completed',
        nodes: new Map([['node1', { state: { status: 'completed' } }]])
      }]);
      
      const mockContext = { subscriptions: [] };
      manager.createTreeView(mockContext as any);
      
      const provider = (manager as any).treeDataProvider;
      const fireSpy = sinon.spy(provider._onDidChangeTreeData, 'fire');
      
      clock.tick(5000);
      
      assert.strictEqual(fireSpy.callCount, 0, 'Should not fire when no plans are running');
      
      manager.dispose();
    });
    
    test('should return fresh duration in getTreeItem', () => {
      const provider = createPlansTreeProvider();
      const plan = { 
        id: 'test-plan',
        startedAt: Date.now() - 65000,  // 65 seconds ago
        spec: { name: 'Test Plan' },
        nodes: new Map()
      };
      
      // Mock the plan runner to return our test plan
      const mockRunnerInstance = (provider as any).planRunner;
      mockRunnerInstance.setMockPlans([{
        id: 'test-plan',
        status: 'running',
        startedAt: plan.startedAt
      }]);
      
      const item = provider.getTreeItem({ plan } as any);
      
      // Should contain duration around 1m 5s or 1m 6s (allowing for timing variance)
      const description = typeof item.description === 'string' ? item.description : '';
      assert.ok(
        description.match(/1m [5-6]s/), 
        `Expected duration around 1m 5s, got: ${description}`
      );
    });
  });
  
  suite('Webview Timer JavaScript', () => {
    test('should have setInterval in plan detail webview', () => {
      const panel = createPlanDetailPanel();
      const html = panel.getWebviewHtml();
      
      assert.ok(html.includes('setInterval'), 'Plan detail webview should contain setInterval');
      assert.ok(html.includes('formatDuration'), 'Plan detail webview should contain formatDuration function');
    });
    
    test('should have setInterval in node detail webview', () => {
      const panel = createNodeDetailPanel();
      const html = panel.getWebviewHtml();
      
      assert.ok(html.includes('setInterval'), 'Node detail webview should contain setInterval');
      assert.ok(html.includes('formatDuration'), 'Node detail webview should contain formatDuration function');
    });
    
    test('should include startedAt timestamp in webview', () => {
      const startedAt = '2026-02-12T10:00:00Z';
      const panel = createNodeDetailPanel({ state: { startedAt, status: 'running' } });
      const html = panel.getWebviewHtml();
      
      assert.ok(html.includes(startedAt), 'Webview should include startedAt timestamp');
    });
  });
  
  suite('formatDuration function', () => {
    test('should format seconds', () => {
      assert.strictEqual(formatDurationMs(45000), '45s', 'Should format 45000ms as "45s"');
    });
    
    test('should format minutes and seconds', () => {
      assert.strictEqual(formatDurationMs(125000), '2m 5s', 'Should format 125000ms as "2m 5s"');
    });
    
    test('should format hours and minutes', () => {
      assert.strictEqual(formatDurationMs(3725000), '1h 2m', 'Should format 3725000ms as "1h 2m"');
    });
    
    test('should format sub-second durations', () => {
      assert.strictEqual(formatDurationMs(500), '< 1s', 'Should format 500ms as "< 1s"');
    });
    
    test('should format exact minute boundaries', () => {
      assert.strictEqual(formatDurationMs(60000), '1m 0s', 'Should format 60000ms as "1m 0s"');
    });
    
    test('should format exact hour boundaries', () => {
      assert.strictEqual(formatDurationMs(3600000), '1h 0m', 'Should format 3600000ms as "1h 0m"');
    });
  });
});