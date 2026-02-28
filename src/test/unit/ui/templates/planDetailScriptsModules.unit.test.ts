/**
 * @fileoverview Unit tests for plan detail scripts sub-modules.
 *
 * @module test/unit/ui/templates/planDetailScriptsModules
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import { renderMermaidInit } from '../../../../ui/templates/planDetail/scripts/mermaidInit';
import { renderZoomPan } from '../../../../ui/templates/planDetail/scripts/zoomPan';
import { renderControlWiring } from '../../../../ui/templates/planDetail/scripts/controlWiring';
import type { PlanScriptsData } from '../../../../ui/templates/planDetail/scriptsTemplate';

suite('planDetailScripts sub-modules', () => {
  const mockData: PlanScriptsData = {
    nodeData: { 'node1': { nodeId: 'job-1', planId: 'plan-123', type: 'job', name: 'Test', startedAt: Date.now(), status: 'running', version: 1 } },
    nodeTooltips: { 'node1': 'Test Job' },
    mermaidDef: 'graph TD\n  node1[Test]',
    edgeData: [],
    globalCapacityStats: null,
    timelineData: { nodes: [] },
  };

  suite('renderMermaidInit', () => {
    test('should return JavaScript code string', () => {
      const result = renderMermaidInit(mockData);
      assert.strictEqual(typeof result, 'string', 'Should return a string');
      assert.ok(result.length > 100, 'Should return substantial code');
    });

    test('should include Mermaid initialization', () => {
      const result = renderMermaidInit(mockData);
      assert.ok(result.includes('mermaid.initialize'), 'Should initialize Mermaid');
      assert.ok(result.includes('startOnLoad: false'), 'Should configure Mermaid');
    });

    test('should include Mermaid rendering logic', () => {
      const result = renderMermaidInit(mockData);
      assert.ok(result.includes('mermaid.render'), 'Should call mermaid.render');
      assert.ok(result.includes('mermaid-graph'), 'Should use correct graph ID');
    });

    test('should include tooltip injection', () => {
      const result = renderMermaidInit(mockData);
      assert.ok(result.includes('nodeTooltips'), 'Should reference nodeTooltips');
      assert.ok(result.includes('setAttribute(\'title\''), 'Should set title attribute for tooltips');
    });

    test('should include click handlers', () => {
      const result = renderMermaidInit(mockData);
      assert.ok(result.includes('addEventListener(\'click\''), 'Should attach click handlers');
      assert.ok(result.includes('vscode.postMessage'), 'Should post message on click');
      assert.ok(result.includes('type: \'openNode\''), 'Should send openNode message');
    });

    test('should include error handling', () => {
      const result = renderMermaidInit(mockData);
      assert.ok(result.includes('catch'), 'Should have error handling');
      assert.ok(result.includes('Failed to render diagram'), 'Should show error message');
    });

    test('should call zoomFit after render', () => {
      const result = renderMermaidInit(mockData);
      assert.ok(result.includes('zoomFit'), 'Should call zoomFit function');
    });
  });

  suite('renderZoomPan', () => {
    test('should return JavaScript code string', () => {
      const result = renderZoomPan();
      assert.strictEqual(typeof result, 'string', 'Should return a string');
      assert.ok(result.length > 100, 'Should return substantial code');
    });

    test('should define zoom functions', () => {
      const result = renderZoomPan();
      assert.ok(result.includes('function zoomIn'), 'Should define zoomIn');
      assert.ok(result.includes('function zoomOut'), 'Should define zoomOut');
      assert.ok(result.includes('function zoomReset'), 'Should define zoomReset');
      assert.ok(result.includes('function zoomFit'), 'Should define zoomFit');
    });

    test('should define updateZoom function', () => {
      const result = renderZoomPan();
      assert.ok(result.includes('function updateZoom'), 'Should define updateZoom');
      assert.ok(result.includes('transform'), 'Should set CSS transform');
    });

    test('should attach wheel event handler', () => {
      const result = renderZoomPan();
      assert.ok(result.includes('addEventListener(\'wheel\''), 'Should attach wheel listener');
      assert.ok(result.includes('deltaY'), 'Should check deltaY for zoom direction');
    });

    test('should include pan logic', () => {
      const result = renderZoomPan();
      assert.ok(result.includes('mousedown'), 'Should handle mousedown for panning');
      assert.ok(result.includes('mousemove'), 'Should handle mousemove for panning');
      assert.ok(result.includes('mouseup'), 'Should handle mouseup to stop panning');
      assert.ok(result.includes('isPanning'), 'Should track panning state');
    });

    test('should prevent click after pan', () => {
      const result = renderZoomPan();
      assert.ok(result.includes('didPan'), 'Should track if user panned');
      assert.ok(result.includes('stopPropagation'), 'Should stop click propagation after pan');
    });
  });

  suite('renderControlWiring', () => {
    test('should return JavaScript code string', () => {
      const result = renderControlWiring(mockData);
      assert.strictEqual(typeof result, 'string', 'Should return a string');
      assert.ok(result.length > 500, 'Should return substantial code');
    });

    test('should create SubscribableControl instances', () => {
      const result = renderControlWiring(mockData);
      assert.ok(result.includes('new SubscribableControl(bus'), 'Should create controls');
      assert.ok(result.includes('capacityInfoCtrl'), 'Should define capacity control');
      assert.ok(result.includes('planStatusCtrl'), 'Should define plan status control');
      assert.ok(result.includes('progressCtrl'), 'Should define progress control');
    });

    test('should wire postMessage handler', () => {
      const result = renderControlWiring(mockData);
      assert.ok(result.includes('window.addEventListener(\'message\''), 'Should wire message handler');
      assert.ok(result.includes('event.data'), 'Should access message data');
    });

    test('should handle status updates', () => {
      const result = renderControlWiring(mockData);
      assert.ok(result.includes('handleStatusUpdate'), 'Should define handleStatusUpdate');
      assert.ok(result.includes('bus.emit'), 'Should emit to event bus');
    });

    test('should include duration counter logic', () => {
      const result = renderControlWiring(mockData);
      assert.ok(result.includes('updateDurationCounter'), 'Should define updateDurationCounter');
      assert.ok(result.includes('formatDurationLive'), 'Should define duration formatter');
    });

    test('should include process tree rendering', () => {
      const result = renderControlWiring(mockData);
      assert.ok(result.includes('renderAllProcesses'), 'Should define renderAllProcesses');
      assert.ok(result.includes('renderJobNode'), 'Should define renderJobNode');
      assert.ok(result.includes('renderProc'), 'Should define renderProc');
    });

    test('should subscribe to PULSE for updates', () => {
      const result = renderControlWiring(mockData);
      assert.ok(result.includes('Topics.PULSE'), 'Should reference PULSE topic');
      assert.ok(result.includes('bus.on(Topics.PULSE'), 'Should subscribe to pulse');
    });

    test('should define status colors', () => {
      const result = renderControlWiring(mockData);
      assert.ok(result.includes('statusColors'), 'Should define statusColors map');
      assert.ok(result.includes('groupColors'), 'Should define groupColors map');
      assert.ok(result.includes('nodeIcons'), 'Should define nodeIcons map');
    });

    test('should include control implementations', () => {
      const result = renderControlWiring(mockData);
      assert.ok(result.includes('mermaidNodeStyleCtrl'), 'Should define Mermaid node style control');
      assert.ok(result.includes('mermaidEdgeStyleCtrl'), 'Should define Mermaid edge style control');
      assert.ok(result.includes('metricsBarCtrl'), 'Should define metrics bar control');
    });
  });
});
