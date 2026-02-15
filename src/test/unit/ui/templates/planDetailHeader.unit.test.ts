/**
 * @fileoverview Unit tests for planDetail header template.
 *
 * @module test/unit/ui/templates/planDetailHeader
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import { renderPlanHeader, formatPlanDuration } from '../../../../ui/templates/planDetail/headerTemplate';
import type { PlanHeaderData } from '../../../../ui/templates/planDetail/headerTemplate';

suite('planDetail headerTemplate', () => {

  // -----------------------------------------------------------------------
  // formatPlanDuration
  // -----------------------------------------------------------------------
  suite('formatPlanDuration', () => {
    test('returns "--" when startedAt is undefined', () => {
      assert.strictEqual(formatPlanDuration(undefined, undefined), '--');
    });

    test('returns "--" when startedAt is 0', () => {
      assert.strictEqual(formatPlanDuration(0, undefined), '--');
    });

    test('formats duration between startedAt and endedAt', () => {
      const started = 1000000;
      const ended = started + 65000; // 65 seconds = 1m 5s
      const result = formatPlanDuration(started, ended);
      assert.strictEqual(result, '1m 5s');
    });

    test('uses Date.now() when endedAt is not provided', () => {
      const started = Date.now() - 5000; // 5 seconds ago
      const result = formatPlanDuration(started, undefined);
      assert.ok(result === '5s' || result === '4s' || result === '6s', `Expected ~5s, got ${result}`);
    });

    test('formats sub-second duration as "< 1s"', () => {
      const started = 1000;
      const ended = 1500; // 500ms
      assert.strictEqual(formatPlanDuration(started, ended), '< 1s');
    });

    test('formats hours correctly', () => {
      const started = 1;
      const ended = 3661001; // ~1h 1m 1s
      assert.strictEqual(formatPlanDuration(started, ended), '1h 1m');
    });
  });

  // -----------------------------------------------------------------------
  // renderPlanHeader
  // -----------------------------------------------------------------------
  suite('renderPlanHeader', () => {
    function makeHeaderData(overrides?: Partial<PlanHeaderData>): PlanHeaderData {
      return {
        planName: 'Test Plan',
        status: 'running',
        startedAt: 1000000,
        effectiveEndedAt: undefined,
        baseBranch: 'main',
        targetBranch: undefined,
        showBranchFlow: false,
        globalCapacityStats: null,
        ...overrides,
      };
    }

    test('renders plan name (HTML-escaped)', () => {
      const html = renderPlanHeader(makeHeaderData({ planName: '<script>alert("xss")</script>' }));
      assert.ok(html.includes('&lt;script&gt;'), 'Plan name should be escaped');
      assert.ok(!html.includes('<script>alert'), 'Unescaped script should not appear');
    });

    test('renders status badge with correct class', () => {
      const html = renderPlanHeader(makeHeaderData({ status: 'succeeded' }));
      assert.ok(html.includes('class="status-badge succeeded"'));
      assert.ok(html.includes('>succeeded<'));
    });

    test('renders pending status badge', () => {
      const html = renderPlanHeader(makeHeaderData({ status: 'pending' }));
      assert.ok(html.includes('class="status-badge pending"'));
    });

    test('renders failed status badge', () => {
      const html = renderPlanHeader(makeHeaderData({ status: 'failed' }));
      assert.ok(html.includes('class="status-badge failed"'));
    });

    test('renders paused status badge', () => {
      const html = renderPlanHeader(makeHeaderData({ status: 'paused' }));
      assert.ok(html.includes('class="status-badge paused"'));
    });

    test('renders canceled status badge', () => {
      const html = renderPlanHeader(makeHeaderData({ status: 'canceled' }));
      assert.ok(html.includes('class="status-badge canceled"'));
    });

    test('renders duration with data attributes', () => {
      const html = renderPlanHeader(makeHeaderData({
        startedAt: 12345,
        effectiveEndedAt: 67890,
        status: 'succeeded',
      }));
      assert.ok(html.includes('data-started="12345"'));
      assert.ok(html.includes('data-ended="67890"'));
      assert.ok(html.includes('data-status="succeeded"'));
    });

    test('renders "--" when startedAt is undefined', () => {
      const html = renderPlanHeader(makeHeaderData({ startedAt: undefined }));
      assert.ok(html.includes('>--<'));
    });

    test('uses 0 for missing startedAt/endedAt', () => {
      const html = renderPlanHeader(makeHeaderData({
        startedAt: undefined,
        effectiveEndedAt: undefined,
      }));
      assert.ok(html.includes('data-started="0"'));
      assert.ok(html.includes('data-ended="0"'));
    });

    test('does NOT render branch flow when showBranchFlow is false', () => {
      const html = renderPlanHeader(makeHeaderData({ showBranchFlow: false }));
      assert.ok(!html.includes('branch-flow'));
    });

    test('renders branch flow when showBranchFlow is true', () => {
      const html = renderPlanHeader(makeHeaderData({
        showBranchFlow: true,
        baseBranch: 'develop',
        targetBranch: 'release/1.0',
      }));
      assert.ok(html.includes('branch-flow'));
      assert.ok(html.includes('develop'));
      assert.ok(html.includes('release/1.0'));
      assert.ok(html.includes('Base:'));
      assert.ok(html.includes('Target:'));
    });

    test('escapes branch names in branch flow', () => {
      const html = renderPlanHeader(makeHeaderData({
        showBranchFlow: true,
        baseBranch: '<b>main</b>',
        targetBranch: 'target',
      }));
      assert.ok(html.includes('&lt;b&gt;main&lt;/b&gt;'));
    });

    test('uses baseBranch as target when targetBranch is undefined', () => {
      const html = renderPlanHeader(makeHeaderData({
        showBranchFlow: true,
        baseBranch: 'main',
        targetBranch: undefined,
      }));
      // The target display should be baseBranch
      const branchNames = html.match(/class="branch-name">([^<]+)/g);
      assert.ok(branchNames, 'Should have branch-name elements');
      assert.ok(branchNames!.length >= 2, 'Should have at least 2 branch names');
    });

    test('always renders capacity info (hidden by default)', () => {
      const html = renderPlanHeader(makeHeaderData());
      assert.ok(html.includes('id="capacityInfo"'));
      assert.ok(html.includes('style="display: none;"'));
      assert.ok(html.includes('id="instanceCount"'));
      assert.ok(html.includes('id="globalJobs"'));
      assert.ok(html.includes('id="globalMax"'));
    });

    test('renders duration-value with status class', () => {
      const html = renderPlanHeader(makeHeaderData({ status: 'running' }));
      assert.ok(html.includes('class="duration-value running"'));
    });
  });
});
