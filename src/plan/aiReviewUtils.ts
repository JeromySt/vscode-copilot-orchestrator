/**
 * @fileoverview AI Review Utilities
 * 
 * Utilities for parsing AI review responses in various formats and generating
 * review instruction files. Provides robust parsing that handles clean JSON, 
 * markdown code blocks, HTML-encoded content, and field extraction as fallback.
 * 
 * @module plan/aiReviewUtils
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Result of AI review parsing
 */
export interface AiReviewResult {
  legitimate: boolean;
  reason: string;
}

/**
 * Parse AI review result from agent output.
 * Handles various formats: clean JSON, markdown code blocks, HTML-encoded.
 * 
 * @param output Raw output from AI agent
 * @returns Parsed review result or null if parsing failed
 */
export function parseAiReviewResult(output: string): AiReviewResult | null {
  // Step 1: Try clean JSON first (expected path with new prompt)
  try {
    const cleanMatch = output.match(/\{\s*"legitimate"\s*:\s*(true|false)[^}]*\}/s);
    if (cleanMatch) {
      const parsed = JSON.parse(cleanMatch[0]);
      if (typeof parsed.legitimate === 'boolean' && typeof parsed.reason === 'string') {
        return parsed;
      }
    }
  } catch { /* continue */ }
  
  // Step 2: Extract from markdown code block
  try {
    const codeBlockMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (codeBlockMatch) {
      const jsonContent = codeBlockMatch[1].trim();
      const parsed = JSON.parse(jsonContent);
      if (typeof parsed.legitimate === 'boolean') {
        return {
          legitimate: parsed.legitimate,
          reason: parsed.reason || (parsed.legitimate ? 'AI review approved' : 'AI review rejected')
        };
      }
    }
  } catch { /* continue */ }
  
  // Step 3: Decode HTML entities (fallback for old format)
  try {
    const decoded = decodeHtmlEntities(output);
    const stripped = stripHtmlTags(decoded);
    const jsonMatch = stripped.match(/\{\s*"legitimate"\s*:\s*(true|false)[^}]*\}/s);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.legitimate === 'boolean') {
        return {
          legitimate: parsed.legitimate,
          reason: parsed.reason || (parsed.legitimate ? 'AI review approved' : 'AI review rejected')
        };
      }
    }
  } catch { /* continue */ }
  
  // Step 4: Last resort - extract fields directly
  const legitMatch = output.match(/"legitimate"\s*:\s*(true|false)/i);
  if (legitMatch) {
    const legitimate = legitMatch[1].toLowerCase() === 'true';
    const reasonMatch = output.match(/"reason"\s*:\s*"([^"]*)"/i);
    const reason = reasonMatch ? reasonMatch[1] : 'No reason extracted';
    return { legitimate, reason };
  }
  
  return null;
}

/**
 * Decode HTML entities
 * 
 * @param text Text with potential HTML entities
 * @returns Decoded text
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * Strip HTML tags from text
 * Loop to handle nested/incomplete tag stripping (e.g. <scr<script>ipt>)
 * 
 * @param text Text with potential HTML tags
 * @returns Text without HTML tags
 */
export function stripHtmlTags(text: string): string {
  let result = text;
  let prev: string;
  do {
    prev = result;
    result = result.replace(/<\/?[^>]+>/g, '');
  } while (result !== prev);
  
  // Also remove markdown code fence markers
  result = result.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
  
  return result;
}

/**
 * Write AI review instructions file to the standard location.
 * Creates the instructions content that prompts for JSON-only responses
 * for reviewing agent execution logs.
 * 
 * @param worktreePath Path to the worktree directory
 * @param nodeId The node ID for file naming
 * @param executionLogs The execution logs to include in instructions
 * @param taskDescription Brief task description for context
 * @returns Path to the written instructions file
 */
export async function writeAiReviewInstructions(
  worktreePath: string,
  nodeId: string,
  executionLogs: string,
  taskDescription: string
): Promise<string> {
  const instructionsDir = path.join(worktreePath, '.github', 'instructions');
  await fs.promises.mkdir(instructionsDir, { recursive: true });
  
  const fileName = `orchestrator-ai-review-${nodeId}.instructions.md`;
  const instructionsPath = path.join(instructionsDir, fileName);
  
  const instructionsContent = `# AI Review: No-Change Assessment

## Task
You are reviewing the execution logs of an agent that completed without making file changes.
Determine if this is a legitimate outcome or if the agent failed to do its work.

## Original Task Description
${taskDescription}

## Execution Logs
\`\`\`
${executionLogs}
\`\`\`

## Your Response
**IMPORTANT: Respond ONLY with a JSON object. No markdown, no explanation, no HTML.**

Analyze the logs and respond with exactly this format:
\`\`\`json
{"legitimate": true, "reason": "Brief explanation why no changes were needed"}
\`\`\`
OR
\`\`\`json
{"legitimate": false, "reason": "Brief explanation of what went wrong"}
\`\`\`

### Legitimate No-Change Scenarios
- Work was already completed in a prior commit/dependency
- Task was verification/analysis only (no changes expected)
- Agent correctly determined no changes were needed

### NOT Legitimate (should return false)
- Agent encountered errors and gave up
- Agent misunderstood the task
- Agent claimed success without evidence
- Logs show the agent didn't attempt the work

**YOUR RESPONSE (JSON ONLY):**`;

  await fs.promises.writeFile(instructionsPath, instructionsContent, 'utf-8');
  return instructionsPath;
}