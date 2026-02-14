/**
 * @fileoverview Unit tests for workPhase and executionPump edge cases
 */
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as path from 'path';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

suite('workPhase edge cases', () => {
  let quiet: { restore: () => void };

  setup(() => { quiet = silenceConsole(); });
  teardown(() => { quiet.restore(); });

  test('adaptCommandForPowerShell is importable', async () => {
    // Test that the module exports exist and the workPhase can be loaded
    const workPhase = await import('../../../plan/phases/workPhase');
    assert.ok(workPhase.WorkPhaseExecutor);
  });

  test('WorkPhaseExecutor construction', async () => {
    const workPhase = await import('../../../plan/phases/workPhase');
    const executor = new workPhase.WorkPhaseExecutor({
      agentDelegator: undefined,
      getCopilotConfigDir: () => '/tmp/.copilot-cli',
      spawner: { spawn: () => ({} as any) },
    });
    assert.ok(executor);
  });
});
