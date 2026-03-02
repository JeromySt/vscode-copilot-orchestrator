/**
 * @fileoverview Unit tests for node detail styles template.
 *
 * Verifies that the CSS generation function returns valid styles
 * with all required selectors present.
 *
 * @module test/unit/ui/templates/nodeDetailStyles
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import { renderNodeDetailStyles } from '../../../../ui/templates/nodeDetail/stylesTemplate';

suite('nodeDetail/stylesTemplate', () => {
  suite('renderNodeDetailStyles', () => {
    let styles: string;

    test('should return non-empty string', () => {
      styles = renderNodeDetailStyles();
      assert.ok(styles.length > 0, 'Styles should not be empty');
    });

    test('should contain status badge selectors', () => {
      styles = renderNodeDetailStyles();
      assert.ok(styles.includes('.status-badge'), 'Should contain .status-badge');
      assert.ok(styles.includes('.status-badge.running'), 'Should contain .status-badge.running');
      assert.ok(styles.includes('.status-badge.succeeded'), 'Should contain .status-badge.succeeded');
      assert.ok(styles.includes('.status-badge.failed'), 'Should contain .status-badge.failed');
    });

    test('should contain log viewer selectors', () => {
      styles = renderNodeDetailStyles();
      assert.ok(styles.includes('.log-viewer'), 'Should contain .log-viewer');
      assert.ok(styles.includes('.log-file-path'), 'Should contain .log-file-path');
    });

    test('should contain phase tabs selectors', () => {
      styles = renderNodeDetailStyles();
      assert.ok(styles.includes('.phase-tabs'), 'Should contain .phase-tabs');
      assert.ok(styles.includes('.phase-tab'), 'Should contain .phase-tab');
      assert.ok(styles.includes('.phase-tab.active'), 'Should contain .phase-tab.active');
    });

    test('should contain attempt card selectors', () => {
      styles = renderNodeDetailStyles();
      assert.ok(styles.includes('.attempt-card'), 'Should contain .attempt-card');
      assert.ok(styles.includes('.attempt-header'), 'Should contain .attempt-header');
      assert.ok(styles.includes('.attempt-badge'), 'Should contain .attempt-badge');
    });

    test('should contain process tree selectors', () => {
      styles = renderNodeDetailStyles();
      assert.ok(styles.includes('.process-tree'), 'Should contain .process-tree');
      assert.ok(styles.includes('.process-tree-node'), 'Should contain .process-tree-node');
    });

    test('should contain config section selectors', () => {
      styles = renderNodeDetailStyles();
      assert.ok(styles.includes('.config-phase-section'), 'Should contain .config-phase-section');
      assert.ok(styles.includes('.on-failure-config'), 'Should contain .on-failure-config');
    });

    test('should contain dependency selectors', () => {
      styles = renderNodeDetailStyles();
      assert.ok(styles.includes('.dependencies'), 'Should contain .dependencies');
      assert.ok(styles.includes('.dependency-item'), 'Should contain .dependency-item');
    });

    test('should contain AI metrics selectors', () => {
      styles = renderNodeDetailStyles();
      assert.ok(styles.includes('.ai-metrics'), 'Should contain .ai-metrics');
      assert.ok(styles.includes('.ai-metric-item'), 'Should contain .ai-metric-item');
    });

    test('should contain work summary selectors', () => {
      styles = renderNodeDetailStyles();
      assert.ok(styles.includes('.work-summary'), 'Should contain .work-summary');
      assert.ok(styles.includes('.work-stat'), 'Should contain .work-stat');
    });

    test('should contain action button selectors', () => {
      styles = renderNodeDetailStyles();
      assert.ok(styles.includes('.action-btn'), 'Should contain .action-btn');
      assert.ok(styles.includes('.action-btn.primary'), 'Should contain .action-btn.primary');
    });

    test('should contain markdown rendering selectors', () => {
      styles = renderNodeDetailStyles();
      assert.ok(styles.includes('.markdown-content'), 'Should contain .markdown-content');
    });

    test('should contain meta grid selectors', () => {
      styles = renderNodeDetailStyles();
      assert.ok(styles.includes('.meta-grid'), 'Should contain .meta-grid');
      assert.ok(styles.includes('.meta-item'), 'Should contain .meta-item');
    });

    test('should contain header selectors', () => {
      styles = renderNodeDetailStyles();
      assert.ok(styles.includes('.header'), 'Should contain .header');
      assert.ok(styles.includes('.header-phase'), 'Should contain .header-phase');
      assert.ok(styles.includes('.header-duration'), 'Should contain .header-duration');
    });

    test('should contain layout selectors', () => {
      styles = renderNodeDetailStyles();
      assert.ok(styles.includes('.sticky-header'), 'Should contain .sticky-header');
      assert.ok(styles.includes('.section'), 'Should contain .section');
      assert.ok(styles.includes('.breadcrumb'), 'Should contain .breadcrumb');
    });
  });
});
