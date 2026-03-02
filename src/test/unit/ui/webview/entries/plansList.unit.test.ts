/**
 * @fileoverview Unit tests for plansList entry point
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';

suite('plansList entry', () => {
  test('should export API to globalThis.Orca', () => {
    // Import the entry point to trigger the globalThis assignment
    require('../../../../../ui/webview/entries/plansList');

    const Orca = (globalThis as any).Orca;
    
    assert.ok(Orca, 'Orca should be defined on globalThis');
    
    // Check for core infrastructure
    assert.ok(Orca.EventBus, 'should export EventBus');
    assert.ok(Orca.SubscribableControl, 'should export SubscribableControl');
    assert.ok(Orca.Topics, 'should export Topics');
    
    // Check for controls
    assert.ok(Orca.PlanListCard, 'should export PlanListCard');
    assert.ok(Orca.ProgressBar, 'should export ProgressBar');
    assert.ok(Orca.DurationCounter, 'should export DurationCounter');
    
    // Check for helpers
    assert.strictEqual(typeof Orca.formatDurationMs, 'function', 'should export formatDurationMs');
    assert.strictEqual(typeof Orca.escapeHtml, 'function', 'should export escapeHtml');
  });
});
