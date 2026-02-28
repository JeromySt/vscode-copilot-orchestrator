/**
 * @fileoverview Unit tests for plansView body template.
 *
 * @module test/unit/ui/templates/plansView/bodyTemplate
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import { renderPlansViewBody } from '../../../../../ui/templates/plansView/bodyTemplate';

suite('plansView bodyTemplate', () => {
  suite('renderPlansViewBody', () => {
    test('returns HTML string', () => {
      const result = renderPlansViewBody();
      assert.strictEqual(typeof result, 'string');
      assert.ok(result.length > 0, 'Should return non-empty string');
    });

    test('includes header section', () => {
      const result = renderPlansViewBody();
      assert.ok(result.includes('<div class="header">'), 'Should include header div');
      assert.ok(result.includes('<h3>Plans</h3>'), 'Should include Plans heading');
      assert.ok(result.includes('id="badge"'), 'Should include badge element');
    });

    test('includes global capacity bar', () => {
      const result = renderPlansViewBody();
      assert.ok(result.includes('id="globalCapacityBar"'), 'Should include capacity bar');
      assert.ok(result.includes('id="globalRunningJobs"'), 'Should include running jobs span');
      assert.ok(result.includes('id="globalMaxParallel"'), 'Should include max parallel span');
      assert.ok(result.includes('id="activeInstances"'), 'Should include active instances span');
    });

    test('includes global stats section', () => {
      const result = renderPlansViewBody();
      assert.ok(result.includes('id="globalStats"'), 'Should include global stats');
      assert.ok(result.includes('id="runningJobs"'), 'Should include running jobs');
      assert.ok(result.includes('id="maxParallel"'), 'Should include max parallel');
      assert.ok(result.includes('id="queuedJobs"'), 'Should include queued jobs');
    });

    test('includes plans container with empty state', () => {
      const result = renderPlansViewBody();
      assert.ok(result.includes('id="plans"'), 'Should include plans container');
      assert.ok(result.includes('class="empty"'), 'Should include empty state');
      assert.ok(result.includes('create_copilot_plan'), 'Should mention MCP tool');
    });

    test('capacity bar is hidden by default', () => {
      const result = renderPlansViewBody();
      assert.ok(result.includes('style="display: none;"'), 'Should hide capacity elements by default');
    });
  });
});
