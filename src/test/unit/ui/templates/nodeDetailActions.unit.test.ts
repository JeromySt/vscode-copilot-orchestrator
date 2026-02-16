/**
 * @fileoverview Unit tests for node detail action button templates.
 *
 * Tests retryButtonsHtml, forceFailButtonHtml, and bottomActionsHtml
 * with various status conditions.
 *
 * @module test/unit/ui/templates/nodeDetailActions
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import {
  retryButtonsHtml,
  forceFailButtonHtml,
  bottomActionsHtml,
} from '../../../../ui/templates/nodeDetail/actionButtonsTemplate';
import type { ActionButtonsData } from '../../../../ui/templates/nodeDetail/actionButtonsTemplate';

suite('Node Detail Action Button Templates', () => {

  const baseData: ActionButtonsData = {
    status: 'pending',
    planId: 'plan-123',
    nodeId: 'node-456',
  };

  suite('retryButtonsHtml', () => {
    test('renders retry buttons for failed status', () => {
      const html = retryButtonsHtml({ ...baseData, status: 'failed' });
      assert.ok(html.includes('retry-section'));
      assert.ok(html.includes('🔄 Retry Node'));
      assert.ok(html.includes('🆕 Retry (Fresh Session)'));
    });

    test('includes plan and node IDs in data attributes', () => {
      const html = retryButtonsHtml({ ...baseData, status: 'failed' });
      assert.ok(html.includes('data-plan-id="plan-123"'));
      assert.ok(html.includes('data-node-id="node-456"'));
    });

    test('includes correct data-action attributes', () => {
      const html = retryButtonsHtml({ ...baseData, status: 'failed' });
      assert.ok(html.includes('data-action="retry-node"'));
      assert.ok(html.includes('data-action="retry-node-fresh"'));
    });

    test('returns empty string for running status', () => {
      const html = retryButtonsHtml({ ...baseData, status: 'running' });
      assert.strictEqual(html, '');
    });

    test('returns empty string for succeeded status', () => {
      const html = retryButtonsHtml({ ...baseData, status: 'succeeded' });
      assert.strictEqual(html, '');
    });

    test('returns empty string for pending status', () => {
      const html = retryButtonsHtml({ ...baseData, status: 'pending' });
      assert.strictEqual(html, '');
    });

    test('returns empty string for scheduled status', () => {
      const html = retryButtonsHtml({ ...baseData, status: 'scheduled' });
      assert.strictEqual(html, '');
    });

    test('secondary button has secondary class', () => {
      const html = retryButtonsHtml({ ...baseData, status: 'failed' });
      assert.ok(html.includes('retry-btn secondary'));
    });
  });

  suite('forceFailButtonHtml', () => {
    test('renders visible force-fail button for running status', () => {
      const html = forceFailButtonHtml({ ...baseData, status: 'running' });
      assert.ok(html.includes('force-fail-btn'));
      assert.ok(html.includes('Force Fail'));
      assert.ok(!html.includes('display:none'));
    });

    test('includes correct data-action attribute', () => {
      const html = forceFailButtonHtml({ ...baseData, status: 'running' });
      assert.ok(html.includes('data-action="force-fail-node"'));
    });

    test('includes plan and node IDs', () => {
      const html = forceFailButtonHtml({ ...baseData, status: 'running' });
      assert.ok(html.includes('data-plan-id="plan-123"'));
      assert.ok(html.includes('data-node-id="node-456"'));
    });

    test('has forceFailBtn id', () => {
      const html = forceFailButtonHtml({ ...baseData, status: 'running' });
      assert.ok(html.includes('id="forceFailBtn"'));
    });

    test('renders hidden button for failed status', () => {
      const html = forceFailButtonHtml({ ...baseData, status: 'failed' });
      assert.ok(html.includes('display:none'));
      assert.ok(html.includes('force-fail-btn'));
    });

    test('renders hidden button for succeeded status', () => {
      const html = forceFailButtonHtml({ ...baseData, status: 'succeeded' });
      assert.ok(html.includes('display:none'));
    });

    test('renders hidden button for pending status', () => {
      const html = forceFailButtonHtml({ ...baseData, status: 'pending' });
      assert.ok(html.includes('display:none'));
    });

    test('renders hidden button for scheduled status', () => {
      const html = forceFailButtonHtml({ ...baseData, status: 'scheduled' });
      assert.ok(html.includes('display:none'));
    });
  });

  suite('bottomActionsHtml', () => {
    test('renders refresh button always', () => {
      const html = bottomActionsHtml(baseData);
      assert.ok(html.includes('Refresh'));
      assert.ok(html.includes('refresh()'));
    });

    test('renders Open Worktree button when worktree exists and not cleaned up', () => {
      const html = bottomActionsHtml({
        ...baseData,
        worktreePath: '/path/to/worktree',
        worktreeCleanedUp: false,
      });
      assert.ok(html.includes('Open Worktree'));
      assert.ok(html.includes('openWorktree()'));
    });

    test('does not render Open Worktree when worktree is cleaned up', () => {
      const html = bottomActionsHtml({
        ...baseData,
        worktreePath: '/path/to/worktree',
        worktreeCleanedUp: true,
      });
      assert.ok(!html.includes('Open Worktree'));
    });

    test('does not render Open Worktree when no worktree path', () => {
      const html = bottomActionsHtml(baseData);
      assert.ok(!html.includes('Open Worktree'));
    });

    test('renders actions div container', () => {
      const html = bottomActionsHtml(baseData);
      assert.ok(html.includes('class="actions"'));
    });

    test('does not render Open Worktree when worktreePath is undefined', () => {
      const html = bottomActionsHtml({ ...baseData, worktreePath: undefined });
      assert.ok(!html.includes('Open Worktree'));
    });

    test('does not render Open Worktree when worktreePath is empty', () => {
      const html = bottomActionsHtml({ ...baseData, worktreePath: '' });
      assert.ok(!html.includes('Open Worktree'));
    });
  });
});
