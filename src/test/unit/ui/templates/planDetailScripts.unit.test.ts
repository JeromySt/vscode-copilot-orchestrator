/**
 * @fileoverview Unit tests for plan detail scripts template.
 *
 * @module test/unit/ui/templates/planDetailScripts
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import { renderPlanScripts } from '../../../../ui/templates/planDetail/scriptsTemplate';
import type { PlanScriptsData } from '../../../../ui/templates/planDetail/scriptsTemplate';

suite('planDetailScripts', () => {
  const mockData: PlanScriptsData = {
    nodeData: {
      'node1': {
        nodeId: 'job-1',
        planId: 'plan-123',
        type: 'job',
        name: 'Test Job',
        startedAt: Date.now(),
        status: 'running',
        version: 1,
      },
    },
    nodeTooltips: { 'node1': 'Test Job Full Name' },
    mermaidDef: 'graph TD\n  node1[Test Job]',
    edgeData: [],
    globalCapacityStats: null,
    timelineData: { nodes: [] },
  };

  suite('renderPlanScripts', () => {
    test('should return a script tag', () => {
      const result = renderPlanScripts(mockData);
      assert.ok(result.startsWith('<script>'), 'Should start with <script> tag');
      assert.ok(result.trimEnd().endsWith('</script>'), 'Should end with </script> tag');
    });

    test('should inject node data as JSON', () => {
      const result = renderPlanScripts(mockData);
      assert.ok(result.includes('const nodeData ='), 'Should define nodeData constant');
      assert.ok(result.includes('"nodeId":"job-1"'), 'Should include serialized node data');
    });

    test('should reference window.Orca bundle', () => {
      const result = renderPlanScripts(mockData);
      assert.ok(result.includes('window.Orca'), 'Should reference window.Orca for bundled controls');
    });

    test('should destructure EventBus from window.Orca', () => {
      const result = renderPlanScripts(mockData);
      assert.ok(result.includes('const { EventBus'), 'Should destructure EventBus from bundle');
      assert.ok(result.includes('SubscribableControl'), 'Should destructure SubscribableControl from bundle');
      assert.ok(result.includes('Topics'), 'Should destructure Topics from bundle');
    });

    test('should NOT contain inline EventBus implementation', () => {
      const result = renderPlanScripts(mockData);
      assert.ok(!result.includes('function EB()'), 'Should NOT contain inline EventBus constructor');
      assert.ok(!result.includes('EB.prototype.on'), 'Should NOT contain inline EventBus prototype methods');
    });

    test('should NOT contain inline SubscribableControl implementation', () => {
      const result = renderPlanScripts(mockData);
      assert.ok(!result.includes('function SC(bus, controlId)'), 'Should NOT contain inline SubscribableControl constructor');
      assert.ok(!result.includes('SC.prototype.subscribe'), 'Should NOT contain inline SubscribableControl prototype methods');
    });

    test('should create bus instance from bundled EventBus', () => {
      const result = renderPlanScripts(mockData);
      assert.ok(result.includes('var bus = new EventBus()'), 'Should instantiate bus from bundled EventBus class');
    });

    test('should include mermaidInit logic', () => {
      const result = renderPlanScripts(mockData);
      assert.ok(result.includes('mermaid.initialize'), 'Should include Mermaid initialization');
      assert.ok(result.includes('mermaid.render'), 'Should include Mermaid render call');
    });

    test('should include zoom/pan handlers', () => {
      const result = renderPlanScripts(mockData);
      assert.ok(result.includes('function zoomIn'), 'Should include zoom functions');
      assert.ok(result.includes('function zoomOut'), 'Should include zoom functions');
      assert.ok(result.includes('function zoomFit'), 'Should include zoom fit function');
    });

    test('should include control wiring', () => {
      const result = renderPlanScripts(mockData);
      assert.ok(result.includes('SubscribableControl(bus'), 'Should use SubscribableControl from bundle');
      assert.ok(result.includes('window.addEventListener'), 'Should wire postMessage handlers');
      assert.ok(result.includes('vscode.postMessage'), 'Should include VS Code message posting');
    });

    test('should handle null globalCapacityStats', () => {
      const dataWithoutCapacity = { ...mockData, globalCapacityStats: null };
      const result = renderPlanScripts(dataWithoutCapacity);
      assert.ok(result.includes('null'), 'Should serialize null capacity stats');
    });

    test('should handle globalCapacityStats when provided', () => {
      const dataWithCapacity = {
        ...mockData,
        globalCapacityStats: {
          thisInstanceJobs: 3,
          totalGlobalJobs: 10,
          globalMaxParallel: 5,
          activeInstances: 2,
        },
      };
      const result = renderPlanScripts(dataWithCapacity);
      assert.ok(result.includes('totalGlobalJobs'), 'Should include capacity stats fields');
      assert.ok(result.includes('globalMaxParallel'), 'Should include capacity stats fields');
    });
  });
});
