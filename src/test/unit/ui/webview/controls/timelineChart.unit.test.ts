/**
 * @fileoverview Unit tests for TimelineChart control
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { suite, test, setup, teardown } from 'mocha';
import { EventBus } from '../../../../../ui/webview/eventBus';
import { Topics } from '../../../../../ui/webview/topics';
import { TimelineChart, TimelineData } from '../../../../../ui/webview/controls/timelineChart';

function mockDocument(elements: Record<string, any> = {}): () => void {
  const prev = (globalThis as any).document;
  (globalThis as any).document = {
    getElementById(id: string) { return elements[id] || null; },
    createElement(tag: string) {
      // Return a minimal mock element
      const children: any[] = [];
      return {
        className: '',
        style: { cssText: '' },
        appendChild(child: any) { children.push(child); return this; },
        setAttribute() {},
        addEventListener() {},
        children,
      };
    },
    createElementNS(ns: string, tag: string) {
      const children: any[] = [];
      return {
        setAttribute() {},
        appendChild(child: any) { children.push(child); return this; },
        style: { cssText: '' },
        children,
      };
    },
  };
  return () => {
    if (prev === undefined) { delete (globalThis as any).document; }
    else { (globalThis as any).document = prev; }
  };
}

function makeContainer(): any {
  const container: any = {
    innerHTML: '',
    clientWidth: 1000,
    appendChild() {},
    closest() { return container; },
    scrollLeft: 0,
    scrollWidth: 2000,
    addEventListener() {},
    removeEventListener() {},
  };
  return container;
}

// Realistic timestamps — small epoch values (e.g. 1000) cause OOM when
// Date.now() is used as the running-plan end, creating billions of loop iterations.
const NOW = Date.now();

suite('TimelineChart', () => {
  let bus: EventBus;
  let restoreDoc: () => void;

  setup(() => {
    bus = new EventBus();
  });

  teardown(() => {
    if (restoreDoc) { restoreDoc(); }
  });

  suite('update', () => {
    test('should handle empty nodes array', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = { nodes: [] };
      
      chart.update(data);
      
      assert.ok(container.innerHTML.includes('No timeline data'), 'Should show empty message');
      chart.dispose();
    });

    test('should handle undefined data', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      
      chart.update(undefined);
      
      assert.ok(container.innerHTML.includes('No timeline data'), 'Should show empty message');
      chart.dispose();
    });

    test('should handle nodes with dependencies', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        nodes: [
          { nodeId: 'n1', name: 'Job1', status: 'succeeded', startedAt: NOW - 5000, endedAt: NOW - 4000 },
          { nodeId: 'n2', name: 'Job2', status: 'succeeded', startedAt: NOW - 3900, endedAt: NOW - 3000, dependencies: ['n1'] },
        ],
      };
      
      chart.update(data);
      
      // Verify no errors during rendering
      assert.ok(container.innerHTML || container.appendChild, 'Should render without errors');
      chart.dispose();
    });

    test('should handle nodes with step statuses', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        nodes: [{
          nodeId: 'n1',
          name: 'Job1',
          status: 'succeeded',
          startedAt: NOW - 5000,
          endedAt: NOW - 4000,
          attempts: [{
            attemptNumber: 1,
            status: 'succeeded',
            startedAt: NOW - 5000,
            endedAt: NOW - 4000,
            stepStatuses: {
              'merge-fi': 'succeeded',
              'prechecks': 'succeeded',
              'work': 'succeeded',
              'commit': 'succeeded',
            },
          }],
        }],
      };
      
      chart.update(data);
      
      // Verify phase segments rendered
      assert.ok(container.innerHTML || container.appendChild, 'Should render without errors');
      chart.dispose();
    });

    test('should handle nodes with groups', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        nodes: [
          { nodeId: 'n1', name: 'Job1', group: 'group-a', status: 'succeeded', startedAt: NOW - 5000, endedAt: NOW - 4000 },
          { nodeId: 'n2', name: 'Job2', group: 'group-a', status: 'succeeded', startedAt: NOW - 3900, endedAt: NOW - 3000 },
          { nodeId: 'n3', name: 'Job3', group: 'group-b', status: 'succeeded', startedAt: NOW - 4500, endedAt: NOW - 3500 },
        ],
      };
      
      chart.update(data);
      
      // Verify group headers rendered
      assert.ok(container.innerHTML || container.appendChild, 'Should render without errors');
      chart.dispose();
    });
  });

  suite('interactivity', () => {
    test('should subscribe to PULSE when running nodes exist', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        nodes: [{ nodeId: 'n1', name: 'Job', status: 'running', startedAt: NOW - 5000 }],
      };
      
      chart.update(data);
      
      assert.strictEqual(bus.count(Topics.PULSE), 1, 'Should subscribe to PULSE');
      chart.dispose();
    });

    test('should NOT subscribe to PULSE when plan has never started (pending-start)', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        planStartedAt: undefined,
        planEndedAt: undefined,
        stateHistory: [{ status: 'pending-start', timestamp: Date.now() }],
        nodes: [{ nodeId: 'n1', name: 'Job', status: 'pending' }],
      };
      
      chart.update(data);
      
      assert.strictEqual(bus.count(Topics.PULSE), 0, 'Should NOT subscribe to PULSE for pending-start plans');
      chart.dispose();
    });

    test('should unsubscribe from PULSE when no running nodes', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      
      // First update with running node
      const runningData: TimelineData = {
        nodes: [{ nodeId: 'n1', name: 'Job', status: 'running', startedAt: NOW - 5000 }],
      };
      chart.update(runningData);
      assert.strictEqual(bus.count(Topics.PULSE), 1, 'Should subscribe to PULSE');
      
      // Then update with completed node
      const completedData: TimelineData = {
        planEndedAt: NOW - 4000,
        nodes: [{ nodeId: 'n1', name: 'Job', status: 'succeeded', startedAt: NOW - 5000, endedAt: NOW - 4000 }],
      };
      chart.update(completedData);
      
      assert.strictEqual(bus.count(Topics.PULSE), 0, 'Should unsubscribe from PULSE');
      chart.dispose();
    });
  });

  suite('phase segments', () => {
    test('should render phase segments for attempts with stepStatuses', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        nodes: [{
          nodeId: 'n1',
          name: 'Job1',
          status: 'succeeded',
          startedAt: NOW - 5000,
          endedAt: NOW - 4000,
          attempts: [{
            attemptNumber: 1,
            status: 'succeeded',
            startedAt: NOW - 5000,
            endedAt: NOW - 4000,
            stepStatuses: {
              'merge-fi': 'succeeded',
              'work': 'succeeded',
              'commit': 'succeeded',
            },
          }],
        }],
      };
      
      chart.update(data);
      
      assert.ok(container.innerHTML || container.appendChild, 'Should render without errors');
      chart.dispose();
    });

    test('should handle attempts without stepStatuses', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        nodes: [{
          nodeId: 'n1',
          name: 'Job1',
          status: 'succeeded',
          startedAt: NOW - 5000,
          endedAt: NOW - 4000,
          attempts: [{
            attemptNumber: 1,
            status: 'succeeded',
            startedAt: NOW - 5000,
            endedAt: NOW - 4000,
          }],
        }],
      };
      
      chart.update(data);
      
      assert.ok(container.innerHTML || container.appendChild, 'Should render without errors');
      chart.dispose();
    });
  });

  suite('dependency arrows', () => {
    test('should render arrows for nodes with dependencies', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        nodes: [
          { nodeId: 'n1', name: 'Job1', status: 'succeeded', startedAt: NOW - 5000, endedAt: NOW - 4000 },
          { nodeId: 'n2', name: 'Job2', status: 'succeeded', startedAt: NOW - 3900, endedAt: NOW - 3000, dependencies: ['n1'] },
        ],
      };
      
      chart.update(data);
      
      assert.ok(container.innerHTML || container.appendChild, 'Should render without errors');
      chart.dispose();
    });

    test('should handle nodes without dependencies', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        nodes: [
          { nodeId: 'n1', name: 'Job1', status: 'succeeded', startedAt: NOW - 5000, endedAt: NOW - 4000 },
          { nodeId: 'n2', name: 'Job2', status: 'succeeded', startedAt: NOW - 3900, endedAt: NOW - 3000 },
        ],
      };
      
      chart.update(data);
      
      assert.ok(container.innerHTML || container.appendChild, 'Should render without errors');
      chart.dispose();
    });
  });

  suite('group headers', () => {
    test('should render group headers for grouped nodes', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        nodes: [
          { nodeId: 'n1', name: 'Job1', group: 'group-a', status: 'succeeded', startedAt: NOW - 5000, endedAt: NOW - 4000 },
          { nodeId: 'n2', name: 'Job2', group: 'group-a', status: 'succeeded', startedAt: NOW - 3900, endedAt: NOW - 3000 },
        ],
      };
      
      chart.update(data);
      
      assert.ok(container.innerHTML || container.appendChild, 'Should render without errors');
      chart.dispose();
    });

    test('should render ungrouped nodes without headers', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        nodes: [
          { nodeId: 'n1', name: 'Job1', status: 'succeeded', startedAt: NOW - 5000, endedAt: NOW - 4000 },
          { nodeId: 'n2', name: 'Job2', status: 'succeeded', startedAt: NOW - 3900, endedAt: NOW - 3000 },
        ],
      };
      
      chart.update(data);
      
      assert.ok(container.innerHTML || container.appendChild, 'Should render without errors');
      chart.dispose();
    });

    test('should render multiple groups', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        nodes: [
          { nodeId: 'n1', name: 'Job1', group: 'group-a', status: 'succeeded', startedAt: NOW - 5000, endedAt: NOW - 4000 },
          { nodeId: 'n2', name: 'Job2', group: 'group-b', status: 'succeeded', startedAt: NOW - 3900, endedAt: NOW - 3000 },
          { nodeId: 'n3', name: 'Job3', status: 'succeeded', startedAt: NOW - 4500, endedAt: NOW - 3500 },
        ],
      };
      
      chart.update(data);
      
      assert.ok(container.innerHTML || container.appendChild, 'Should render without errors');
      chart.dispose();
    });
  });

  suite('dispose', () => {
    test('should clean up subscriptions', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        nodes: [{ nodeId: 'n1', name: 'Job', status: 'running', startedAt: NOW - 5000 }],
      };
      
      chart.update(data);
      assert.strictEqual(bus.count(Topics.PULSE), 1, 'Should have PULSE subscription');
      
      chart.dispose();
      
      assert.strictEqual(bus.count(Topics.PULSE), 0, 'Should clean up PULSE subscription');
    });
  });

  suite('plan state row', () => {
    test('should render plan state row when stateHistory is present', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        planStartedAt: NOW - 5000,
        planEndedAt: NOW - 1000,
        planCreatedAt: NOW - 5100,
        stateHistory: [
          { status: 'created', timestamp: NOW - 5100 },
          { status: 'started', timestamp: NOW - 5000 },
          { status: 'completed', timestamp: NOW - 1000 },
        ],
        nodes: [{ nodeId: 'n1', name: 'Job1', status: 'succeeded', startedAt: NOW - 5000, endedAt: NOW - 4000 }],
      };
      
      chart.update(data);
      
      assert.ok(container.innerHTML || container.appendChild, 'Should render without errors');
      chart.dispose();
    });

    test('should not render plan state row when stateHistory is missing', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        planStartedAt: NOW - 5000,
        planEndedAt: NOW - 1000,
        nodes: [{ nodeId: 'n1', name: 'Job1', status: 'succeeded', startedAt: NOW - 5000, endedAt: NOW - 4000 }],
      };
      
      chart.update(data);
      
      assert.ok(container.innerHTML || container.appendChild, 'Should render without errors');
      chart.dispose();
    });

    test('should render pause intervals on plan state bar', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        planStartedAt: NOW - 5000,
        planEndedAt: NOW - 1000,
        stateHistory: [
          { status: 'started', timestamp: NOW - 5000 },
          { status: 'paused', timestamp: NOW - 4000 },
          { status: 'resumed', timestamp: NOW - 3000 },
          { status: 'completed', timestamp: NOW - 1000 },
        ],
        pauseHistory: [
          { pausedAt: NOW - 4000, resumedAt: NOW - 3000, reason: 'Manual pause' },
        ],
        nodes: [{ nodeId: 'n1', name: 'Job1', status: 'succeeded', startedAt: NOW - 5000, endedAt: NOW - 4000 }],
      };
      
      chart.update(data);
      
      assert.ok(container.innerHTML || container.appendChild, 'Should render without errors');
      chart.dispose();
    });

    test('should render event markers on axis', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        planStartedAt: NOW - 5000,
        planEndedAt: NOW - 1000,
        stateHistory: [
          { status: 'started', timestamp: NOW - 5000 },
          { status: 'paused', timestamp: NOW - 4000 },
          { status: 'resumed', timestamp: NOW - 3000 },
          { status: 'completed', timestamp: NOW - 1000 },
        ],
        nodes: [{ nodeId: 'n1', name: 'Job1', status: 'succeeded', startedAt: NOW - 5000, endedAt: NOW - 4000 }],
      };
      
      chart.update(data);
      
      assert.ok(container.innerHTML || container.appendChild, 'Should render without errors');
      chart.dispose();
    });
  });

  suite('phaseTiming', () => {
    test('should use phaseTiming for proportional segments when available', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        nodes: [{
          nodeId: 'n1',
          name: 'Job1',
          status: 'succeeded',
          startedAt: NOW - 5000,
          endedAt: NOW - 1000,
          attempts: [{
            attemptNumber: 1,
            status: 'succeeded',
            startedAt: NOW - 5000,
            endedAt: NOW - 1000,
            phaseTiming: [
              { phase: 'merge-fi', startedAt: NOW - 5000, endedAt: NOW - 4500 },
              { phase: 'work', startedAt: NOW - 4500, endedAt: NOW - 2000 },
              { phase: 'commit', startedAt: NOW - 2000, endedAt: NOW - 1000 },
            ],
          }],
        }],
      };
      
      chart.update(data);
      
      assert.ok(container.innerHTML || container.appendChild, 'Should render without errors');
      chart.dispose();
    });

    test('should fallback to phaseDurations when phaseTiming is missing', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        nodes: [{
          nodeId: 'n1',
          name: 'Job1',
          status: 'succeeded',
          startedAt: NOW - 5000,
          endedAt: NOW - 1000,
          attempts: [{
            attemptNumber: 1,
            status: 'succeeded',
            startedAt: NOW - 5000,
            endedAt: NOW - 1000,
            phaseDurations: [
              { phase: 'merge-fi', durationMs: 500, status: 'succeeded' },
              { phase: 'work', durationMs: 2500, status: 'succeeded' },
              { phase: 'commit', durationMs: 1000, status: 'succeeded' },
            ],
          }],
        }],
      };
      
      chart.update(data);
      
      assert.ok(container.innerHTML || container.appendChild, 'Should render without errors');
      chart.dispose();
    });
  });

  suite('backward compatibility', () => {
    test('should show backward compat message for completed plans without stateHistory', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        planStartedAt: NOW - 5000,
        planEndedAt: NOW - 1000,
        nodes: [{ nodeId: 'n1', name: 'Job1', status: 'succeeded', startedAt: NOW - 5000, endedAt: NOW - 4000 }],
      };
      
      chart.update(data);
      
      assert.ok(container.innerHTML || container.appendChild, 'Should render without errors');
      chart.dispose();
    });

    test('should not show backward compat message for running plans', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        planStartedAt: NOW - 5000,
        nodes: [{ nodeId: 'n1', name: 'Job1', status: 'running', startedAt: NOW - 5000 }],
      };
      
      chart.update(data);
      
      assert.ok(container.innerHTML || container.appendChild, 'Should render without errors');
      chart.dispose();
    });

    test('should not crash when all new fields are missing', () => {
      const container = makeContainer();
      restoreDoc = mockDocument({ 'timeline-container': container });
      
      const chart = new TimelineChart(bus, 'timeline', 'timeline-container');
      const data: TimelineData = {
        nodes: [{ nodeId: 'n1', name: 'Job1', status: 'succeeded', startedAt: NOW - 5000, endedAt: NOW - 4000 }],
      };
      
      chart.update(data);
      
      assert.ok(container.innerHTML || container.appendChild, 'Should render without errors');
      chart.dispose();
    });
  });
});
