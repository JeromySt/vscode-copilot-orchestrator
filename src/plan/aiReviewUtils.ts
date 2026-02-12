/**
 * @fileoverview Utility functions for parsing AI review results.
 * These functions handle HTML entity decoding, tag stripping, and JSON extraction
 * from AI-generated review output that may be wrapped in HTML or markdown.
 */

/**
 * Decode common HTML entities to their text equivalents.
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Strip HTML tags from text using iterative removal to handle nested/incomplete tags.
 */
export function stripHtmlTags(text: string): string {
  let result = text;
  let prev: string;
  // Remove HTML tags iteratively (handles nested/incomplete tags)
  do {
    prev = result;
    result = result.replace(/<\/?[^>]+>/g, '');
  } while (result !== prev);
  return result;
}

/**
 * Parse AI review result from potentially HTML-wrapped and entity-encoded JSON.
 * This function handles various formats the AI might return:
 * - Clean JSON: {"legitimate": true, "reason": "..."}
 * - HTML-encoded JSON: {&quot;legitimate&quot;: true, &quot;reason&quot;: &quot;...&quot;}
 * - JSON wrapped in HTML tags: <p>{"legitimate": false, "reason": "..."}</p>
 * - Split JSON across multiple lines
 */
export function parseAiReviewResult(input: string): { legitimate: boolean; reason: string } | null {
  if (!input) {
    return null;
  }

  // Helper function that combines HTML tag stripping and entity decoding
  const stripMarkup = (s: string) => {
    let result = stripHtmlTags(s);
    // Remove markdown code fences
    result = result.replace(/```(?:json)?\s*/g, '');
    // Decode HTML entities
    result = decodeHtmlEntities(result);
    return result;
  };

  // Split into lines and process
  const lines = input.split('\n');
  
  // Try each line last-to-first (most likely location)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = stripMarkup(lines[i]);
    const jsonMatch = line.match(/\{[^{}]*"legitimate"\s*:\s*(true|false)[^{}]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as { legitimate: boolean; reason: string };
        return {
          legitimate: parsed.legitimate === true,
          reason: parsed.reason || (parsed.legitimate ? 'AI review approved' : 'AI review rejected'),
        };
      } catch {
        // JSON parse failed, continue searching
      }
    }
  }

  // Try combining all lines and searching the combined text
  // (for JSON split across multiple lines)
  const combined = stripMarkup(lines.join(' '));
  const combinedMatch = combined.match(/\{\s*"legitimate"\s*:\s*(true|false)\s*,\s*"reason"\s*:\s*"([^"]*)"\s*\}/);
  if (combinedMatch) {
    try {
      const parsed = JSON.parse(combinedMatch[0]) as { legitimate: boolean; reason: string };
      return {
        legitimate: parsed.legitimate === true,
        reason: parsed.reason || (parsed.legitimate ? 'AI review approved' : 'AI review rejected'),
      };
    } catch {
      // JSON parse failed
    }
  }

  return null;
}