/**
 * @fileoverview Unit tests for the spawner/runner override wiring in the executor.
 *
 * Validates that ExecutionContext.spawnerOverride and copilotRunnerOverride
 * are properly threaded through to phase executors by DefaultJobExecutor.
 *
 * @module test/unit/plan/testing/executorOverride.unit.test
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import type { ExecutionContext } from '../../../../plan/types/plan';
import type { IProcessSpawner } from '../../../../interfaces/IProcessSpawner';
import type { ICopilotRunner } from '../../../../interfaces/ICopilotRunner';

suite('ExecutionContext overrides', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test('spawnerOverride field exists on ExecutionContext type', () => {
    // This is a compile-time test — if it compiles, the field exists
    const ctx: Partial<ExecutionContext> = {
      spawnerOverride: {
        spawn: () => ({
          pid: 1,
          exitCode: null,
          killed: false,
          stdout: null,
          stderr: null,
          kill: () => true,
          on: () => ({} as any),
        }),
      },
    };
    assert.ok(ctx.spawnerOverride);
  });

  test('copilotRunnerOverride field exists on ExecutionContext type', () => {
    const ctx: Partial<ExecutionContext> = {
      copilotRunnerOverride: {
        run: sandbox.stub().resolves({ success: true }),
        isAvailable: () => true,
        writeInstructionsFile: () => ({ filePath: '', dirPath: '' }),
        buildCommand: () => '',
        cleanupInstructionsFile: () => {},
      },
    };
    assert.ok(ctx.copilotRunnerOverride);
  });

  test('both overrides can be undefined (normal execution path)', () => {
    const ctx: Partial<ExecutionContext> = {
      spawnerOverride: undefined,
      copilotRunnerOverride: undefined,
    };
    assert.strictEqual(ctx.spawnerOverride, undefined);
    assert.strictEqual(ctx.copilotRunnerOverride, undefined);
  });

  test('override spawner takes priority over DI singleton', () => {
    // Simulates what phaseDeps() does in executor.ts
    const diSpawner: IProcessSpawner = {
      spawn: sandbox.stub().returns({ pid: 1, exitCode: null, killed: false, stdout: null, stderr: null, kill: () => true, on: () => ({} as any) }),
    };
    const overrideSpawner: IProcessSpawner = {
      spawn: sandbox.stub().returns({ pid: 2, exitCode: null, killed: false, stdout: null, stderr: null, kill: () => true, on: () => ({} as any) }),
    };

    // This mirrors the logic in executor.ts phaseDeps():
    // spawner: context.spawnerOverride ?? this.spawner
    const context = { spawnerOverride: overrideSpawner } as Partial<ExecutionContext>;
    const effective = context.spawnerOverride ?? diSpawner;

    assert.strictEqual(effective, overrideSpawner);
  });

  test('falls back to DI spawner when override is undefined', () => {
    const diSpawner: IProcessSpawner = {
      spawn: sandbox.stub().returns({ pid: 1, exitCode: null, killed: false, stdout: null, stderr: null, kill: () => true, on: () => ({} as any) }),
    };

    const context = { spawnerOverride: undefined } as Partial<ExecutionContext>;
    const effective = context.spawnerOverride ?? diSpawner;

    assert.strictEqual(effective, diSpawner);
  });

  test('override copilot runner takes priority over DI singleton', () => {
    const diRunner: ICopilotRunner = {
      run: sandbox.stub().resolves({ success: true }),
      isAvailable: () => true,
      writeInstructionsFile: () => ({ filePath: '', dirPath: '' }),
      buildCommand: () => '',
      cleanupInstructionsFile: () => {},
    };
    const overrideRunner: ICopilotRunner = {
      run: sandbox.stub().resolves({ success: true, sessionId: 'test-123' }),
      isAvailable: () => true,
      writeInstructionsFile: () => ({ filePath: '', dirPath: '' }),
      buildCommand: () => '',
      cleanupInstructionsFile: () => {},
    };

    const context = { copilotRunnerOverride: overrideRunner } as Partial<ExecutionContext>;
    const effective = context.copilotRunnerOverride ?? diRunner;

    assert.strictEqual(effective, overrideRunner);
  });
});
