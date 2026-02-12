/**
 * @fileoverview Unit tests for log filtering functionality
 */

import * as assert from 'assert';
import * as sinon from 'sinon';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

/**
 * Format a log message for a specific phase and level, handling multi-line content.
 * Each line of a multi-line message gets tagged with the phase and level.
 */
function formatLogMessage(phase: string, level: string, message: string): string {
  const timestamp = new Date().toISOString();
  const phaseTag = `[${phase.toUpperCase()}]`;
  const levelTag = `[${level.toUpperCase()}]`;
  
  return message.split('\n').map(line => {
    return `[${timestamp}] ${phaseTag} ${levelTag} ${line}`;
  }).join('\n');
}

/**
 * Filter log content by execution phase.
 * Returns only log lines that match the specified phase.
 */
function filterLogsByPhase(logs: string, phase: string): string {
  const phaseTag = `[${phase.toUpperCase()}]`;
  
  return logs.split('\n')
    .filter(line => line.includes(phaseTag))
    .join('\n');
}

suite('Log Filtering', () => {
  let quiet: { restore: () => void };

  setup(() => {
    quiet = silenceConsole();
  });

  teardown(() => {
    quiet.restore();
    sinon.restore();
  });

  suite('Multi-line message handling', () => {
    test('should tag each line of a multi-line message with the phase', () => {
      const message = `# Task: Do Something

## Problem
This is a multi-line message.

## Solution
Fix it.`;
      
      const result = formatLogMessage('work', 'info', message);
      const lines = result.split('\n');
      
      // Every line should have the [WORK] tag
      for (const line of lines) {
        assert.ok(line.includes('[WORK]'), `Line should contain [WORK]: ${line}`);
        assert.ok(line.includes('[INFO]'), `Line should contain [INFO]: ${line}`);
      }
    });
    
    test('should preserve empty lines in multi-line messages', () => {
      const message = `Line 1

Line 3 after blank`;
      
      const result = formatLogMessage('postchecks', 'info', message);
      const lines = result.split('\n');
      
      assert.strictEqual(lines.length, 3);
      // Even the empty line should be tagged
      assert.ok(lines[1].includes('[POSTCHECKS]'), 'Empty line should be tagged with phase');
    });
  });
  
  suite('Phase filtering', () => {
    test('should include all lines of a multi-line message when filtering by phase', () => {
      const logs = `[2026-02-12T10:00:00Z] [WORK] [INFO] # Task Title
[2026-02-12T10:00:00Z] [WORK] [INFO] 
[2026-02-12T10:00:00Z] [WORK] [INFO] ## Details
[2026-02-12T10:00:00Z] [WORK] [INFO] Multi-line content
[2026-02-12T10:00:01Z] [COMMIT] [INFO] Committing changes`;
      
      const filtered = filterLogsByPhase(logs, 'work');
      const lines = filtered.split('\n').filter(l => l.trim());
      
      assert.strictEqual(lines.length, 4, 'Should have all 4 WORK lines');
      assert.ok(lines.every(l => l.includes('[WORK]')), 'All lines should contain [WORK]');
    });
    
    test('should not include lines from other phases', () => {
      const logs = `[2026-02-12T10:00:00Z] [PRECHECKS] [INFO] Running checks
[2026-02-12T10:00:01Z] [WORK] [INFO] Doing work
[2026-02-12T10:00:02Z] [POSTCHECKS] [INFO] Verifying`;
      
      const filtered = filterLogsByPhase(logs, 'work');
      
      assert.ok(filtered.includes('[WORK]'), 'Should contain WORK logs');
      assert.ok(!filtered.includes('[PRECHECKS]'), 'Should not contain PRECHECKS logs');
      assert.ok(!filtered.includes('[POSTCHECKS]'), 'Should not contain POSTCHECKS logs');
    });
  });
});