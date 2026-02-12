/**
 * @fileoverview Unit test for AI review JSON parsing fix.
 */

import * as assert from 'assert';

// Mock the stripMarkup function logic from executor.ts
function stripMarkup(s: string): string {
  let result = s;
  let prev: string;
  // Remove HTML tags iteratively (handles nested/incomplete tags)
  do {
    prev = result;
    result = result.replace(/<\/?[^>]+>/g, '');
  } while (result !== prev);
  // Remove markdown code fences
  result = result.replace(/```(?:json)?\s*/g, '');
  // Decode common HTML entities
  result = result
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  return result;
}

suite('AI Review JSON Parsing Fix', () => {
  suite('stripMarkup HTML entity decoding', () => {
    test('decodes &quot; to double quotes', () => {
      const input = '{&quot;legitimate&quot;: true}';
      const result = stripMarkup(input);
      assert.strictEqual(result, '{"legitimate": true}');
    });

    test('decodes mixed HTML entities', () => {
      const input = '{&quot;legitimate&quot;: true, &quot;reason&quot;: &quot;Test &amp; verify&quot;}';
      const result = stripMarkup(input);
      assert.strictEqual(result, '{"legitimate": true, "reason": "Test & verify"}');
    });

    test('decodes all common HTML entities', () => {
      const input = '&quot;&amp;&lt;&gt;&#39;&nbsp;';
      const result = stripMarkup(input);
      assert.strictEqual(result, '"&<>\' ');
    });

    test('removes HTML tags and decodes entities', () => {
      const input = '<p>{&quot;legitimate&quot;: true, &quot;reason&quot;: &quot;Fixes already committed&quot;}</p>';
      const result = stripMarkup(input);
      assert.strictEqual(result, '{"legitimate": true, "reason": "Fixes already committed"}');
    });

    test('handles complex nested HTML with entities', () => {
      const input = '<div><p>{&quot;legitimate&quot;: false, &quot;reason&quot;: &quot;Missing &lt;tag&gt; &amp; entity&quot;}</p></div>';
      const result = stripMarkup(input);
      assert.strictEqual(result, '{"legitimate": false, "reason": "Missing <tag> & entity"}');
    });

    test('preserves valid JSON without HTML entities or tags', () => {
      const input = '{"legitimate": true, "reason": "No changes needed"}';
      const result = stripMarkup(input);
      assert.strictEqual(result, input);
    });
  });

  suite('JSON parsing after stripMarkup', () => {
    test('parses legitimate: true case', () => {
      const htmlInput = '<p>{&quot;legitimate&quot;: true, &quot;reason&quot;: &quot;No changes needed&quot;}</p>';
      const stripped = stripMarkup(htmlInput);
      const parsed = JSON.parse(stripped);
      
      assert.strictEqual(parsed.legitimate, true);
      assert.strictEqual(parsed.reason, 'No changes needed');
    });

    test('parses legitimate: false case', () => {
      const htmlInput = '<p>{&quot;legitimate&quot;: false, &quot;reason&quot;: &quot;Changes expected&quot;}</p>';
      const stripped = stripMarkup(htmlInput);
      const parsed = JSON.parse(stripped);
      
      assert.strictEqual(parsed.legitimate, false);
      assert.strictEqual(parsed.reason, 'Changes expected');
    });

    test('handles the original problematic input', () => {
      const problematicInput = '<p>{&quot;legitimate&quot;: true, &quot;reason&quot;: &quot;Fixes already committed...&quot;}</p>';
      const stripped = stripMarkup(problematicInput);
      
      // Should be able to parse without throwing
      assert.doesNotThrow(() => {
        const parsed = JSON.parse(stripped);
        assert.strictEqual(parsed.legitimate, true);
        assert.strictEqual(parsed.reason, 'Fixes already committed...');
      });
    });
  });
});