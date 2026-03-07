/**
 * @fileoverview Unit tests for reviewFindingParser
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

suite('reviewFindingParser', () => {
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

  suite('parseReviewFindings', () => {
    test('parses valid JSON between markers', () => {
      const input = `
Some preamble text
<!-- FINDINGS_START -->
[
  {
    "severity": "error",
    "title": "Missing null check",
    "description": "The variable could be null",
    "filePath": "src/app.ts",
    "line": 42,
    "endLine": 45,
    "category": "safety"
  },
  {
    "severity": "warning",
    "title": "Unused import",
    "description": "This import is not used anywhere"
  }
]
<!-- FINDINGS_END -->
Some postamble text
      `.trim();

      const findings = parseReviewFindings(input);

      assert.strictEqual(findings.length, 2);
      
      // First finding
      assert.ok(findings[0].id);
      assert.strictEqual(findings[0].severity, 'error');
      assert.strictEqual(findings[0].title, 'Missing null check');
      assert.strictEqual(findings[0].description, 'The variable could be null');
      assert.strictEqual(findings[0].filePath, 'src/app.ts');
      assert.strictEqual(findings[0].line, 42);
      assert.strictEqual(findings[0].endLine, 45);
      assert.strictEqual(findings[0].category, 'safety');
      assert.strictEqual(findings[0].status, 'open');
      assert.ok(findings[0].createdAt);
      
      // Second finding
      assert.ok(findings[1].id);
      assert.strictEqual(findings[1].severity, 'warning');
      assert.strictEqual(findings[1].title, 'Unused import');
      assert.strictEqual(findings[1].description, 'This import is not used anywhere');
      assert.strictEqual(findings[1].status, 'open');
      assert.ok(findings[1].createdAt);
    });

    test('falls back to heuristic when no markers found', () => {
      const input = `
**ERROR**: Missing null check (src/app.ts:42)
**WARNING**: Unused import
      `.trim();

      const findings = parseReviewFindings(input);

      assert.strictEqual(findings.length, 2);
      assert.strictEqual(findings[0].severity, 'error');
      assert.strictEqual(findings[1].severity, 'warning');
    });

    test('returns empty array for empty input', () => {
      const findings = parseReviewFindings('');
      assert.strictEqual(findings.length, 0);
    });

    test('returns empty array when markers exist but JSON is invalid', () => {
      const input = `
<!-- FINDINGS_START -->
{ invalid json [
<!-- FINDINGS_END -->
      `.trim();

      const findings = parseReviewFindings(input);
      // Falls back to heuristic, which won't find anything in this malformed JSON
      assert.strictEqual(findings.length, 0);
    });

    test('handles findings with all fields populated', () => {
      const input = `
<!-- FINDINGS_START -->
[
  {
    "severity": "info",
    "title": "Consider refactoring",
    "description": "This function is too long",
    "filePath": "src/utils.ts",
    "line": 100,
    "endLine": 150,
    "category": "maintainability"
  }
]
<!-- FINDINGS_END -->
      `.trim();

      const findings = parseReviewFindings(input);

      assert.strictEqual(findings.length, 1);
      assert.ok(findings[0].id);
      assert.strictEqual(findings[0].severity, 'info');
      assert.strictEqual(findings[0].title, 'Consider refactoring');
      assert.strictEqual(findings[0].description, 'This function is too long');
      assert.strictEqual(findings[0].filePath, 'src/utils.ts');
      assert.strictEqual(findings[0].line, 100);
      assert.strictEqual(findings[0].endLine, 150);
      assert.strictEqual(findings[0].category, 'maintainability');
      assert.strictEqual(findings[0].status, 'open');
    });

    test('handles findings with minimal fields (severity + title only)', () => {
      const input = `
<!-- FINDINGS_START -->
[
  {
    "severity": "suggestion",
    "title": "Use const instead of let"
  }
]
<!-- FINDINGS_END -->
      `.trim();

      const findings = parseReviewFindings(input);

      assert.strictEqual(findings.length, 1);
      assert.ok(findings[0].id);
      assert.strictEqual(findings[0].severity, 'suggestion');
      assert.strictEqual(findings[0].title, 'Use const instead of let');
      assert.strictEqual(findings[0].description, '');
      assert.strictEqual(findings[0].status, 'open');
    });

    test('auto-generates IDs for each finding', () => {
      const input = `
<!-- FINDINGS_START -->
[
  {"severity": "error", "title": "First"},
  {"severity": "warning", "title": "Second"},
  {"severity": "info", "title": "Third"}
]
<!-- FINDINGS_END -->
      `.trim();

      const findings = parseReviewFindings(input);

      assert.strictEqual(findings.length, 3);
      assert.ok(findings[0].id);
      assert.ok(findings[1].id);
      assert.ok(findings[2].id);
      
      // IDs should be unique
      assert.notStrictEqual(findings[0].id, findings[1].id);
      assert.notStrictEqual(findings[1].id, findings[2].id);
      assert.notStrictEqual(findings[0].id, findings[2].id);
    });

    test('sets status to open for all parsed findings', () => {
      const input = `
<!-- FINDINGS_START -->
[
  {"severity": "error", "title": "First"},
  {"severity": "warning", "title": "Second"}
]
<!-- FINDINGS_END -->
      `.trim();

      const findings = parseReviewFindings(input);

      assert.strictEqual(findings.length, 2);
      assert.strictEqual(findings[0].status, 'open');
      assert.strictEqual(findings[1].status, 'open');
    });
  });

  suite('parseReviewFindingsHeuristic', () => {
    test('parses **WARNING**: description (file.ts:42) format', () => {
      const input = '**WARNING**: Unused variable (src/app.ts:42)';
      
      const findings = parseReviewFindingsHeuristic(input);
      
      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].severity, 'warning');
      assert.ok(findings[0].title.includes('Unused variable'));
      assert.strictEqual(findings[0].filePath, 'src/app.ts');
      assert.strictEqual(findings[0].line, 42);
      assert.strictEqual(findings[0].status, 'open');
    });

    test('parses ERROR: description format without file', () => {
      const input = 'ERROR: Missing return statement';
      
      const findings = parseReviewFindingsHeuristic(input);
      
      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].severity, 'error');
      assert.ok(findings[0].title.includes('Missing return statement'));
      assert.strictEqual(findings[0].filePath, undefined);
      assert.strictEqual(findings[0].line, undefined);
    });

    test('parses markdown bullet lists with severity', () => {
      const input = `
- [error] Missing null check
- [warning] Unused import in \`src/utils.ts\` line 10
- [info] Consider adding documentation
      `.trim();
      
      const findings = parseReviewFindingsHeuristic(input);
      
      assert.strictEqual(findings.length, 3);
      
      // First finding
      assert.strictEqual(findings[0].severity, 'error');
      assert.ok(findings[0].description && findings[0].description.length > 0, 'description should exist');
      // The description or title should contain the text
      const firstText = findings[0].description + ' ' + findings[0].title;
      assert.ok(firstText.includes('Missing null check') || firstText.includes('null check'), 'should contain finding text');
      
      // Second finding
      assert.strictEqual(findings[1].severity, 'warning');
      assert.ok(findings[1].description.includes('Unused import'));
      assert.strictEqual(findings[1].filePath, 'src/utils.ts');
      assert.strictEqual(findings[1].line, 10);
      
      // Third finding
      assert.strictEqual(findings[2].severity, 'info');
      assert.ok(findings[2].description.includes('Consider adding documentation'));
    });

    test('extracts file:line references', () => {
      const input = '**ERROR**: Bad code (src/index.ts:123)';
      
      const findings = parseReviewFindingsHeuristic(input);
      
      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].filePath, 'src/index.ts');
      assert.strictEqual(findings[0].line, 123);
    });

    test('extracts category from brackets like [security]', () => {
      const input = '**ERROR**: SQL injection vulnerability [security]';
      
      const findings = parseReviewFindingsHeuristic(input);
      
      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].category, 'security');
      assert.ok(findings[0].description.includes('SQL injection vulnerability'));
      assert.ok(!findings[0].description.includes('[security]'));
    });

    test('returns empty for completely unstructured text', () => {
      const input = 'This is just some random text without any patterns.';
      
      const findings = parseReviewFindingsHeuristic(input);
      
      assert.strictEqual(findings.length, 0);
    });

    test('handles mixed severity levels', () => {
      const input = `
**ERROR**: Critical issue (main.ts:1)
**WARNING**: Minor issue (main.ts:2)
**INFO**: Note something (main.ts:3)
**SUGGESTION**: Consider this (main.ts:4)
      `.trim();
      
      const findings = parseReviewFindingsHeuristic(input);
      
      assert.strictEqual(findings.length, 4);
      assert.strictEqual(findings[0].severity, 'error');
      assert.strictEqual(findings[1].severity, 'warning');
      assert.strictEqual(findings[2].severity, 'info');
      assert.strictEqual(findings[3].severity, 'suggestion');
    });
  });
});
