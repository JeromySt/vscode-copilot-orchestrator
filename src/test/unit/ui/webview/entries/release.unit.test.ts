/**
 * @fileoverview Unit tests for release entry point
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';

suite('release entry', () => {
  test('should export API to globalThis.Orca', () => {
    // Import the entry point to trigger the globalThis assignment
    require('../../../../../ui/webview/entries/release');

    const Orca = (globalThis as any).Orca;

    assert.ok(Orca, 'Orca should be defined on globalThis');

    // Check for core infrastructure
    assert.ok(Orca.EventBus, 'should export EventBus');
    assert.ok(Orca.SubscribableControl, 'should export SubscribableControl');
    assert.ok(Orca.Topics, 'should export Topics');

    // Check for release-specific export
    assert.strictEqual(typeof Orca.initReleasePanel, 'function', 'should export initReleasePanel');

    // Check for helpers
    assert.strictEqual(typeof Orca.formatDurationMs, 'function', 'should export formatDurationMs');
    assert.strictEqual(typeof Orca.escapeHtml, 'function', 'should export escapeHtml');
  });
});
