/**
 * @fileoverview Unit tests for plansView scripts template.
 *
 * @module test/unit/ui/templates/plansView/scriptsTemplate
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import { renderPlansViewScripts } from '../../../../../ui/templates/plansView/scriptsTemplate';

suite('plansView scriptsTemplate', () => {
  suite('renderPlansViewScripts', () => {
    test('returns string wrapped in <script> tags', () => {
      const result = renderPlansViewScripts();
      assert.ok(result.startsWith('<script>'), 'Should start with <script>');
      assert.ok(result.endsWith('</script>'), 'Should end with </script>');
    });

    test('includes vscode API acquisition', () => {
      const result = renderPlansViewScripts();
      assert.ok(result.includes('acquireVsCodeApi()'), 'Should acquire VS Code API');
    });

    test('includes EventBus from window.Orca', () => {
      const result = renderPlansViewScripts();
      assert.ok(result.includes('EventBus'), 'Should reference EventBus');
      assert.ok(result.includes('window.Orca'), 'Should destructure from window.Orca');
      assert.ok(result.includes('var bus = new EventBus()'), 'Should create bus instance');
    });

    test('includes SubscribableControl as base class', () => {
      const result = renderPlansViewScripts();
      assert.ok(result.includes('extends SubscribableControl'), 'Should extend SubscribableControl');
    });

    test('includes Topics definition', () => {
      const result = renderPlansViewScripts();
      assert.ok(result.includes('PlansTopics'), 'Should define PlansTopics');
      assert.ok(result.includes('PLAN_STATE_CHANGE'), 'Should include PLAN_STATE_CHANGE topic');
      assert.ok(result.includes('PLANS_UPDATE'), 'Should include PLANS_UPDATE topic');
      assert.ok(result.includes('CAPACITY_UPDATE'), 'Should include CAPACITY_UPDATE topic');
      assert.ok(result.includes('PULSE'), 'Should include PULSE topic');
    });

    test('includes PlanListCardControl definition', () => {
      const result = renderPlansViewScripts();
      assert.ok(result.includes('class PlanListCardControl'), 'Should define PlanListCardControl as a class');
      assert.ok(result.includes('update(data)'), 'Should include update method');
    });

    test('includes PlanListContainerControl definition', () => {
      const result = renderPlansViewScripts();
      assert.ok(result.includes('class PlanListContainerControl'), 'Should define PlanListContainerControl as a class');
      assert.ok(result.includes('updatePlans('), 'Should include updatePlans method');
      assert.ok(result.includes('addPlan('), 'Should include addPlan method');
      assert.ok(result.includes('removePlan('), 'Should include removePlan method');
    });

    test('includes CapacityBarControl definition', () => {
      const result = renderPlansViewScripts();
      assert.ok(result.includes('class CapacityBarControl'), 'Should define CapacityBarControl as a class');
    });

    test('includes control instantiation', () => {
      const result = renderPlansViewScripts();
      assert.ok(result.includes('new PlanListContainerControl'), 'Should instantiate PlanListContainerControl');
      assert.ok(result.includes('new CapacityBarControl'), 'Should instantiate CapacityBarControl');
    });

    test('includes duration ticker', () => {
      const result = renderPlansViewScripts();
      assert.ok(result.includes('function tickAllDurations'), 'Should define tickAllDurations');
      assert.ok(result.includes('querySelectorAll(\'.plan-duration\')'), 'Should query duration elements');
    });

    test('includes message handler', () => {
      const result = renderPlansViewScripts();
      assert.ok(result.includes('window.addEventListener(\'message\''), 'Should add message listener');
      assert.ok(result.includes('case \'update\':'), 'Should handle update messages');
      assert.ok(result.includes('case \'planAdded\':'), 'Should handle planAdded messages');
      assert.ok(result.includes('case \'planStateChange\':'), 'Should handle planStateChange messages');
      assert.ok(result.includes('case \'planDeleted\':'), 'Should handle planDeleted messages');
      assert.ok(result.includes('case \'pulse\':'), 'Should handle pulse messages');
    });

    test('includes keyboard navigation', () => {
      const result = renderPlansViewScripts();
      assert.ok(result.includes('document.addEventListener(\'keydown\''), 'Should add keydown listener');
      assert.ok(result.includes('e.key === \'Enter\''), 'Should handle Enter key');
      assert.ok(result.includes('e.key === \'Delete\''), 'Should handle Delete key');
      assert.ok(result.includes('e.key === \'ArrowDown\''), 'Should handle ArrowDown key');
      assert.ok(result.includes('e.key === \'ArrowUp\''), 'Should handle ArrowUp key');
    });

    test('requests initial data', () => {
      const result = renderPlansViewScripts();
      assert.ok(result.includes('postMessage({ type: \'refresh\' })'), 'Should request initial refresh');
    });

    test('includes utility functions', () => {
      const result = renderPlansViewScripts();
      assert.ok(result.includes('function formatDuration'), 'Should define formatDuration');
      assert.ok(result.includes('escapeHtml'), 'Should reference escapeHtml (destructured from window.Orca)');
    });
  });
});
