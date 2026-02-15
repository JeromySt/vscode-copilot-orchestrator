/**
 * @fileoverview Unit tests for planDetail nodeCard template.
 *
 * @module test/unit/ui/templates/planDetailNodeCard
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import { renderPlanNodeCard } from '../../../../ui/templates/planDetail/nodeCardTemplate';
import type { PlanNodeCardData } from '../../../../ui/templates/planDetail/nodeCardTemplate';
import type { NodeStatus } from '../../../../plan/types/nodes';

suite('planDetail nodeCardTemplate', () => {

  function emptyCounts(): Record<NodeStatus, number> {
    return {
      pending: 0,
      ready: 0,
      scheduled: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      blocked: 0,
      canceled: 0,
    };
  }

  function makeData(overrides?: Partial<PlanNodeCardData>): PlanNodeCardData {
    return {
      total: 10,
      counts: { ...emptyCounts(), succeeded: 5, failed: 1, running: 2, pending: 2 },
      progress: 60,
      status: 'running',
      ...overrides,
    };
  }

  // -----------------------------------------------------------------------
  // Stats section
  // -----------------------------------------------------------------------
  suite('Stats grid', () => {
    test('renders stats container', () => {
      const html = renderPlanNodeCard(makeData());
      assert.ok(html.includes('class="stats"'));
    });

    test('renders total nodes', () => {
      const html = renderPlanNodeCard(makeData({ total: 42 }));
      assert.ok(html.includes('>42<'));
      assert.ok(html.includes('Total Nodes'));
    });

    test('renders succeeded count', () => {
      const counts = { ...emptyCounts(), succeeded: 7 };
      const html = renderPlanNodeCard(makeData({ counts }));
      assert.ok(html.includes('class="stat-value succeeded">7<'));
      assert.ok(html.includes('Succeeded'));
    });

    test('renders failed count', () => {
      const counts = { ...emptyCounts(), failed: 3 };
      const html = renderPlanNodeCard(makeData({ counts }));
      assert.ok(html.includes('class="stat-value failed">3<'));
      assert.ok(html.includes('Failed'));
    });

    test('renders running count (running + scheduled)', () => {
      const counts = { ...emptyCounts(), running: 2, scheduled: 1 };
      const html = renderPlanNodeCard(makeData({ counts }));
      assert.ok(html.includes('class="stat-value running">3<'));
      assert.ok(html.includes('Running'));
    });

    test('renders pending count (pending + ready)', () => {
      const counts = { ...emptyCounts(), pending: 4, ready: 2 };
      const html = renderPlanNodeCard(makeData({ counts }));
      // Should show 6
      assert.ok(html.includes('>6<'));
      assert.ok(html.includes('Pending'));
    });

    test('defaults missing counts to 0', () => {
      const counts = emptyCounts();
      const html = renderPlanNodeCard(makeData({ counts, total: 0 }));
      assert.ok(html.includes('class="stat-value succeeded">0<'));
      assert.ok(html.includes('class="stat-value failed">0<'));
      assert.ok(html.includes('class="stat-value running">0<'));
    });
  });

  // -----------------------------------------------------------------------
  // Progress bar
  // -----------------------------------------------------------------------
  suite('Progress bar', () => {
    test('renders progress container', () => {
      const html = renderPlanNodeCard(makeData());
      assert.ok(html.includes('class="progress-container"'));
      assert.ok(html.includes('class="progress-bar"'));
    });

    test('renders progress fill with correct width', () => {
      const html = renderPlanNodeCard(makeData({ progress: 75 }));
      assert.ok(html.includes('style="width: 75%"'));
    });

    test('renders 0% progress', () => {
      const html = renderPlanNodeCard(makeData({ progress: 0 }));
      assert.ok(html.includes('style="width: 0%"'));
    });

    test('renders 100% progress', () => {
      const html = renderPlanNodeCard(makeData({ progress: 100 }));
      assert.ok(html.includes('style="width: 100%"'));
    });

    test('applies "failed" class when status is failed', () => {
      const html = renderPlanNodeCard(makeData({ status: 'failed' }));
      assert.ok(html.includes('class="progress-fill failed"'));
    });

    test('applies "succeeded" class when status is succeeded', () => {
      const html = renderPlanNodeCard(makeData({ status: 'succeeded' }));
      assert.ok(html.includes('class="progress-fill succeeded"'));
    });

    test('no extra class when status is running', () => {
      const html = renderPlanNodeCard(makeData({ status: 'running' }));
      assert.ok(html.includes('class="progress-fill "'));
    });

    test('no extra class when status is pending', () => {
      const html = renderPlanNodeCard(makeData({ status: 'pending' }));
      assert.ok(html.includes('class="progress-fill "'));
    });

    test('no extra class when status is paused', () => {
      const html = renderPlanNodeCard(makeData({ status: 'paused' }));
      assert.ok(html.includes('class="progress-fill "'));
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  suite('Edge cases', () => {
    test('all zeros', () => {
      const html = renderPlanNodeCard(makeData({
        total: 0,
        counts: emptyCounts(),
        progress: 0,
      }));
      assert.ok(html.includes('class="stats"'));
      assert.ok(html.includes('style="width: 0%"'));
    });

    test('large numbers', () => {
      const counts = { ...emptyCounts(), succeeded: 999, failed: 100, running: 50, scheduled: 10, pending: 500, ready: 341 };
      const html = renderPlanNodeCard(makeData({
        total: 2000,
        counts,
        progress: 55,
      }));
      assert.ok(html.includes('>2000<'));
      assert.ok(html.includes('>999<'));
      assert.ok(html.includes('>100<'));
      assert.ok(html.includes('>60<'));  // running(50) + scheduled(10)
      assert.ok(html.includes('>841<')); // pending(500) + ready(341)
    });
  });
});
