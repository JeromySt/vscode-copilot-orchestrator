/**
 * @fileoverview Tests that template outputs don't contain inline duplicates.
 * 
 * Verifies that migrated templates reference window.Orca instead of defining
 * inline EventBus/SubscribableControl duplicates.
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import { renderPlanScripts } from '../../../../ui/templates/planDetail/scriptsTemplate';
import { webviewScripts } from '../../../../ui/templates/nodeDetail/scriptsTemplate';
import { renderPlansViewScripts } from '../../../../ui/templates/plansView/scriptsTemplate';

suite('Template No Inline Duplicates', () => {
  suite('planDetail scripts', () => {
    test('should not contain inline EventBus', () => {
      const output = renderPlanScripts({
        nodeData: {},
        nodeTooltips: {},
        mermaidDef: '',
        edgeData: [],
        globalCapacityStats: null,
        timelineData: { nodes: [] },
      });

      // Should NOT have inline EventBus definition
      assert.ok(!output.includes('function EB()'), 'Should not define inline EventBus');
      assert.ok(!output.includes('function EventBus()'), 'Should not define inline EventBus');
    });

    test('should reference window.Orca', () => {
      const output = renderPlanScripts({
        nodeData: {},
        nodeTooltips: {},
        mermaidDef: '',
        edgeData: [],
        globalCapacityStats: null,
        timelineData: { nodes: [] },
      });

      // Should reference window.Orca
      assert.ok(output.includes('window.Orca'), 'Should reference window.Orca');
    });

    test('should destructure from window.Orca', () => {
      const output = renderPlanScripts({
        nodeData: {},
        nodeTooltips: {},
        mermaidDef: '',
        edgeData: [],
        globalCapacityStats: null,
        timelineData: { nodes: [] },
      });

      // Should destructure base classes
      assert.ok(
        output.includes('EventBus, SubscribableControl, Topics') || 
        output.includes('EventBus') && output.includes('SubscribableControl'),
        'Should destructure EventBus and SubscribableControl from window.Orca'
      );
    });

    test('should reference TimelineChart and ViewTabBar from window.Orca', () => {
      const output = renderPlanScripts({
        nodeData: {},
        nodeTooltips: {},
        mermaidDef: '',
        edgeData: [],
        globalCapacityStats: null,
        timelineData: { nodes: [] },
      });

      // Should destructure timeline controls from window.Orca
      assert.ok(
        output.includes('TimelineChart') && output.includes('ViewTabBar'),
        'Should reference TimelineChart and ViewTabBar from window.Orca'
      );
      assert.ok(
        !output.includes('function TimelineChart') && !output.includes('function ViewTabBar'),
        'Should not define TimelineChart or ViewTabBar inline'
      );
    });
  });

  suite('nodeDetail scripts', () => {
    test('should not contain inline EventBus', () => {
      const output = webviewScripts({
        planId: 'plan1',
        nodeId: 'node1',
        currentPhase: null,
        initialPhase: null,
        nodeStatus: 'pending',
      });

      // Should NOT have inline EventBus definition
      assert.ok(!output.includes('function EB()'), 'Should not define inline EventBus');
      assert.ok(!output.includes('function EventBus()'), 'Should not define inline EventBus');
    });

    test('should reference window.Orca', () => {
      const output = webviewScripts({
        planId: 'plan1',
        nodeId: 'node1',
        currentPhase: null,
        initialPhase: null,
        nodeStatus: 'pending',
      });

      // Should reference window.Orca
      assert.ok(output.includes('window.Orca'), 'Should reference window.Orca');
    });

    test('should destructure from window.Orca', () => {
      const output = webviewScripts({
        planId: 'plan1',
        nodeId: 'node1',
        currentPhase: null,
        initialPhase: null,
        nodeStatus: 'pending',
      });

      // Should destructure controls
      assert.ok(
        output.includes('EventBus, Topics') || output.includes('EventBus'),
        'Should destructure EventBus from window.Orca'
      );
    });
  });

  suite('plansView scripts', () => {
    test('should not contain inline EventBus', () => {
      const output = renderPlansViewScripts();

      // Should NOT have inline EventBus definition (migrated to bundle)
      assert.ok(!output.includes('function EB()'), 'Should not define inline EventBus');
      assert.ok(!output.includes('EB.prototype.on'), 'Should not have EB.prototype methods');
    });

    test('should reference window.Orca', () => {
      const output = renderPlansViewScripts();

      // Should reference window.Orca
      assert.ok(output.includes('window.Orca'), 'plansView should reference window.Orca');
    });

    test('should destructure from window.Orca', () => {
      const output = renderPlansViewScripts();

      assert.ok(
        output.includes('EventBus') && output.includes('SubscribableControl'),
        'Should destructure EventBus and SubscribableControl from window.Orca'
      );
    });
  });

  suite('all views migrated to bundle', () => {
    test('planDetail is migrated to bundle', () => {
      const pd = renderPlanScripts({
        nodeData: {},
        nodeTooltips: {},
        mermaidDef: '',
        edgeData: [],
        globalCapacityStats: null,
        timelineData: { nodes: [] },
      });

      assert.ok(pd.includes('window.Orca'), 'planDetail uses window.Orca');
      assert.ok(!pd.includes('function EB()'), 'planDetail does not define inline EventBus');
    });

    test('nodeDetail is migrated to bundle', () => {
      const nd = webviewScripts({
        planId: 'p',
        nodeId: 'n',
        currentPhase: null,
        initialPhase: null,
        nodeStatus: 'pending',
      });

      assert.ok(nd.includes('window.Orca'), 'nodeDetail uses window.Orca');
      assert.ok(!nd.includes('function EB()'), 'nodeDetail does not define inline EventBus');
    });

    test('plansView is migrated to bundle', () => {
      const pl = renderPlansViewScripts();

      assert.ok(pl.includes('window.Orca'), 'plansView uses window.Orca');
      assert.ok(!pl.includes('function EB()'), 'plansView does not define inline EventBus');
    });
  });
});
