/**
 * @fileoverview Tests for modelDiscovery (src/agent/modelDiscovery.ts).
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import {
  classifyModel,
  parseModelChoices,
  discoverAvailableModels,
  getCachedModels,
  refreshModelCache,
  isValidModel,
  suggestModel,
  resetModelCache,
} from '../../../agent/modelDiscovery';
import type { ModelDiscoveryDeps } from '../../../agent/modelDiscovery';
import type { IProcessSpawner, ChildProcessLike } from '../../../interfaces/IProcessSpawner';
import { EventEmitter } from 'events';

function silenceConsole() {
  sinon.stub(console, 'error');
  sinon.stub(console, 'warn');
}

// Helper: create a mock spawner whose spawn() emits stdout then closes
function createMockSpawner(exitCode: number, stdout = ''): IProcessSpawner {
  return {
    spawn(): ChildProcessLike {
      const proc = new EventEmitter() as EventEmitter & ChildProcessLike;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      Object.assign(proc, {
        pid: 1,
        exitCode: null as number | null,
        killed: false,
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
        kill() { return true; },
      });
      setTimeout(() => {
        if (stdout) {
          stdoutEmitter.emit('data', Buffer.from(stdout));
        }
        (proc as any).exitCode = exitCode;
        proc.emit('close', exitCode);
      }, 5);
      return proc as unknown as ChildProcessLike;
    },
  };
}

// Helper: create a mock spawner whose spawn() emits an error
function createErrorSpawner(): IProcessSpawner {
  return {
    spawn(): ChildProcessLike {
      const proc = new EventEmitter() as EventEmitter & ChildProcessLike;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      Object.assign(proc, {
        pid: 1,
        exitCode: null as number | null,
        killed: false,
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
        kill() { return true; },
      });
      setTimeout(() => proc.emit('error', new Error('not found')), 5);
      return proc as unknown as ChildProcessLike;
    },
  };
}

suite('modelDiscovery', () => {
  let deps: ModelDiscoveryDeps;

  setup(() => {
    silenceConsole();
    resetModelCache();
    deps = { spawner: createMockSpawner(0, '') };
  });

  teardown(() => {
    sinon.restore();
    resetModelCache();
  });

  const HELP_OUTPUT = `Usage: copilot [options]

Options:
  -p, --prompt <prompt>  The prompt to send
  --model <model>  Set the AI model to use (choices: "claude-sonnet-4.5", "gpt-5", "gemini-2.0-flash", "gpt-4.1-mini", "claude-haiku-4.5", "claude-opus-4.5")
  --stream <mode>  Stream mode (choices: "on", "off")
  -h, --help       Display help
`;

  // =========================================================================
  // classifyModel
  // =========================================================================

  suite('classifyModel', () => {
    test('classifies claude models as anthropic', () => {
      const result = classifyModel('claude-sonnet-4.5');
      assert.strictEqual(result.vendor, 'anthropic');
      assert.strictEqual(result.family, 'claude');
      assert.strictEqual(result.tier, 'standard');
    });

    test('classifies gpt models as openai', () => {
      const result = classifyModel('gpt-5');
      assert.strictEqual(result.vendor, 'openai');
      assert.strictEqual(result.family, 'gpt');
      assert.strictEqual(result.tier, 'standard');
    });

    test('classifies gemini models as google', () => {
      const result = classifyModel('gemini-2.0-flash');
      assert.strictEqual(result.vendor, 'google');
      assert.strictEqual(result.family, 'gemini');
      assert.strictEqual(result.tier, 'standard');
    });

    test('classifies unknown vendor', () => {
      const result = classifyModel('llama-3');
      assert.strictEqual(result.vendor, 'unknown');
      assert.strictEqual(result.family, 'llama-3');
      assert.strictEqual(result.tier, 'standard');
    });

    test('classifies mini as fast tier', () => {
      const result = classifyModel('gpt-4.1-mini');
      assert.strictEqual(result.tier, 'fast');
    });

    test('classifies haiku as fast tier', () => {
      const result = classifyModel('claude-haiku-4.5');
      assert.strictEqual(result.tier, 'fast');
    });

    test('classifies opus as premium tier', () => {
      const result = classifyModel('claude-opus-4.5');
      assert.strictEqual(result.tier, 'premium');
    });

    test('classifies max as premium tier', () => {
      const result = classifyModel('gpt-5.1-codex-max');
      assert.strictEqual(result.tier, 'premium');
    });
  });

  // =========================================================================
  // parseModelChoices
  // =========================================================================

  suite('parseModelChoices', () => {
    test('parses model choices from help output', () => {
      const choices = parseModelChoices(HELP_OUTPUT);
      assert.deepStrictEqual(choices, [
        'claude-sonnet-4.5',
        'gpt-5',
        'gemini-2.0-flash',
        'gpt-4.1-mini',
        'claude-haiku-4.5',
        'claude-opus-4.5',
      ]);
    });

    test('returns empty array when no model choices found', () => {
      const choices = parseModelChoices('some random output');
      assert.deepStrictEqual(choices, []);
    });

    test('returns empty array for empty string', () => {
      const choices = parseModelChoices('');
      assert.deepStrictEqual(choices, []);
    });
  });

  // =========================================================================
  // discoverAvailableModels
  // =========================================================================

  suite('discoverAvailableModels', () => {
    test('discovers models from copilot --help', async () => {
      deps = { spawner: createMockSpawner(0, HELP_OUTPUT) };

      const result = await discoverAvailableModels(deps);
      assert.strictEqual(result.models.length, 6);
      assert.strictEqual(result.rawChoices.length, 6);
      assert.ok(result.discoveredAt > 0);
      assert.strictEqual(result.models[0].id, 'claude-sonnet-4.5');
      assert.strictEqual(result.models[0].vendor, 'anthropic');
    });

    test('returns empty result on spawn error', async () => {
      deps = { spawner: createErrorSpawner() };

      const result = await discoverAvailableModels(deps);
      assert.strictEqual(result.models.length, 0);
      assert.strictEqual(result.rawChoices.length, 0);
    });

    test('returns empty result when no choices in output', async () => {
      deps = { spawner: createMockSpawner(0, 'no model info here') };

      const result = await discoverAvailableModels(deps);
      assert.strictEqual(result.models.length, 0);
    });

    test('caches failure for 5 minutes', async () => {
      deps = { spawner: createErrorSpawner() };

      const result1 = await discoverAvailableModels(deps);
      assert.strictEqual(result1.models.length, 0);

      // Second call should not spawn again (failure cached)
      deps = { spawner: createMockSpawner(0, HELP_OUTPUT) };
      const result2 = await discoverAvailableModels(deps);
      assert.strictEqual(result2.models.length, 0);
    });
  });

  // =========================================================================
  // getCachedModels
  // =========================================================================

  suite('getCachedModels', () => {
    test('returns cached result if fresh', async () => {
      deps = { spawner: createMockSpawner(0, HELP_OUTPUT) };

      const first = await getCachedModels(deps);
      assert.strictEqual(first.models.length, 6);

      // Change the spawner to return nothing - should still get cached result
      deps = { spawner: createMockSpawner(0, 'nothing') };
      const second = await getCachedModels(deps);
      assert.strictEqual(second.models.length, 6);
      assert.strictEqual(second.discoveredAt, first.discoveredAt);
    });
  });

  // =========================================================================
  // refreshModelCache
  // =========================================================================

  suite('refreshModelCache', () => {
    test('forces re-discovery', async () => {
      deps = { spawner: createMockSpawner(0, HELP_OUTPUT) };
      const first = await getCachedModels(deps);
      assert.strictEqual(first.models.length, 6);

      // Change output
      const newHelp = '--model <model>  Set the AI model to use (choices: "gpt-5")';
      deps = { spawner: createMockSpawner(0, newHelp) };
      const refreshed = await refreshModelCache(deps);
      assert.strictEqual(refreshed.models.length, 1);
      assert.strictEqual(refreshed.models[0].id, 'gpt-5');
    });
  });

  // =========================================================================
  // isValidModel
  // =========================================================================

  suite('isValidModel', () => {
    test('returns true for a known model', async () => {
      deps = { spawner: createMockSpawner(0, HELP_OUTPUT) };
      assert.strictEqual(await isValidModel('gpt-5', deps), true);
    });

    test('returns false for an unknown model', async () => {
      deps = { spawner: createMockSpawner(0, HELP_OUTPUT) };
      assert.strictEqual(await isValidModel('unknown-model', deps), false);
    });
  });

  // =========================================================================
  // suggestModel
  // =========================================================================

  suite('suggestModel', () => {
    test('suggests fast model for fast task', async () => {
      deps = { spawner: createMockSpawner(0, HELP_OUTPUT) };
      const model = await suggestModel('fast', deps);
      assert.ok(model);
      assert.strictEqual(model!.tier, 'fast');
    });

    test('suggests premium model for premium task', async () => {
      deps = { spawner: createMockSpawner(0, HELP_OUTPUT) };
      const model = await suggestModel('premium', deps);
      assert.ok(model);
      assert.strictEqual(model!.tier, 'premium');
    });

    test('suggests standard model for standard task', async () => {
      deps = { spawner: createMockSpawner(0, HELP_OUTPUT) };
      const model = await suggestModel('standard', deps);
      assert.ok(model);
      assert.strictEqual(model!.tier, 'standard');
    });

    test('falls back to standard if no matching tier', async () => {
      const limitedHelp = '--model <model>  Set the AI model to use (choices: "gpt-5")';
      deps = { spawner: createMockSpawner(0, limitedHelp) };
      const model = await suggestModel('fast', deps);
      assert.ok(model);
      assert.strictEqual(model!.id, 'gpt-5');
    });

    test('returns undefined when no models available', async () => {
      deps = { spawner: createErrorSpawner() };
      const model = await suggestModel('standard', deps);
      assert.strictEqual(model, undefined);
    });
  });
});
