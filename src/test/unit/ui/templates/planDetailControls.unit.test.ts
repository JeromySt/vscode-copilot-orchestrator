/**
 * @fileoverview Unit tests for planDetail controls template.
 *
 * @module test/unit/ui/templates/planDetailControls
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import { renderPlanControls } from '../../../../ui/templates/planDetail/controlsTemplate';
import type { PlanControlsData } from '../../../../ui/templates/planDetail/controlsTemplate';

suite('planDetail controlsTemplate', () => {

  function makeData(status: string): PlanControlsData {
    return { status };
  }

  // -----------------------------------------------------------------------
  // Always-visible buttons
  // -----------------------------------------------------------------------
  test('always renders Refresh button', () => {
    for (const s of ['running', 'pending', 'paused', 'succeeded', 'failed', 'canceled']) {
      const html = renderPlanControls(makeData(s));
      assert.ok(html.includes('onclick="refresh()"'), `Refresh button missing for status=${s}`);
      // Refresh never has display:none
      assert.ok(!html.includes('refresh()" style="display:none"'), `Refresh should be visible for status=${s}`);
    }
  });

  test('always renders Delete button', () => {
    for (const s of ['running', 'pending', 'paused', 'succeeded', 'failed', 'canceled']) {
      const html = renderPlanControls(makeData(s));
      assert.ok(html.includes('onclick="deletePlan()"'), `Delete button missing for status=${s}`);
    }
  });

  // -----------------------------------------------------------------------
  // Pause button
  // -----------------------------------------------------------------------
  suite('Pause button visibility', () => {
    test('visible when running', () => {
      const html = renderPlanControls(makeData('running'));
      assert.ok(html.includes('id="pauseBtn"'));
      assert.ok(!html.includes('pauseBtn" class="action-btn secondary" onclick="pausePlan()" style="display:none"'));
    });

    test('visible when pending', () => {
      const html = renderPlanControls(makeData('pending'));
      assert.ok(html.includes('id="pauseBtn"'));
      const btnMatch = html.match(/id="pauseBtn"[^>]*/);
      assert.ok(btnMatch && !btnMatch[0].includes('display:none'), 'Pause should be visible for pending');
    });

    test('hidden when succeeded', () => {
      const html = renderPlanControls(makeData('succeeded'));
      assert.ok(html.includes('pausePlan()" style="display:none"'));
    });

    test('hidden when failed', () => {
      const html = renderPlanControls(makeData('failed'));
      assert.ok(html.includes('pausePlan()" style="display:none"'));
    });

    test('hidden when paused', () => {
      const html = renderPlanControls(makeData('paused'));
      assert.ok(html.includes('pausePlan()" style="display:none"'));
    });

    test('hidden when canceled', () => {
      const html = renderPlanControls(makeData('canceled'));
      assert.ok(html.includes('pausePlan()" style="display:none"'));
    });
  });

  // -----------------------------------------------------------------------
  // Resume button
  // -----------------------------------------------------------------------
  suite('Resume button visibility', () => {
    test('visible when paused', () => {
      const html = renderPlanControls(makeData('paused'));
      assert.ok(html.includes('id="resumeBtn"'));
      const btnSection = html.substring(html.indexOf('id="resumeBtn"'));
      assert.ok(!btnSection.startsWith('id="resumeBtn" class="action-btn primary" onclick="resumePlan()" style="display:none"'));
    });

    test('hidden when running', () => {
      const html = renderPlanControls(makeData('running'));
      assert.ok(html.includes('resumePlan()" style="display:none"'));
    });

    test('hidden when succeeded', () => {
      const html = renderPlanControls(makeData('succeeded'));
      assert.ok(html.includes('resumePlan()" style="display:none"'));
    });

    test('hidden when failed', () => {
      const html = renderPlanControls(makeData('failed'));
      assert.ok(html.includes('resumePlan()" style="display:none"'));
    });

    test('hidden when pending', () => {
      const html = renderPlanControls(makeData('pending'));
      assert.ok(html.includes('resumePlan()" style="display:none"'));
    });
  });

  // -----------------------------------------------------------------------
  // Cancel button
  // -----------------------------------------------------------------------
  suite('Cancel button visibility', () => {
    test('visible when running', () => {
      const html = renderPlanControls(makeData('running'));
      // Cancel should not have display:none
      const cancelMatch = html.match(/id="cancelBtn"[^>]*/);
      assert.ok(cancelMatch && !cancelMatch[0].includes('display:none'), 'Cancel should be visible for running');
    });

    test('visible when pending', () => {
      const html = renderPlanControls(makeData('pending'));
      const cancelMatch = html.match(/id="cancelBtn"[^>]*/);
      assert.ok(cancelMatch && !cancelMatch[0].includes('display:none'), 'Cancel should be visible for pending');
    });

    test('visible when paused', () => {
      const html = renderPlanControls(makeData('paused'));
      const cancelMatch = html.match(/id="cancelBtn"[^>]*/);
      assert.ok(cancelMatch && !cancelMatch[0].includes('display:none'), 'Cancel should be visible for paused');
    });

    test('hidden when succeeded', () => {
      const html = renderPlanControls(makeData('succeeded'));
      assert.ok(html.includes('cancelPlan()" style="display:none"'));
    });

    test('hidden when failed', () => {
      const html = renderPlanControls(makeData('failed'));
      assert.ok(html.includes('cancelPlan()" style="display:none"'));
    });

    test('hidden when canceled', () => {
      const html = renderPlanControls(makeData('canceled'));
      assert.ok(html.includes('cancelPlan()" style="display:none"'));
    });
  });

  // -----------------------------------------------------------------------
  // Work Summary button
  // -----------------------------------------------------------------------
  suite('Work Summary button visibility', () => {
    test('visible when succeeded', () => {
      const html = renderPlanControls(makeData('succeeded'));
      const wsMatch = html.match(/id="workSummaryBtn"[^>]*/);
      assert.ok(wsMatch && !wsMatch[0].includes('display:none'), 'Work Summary should be visible for succeeded');
    });

    test('hidden when running', () => {
      const html = renderPlanControls(makeData('running'));
      assert.ok(html.includes('showWorkSummary()" style="display:none"'));
    });

    test('hidden when failed', () => {
      const html = renderPlanControls(makeData('failed'));
      assert.ok(html.includes('showWorkSummary()" style="display:none"'));
    });

    test('hidden when pending', () => {
      const html = renderPlanControls(makeData('pending'));
      assert.ok(html.includes('showWorkSummary()" style="display:none"'));
    });

    test('hidden when paused', () => {
      const html = renderPlanControls(makeData('paused'));
      assert.ok(html.includes('showWorkSummary()" style="display:none"'));
    });
  });

  // -----------------------------------------------------------------------
  // Button CSS classes
  // -----------------------------------------------------------------------
  suite('Button CSS classes', () => {
    test('Pause has secondary class', () => {
      const html = renderPlanControls(makeData('running'));
      assert.ok(html.includes('id="pauseBtn" class="action-btn secondary"'));
    });

    test('Resume has primary class', () => {
      const html = renderPlanControls(makeData('paused'));
      assert.ok(html.includes('id="resumeBtn" class="action-btn primary"'));
    });

    test('Cancel has secondary class', () => {
      const html = renderPlanControls(makeData('running'));
      assert.ok(html.includes('id="cancelBtn" class="action-btn secondary"'));
    });

    test('Delete has danger class', () => {
      const html = renderPlanControls(makeData('running'));
      assert.ok(html.includes('class="action-btn danger"'));
    });

    test('Work Summary has primary class', () => {
      const html = renderPlanControls(makeData('succeeded'));
      assert.ok(html.includes('id="workSummaryBtn" class="action-btn primary"'));
    });
  });

  // -----------------------------------------------------------------------
  // Actions container
  // -----------------------------------------------------------------------
  test('wraps buttons in actions div', () => {
    const html = renderPlanControls(makeData('running'));
    assert.ok(html.includes('class="actions"'));
  });
});
