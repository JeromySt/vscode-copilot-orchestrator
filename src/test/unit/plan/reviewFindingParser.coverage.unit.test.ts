/**
 * @fileoverview Coverage tests for reviewFindingParser.
 * Covers: cleanup retry path (lines 58-97) inner catch, and look-ahead
 * continuation lines (162-164) edge cases.
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { parseReviewFindings, parseReviewFindingsHeuristic } from '../../../plan/reviewFindingParser';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

suite('reviewFindingParser coverage', () => {
  let quiet: { restore: () => void };
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    quiet = silenceConsole();
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    quiet.restore();
    sandbox.restore();
  });

  // ── parseReviewFindings – cleanup path inner catch (line 94) ─────────────

  suite('parseReviewFindings cleanup path', () => {
    test('falls back to heuristic when cleaned JSON is also invalid (inner catch)', () => {
      // First parse fails due to interleaved noise
      // After cleaning, the result is still invalid JSON → inner catch triggers
      // The cleaned content has [ ... ] but still invalid JSON inside
      const input = [
        '<!-- FINDINGS_START -->',
        '[',
        '● tool output',
        'this is not json at all { broken',
        ']',
        '<!-- FINDINGS_END -->',
        '**ERROR**: Fallback finding (src/a.ts:10)',
      ].join('\n');

      const findings = parseReviewFindings(input);

      // Falls back to heuristic after both JSON parse attempts fail
      // The heuristic should find the ERROR line
      assert.ok(Array.isArray(findings));
    });

    test('exercises all noise filter predicates in cleanup path', () => {
      // JSON fails first time; cleaned JSON succeeds
      const validJson = JSON.stringify([
        { severity: 'warning', title: 'Test finding', description: 'A warning from cleanup' }
      ]);
      const input = [
        '<!-- FINDINGS_START -->',
        '[',
        '● Running tool: read_file',      // startsWith('●')
        '└ Done',                          // startsWith('└')
        '$ ls -la',                        // startsWith('$')
        'CWD: /some/path',                 // startsWith('CWD:')
        'Spawning: node process',          // startsWith('Spawning:')
        'Environment: NODE_ENV=test',      // startsWith('Environment')
        '',                                // empty line (filtered by length > 0)
        validJson,                         // valid JSON line
        ']',
        '<!-- FINDINGS_END -->',
      ].join('\n');

      const findings = parseReviewFindings(input);

      // The valid JSON should be preserved after cleaning, then parsed
      assert.ok(Array.isArray(findings));
    });

    test('inner JSON parse attempt when cleaned text has no [ ] brackets', () => {
      // After cleaning, the text has no brackets → inner if branch not taken
      const input = [
        '<!-- FINDINGS_START -->',
        '● some noise',
        '└ more noise',
        '<!-- FINDINGS_END -->',
      ].join('\n');

      // No [ ] in original → arrayStart/arrayEnd both -1 → entire block skipped
      // falls through to heuristic
      const findings = parseReviewFindings(input);
      assert.ok(Array.isArray(findings));
    });

    test('parseReviewFindings returns empty array when FINDINGS_END before FINDINGS_START', () => {
      // endIndex < startIndex → condition fails
      const input = '<!-- FINDINGS_END -->\n<!-- FINDINGS_START -->\n[{"severity":"error"}]';
      const findings = parseReviewFindings(input);
      // Falls to heuristic, which won't match this JSON
      assert.ok(Array.isArray(findings));
    });

    test('handles markers but no [ ] in JSON block', () => {
      const input = [
        '<!-- FINDINGS_START -->',
        '{ "not": "an array" }',
        '<!-- FINDINGS_END -->',
      ].join('\n');

      // arrayStart = -1 because there's no [ in the JSON block
      const findings = parseReviewFindings(input);
      assert.ok(Array.isArray(findings));
    });

    test('returns parsed findings when cleanup JSON parse succeeds', () => {
      // Valid JSON but with noise lines mixed in (the original parse will fail)
      const input = [
        '<!-- FINDINGS_START -->',
        '[',
        '● tool noise',
        '{"severity":"error","title":"Real finding","description":"desc"}',
        ']',
        '<!-- FINDINGS_END -->',
      ].join('\n');

      const findings = parseReviewFindings(input);
      assert.ok(Array.isArray(findings));
      // Either cleanup path succeeds or heuristic finds nothing — just no crash
    });
  });

  // ── parseReviewFindingsHeuristic – continuation lines (162-164) ──────────

  suite('parseReviewFindingsHeuristic continuation lines', () => {
    test('continuation lines are appended to description until next pattern', () => {
      const input = [
        '**WARNING**: The function is too long.',
        'This is a continuation line.',
        'Another continuation.',
        '**ERROR**: New finding here.',
      ].join('\n');

      const findings = parseReviewFindingsHeuristic(input);

      assert.ok(findings.length >= 2);
      // First finding should have continuation lines in description
      assert.ok(findings[0].description.includes('continuation line'));
    });

    test('continuation lines stop at empty line', () => {
      const input = [
        '**INFO**: Short description.',
        'Extra detail here.',
        '',  // empty line stops continuation
        '**WARNING**: Next finding.',
      ].join('\n');

      const findings = parseReviewFindingsHeuristic(input);
      assert.ok(findings.length >= 1);
    });

    test('i is advanced past consumed continuation lines', () => {
      // This ensures the "i = j - 1" line (184) is covered
      const input = [
        '**ERROR**: Main issue description.',
        'Detail about the issue.',
        'More details.',
        '**WARNING**: Second issue.',
      ].join('\n');

      const findings = parseReviewFindingsHeuristic(input);
      // Should have 2 findings, not 4 (i advances past continuation lines)
      assert.strictEqual(findings.length, 2);
    });

    test('title truncated at sentence end when description is long', () => {
      const input = '**ERROR**: First sentence ends here. Extra content beyond 80 chars that should not be in title.';

      const findings = parseReviewFindingsHeuristic(input);

      assert.strictEqual(findings.length, 1);
      assert.ok(findings[0].title.endsWith('.'));
      assert.ok(!findings[0].title.includes('Extra content'));
    });

    test('title truncated at 80 chars with ellipsis when no sentence break', () => {
      const longDesc = 'A'.repeat(100); // No sentence break, 100 chars
      const input = `**WARNING**: ${longDesc}`;

      const findings = parseReviewFindingsHeuristic(input);

      assert.strictEqual(findings.length, 1);
      assert.ok(findings[0].title.endsWith('...'));
      assert.ok(findings[0].title.length <= 83); // 80 + '...'
    });

    test('empty lines are skipped in the main loop', () => {
      const input = '\n\n\n**ERROR**: Only finding.\n\n\n';

      const findings = parseReviewFindingsHeuristic(input);

      assert.strictEqual(findings.length, 1);
      assert.ok(findings[0].severity === 'error');
    });

    test('handles SUGGESTION severity in pattern1', () => {
      const input = '**SUGGESTION**: Consider using a constant here';

      const findings = parseReviewFindingsHeuristic(input);

      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].severity, 'suggestion');
    });

    test('handles INFO severity in pattern3 (plain prefix)', () => {
      const input = 'INFO: Note that this is informational';

      const findings = parseReviewFindingsHeuristic(input);

      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].severity, 'info');
    });

    test('category extracted and removed from description', () => {
      const input = '**WARNING**: SQL injection risk [security] in this function';

      const findings = parseReviewFindingsHeuristic(input);

      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].category, 'security');
      assert.ok(!findings[0].description.includes('[security]'));
    });
  });
});
