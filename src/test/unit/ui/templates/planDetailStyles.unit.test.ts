/**
 * @fileoverview Unit tests for plan detail styles template.
 *
 * Tests the style generation functions to ensure they produce valid CSS
 * and contain expected class definitions.
 *
 * @module test/unit/ui/templates/planDetailStyles
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import { renderPlanDetailStyles } from '../../../../ui/templates/planDetail/stylesTemplate';

suite('planDetailStyles', () => {
  suite('renderPlanDetailStyles', () => {
    test('should return non-empty CSS string', () => {
      const css = renderPlanDetailStyles();
      assert.ok(css.length > 0, 'CSS should not be empty');
      assert.ok(css.includes('{'), 'CSS should contain style blocks');
    });

    test('should include layout styles', () => {
      const css = renderPlanDetailStyles();
      assert.ok(css.includes('body'), 'Should include body styles');
      assert.ok(css.includes('.plan-content-wrapper'), 'Should include plan-content-wrapper');
      assert.ok(css.includes('.sticky-header'), 'Should include sticky-header');
    });

    test('should include header styles', () => {
      const css = renderPlanDetailStyles();
      assert.ok(css.includes('.header'), 'Should include header class');
      assert.ok(css.includes('.header-duration'), 'Should include header-duration class');
      assert.ok(css.includes('.duration-icon'), 'Should include duration-icon class');
      assert.ok(css.includes('.duration-value'), 'Should include duration-value class');
    });

    test('should include status badge styles', () => {
      const css = renderPlanDetailStyles();
      assert.ok(css.includes('.status-badge'), 'Should include status-badge class');
      assert.ok(css.includes('.status-badge.running'), 'Should include running status');
      assert.ok(css.includes('.status-badge.succeeded'), 'Should include succeeded status');
      assert.ok(css.includes('.status-badge.failed'), 'Should include failed status');
      assert.ok(css.includes('.status-badge.scaffolding'), 'Should include scaffolding status');
      assert.ok(css.includes('.phase-indicator'), 'Should include phase-indicator');
    });

    test('should include branch flow styles', () => {
      const css = renderPlanDetailStyles();
      assert.ok(css.includes('.branch-flow'), 'Should include branch-flow class');
      assert.ok(css.includes('.branch-name'), 'Should include branch-name class');
      assert.ok(css.includes('.branch-arrow'), 'Should include branch-arrow class');
    });

    test('should include capacity styles', () => {
      const css = renderPlanDetailStyles();
      assert.ok(css.includes('.capacity-info'), 'Should include capacity-info class');
      assert.ok(css.includes('.capacity-badge'), 'Should include capacity-badge class');
    });

    test('should include stats grid styles', () => {
      const css = renderPlanDetailStyles();
      assert.ok(css.includes('.stats'), 'Should include stats class');
      assert.ok(css.includes('.stat'), 'Should include stat class');
      assert.ok(css.includes('.stat-value'), 'Should include stat-value class');
      assert.ok(css.includes('.stat-label'), 'Should include stat-label class');
    });

    test('should include progress bar styles', () => {
      const css = renderPlanDetailStyles();
      assert.ok(css.includes('.progress-container'), 'Should include progress-container');
      assert.ok(css.includes('.progress-bar'), 'Should include progress-bar');
      assert.ok(css.includes('.progress-fill'), 'Should include progress-fill');
    });

    test('should include mermaid diagram styles', () => {
      const css = renderPlanDetailStyles();
      assert.ok(css.includes('#mermaid-diagram'), 'Should include mermaid-diagram id');
      assert.ok(css.includes('.mermaid .node'), 'Should include mermaid node styles');
      assert.ok(css.includes('.mermaid-container'), 'Should include mermaid-container');
      assert.ok(css.includes('.mermaid .cluster'), 'Should include cluster styles');
    });

    test('should include zoom control styles', () => {
      const css = renderPlanDetailStyles();
      assert.ok(css.includes('.zoom-controls'), 'Should include zoom-controls class');
      assert.ok(css.includes('.zoom-btn'), 'Should include zoom-btn class');
      assert.ok(css.includes('.zoom-level'), 'Should include zoom-level class');
    });

    test('should include legend styles', () => {
      const css = renderPlanDetailStyles();
      assert.ok(css.includes('.legend'), 'Should include legend class');
      assert.ok(css.includes('.legend-toggle'), 'Should include legend-toggle class');
      assert.ok(css.includes('.legend-item'), 'Should include legend-item class');
      assert.ok(css.includes('.legend-icon'), 'Should include legend-icon class');
    });

    test('should include processes styles', () => {
      const css = renderPlanDetailStyles();
      assert.ok(css.includes('.processes-section'), 'Should include processes-section');
      assert.ok(css.includes('.node-processes'), 'Should include node-processes');
      assert.ok(css.includes('.process-item'), 'Should include process-item');
      assert.ok(css.includes('.processes-summary'), 'Should include processes-summary');
    });

    test('should include work summary styles', () => {
      const css = renderPlanDetailStyles();
      assert.ok(css.includes('.work-summary'), 'Should include work-summary class');
      assert.ok(css.includes('.work-summary-grid'), 'Should include work-summary-grid');
      assert.ok(css.includes('.work-stat'), 'Should include work-stat class');
      assert.ok(css.includes('.job-summaries'), 'Should include job-summaries class');
      assert.ok(css.includes('.work-summary-clickable'), 'Should include clickable work summary');
    });

    test('should include metrics bar styles', () => {
      const css = renderPlanDetailStyles();
      assert.ok(css.includes('.plan-metrics-bar'), 'Should include plan-metrics-bar');
      assert.ok(css.includes('.metrics-label'), 'Should include metrics-label');
      assert.ok(css.includes('.metric-item'), 'Should include metric-item');
      assert.ok(css.includes('.model-breakdown'), 'Should include model-breakdown');
    });

    test('should include toolbar styles', () => {
      const css = renderPlanDetailStyles();
      assert.ok(css.includes('.plan-toolbar'), 'Should include plan-toolbar class');
      assert.ok(css.includes('.actions'), 'Should include actions class');
    });

    test('should include action button styles', () => {
      const css = renderPlanDetailStyles();
      assert.ok(css.includes('.action-btn'), 'Should include action-btn class');
      assert.ok(css.includes('.action-btn.primary'), 'Should include primary button');
      assert.ok(css.includes('.action-btn.secondary'), 'Should include secondary button');
      assert.ok(css.includes('.action-btn.danger'), 'Should include danger button');
    });

    test('should include scaffolding styles', () => {
      const css = renderPlanDetailStyles();
      assert.ok(css.includes('.scaffolding-message'), 'Should include scaffolding-message');
    });

    test('should use VS Code CSS variables', () => {
      const css = renderPlanDetailStyles();
      assert.ok(css.includes('var(--vscode-'), 'Should use VS Code CSS custom properties');
      assert.ok(css.includes('var(--vscode-foreground)'), 'Should use foreground color');
      assert.ok(css.includes('var(--vscode-editor-background)'), 'Should use editor background');
    });

    test('should contain all expected sub-style sections', () => {
      const css = renderPlanDetailStyles();
      // Verify that all sections are concatenated
      const sections = [
        '.plan-content-wrapper',      // layout
        '.header',                     // header
        '.status-badge',               // status badge
        '.branch-flow',                // branch flow
        '.capacity-info',              // capacity
        '.stats',                      // stats grid
        '.progress-bar',               // progress bar
        '#mermaid-diagram',            // mermaid
        '.zoom-controls',              // zoom
        '.legend',                     // legend
        '.processes-section',          // processes
        '.work-summary',               // work summary
        '.plan-metrics-bar',           // metrics
        '.plan-toolbar',               // toolbar
        '.action-btn',                 // actions
        '.scaffolding-message',        // scaffolding
      ];

      for (const selector of sections) {
        assert.ok(
          css.includes(selector),
          `CSS should include ${selector} from corresponding section`,
        );
      }
    });
  });
});
