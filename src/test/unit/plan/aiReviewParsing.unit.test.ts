/**
 * @fileoverview Unit tests for AI Review parsing functionality
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { parseAiReviewResult, decodeHtmlEntities, stripHtmlTags } from '../../../plan/aiReviewUtils';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

suite('AI Review Parsing', () => {
  let quiet: { restore: () => void };

  setup(() => {
    quiet = silenceConsole();
  });

  teardown(() => {
    quiet.restore();
    sinon.restore();
  });

  suite('parseAiReviewResult', () => {
    test('should parse clean JSON (expected path)', () => {
      const input = '{ "legitimate": true, "reason": "Tests already pass" }';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, true);
      assert.strictEqual(result?.reason, 'Tests already pass');
    });

    test('should parse clean JSON with extra whitespace', () => {
      const input = '  {\n  "legitimate"  :  false  ,\n  "reason"  :  "Changes were expected"  \n}  ';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, false);
      assert.strictEqual(result?.reason, 'Changes were expected');
    });

    test('should parse JSON embedded in text', () => {
      const input = 'Some leading text { "legitimate": true, "reason": "All good" } trailing text';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, true);
      assert.strictEqual(result?.reason, 'All good');
    });

    test('should parse JSON from markdown code block', () => {
      const input = 'Here is the result:\n```json\n{ "legitimate": false, "reason": "Missing tests" }\n```';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, false);
      assert.strictEqual(result?.reason, 'Missing tests');
    });

    test('should parse JSON from plain code block', () => {
      const input = 'Result:\n```\n{ "legitimate": true, "reason": "Code looks good" }\n```';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, true);
      assert.strictEqual(result?.reason, 'Code looks good');
    });

    test('should handle HTML-encoded JSON', () => {
      const input = '{ &quot;legitimate&quot;: true, &quot;reason&quot;: &quot;No issues found&quot; }';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, true);
      assert.strictEqual(result?.reason, 'No issues found');
    });

    test('should handle JSON with HTML tags', () => {
      const input = '<pre><code>{ "legitimate": false, "reason": "Needs work" }</code></pre>';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, false);
      assert.strictEqual(result?.reason, 'Needs work');
    });

    test('should handle complex HTML with nested tags', () => {
      const input = '<div><p>Result:</p><pre><code>{ &quot;legitimate&quot;: true, &quot;reason&quot;: &quot;Excellent work&quot; }</code></pre></div>';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, true);
      assert.strictEqual(result?.reason, 'Excellent work');
    });

    test('should extract fields as fallback when JSON parsing fails', () => {
      const input = '{ "legitimate": true, some other text, "reason": "Works fine"';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, true);
      assert.strictEqual(result?.reason, 'Works fine');
    });

    test('should extract fields with only legitimate field', () => {
      const input = 'some text "legitimate": false more text';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, false);
      assert.strictEqual(result?.reason, 'No reason extracted');
    });

    test('should handle case-insensitive field extraction', () => {
      const input = '"LEGITIMATE": True and "REASON": "Case test"';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, true);
      assert.strictEqual(result?.reason, 'Case test');
    });

    test('should return null for unparseable content', () => {
      const input = 'This is just random text with no JSON or fields';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result, null);
    });

    test('should return null for invalid JSON', () => {
      const input = '{ "legitimate": "not a boolean", "reason": "invalid" }';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result, null);
    });

    test('should handle missing reason field gracefully', () => {
      const input = '{ "legitimate": true }';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, true);
      assert.strictEqual(result?.reason, 'AI review approved');
    });

    test('should handle missing reason field for false legitimate', () => {
      const input = '{ "legitimate": false }';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, false);
      assert.strictEqual(result?.reason, 'AI review rejected');
    });

    test('should handle multiline JSON in code blocks', () => {
      const input = `Here's the analysis:
\`\`\`json
{
  "legitimate": true,
  "reason": "All tests pass and code quality is good"
}
\`\`\``;
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, true);
      assert.strictEqual(result?.reason, 'All tests pass and code quality is good');
    });

    test('should prefer clean JSON over other formats', () => {
      // This input has both markdown block and clean JSON - should prefer clean JSON
      const input = `\`\`\`json
{ "legitimate": false, "reason": "From code block" }
\`\`\`
Some text { "legitimate": true, "reason": "From clean JSON" } more text`;
      const result = parseAiReviewResult(input);
      
      // Should pick the first matching clean JSON
      assert.strictEqual(result?.legitimate, false);
      assert.strictEqual(result?.reason, 'From code block');
    });

    test('should handle complex nested HTML entities', () => {
      const input = '&lt;div&gt;{ &quot;legitimate&quot;: true, &quot;reason&quot;: &quot;Good &amp; clean&quot; }&lt;/div&gt;';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, true);
      assert.strictEqual(result?.reason, 'Good & clean');
    });
  });

  suite('decodeHtmlEntities', () => {
    test('should decode common HTML entities', () => {
      const input = '&quot;test&quot; &amp; &lt;tag&gt; &#39;quote&#39; &apos;apos&apos;';
      const result = decodeHtmlEntities(input);
      
      assert.strictEqual(result, '"test" & <tag> \'quote\' \'apos\'');
    });

    test('should handle text without entities', () => {
      const input = 'plain text with no entities';
      const result = decodeHtmlEntities(input);
      
      assert.strictEqual(result, 'plain text with no entities');
    });

    test('should handle empty string', () => {
      const result = decodeHtmlEntities('');
      assert.strictEqual(result, '');
    });
  });

  suite('stripHtmlTags', () => {
    test('should remove simple HTML tags', () => {
      const input = '<p>Hello <strong>world</strong></p>';
      const result = stripHtmlTags(input);
      
      assert.strictEqual(result, 'Hello world');
    });

    test('should handle nested tags', () => {
      const input = '<div><p>Nested <span>content</span></p></div>';
      const result = stripHtmlTags(input);
      
      assert.strictEqual(result, 'Nested content');
    });

    test('should handle malformed nested tags', () => {
      const input = '<scr<script>ipt>alert("test")</script>';
      const result = stripHtmlTags(input);
      
      assert.strictEqual(result, 'ipt>alert("test")');
    });

    test('should remove markdown code fences', () => {
      const input = '```json\n{ "test": true }\n```';
      const result = stripHtmlTags(input);
      
      assert.strictEqual(result, '{ "test": true }\n');
    });

    test('should remove code fences without language', () => {
      const input = '```\nsome code\n```';
      const result = stripHtmlTags(input);
      
      assert.strictEqual(result, 'some code\n');
    });

    test('should handle text without tags', () => {
      const input = 'plain text';
      const result = stripHtmlTags(input);
      
      assert.strictEqual(result, 'plain text');
    });

    test('should handle empty string', () => {
      const result = stripHtmlTags('');
      assert.strictEqual(result, '');
    });
  });
});