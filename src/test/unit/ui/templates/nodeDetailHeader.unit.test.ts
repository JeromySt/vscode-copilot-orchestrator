/**
 * @fileoverview Unit tests for node detail header templates.
 *
 * Tests the breadcrumbHtml, headerRowHtml, and executionStateHtml
 * template functions with various input states.
 *
 * @module test/unit/ui/templates/nodeDetailHeader
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import {
  breadcrumbHtml,
  headerRowHtml,
  executionStateHtml,
} from '../../../../ui/templates/nodeDetail/headerTemplate';
import type { HeaderData } from '../../../../ui/templates/nodeDetail/headerTemplate';

suite('Node Detail Header Templates', () => {

  suite('breadcrumbHtml', () => {
    test('renders plan name and node name', () => {
      const html = breadcrumbHtml('plan-123', 'My Plan', 'Build Step');
      assert.ok(html.includes('My Plan'));
      assert.ok(html.includes('Build Step'));
      assert.ok(html.includes('breadcrumb'));
    });

    test('passes plan ID to onclick handler', () => {
      const html = breadcrumbHtml('plan-abc', 'Test Plan', 'Node');
      assert.ok(html.includes("openPlan('plan-abc')"));
    });

    test('escapes HTML in plan name', () => {
      const html = breadcrumbHtml('p1', '<script>alert("xss")</script>', 'node');
      assert.ok(!html.includes('<script>'));
      assert.ok(html.includes('&lt;script&gt;'));
    });

    test('escapes HTML in node name', () => {
      const html = breadcrumbHtml('p1', 'plan', '<b>bold</b>');
      assert.ok(!html.includes('<b>bold</b>'));
      assert.ok(html.includes('&lt;b&gt;'));
    });
  });

  suite('headerRowHtml', () => {
    test('renders node name as h2', () => {
      const html = headerRowHtml('Test Node', 'running');
      assert.ok(html.includes('<h2>Test Node</h2>'));
    });

    test('renders status badge with correct class', () => {
      const html = headerRowHtml('Node', 'failed');
      assert.ok(html.includes('status-badge failed'));
      assert.ok(html.includes('FAILED'));
    });

    test('uppercases status text', () => {
      const html = headerRowHtml('Node', 'succeeded');
      assert.ok(html.includes('SUCCEEDED'));
    });

    test('renders running status', () => {
      const html = headerRowHtml('Node', 'running');
      assert.ok(html.includes('status-badge running'));
      assert.ok(html.includes('RUNNING'));
    });

    test('renders pending status', () => {
      const html = headerRowHtml('Node', 'pending');
      assert.ok(html.includes('status-badge pending'));
      assert.ok(html.includes('PENDING'));
    });

    test('escapes node name HTML', () => {
      const html = headerRowHtml('<img src=x>', 'running');
      assert.ok(!html.includes('<img'));
      assert.ok(html.includes('&lt;img'));
    });
  });

  suite('executionStateHtml', () => {
    const baseData: HeaderData = {
      planId: 'p1',
      planName: 'Plan',
      nodeName: 'Node',
      nodeType: 'job',
      status: 'pending',
      attempts: 1,
    };

    test('renders Job type for job nodes', () => {
      const html = executionStateHtml({ ...baseData, nodeType: 'job' });
      assert.ok(html.includes('Job'));
    });

    test('renders sub-plan type for sub-plan nodes', () => {
      const html = executionStateHtml({ ...baseData, nodeType: 'sub-plan' });
      assert.ok(html.includes('sub-plan'));
    });

    test('renders attempt count', () => {
      const html = executionStateHtml({ ...baseData, attempts: 3 });
      assert.ok(html.includes('3'));
      assert.ok(html.includes('⟳'));
    });

    test('does not show retry icon for single attempt', () => {
      const html = executionStateHtml({ ...baseData, attempts: 1 });
      assert.ok(!html.includes('⟳'));
    });

    test('renders started time when present', () => {
      const startedAt = new Date('2024-01-15T10:30:00Z').getTime();
      const html = executionStateHtml({ ...baseData, startedAt });
      assert.ok(html.includes('Started'));
    });

    test('does not render started time when absent', () => {
      const html = executionStateHtml({ ...baseData });
      assert.ok(!html.includes('Started'));
    });

    test('renders duration when started (via headerRowHtml)', () => {
      const startedAt = Date.now() - 65000; // 65 seconds ago
      const html = headerRowHtml('Node', 'running', startedAt);
      assert.ok(html.includes('duration-timer'));
      assert.ok(html.includes('duration-value'));
    });

    test('renders duration with data-started-at for running nodes (via headerRowHtml)', () => {
      const startedAt = Date.now() - 5000;
      const html = headerRowHtml('Node', 'running', startedAt);
      assert.ok(html.includes('data-started-at'));
    });

    test('does not render data-started-at for ended nodes', () => {
      const startedAt = Date.now() - 10000;
      const endedAt = Date.now();
      const html = executionStateHtml({ ...baseData, startedAt, endedAt });
      assert.ok(!html.includes('data-started-at'));
    });

    test('renders copilot session ID', () => {
      const html = executionStateHtml({
        ...baseData,
        copilotSessionId: 'abcdef123456789xyz',
      });
      assert.ok(html.includes('Copilot Session'));
      assert.ok(html.includes('abcdef123456'));
      assert.ok(html.includes('📋'));
    });

    test('does not render session when absent', () => {
      const html = executionStateHtml(baseData);
      assert.ok(!html.includes('Copilot Session'));
    });

    test('renders error box when error present', () => {
      const html = executionStateHtml({ ...baseData, error: 'Something went wrong' });
      assert.ok(html.includes('error-box'));
      assert.ok(html.includes('Something went wrong'));
    });

    test('renders crashed error with special styling', () => {
      const html = executionStateHtml({
        ...baseData,
        error: 'Process crashed',
        failureReason: 'crashed',
      });
      assert.ok(html.includes('Crashed:'));
      assert.ok(html.includes('error-message crashed'));
    });

    test('renders failed phase info', () => {
      const html = executionStateHtml({
        ...baseData,
        error: 'Work failed',
        lastAttemptPhase: 'work',
      });
      assert.ok(html.includes('Failed in phase'));
      assert.ok(html.includes('work'));
    });

    test('renders exit code info', () => {
      const html = executionStateHtml({
        ...baseData,
        error: 'Process exited',
        lastAttemptExitCode: 137,
      });
      assert.ok(html.includes('Exit code'));
      assert.ok(html.includes('137'));
    });

    test('does not render error box when no error', () => {
      const html = executionStateHtml(baseData);
      assert.ok(!html.includes('error-box'));
    });

    test('escapes error message HTML', () => {
      const html = executionStateHtml({
        ...baseData,
        error: '<script>alert("xss")</script>',
      });
      assert.ok(!html.includes('<script>alert'));
      assert.ok(html.includes('&lt;script&gt;'));
    });

    test('renders Execution State heading', () => {
      const html = executionStateHtml(baseData);
      assert.ok(html.includes('Execution State'));
    });
  });
});
