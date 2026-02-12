/**
 * @fileoverview Unit tests for AI review parsing functionality.
 * Tests verify HTML entity decoding, tag stripping, and JSON parsing
 * for various formats that AI agents might return.
 */

import * as assert from 'assert';
import { parseAiReviewResult, decodeHtmlEntities, stripHtmlTags } from '../../../plan/aiReviewUtils';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

suite('AI Review Parsing', () => {
  let consoleSilencer: { restore: () => void };

  setup(() => {
    consoleSilencer = silenceConsole();
  });

  teardown(() => {
    consoleSilencer.restore();
  });

  suite('decodeHtmlEntities', () => {
    test('should decode &quot; to quotes', () => {
      assert.strictEqual(decodeHtmlEntities('&quot;hello&quot;'), '"hello"');
    });
    
    test('should decode multiple entity types', () => {
      const input = '&lt;test&gt; &amp; &quot;value&quot;';
      assert.strictEqual(decodeHtmlEntities(input), '<test> & "value"');
    });

    test('should handle &#39; and &nbsp;', () => {
      const input = 'It&#39;s&nbsp;working';
      assert.strictEqual(decodeHtmlEntities(input), "It's working");
    });

    test('should handle mixed entities', () => {
      const input = '&lt;div&gt;&quot;Test&amp;Data&quot;&lt;/div&gt;';
      assert.strictEqual(decodeHtmlEntities(input), '<div>"Test&Data"</div>');
    });
  });
  
  suite('stripHtmlTags', () => {
    test('should remove HTML tags', () => {
      assert.strictEqual(stripHtmlTags('<p>content</p>'), 'content');
    });
    
    test('should handle nested tags', () => {
      assert.strictEqual(stripHtmlTags('<div><p>text</p></div>'), 'text');
    });
    
    test('should preserve text between tags', () => {
      assert.strictEqual(stripHtmlTags('<p>one</p><p>two</p>'), 'onetwo');
    });

    test('should handle self-closing tags', () => {
      assert.strictEqual(stripHtmlTags('before<br/>after'), 'beforeafter');
    });

    test('should handle incomplete or malformed tags iteratively', () => {
      // This edge case shows behavior with malformed nested tags
      assert.strictEqual(stripHtmlTags('<p><scr<script>ipt>text</p>'), 'ipt>text');
    });

    test('should handle mixed tag types', () => {
      const input = '<div class="test"><span>nested</span></div>';
      assert.strictEqual(stripHtmlTags(input), 'nested');
    });
  });
  
  suite('parseAiReviewResult', () => {
    test('should parse clean JSON', () => {
      const input = '{"legitimate": true, "reason": "Work already done"}';
      const result = parseAiReviewResult(input);
      
      assert.deepStrictEqual(result, {
        legitimate: true,
        reason: 'Work already done'
      });
    });
    
    test('should parse HTML-encoded JSON', () => {
      const input = '{&quot;legitimate&quot;: true, &quot;reason&quot;: &quot;Already fixed&quot;}';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, true);
      assert.strictEqual(result?.reason, 'Already fixed');
    });
    
    test('should parse JSON wrapped in HTML tags', () => {
      const input = '<p>{"legitimate": false, "reason": "No work done"}</p>';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, false);
      assert.strictEqual(result?.reason, 'No work done');
    });
    
    test('should parse HTML-encoded JSON in HTML tags', () => {
      const input = '<p>{&quot;legitimate&quot;: true, &quot;reason&quot;: &quot;Fixes already committed&quot;}</p>';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, true);
      assert.ok(result?.reason.includes('committed'));
    });
    
    test('should extract from multi-line HTML output', () => {
      const input = `
        <p>Analysis complete.</p>
        <p>{&quot;legitimate&quot;: true, &quot;reason&quot;: &quot;All tests pass&quot;}</p>
        <p>Done.</p>
      `;
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, true);
      assert.strictEqual(result?.reason, 'All tests pass');
    });
    
    test('should handle legitimate: false', () => {
      const input = '{"legitimate": false, "reason": "Agent did nothing"}';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, false);
      assert.strictEqual(result?.reason, 'Agent did nothing');
    });
    
    test('should return null for missing JSON', () => {
      const input = '<p>No judgment here</p>';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result, null);
    });
    
    test('should return null for malformed JSON', () => {
      const input = '{legitimate: true}';  // Missing quotes
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result, null);
    });

    test('should return null for empty input', () => {
      assert.strictEqual(parseAiReviewResult(''), null);
      assert.strictEqual(parseAiReviewResult(' '), null);
    });
    
    test('should handle split JSON across lines (from log output)', () => {
      // Simulates what we see in logs where JSON is split
      const input = `<p>{&quot;legitimate&quot;: true, &quot;reason&quot;: &quot;Fixes already committed in 8e215c7
and verified working; all 315/315 unit tests pass including crash recovery tests; no additional
changes needed&quot;}</p>`;
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, true);
      assert.ok(result?.reason.includes('committed'));
      assert.ok(result?.reason.includes('315/315'));
    });

    test('should find JSON in last line when present in multiple lines', () => {
      const input = `
        {"legitimate": false, "reason": "Not the right one"}
        Some other content
        {"legitimate": true, "reason": "This should be found"}
      `;
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, true);
      assert.strictEqual(result?.reason, 'This should be found');
    });

    test('should handle markdown code fences', () => {
      const input = '```json\n{"legitimate": true, "reason": "Code block result"}\n```';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, true);
      assert.strictEqual(result?.reason, 'Code block result');
    });

    test('should provide default reason when reason is missing', () => {
      const input = '{"legitimate": true}';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, true);
      assert.strictEqual(result?.reason, 'AI review approved');
    });

    test('should provide default reason for false case when missing', () => {
      const input = '{"legitimate": false}';
      const result = parseAiReviewResult(input);
      
      assert.strictEqual(result?.legitimate, false);
      assert.strictEqual(result?.reason, 'AI review rejected');
    });
  });
});