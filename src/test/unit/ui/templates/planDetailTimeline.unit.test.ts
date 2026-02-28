/**
 * @fileoverview Unit tests for timeline templates
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import { renderPlanTimeline } from '../../../../ui/templates/planDetail/timelineTemplate';
import { renderViewTabBar } from '../../../../ui/templates/planDetail/tabBarTemplate';
import { renderTimelineStyles } from '../../../../ui/templates/planDetail/timelineStyles';
import { renderTabBarStyles } from '../../../../ui/templates/planDetail/tabBarStyles';

suite('Timeline Templates', () => {
  suite('renderPlanTimeline', () => {
    test('should return timeline-section div', () => {
      const html = renderPlanTimeline({ status: 'running' });
      assert.ok(html.includes('id="timeline-section"'), 'Should have timeline-section id');
      assert.ok(html.includes('class="section"'), 'Should have section class');
    });

    test('should include timeline-container', () => {
      const html = renderPlanTimeline({ status: 'running' });
      assert.ok(html.includes('id="timeline-container"'), 'Should have timeline-container id');
      assert.ok(html.includes('class="timeline-container"'), 'Should have timeline-container class');
    });

    test('should include zoom controls', () => {
      const html = renderPlanTimeline({ status: 'running' });
      assert.ok(html.includes('class="timeline-controls"'), 'Should have timeline-controls');
      assert.ok(html.includes('id="timelineZoomIn"'), 'Should have zoom in button');
      assert.ok(html.includes('id="timelineZoomOut"'), 'Should have zoom out button');
      assert.ok(html.includes('id="timelineResetZoom"'), 'Should have reset zoom button');
      assert.ok(html.includes('Zoom In'), 'Should have zoom in title');
      assert.ok(html.includes('Zoom Out'), 'Should have zoom out title');
      assert.ok(html.includes('Reset'), 'Should have reset title');
    });

    test('should start hidden (display: none)', () => {
      const html = renderPlanTimeline({ status: 'running' });
      assert.ok(html.includes('style="display: none;"') || html.includes('style="display:none;"'), 
        'Timeline section should start hidden');
    });

    test('should include timeline-chart div', () => {
      const html = renderPlanTimeline({ status: 'running' });
      assert.ok(html.includes('id="timeline-chart"'), 'Should have timeline-chart id');
      assert.ok(html.includes('class="timeline-chart"'), 'Should have timeline-chart class');
    });
  });

  suite('renderViewTabBar', () => {
    test('should render two tab buttons', () => {
      const html = renderViewTabBar({ activeTab: 'dag' });
      const dagMatches = html.match(/data-tab="dag"/g);
      const timelineMatches = html.match(/data-tab="timeline"/g);
      
      assert.ok(dagMatches && dagMatches.length === 1, 'Should have one dag tab');
      assert.ok(timelineMatches && timelineMatches.length === 1, 'Should have one timeline tab');
    });

    test('should mark dag as active by default', () => {
      const html = renderViewTabBar({ activeTab: 'dag' });
      
      // Check that dag has active class somewhere in its button
      assert.ok(html.includes('data-tab="dag"'), 'Should have dag button');
      assert.ok(html.match(/data-tab="dag"[^>]*class="[^"]*active/) || 
                html.match(/class="[^"]*active[^"]*"[^>]*data-tab="dag"/), 
        'DAG button should have active class');
    });

    test('should mark timeline as active when specified', () => {
      const html = renderViewTabBar({ activeTab: 'timeline' });
      
      // Timeline button should have active class
      assert.ok(html.includes('data-tab="timeline"'), 'Should have timeline button');
      assert.ok(html.match(/data-tab="timeline"[^>]*class="[^"]*active/) || 
                html.match(/class="[^"]*active[^"]*"[^>]*data-tab="timeline"/), 
        'Timeline button should have active class');
    });

    test('should include aria-selected attributes', () => {
      const htmlDag = renderViewTabBar({ activeTab: 'dag' });
      assert.ok(htmlDag.includes('aria-selected="true"'), 'Should have aria-selected true');
      assert.ok(htmlDag.includes('aria-selected="false"'), 'Should have aria-selected false');
      
      const htmlTimeline = renderViewTabBar({ activeTab: 'timeline' });
      assert.ok(htmlTimeline.includes('aria-selected="true"'), 'Should have aria-selected true');
      assert.ok(htmlTimeline.includes('aria-selected="false"'), 'Should have aria-selected false');
    });

    test('should have role="tablist" on container', () => {
      const html = renderViewTabBar({ activeTab: 'dag' });
      assert.ok(html.includes('role="tablist"'), 'Should have tablist role');
    });

    test('should have role="tab" on buttons', () => {
      const html = renderViewTabBar({ activeTab: 'dag' });
      const tabRoleMatches = html.match(/role="tab"/g);
      assert.ok(tabRoleMatches && tabRoleMatches.length === 2, 'Should have two tab roles');
    });

    test('should include tab icons', () => {
      const html = renderViewTabBar({ activeTab: 'dag' });
      assert.ok(html.includes('class="tab-icon"'), 'Should include tab icons');
    });

    test('should have view-tab-bar container', () => {
      const html = renderViewTabBar({ activeTab: 'dag' });
      assert.ok(html.includes('class="view-tab-bar"'), 'Should have view-tab-bar class');
    });
  });

  suite('renderTimelineStyles', () => {
    test('should include timeline-chart selector', () => {
      const css = renderTimelineStyles();
      assert.ok(css.includes('.timeline-chart'), 'Should have timeline-chart selector');
    });

    test('should include timeline-bar selectors', () => {
      const css = renderTimelineStyles();
      assert.ok(css.includes('.timeline-bar'), 'Should have timeline-bar selector');
      assert.ok(css.includes('.timeline-bar.succeeded'), 'Should have succeeded bar style');
      assert.ok(css.includes('.timeline-bar.failed'), 'Should have failed bar style');
      assert.ok(css.includes('.timeline-bar.running'), 'Should have running bar style');
    });

    test('should use VS Code theme variables', () => {
      const css = renderTimelineStyles();
      assert.ok(css.includes('var(--vscode-'), 'Should use VS Code CSS variables');
      assert.ok(css.includes('var(--vscode-testing-iconPassed'), 'Should use testing icon variables');
      assert.ok(css.includes('var(--vscode-testing-iconFailed'), 'Should use testing icon variables');
      assert.ok(css.includes('var(--vscode-progressBar-background'), 'Should use progress bar variable');
    });

    test('should include timeline-axis styles', () => {
      const css = renderTimelineStyles();
      assert.ok(css.includes('.timeline-axis'), 'Should have timeline-axis selector');
      assert.ok(css.includes('.timeline-tick'), 'Should have timeline-tick selector');
    });

    test('should include timeline-row styles', () => {
      const css = renderTimelineStyles();
      assert.ok(css.includes('.timeline-row'), 'Should have timeline-row selector');
      assert.ok(css.includes('.timeline-label'), 'Should have timeline-label selector');
    });

    test('should include now-marker styles', () => {
      const css = renderTimelineStyles();
      assert.ok(css.includes('.timeline-now-marker'), 'Should have now-marker selector');
    });

    test('should include zoom control styles', () => {
      const css = renderTimelineStyles();
      assert.ok(css.includes('.timeline-controls'), 'Should have timeline-controls selector');
      assert.ok(css.includes('.zoom-btn'), 'Should have zoom-btn selector');
    });

    test('should include animation keyframes', () => {
      const css = renderTimelineStyles();
      assert.ok(css.includes('@keyframes'), 'Should have keyframes');
      assert.ok(css.includes('pulse-bar') || css.includes('pulse-marker'), 'Should have pulse animations');
    });
  });

  suite('renderTabBarStyles', () => {
    test('should include view-tab-bar selector', () => {
      const css = renderTabBarStyles();
      assert.ok(css.includes('.view-tab-bar'), 'Should have view-tab-bar selector');
    });

    test('should include active tab styling', () => {
      const css = renderTabBarStyles();
      assert.ok(css.includes('.view-tab'), 'Should have view-tab selector');
      assert.ok(css.includes('.view-tab.active'), 'Should have active tab selector');
    });

    test('should use VS Code theme variables', () => {
      const css = renderTabBarStyles();
      assert.ok(css.includes('var(--vscode-'), 'Should use VS Code CSS variables');
      assert.ok(css.includes('var(--vscode-foreground') || 
                css.includes('var(--vscode-descriptionForeground'), 
        'Should use foreground variables');
    });

    test('should include hover styles', () => {
      const css = renderTabBarStyles();
      assert.ok(css.includes(':hover') || css.includes('.view-tab:hover'), 'Should have hover styles');
    });

    test('should include tab-icon styles', () => {
      const css = renderTabBarStyles();
      assert.ok(css.includes('.tab-icon'), 'Should have tab-icon selector');
    });

    test('should include border styles', () => {
      const css = renderTabBarStyles();
      assert.ok(css.includes('border'), 'Should have border styles');
    });
  });
});
