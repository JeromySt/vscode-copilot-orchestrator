/**
 * @fileoverview Unit tests for processScripts — script catalog functions.
 *
 * Validates that the example script functions produce well-formed ProcessScript
 * objects with correct handler trigger patterns and non-empty output.
 *
 * @module test/unit/plan/testing/processScripts.unit.test
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import {
  sessionIdLines,
  statsLines,
  taskCompleteLines,
  contextPressureLogLines,
  successfulAgentScript,
  successfulShellScript,
  failingShellScript,
  failThenSucceedScripts,
  alwaysFailsScript,
  noChangesScript,
  failingPostcheckScript,
  passingPostcheckScript,
  gitSuccessScript,
} from '../../../../plan/testing/processScripts';

suite('processScripts', () => {
  suite('sessionIdLines', () => {
    test('contains a UUID pattern', () => {
      const lines = sessionIdLines();
      assert.ok(lines.length > 0);
      assert.ok(lines[0].text.match(/[a-f0-9-]{36}/));
    });

    test('uses custom session ID', () => {
      const customId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const lines = sessionIdLines(customId);
      assert.ok(lines[0].text.includes(customId));
    });
  });

  suite('statsLines', () => {
    test('contains premium requests pattern', () => {
      const lines = statsLines();
      const premiumLine = lines.find(l => l.text.includes('Premium request'));
      assert.ok(premiumLine, 'Missing premium requests line');
    });

    test('contains API time pattern', () => {
      const lines = statsLines();
      const apiTimeLine = lines.find(l => l.text.includes('API time spent'));
      assert.ok(apiTimeLine);
    });

    test('contains code changes pattern', () => {
      const lines = statsLines();
      const changeLine = lines.find(l => l.text.includes('Total code changes'));
      assert.ok(changeLine);
    });

    test('contains model breakdown header', () => {
      const lines = statsLines();
      const headerLine = lines.find(l => l.text.includes('Breakdown by AI model'));
      assert.ok(headerLine);
    });

    test('contains model lines with token counts', () => {
      const lines = statsLines();
      const modelLines = lines.filter(l => l.text.includes(' in,') && l.text.includes(' out'));
      assert.ok(modelLines.length >= 2, `Expected at least 2 model lines, got ${modelLines.length}`);
    });

    test('accepts custom options', () => {
      const lines = statsLines({ premiumRequests: 5, linesAdded: 1000, linesRemoved: 500 });
      const premiumLine = lines.find(l => l.text.includes('5 Premium'));
      assert.ok(premiumLine);
      const changeLine = lines.find(l => l.text.includes('+1000') && l.text.includes('-500'));
      assert.ok(changeLine);
    });
  });

  suite('taskCompleteLines', () => {
    test('contains Task complete text', () => {
      const lines = taskCompleteLines();
      assert.strictEqual(lines.length, 1);
      assert.ok(lines[0].text.includes('Task complete'));
    });
  });

  suite('contextPressureLogLines', () => {
    test('normal level has model limits and low token counts', () => {
      const lines = contextPressureLogLines('normal');
      assert.ok(lines.length >= 2);
      assert.ok(lines[0].text.includes('max_prompt_tokens'));
    });

    test('elevated level has more entries than normal', () => {
      const normalLines = contextPressureLogLines('normal');
      const elevatedLines = contextPressureLogLines('elevated');
      assert.ok(elevatedLines.length > normalLines.length);
    });

    test('critical level includes compaction event', () => {
      const lines = contextPressureLogLines('critical');
      const compactionLine = lines.find(l => l.text.includes('truncateBasedOn'));
      assert.ok(compactionLine, 'Critical pressure should include compaction event');
    });
  });

  suite('successfulAgentScript', () => {
    test('returns a complete script with exit code 0', () => {
      const script = successfulAgentScript('test', { command: 'copilot' });
      assert.strictEqual(script.exitCode, 0);
      assert.ok(script.stdout.length > 0);
      assert.strictEqual(script.label, 'test');
    });

    test('includes session ID, stats, and task complete lines', () => {
      const script = successfulAgentScript('test', { command: 'copilot' });
      const allText = script.stdout.map(l => l.text).join('\n');
      assert.ok(allText.includes('session'), 'Should include session ID');
      assert.ok(allText.includes('Premium request'), 'Should include stats');
      assert.ok(allText.includes('Task complete'), 'Should include task complete');
    });
  });

  suite('successfulShellScript', () => {
    test('returns exit code 0', () => {
      const script = successfulShellScript('test', { command: 'npm' });
      assert.strictEqual(script.exitCode, 0);
    });

    test('uses custom output lines', () => {
      const script = successfulShellScript('test', { command: 'npm' }, ['line1', 'line2']);
      assert.strictEqual(script.stdout.length, 2);
      assert.strictEqual(script.stdout[0].text, 'line1');
    });
  });

  suite('failingShellScript', () => {
    test('returns exit code 1', () => {
      const script = failingShellScript('test', { command: 'npm' });
      assert.strictEqual(script.exitCode, 1);
    });

    test('has stderr content', () => {
      const script = failingShellScript('test', { command: 'npm' });
      assert.ok(script.stderr);
      assert.ok(script.stderr!.length > 0);
    });
  });

  suite('failThenSucceedScripts', () => {
    test('returns two scripts', () => {
      const scripts = failThenSucceedScripts('test', { command: 'copilot' });
      assert.strictEqual(scripts.length, 2);
    });

    test('first script fails and is consumeOnce', () => {
      const scripts = failThenSucceedScripts('test', { command: 'copilot' });
      assert.strictEqual(scripts[0].exitCode, 1);
      assert.strictEqual(scripts[0].consumeOnce, true);
    });

    test('second script succeeds', () => {
      const scripts = failThenSucceedScripts('test', { command: 'copilot' });
      assert.strictEqual(scripts[1].exitCode, 0);
    });
  });

  suite('alwaysFailsScript', () => {
    test('returns exit code 1', () => {
      const script = alwaysFailsScript('test', { command: 'fail' });
      assert.strictEqual(script.exitCode, 1);
    });
  });

  suite('noChangesScript', () => {
    test('returns exit code 0 with zero line changes', () => {
      const script = noChangesScript('test', { command: 'review' });
      assert.strictEqual(script.exitCode, 0);
      const allText = script.stdout.map(l => l.text).join('\n');
      assert.ok(allText.includes('+0'), 'Should report 0 lines added');
    });
  });

  suite('failingPostcheckScript', () => {
    test('returns exit code 1 with test failure info', () => {
      const script = failingPostcheckScript('test', { command: 'npm' });
      assert.strictEqual(script.exitCode, 1);
      const allText = script.stdout.map(l => l.text).join('\n');
      assert.ok(allText.includes('failing'));
    });
  });

  suite('passingPostcheckScript', () => {
    test('returns exit code 0', () => {
      const script = passingPostcheckScript('test', { command: 'npm' });
      assert.strictEqual(script.exitCode, 0);
    });
  });

  suite('gitSuccessScript', () => {
    test('returns exit code 0', () => {
      const script = gitSuccessScript('git', { command: 'git' });
      assert.strictEqual(script.exitCode, 0);
    });
  });
});
