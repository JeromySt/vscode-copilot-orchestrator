/**
 * @fileoverview Unit tests for nodeDetail entry point
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';

suite('nodeDetail entry', () => {
  test('should export API to globalThis.Orca', () => {
    // Import the entry point to trigger the globalThis assignment
    require('../../../../../ui/webview/entries/nodeDetail');

    const Orca = (globalThis as any).Orca;
    
    assert.ok(Orca, 'Orca should be defined on globalThis');
    
    // Check for core infrastructure
    assert.ok(Orca.EventBus, 'should export EventBus');
    assert.ok(Orca.SubscribableControl, 'should export SubscribableControl');
    assert.ok(Orca.Topics, 'should export Topics');
    
    // Check for controls
    assert.ok(Orca.DurationCounter, 'should export DurationCounter');
    assert.ok(Orca.StatusBadge, 'should export StatusBadge');
    assert.ok(Orca.LogViewer, 'should export LogViewer');
    assert.ok(Orca.ProcessTree, 'should export ProcessTree');
    assert.ok(Orca.PhaseTabBar, 'should export PhaseTabBar');
    assert.ok(Orca.AttemptCard, 'should export AttemptCard');
    assert.ok(Orca.AiUsageStats, 'should export AiUsageStats');
    assert.ok(Orca.WorkSummary, 'should export WorkSummary');
    assert.ok(Orca.ConfigDisplay, 'should export ConfigDisplay');
    
    // Check for helpers
    assert.strictEqual(typeof Orca.formatDurationMs, 'function', 'should export formatDurationMs');
    assert.strictEqual(typeof Orca.escapeHtml, 'function', 'should export escapeHtml');
  });
});
