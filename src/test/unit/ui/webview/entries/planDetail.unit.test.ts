/**
 * @fileoverview Unit tests for planDetail entry point
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';

suite('planDetail entry', () => {
  test('should export API to globalThis.Orca', () => {
    // Import the entry point to trigger the globalThis assignment
    require('../../../../../ui/webview/entries/planDetail');

    const Orca = (globalThis as any).Orca;
    
    assert.ok(Orca, 'Orca should be defined on globalThis');
    
    // Check for core infrastructure
    assert.ok(Orca.EventBus, 'should export EventBus');
    assert.ok(Orca.SubscribableControl, 'should export SubscribableControl');
    assert.ok(Orca.Topics, 'should export Topics');
    
    // Check for controls
    assert.ok(Orca.DurationCounter, 'should export DurationCounter');
    assert.ok(Orca.MermaidNodeStyle, 'should export MermaidNodeStyle');
    assert.ok(Orca.LayoutManager, 'should export LayoutManager');
    assert.ok(Orca.ProcessTree, 'should export ProcessTree');
    assert.ok(Orca.StatusBadge, 'should export StatusBadge');
    assert.ok(Orca.ProgressBar, 'should export ProgressBar');
    assert.ok(Orca.NodeCard, 'should export NodeCard');
    assert.ok(Orca.GroupContainer, 'should export GroupContainer');
    assert.ok(Orca.AiUsageStats, 'should export AiUsageStats');
    assert.ok(Orca.WorkSummary, 'should export WorkSummary');
    assert.ok(Orca.TimelineChart, 'should export TimelineChart');
    assert.ok(Orca.ViewTabBar, 'should export ViewTabBar');
    
    // Check for helpers
    assert.strictEqual(typeof Orca.formatDurationMs, 'function', 'should export formatDurationMs');
    assert.strictEqual(typeof Orca.escapeHtml, 'function', 'should export escapeHtml');
  });
});
