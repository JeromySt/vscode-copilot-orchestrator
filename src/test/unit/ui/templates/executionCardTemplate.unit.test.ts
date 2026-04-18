/**
 * @fileoverview Unit tests for the shared executionCardTemplate module.
 *
 * Covers: phaseTabsHtml, metricsHtml, errorHtml, contextHtml,
 *         executionCardHtml (live + historical), and splitAttemptLogs.
 *
 * @module test/unit/ui/templates/executionCardTemplate
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import {
  phaseTabsHtml,
  metricsHtml,
  errorHtml,
  contextHtml,
  executionCardHtml,
  splitAttemptLogs,
  type ExecutionCardData,
} from '../../../../ui/templates/nodeDetail/executionCardTemplate';

// ─── phaseTabsHtml ────────────────────────────────────────────────────────────

suite('executionCardTemplate', () => {
  suite('phaseTabsHtml', () => {
    test('renders seven step-icon spans', () => {
      const html = phaseTabsHtml({}, false);
      const matches = html.match(/<span class="step-icon/g);
      assert.strictEqual(matches?.length, 7, 'Should produce 7 step-icon spans');
    });

    test('all pending icons when no statuses given', () => {
      const html = phaseTabsHtml({}, false);
      assert.ok(!html.includes('class="step-icon success"'), 'No success icons expected');
      assert.ok(!html.includes('class="step-icon failed"'), 'No failed icons expected');
      assert.ok(html.includes('class="step-icon pending"'), 'Should have pending icons');
    });

    test('renders success icon for succeeded phase', () => {
      const html = phaseTabsHtml({ work: 'succeeded' }, false);
      assert.ok(html.includes('class="step-icon success"'), 'Should have one success icon');
    });

    test('renders failed icon for failed phase', () => {
      const html = phaseTabsHtml({ postchecks: 'failed' }, false);
      assert.ok(html.includes('class="step-icon failed"'), 'Should have one failed icon');
    });

    test('renders running icon for running phase', () => {
      const html = phaseTabsHtml({ work: 'running' }, false);
      assert.ok(html.includes('class="step-icon running"'), 'Should have one running icon');
    });

    test('renders skipped icon for skipped phase', () => {
      const html = phaseTabsHtml({ prechecks: 'skipped' }, false);
      assert.ok(html.includes('class="step-icon skipped"'), 'Should have one skipped icon');
    });

    test('uses unicode check mark for success', () => {
      const html = phaseTabsHtml({ 'merge-fi': 'success' }, false);
      assert.ok(html.includes('\u2713'), 'Should use ✓ for success');
    });

    test('uses unicode cross for failed', () => {
      const html = phaseTabsHtml({ commit: 'failed' }, false);
      assert.ok(html.includes('\u2717'), 'Should use ✗ for failed');
    });

    test('uses unicode bullet for pending', () => {
      const html = phaseTabsHtml({}, false);
      assert.ok(html.includes('\u2022'), 'Should use • for pending');
    });
  });

  // ─── metricsHtml ──────────────────────────────────────────────────────────

  suite('metricsHtml', () => {
    test('returns empty string for undefined metrics', () => {
      assert.strictEqual(metricsHtml(undefined), '');
    });

    test('returns empty string for empty metrics object', () => {
      assert.strictEqual(metricsHtml({}), '');
    });

    test('renders attempt-metrics-card wrapper', () => {
      const html = metricsHtml({ premiumRequests: 2 });
      assert.ok(html.includes('attempt-metrics-card'), 'Should have .attempt-metrics-card');
    });

    test('renders metrics-stats-grid', () => {
      const html = metricsHtml({ apiTimeSeconds: 30 });
      assert.ok(html.includes('metrics-stats-grid'), 'Should have .metrics-stats-grid');
    });

    test('includes premium requests when provided', () => {
      const html = metricsHtml({ premiumRequests: 5 });
      assert.ok(html.length > 0, 'Should produce output for premium requests');
      assert.ok(html.includes('metrics-stat'), 'Should include metrics-stat div');
    });

    test('includes api time when provided', () => {
      const html = metricsHtml({ apiTimeSeconds: 60 });
      assert.ok(html.includes('API'), 'Should include API time label');
    });

    test('includes session time when provided', () => {
      const html = metricsHtml({ sessionTimeSeconds: 120 });
      assert.ok(html.includes('Session'), 'Should include Session label');
    });

    test('includes code changes when provided', () => {
      const html = metricsHtml({ codeChanges: { linesAdded: 10, linesRemoved: 3 } });
      assert.ok(html.includes('Code'), 'Should include Code label');
    });

    test('renders model breakdown when provided', () => {
      const html = metricsHtml({
        modelBreakdown: [
          { model: 'gpt-4o', inputTokens: 1000, outputTokens: 500, premiumRequests: 1 },
        ],
      });
      assert.ok(html.includes('model-breakdown'), 'Should include model-breakdown');
      assert.ok(html.includes('gpt-4o'), 'Should include model name');
    });

    test('returns empty string for metrics with only empty model breakdown', () => {
      const html = metricsHtml({ modelBreakdown: [] });
      assert.strictEqual(html, '', 'Empty model breakdown with no stats should be empty');
    });
  });

  // ─── errorHtml ────────────────────────────────────────────────────────────

  suite('errorHtml', () => {
    test('returns empty string when no error', () => {
      assert.strictEqual(errorHtml(undefined), '');
      assert.strictEqual(errorHtml(''), '');
    });

    test('renders error section with message', () => {
      const html = errorHtml('Something went wrong');
      assert.ok(html.includes('attempt-error-section'), 'Should have error section class');
      assert.ok(html.includes('Something went wrong'), 'Should include error message');
    });

    test('escapes HTML in error message', () => {
      const html = errorHtml('<script>alert(1)</script>');
      assert.ok(!html.includes('<script>'), 'Should escape script tag');
      assert.ok(html.includes('&lt;script&gt;'), 'Should have escaped lt/gt');
    });

    test('includes phase when provided', () => {
      const html = errorHtml('Error', undefined, 'postchecks');
      assert.ok(html.includes('postchecks'), 'Should include phase name');
      assert.ok(html.includes('Failed in phase'), 'Should have phase label');
    });

    test('includes exit code when provided', () => {
      const html = errorHtml('Error', undefined, undefined, 1);
      assert.ok(html.includes('Exit code'), 'Should include exit code label');
      assert.ok(html.includes('>1<'), 'Should show the exit code value');
    });

    test('does not include phase label when phase not provided', () => {
      const html = errorHtml('Error');
      assert.ok(!html.includes('Failed in phase'), 'Should not include phase label');
    });

    test('does not include exit code label when exit code not provided', () => {
      const html = errorHtml('Error');
      assert.ok(!html.includes('Exit code'), 'Should not include exit code label');
    });
  });

  // ─── contextHtml ──────────────────────────────────────────────────────────

  suite('contextHtml', () => {
    test('returns empty string when no context data', () => {
      assert.strictEqual(contextHtml({}), '');
    });

    test('renders context section when base commit provided', () => {
      const html = contextHtml({ baseCommit: 'abc12345def67890' });
      assert.ok(html.includes('attempt-section'), 'Should have attempt-section class');
      assert.ok(html.includes('abc12345'), 'Should include first 8 chars of commit');
      assert.ok(!html.includes('def67890'), 'Should truncate commit to 8 chars');
    });

    test('renders worktree path', () => {
      const html = contextHtml({ worktreePath: '/some/path' });
      assert.ok(html.includes('Worktree'), 'Should have Worktree label');
      assert.ok(html.includes('/some/path'), 'Should include path');
    });

    test('renders log file path', () => {
      const html = contextHtml({ logFilePath: '/logs/test.log' });
      assert.ok(html.includes('Log'), 'Should have Log label');
      assert.ok(html.includes('data-path'), 'Should have data-path attribute');
    });

    test('renders session ID truncated', () => {
      const html = contextHtml({ copilotSessionId: 'abcdef123456789012345' });
      assert.ok(html.includes('Session'), 'Should have Session label');
      assert.ok(html.includes('abcdef123456'), 'Should include first 12 chars');
    });

    test('escapes HTML in worktree path', () => {
      const html = contextHtml({ worktreePath: '<evil>' });
      assert.ok(!html.includes('<evil>'), 'Should escape HTML');
      assert.ok(html.includes('&lt;evil&gt;'), 'Should have escaped version');
    });

    test('renders context section with Context heading', () => {
      const html = contextHtml({ baseCommit: 'abc12345' });
      assert.ok(html.includes('Context'), 'Should include Context heading');
    });
  });

  // ─── executionCardHtml ────────────────────────────────────────────────────

  suite('executionCardHtml', () => {
    const minimalData: ExecutionCardData = {
      attemptNumber: 1,
      status: 'running',
    };

    suite('isLive: true', () => {
      test('wraps in #liveExecutionCard', () => {
        const html = executionCardHtml({ ...minimalData, isLive: true });
        assert.ok(html.includes('id="liveExecutionCard"'), 'Should have liveExecutionCard id');
      });

      test('has execution-card-live class', () => {
        const html = executionCardHtml({ ...minimalData, isLive: true });
        assert.ok(html.includes('execution-card-live'), 'Should have execution-card-live class');
      });

      test('includes step indicators container', () => {
        const html = executionCardHtml({ ...minimalData, isLive: true });
        assert.ok(html.includes('step-indicators'), 'Should have step-indicators');
      });

      test('includes liveAiUsage id for CSR metrics target', () => {
        const html = executionCardHtml({ ...minimalData, isLive: true });
        assert.ok(html.includes('id="liveAiUsage"'), 'Should have liveAiUsage id');
      });

      test('hides empty metrics section with display:none', () => {
        const html = executionCardHtml({ ...minimalData, isLive: true });
        assert.ok(html.includes('display:none'), 'Empty metrics should be hidden');
      });

      test('shows metrics section when metrics provided', () => {
        const html = executionCardHtml({
          ...minimalData,
          isLive: true,
          metrics: { premiumRequests: 3 },
        });
        assert.ok(!html.includes('display:none'), 'Metrics section should be visible');
        assert.ok(html.includes('AI Usage'), 'Should include AI Usage title');
      });

      test('includes error section when error provided', () => {
        const html = executionCardHtml({ ...minimalData, isLive: true, error: 'Oops' });
        assert.ok(html.includes('attempt-error-section'), 'Should have error section');
      });

      test('renders seven step icons', () => {
        const html = executionCardHtml({ ...minimalData, isLive: true });
        const matches = html.match(/<span class="step-icon/g);
        assert.strictEqual(matches?.length, 7, 'Should render 7 step icons');
      });
    });

    suite('isLive: false (historical)', () => {
      test('does not have liveExecutionCard wrapper', () => {
        const html = executionCardHtml({ ...minimalData, isLive: false, status: 'succeeded' });
        assert.ok(!html.includes('id="liveExecutionCard"'), 'Should not have liveExecutionCard');
      });

      test('does not have liveAiUsage id', () => {
        const html = executionCardHtml({ ...minimalData, isLive: false, status: 'succeeded' });
        assert.ok(!html.includes('id="liveAiUsage"'), 'Should not have liveAiUsage');
      });

      test('renders running placeholder when running with no content', () => {
        const html = executionCardHtml({ ...minimalData, isLive: false });
        assert.ok(html.includes('attempt-running-indicator'), 'Should have running indicator');
      });

      test('no running placeholder when not running', () => {
        const html = executionCardHtml({ ...minimalData, isLive: false, status: 'succeeded' });
        assert.ok(!html.includes('attempt-running-indicator'), 'Should not have running indicator');
      });

      test('returns empty string when succeeded with no data', () => {
        const html = executionCardHtml({ ...minimalData, isLive: false, status: 'succeeded' });
        assert.strictEqual(html, '', 'Should be empty for succeeded with no data');
      });

      test('renders error section when error provided', () => {
        const html = executionCardHtml({ ...minimalData, isLive: false, error: 'Broke' });
        assert.ok(html.includes('attempt-error-section'), 'Should include error section');
        assert.ok(html.includes('Broke'), 'Should include error message');
      });

      test('renders metrics section when metrics provided', () => {
        const html = executionCardHtml({
          ...minimalData,
          isLive: false,
          status: 'succeeded',
          metrics: { apiTimeSeconds: 45 },
        });
        assert.ok(html.includes('AI Usage'), 'Should include AI Usage label');
        assert.ok(html.includes('attempt-metrics-card'), 'Should include metrics card');
      });

      test('renders context section when context provided', () => {
        const html = executionCardHtml({
          ...minimalData,
          isLive: false,
          status: 'succeeded',
          baseCommit: 'aabbccdd',
        });
        assert.ok(html.includes('Context'), 'Should include context section');
      });
    });
  });

  // ─── splitAttemptLogs ─────────────────────────────────────────────────────

  suite('splitAttemptLogs', () => {
    test('always includes "all" key with full log', () => {
      const result = splitAttemptLogs('some log content');
      assert.strictEqual(result['all'], 'some log content', 'Should include full log under "all"');
    });

    test('returns only "all" when no phase markers found', () => {
      const result = splitAttemptLogs('no markers here');
      assert.deepStrictEqual(Object.keys(result), ['all'], 'Should only have "all" key');
    });

    test('extracts prechecks section', () => {
      const log = 'header\nPRECHECKS SECTION\nsome check output\nPRECHECKS SECTION\nfooter';
      const result = splitAttemptLogs(log);
      assert.ok('prechecks' in result, 'Should extract prechecks key');
      assert.ok(result['prechecks'].includes('PRECHECKS SECTION'), 'Should include marker text');
    });

    test('extracts work section', () => {
      const log = 'start\nWORK SECTION\nwork output\nWORK SECTION\nend';
      const result = splitAttemptLogs(log);
      assert.ok('work' in result, 'Should extract work key');
    });

    test('extracts forward integration section', () => {
      const log = 'MERGE-FI SECTION\nmerge output\nMERGE-FI SECTION\nrest';
      const result = splitAttemptLogs(log);
      assert.ok('merge-fi' in result, 'Should extract merge-fi key');
    });

    test('extracts reverse integration section', () => {
      const log = 'before\nMERGE-RI SECTION\nri output\nMERGE-RI SECTION\nafter';
      const result = splitAttemptLogs(log);
      assert.ok('merge-ri' in result, 'Should extract merge-ri key');
    });

    test('uses content from marker to end when no closing marker', () => {
      const log = 'POSTCHECKS SECTION\ntest output line 1\ntest output line 2';
      const result = splitAttemptLogs(log);
      assert.ok('postchecks' in result, 'Should extract postchecks key');
      assert.ok(result['postchecks'].startsWith('POSTCHECKS SECTION'), 'Should start at marker');
    });

    test('handles empty string input', () => {
      const result = splitAttemptLogs('');
      assert.strictEqual(result['all'], '', 'all should be empty string');
    });
  });
});
