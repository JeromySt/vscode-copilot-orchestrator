/**
 * @fileoverview Review Finding Parser
 *
 * Parses AI code review output into structured ReviewFinding objects.
 * Supports both delimited JSON format and heuristic pattern matching.
 *
 * @module plan/reviewFindingParser
 */

import { randomUUID } from 'crypto';
import type { ReviewFinding, ReviewFindingSeverity } from './types/release';

/**
 * Parse review findings from Copilot CLI output.
 * Looks for a JSON array between <!-- FINDINGS_START --> and <!-- FINDINGS_END --> markers.
 * Falls back to heuristic parsing if no markers found.
 *
 * @param output - Raw output from Copilot CLI
 * @returns Array of parsed review findings
 */
export function parseReviewFindings(output: string): ReviewFinding[] {
  // Try to extract findings from delimited JSON block
  const startMarker = '<!-- FINDINGS_START -->';
  const endMarker = '<!-- FINDINGS_END -->';
  
  const startIndex = output.indexOf(startMarker);
  const endIndex = output.indexOf(endMarker);
  
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const jsonBlock = output.substring(startIndex + startMarker.length, endIndex).trim();
    
    // The JSON may be split across multiple lines with interleaved CLI output.
    // Strategy: find the JSON array within the block by locating the outermost [ ... ]
    const arrayStart = jsonBlock.indexOf('[');
    const arrayEnd = jsonBlock.lastIndexOf(']');
    
    if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
      const jsonCandidate = jsonBlock.substring(arrayStart, arrayEnd + 1);
      
      try {
        const rawFindings = JSON.parse(jsonCandidate);
        
        if (Array.isArray(rawFindings)) {
          return rawFindings.map((raw) => ({
            id: randomUUID(),
            severity: raw.severity || 'info',
            title: raw.title || 'Untitled finding',
            description: raw.description || '',
            filePath: raw.filePath,
            line: raw.line,
            endLine: raw.endLine,
            category: raw.category,
            status: 'open' as const,
            createdAt: Date.now(),
          }));
        }
      } catch {
        // JSON parsing failed — try cleaning up the content
        // Remove common noise: lines starting with ● (tool calls), └, $, etc.
        const cleanedLines = jsonCandidate.split('\n')
          .filter(line => {
            const trimmed = line.trim();
            return trimmed.length > 0 &&
              !trimmed.startsWith('●') &&
              !trimmed.startsWith('└') &&
              !trimmed.startsWith('$') &&
              !trimmed.startsWith('CWD:') &&
              !trimmed.startsWith('Spawning:') &&
              !trimmed.startsWith('Environment');
          })
          .join(' ');
        
        try {
          // Find the [ ... ] in cleaned text
          const cleanStart = cleanedLines.indexOf('[');
          const cleanEnd = cleanedLines.lastIndexOf(']');
          if (cleanStart !== -1 && cleanEnd !== -1) {
            const rawFindings = JSON.parse(cleanedLines.substring(cleanStart, cleanEnd + 1));
            if (Array.isArray(rawFindings)) {
              return rawFindings.map((raw) => ({
                id: randomUUID(),
                severity: raw.severity || 'info',
                title: raw.title || 'Untitled finding',
                description: raw.description || '',
                filePath: raw.filePath,
                line: raw.line,
                endLine: raw.endLine,
                category: raw.category,
                status: 'open' as const,
                createdAt: Date.now(),
              }));
            }
          }
        } catch {
          // Still failed, fall through to heuristic
        }
      }
    }
  }
  
  // Fall back to heuristic parsing
  return parseReviewFindingsHeuristic(output);
}

/**
 * Heuristic parser that attempts to extract findings from unstructured review output.
 * Looks for patterns like:
 * - "**WARNING**: description (file.ts:42)"
 * - "- [error] description in `file.ts` line 42"
 * - Markdown bullet lists with severity indicators
 *
 * @param output - Raw output text
 * @returns Array of parsed review findings
 */
export function parseReviewFindingsHeuristic(output: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const lines = output.split('\n');
  
  // Pattern 1: **SEVERITY**: description (file.ts:42)
  const pattern1 = /^\*\*\s*(ERROR|WARNING|INFO|SUGGESTION)\s*\*\*\s*:?\s*(.+?)(?:\s*\(([^:]+):(\d+)\))?$/i;
  
  // Pattern 2: - [severity] description in `file.ts` line 42
  const pattern2 = /^[-*]\s*\[(error|warning|info|suggestion)\]\s*(.+?)(?:\s+in\s+`([^`]+)`\s+line\s+(\d+))?$/i;
  
  // Pattern 3: ERROR: description (file.ts:42)
  const pattern3 = /^(ERROR|WARNING|INFO|SUGGESTION)\s*:?\s*(.+?)(?:\s*\(([^:]+):(\d+)\))?$/i;
  
  // Pattern 4: Category tag like [security], [performance]
  const categoryPattern = /\[([a-z]+)\]/i;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    if (!line) {
      continue;
    }
    
    let match = line.match(pattern1) || line.match(pattern2) || line.match(pattern3);
    
    if (match) {
      const severity = match[1].toLowerCase() as ReviewFindingSeverity;
      let description = match[2].trim();
      const filePath = match[3];
      const lineNum = match[4] ? parseInt(match[4], 10) : undefined;
      
      // Extract category if present
      let category: string | undefined;
      const categoryMatch = description.match(categoryPattern);
      if (categoryMatch) {
        category = categoryMatch[1].toLowerCase();
        description = description.replace(categoryPattern, '').trim();
      }
      
      // Look ahead for additional description lines (non-pattern lines)
      let fullDescription = description;
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j].trim();
        if (!nextLine || pattern1.test(nextLine) || pattern2.test(nextLine) || pattern3.test(nextLine)) {
          break;
        }
        fullDescription += ' ' + nextLine;
        j++;
      }
      
      // Extract title from description (first sentence or first 80 chars)
      const sentenceEnd = fullDescription.match(/[.!?]\s/);
      const title = sentenceEnd 
        ? fullDescription.substring(0, sentenceEnd.index! + 1).trim()
        : fullDescription.substring(0, 80).trim() + (fullDescription.length > 80 ? '...' : '');
      
      findings.push({
        id: randomUUID(),
        severity,
        title,
        description: fullDescription,
        filePath,
        line: lineNum,
        category,
        status: 'open',
        createdAt: Date.now(),
      });
      
      i = j - 1; // Skip the lines we consumed
    }
  }
  
  return findings;
}
