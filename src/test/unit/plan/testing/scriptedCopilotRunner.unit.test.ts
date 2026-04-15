/**
 * @fileoverview Unit tests for ScriptedCopilotRunner.
 *
 * Validates that the scripted runner delegates to the scripted spawner,
 * extracts session IDs from stdout, and returns correct CopilotRunResult shapes.
 *
 * @module test/unit/plan/testing/scriptedCopilotRunner.unit.test
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { ScriptedCopilotRunner } from '../../../../plan/testing/scriptedCopilotRunner';
import { ScriptedProcessSpawner } from '../../../../plan/testing/scriptedProcessSpawner';
import { successfulAgentScript, alwaysFailsScript } from '../../../../plan/testing/processScripts';

suite('ScriptedCopilotRunner', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test('isAvailable returns true', () => {
    const spawner = new ScriptedProcessSpawner();
    const runner = new ScriptedCopilotRunner(spawner);
    assert.strictEqual(runner.isAvailable(), true);
  });

  test('run returns success for matching script with exit 0', async () => {
    const spawner = new ScriptedProcessSpawner();
    spawner.addScript(successfulAgentScript('test-agent', { cwdContain: 'test-job' }));

    const runner = new ScriptedCopilotRunner(spawner);
    const result = await runner.run({
      cwd: '/worktrees/test-job',
      task: 'Test task',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.exitCode, 0);
  });

  test('run extracts session ID from stdout', async () => {
    const spawner = new ScriptedProcessSpawner();
    spawner.addScript(successfulAgentScript('session-test', { cwdContain: 'session-job' }));

    const runner = new ScriptedCopilotRunner(spawner);
    const result = await runner.run({
      cwd: '/worktrees/session-job',
      task: 'Extract session',
    });

    assert.ok(result.sessionId, 'Should extract session ID from stdout');
    assert.match(result.sessionId!, /^[a-f0-9-]{36}$/);
  });

  test('run returns failure for failing script', async () => {
    const spawner = new ScriptedProcessSpawner();
    spawner.addScript(alwaysFailsScript('fail-agent', { cwdContain: 'fail-job' }));

    const runner = new ScriptedCopilotRunner(spawner);
    const result = await runner.run({
      cwd: '/worktrees/fail-job',
      task: 'Will fail',
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.error);
  });

  test('run invokes onOutput callback for each line', async () => {
    const spawner = new ScriptedProcessSpawner();
    spawner.addScript(successfulAgentScript('callback-test', { cwdContain: 'cb-job' }));

    const runner = new ScriptedCopilotRunner(spawner);
    const outputLines: string[] = [];

    await runner.run({
      cwd: '/worktrees/cb-job',
      task: 'Test callbacks',
      onOutput: (line) => outputLines.push(line),
    });

    assert.ok(outputLines.length > 0, 'Should have received output lines');
    assert.ok(outputLines.some(l => l.includes('Task complete')));
  });

  test('run invokes onProcess callback', async () => {
    const spawner = new ScriptedProcessSpawner();
    spawner.addScript(successfulAgentScript('process-cb', { cwdContain: 'proc-job' }));

    const runner = new ScriptedCopilotRunner(spawner);
    let processReceived = false;

    await runner.run({
      cwd: '/worktrees/proc-job',
      task: 'Test process callback',
      onProcess: () => { processReceived = true; },
    });

    assert.strictEqual(processReceived, true);
  });

  test('run defaults to exit 0 for unmatched spawns', async () => {
    const spawner = new ScriptedProcessSpawner();
    const runner = new ScriptedCopilotRunner(spawner);

    const result = await runner.run({
      cwd: '/worktrees/unmatched-job',
      task: 'No matching script',
    });

    // Default exit code is 0, treated as success
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.exitCode, 0);
  });

  test('writeInstructionsFile returns dummy paths', () => {
    const spawner = new ScriptedProcessSpawner();
    const runner = new ScriptedCopilotRunner(spawner);
    const result = runner.writeInstructionsFile('/tmp', 'task', undefined, 'label');
    assert.ok(result.filePath);
    assert.ok(result.dirPath);
  });

  test('buildCommand returns a command string', () => {
    const spawner = new ScriptedProcessSpawner();
    const runner = new ScriptedCopilotRunner(spawner);
    const cmd = runner.buildCommand({ task: 'do something' });
    assert.ok(cmd.includes('copilot'));
    assert.ok(cmd.includes('do something'));
  });
});
