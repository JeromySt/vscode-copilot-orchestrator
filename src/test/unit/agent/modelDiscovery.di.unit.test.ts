/**
 * @fileoverview DI unit tests for modelDiscovery module
 *
 * Tests discovery, cache, classify, parse with mock spawner and injectable clock.
 */

import * as assert from 'assert';
import { EventEmitter } from 'events';
import {
  classifyModel,
  parseModelChoices,
  resetModelCache,
  discoverAvailableModels,
  getCachedModels,
  refreshModelCache,
  isValidModel,
  suggestModel,
  runCopilotHelp,
} from '../../../agent/modelDiscovery';
import type { ModelDiscoveryDeps } from '../../../agent/modelDiscovery';
import type { IProcessSpawner, ChildProcessLike } from '../../../interfaces/IProcessSpawner';

// ── Helpers ────────────────────────────────────────────────────────────

const HELP_OUTPUT_WITH_MODELS = `Usage: copilot [options]

Options:
  --model <model>  AI model to use (choices: "claude-sonnet-4.5", "gpt-5", "gpt-5-mini", "claude-opus-4.6", "gemini-3-pro-preview")
  --help           display help
`;

function createFakeProcess(stdout = '', exitCode = 0): ChildProcessLike & EventEmitter {
  const proc = new EventEmitter() as any;
  proc.pid = 1234;
  proc.exitCode = null;
  proc.killed = false;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => { proc.killed = true; return true; };

  // Auto-emit data and close after a tick
  setImmediate(() => {
    proc.stdout.emit('data', Buffer.from(stdout));
    proc.exitCode = exitCode;
    proc.emit('close', exitCode);
  });
  return proc;
}

function createMockSpawner(stdout = '', exitCode = 0): IProcessSpawner {
  return {
    spawn: () => createFakeProcess(stdout, exitCode),
  };
}

function createErrorSpawner(errorMessage: string): IProcessSpawner {
  return {
    spawn: () => {
      const proc = new EventEmitter() as any;
      proc.pid = undefined;
      proc.exitCode = null;
      proc.killed = false;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => true;
      setImmediate(() => proc.emit('error', new Error(errorMessage)));
      return proc;
    },
  };
}

function createNoopLogger(): import('../../../interfaces/ILogger').ILogger {
  return {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    isDebugEnabled: () => false, setLevel: () => {}, getLevel: () => 'info',
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

suite('Model Discovery DI', () => {
  setup(() => {
    resetModelCache();
  });

  teardown(() => {
    resetModelCache();
  });

  // ====================================================================
  // classifyModel (pure)
  // ====================================================================
  suite('classifyModel', () => {
    test('classifies Claude models', () => {
      const result = classifyModel('claude-sonnet-4.5');
      assert.strictEqual(result.vendor, 'anthropic');
      assert.strictEqual(result.family, 'claude');
      assert.strictEqual(result.tier, 'standard');
    });

    test('classifies Claude Opus as premium', () => {
      const result = classifyModel('claude-opus-4.6');
      assert.strictEqual(result.vendor, 'anthropic');
      assert.strictEqual(result.tier, 'premium');
    });

    test('classifies Claude Haiku as fast', () => {
      const result = classifyModel('claude-haiku-4.5');
      assert.strictEqual(result.vendor, 'anthropic');
      assert.strictEqual(result.tier, 'fast');
    });

    test('classifies GPT models', () => {
      const result = classifyModel('gpt-5');
      assert.strictEqual(result.vendor, 'openai');
      assert.strictEqual(result.family, 'gpt');
      assert.strictEqual(result.tier, 'standard');
    });

    test('classifies GPT mini as fast', () => {
      const result = classifyModel('gpt-5-mini');
      assert.strictEqual(result.vendor, 'openai');
      assert.strictEqual(result.tier, 'fast');
    });

    test('classifies GPT max as premium', () => {
      const result = classifyModel('gpt-5.1-codex-max');
      assert.strictEqual(result.vendor, 'openai');
      assert.strictEqual(result.tier, 'premium');
    });

    test('classifies Gemini models', () => {
      const result = classifyModel('gemini-3-pro-preview');
      assert.strictEqual(result.vendor, 'google');
      assert.strictEqual(result.family, 'gemini');
      assert.strictEqual(result.tier, 'standard');
    });

    test('classifies unknown vendor', () => {
      const result = classifyModel('some-custom-model');
      assert.strictEqual(result.vendor, 'unknown');
      assert.strictEqual(result.tier, 'standard');
    });
  });

  // ====================================================================
  // parseModelChoices (pure)
  // ====================================================================
  suite('parseModelChoices', () => {
    test('parses model choices from help output', () => {
      const choices = parseModelChoices(HELP_OUTPUT_WITH_MODELS);
      assert.deepStrictEqual(choices, [
        'claude-sonnet-4.5',
        'gpt-5',
        'gpt-5-mini',
        'claude-opus-4.6',
        'gemini-3-pro-preview',
      ]);
    });

    test('returns empty array when no models found', () => {
      const choices = parseModelChoices('some random output without models');
      assert.deepStrictEqual(choices, []);
    });

    test('returns empty for empty string', () => {
      const choices = parseModelChoices('');
      assert.deepStrictEqual(choices, []);
    });
  });

  // ====================================================================
  // runCopilotHelp with mock spawner
  // ====================================================================
  suite('runCopilotHelp', () => {
    test('returns stdout from spawned process', async () => {
      const spawner = createMockSpawner('hello from copilot');
      const result = await runCopilotHelp(spawner);
      assert.strictEqual(result, 'hello from copilot');
    });

    test('rejects on spawn error', async () => {
      const spawner = createErrorSpawner('command not found');
      try {
        await runCopilotHelp(spawner);
        assert.fail('Should have thrown');
      } catch (e: any) {
        assert.strictEqual(e.message, 'command not found');
      }
    });
  });

  // ====================================================================
  // discoverAvailableModels with DI
  // ====================================================================
  suite('discoverAvailableModels with DI', () => {
    test('discovers models from mock spawner', async () => {
      const deps: ModelDiscoveryDeps = {
        spawner: createMockSpawner(HELP_OUTPUT_WITH_MODELS),
        clock: () => 1000000,
        logger: createNoopLogger(),
      };
      const result = await discoverAvailableModels(deps);
      assert.strictEqual(result.models.length, 5);
      assert.ok(result.models.some(m => m.id === 'claude-sonnet-4.5'));
      assert.ok(result.models.some(m => m.id === 'gpt-5'));
      assert.strictEqual(result.discoveredAt, 1000000);
    });

    test('returns empty when no models in output', async () => {
      const warnings: string[] = [];
      const logger = createNoopLogger();
      logger.warn = (msg: string) => { warnings.push(msg); };
      const deps: ModelDiscoveryDeps = {
        spawner: createMockSpawner('no models here'),
        clock: () => 2000000,
        logger,
      };
      const result = await discoverAvailableModels(deps);
      assert.strictEqual(result.models.length, 0);
      assert.ok(warnings.some(w => w.includes('No model choices')));
    });

    test('returns empty on spawn error', async () => {
      const warnings: string[] = [];
      const logger = createNoopLogger();
      logger.warn = (msg: string) => { warnings.push(msg); };
      const deps: ModelDiscoveryDeps = {
        spawner: createErrorSpawner('ENOENT'),
        clock: () => 3000000,
        logger,
      };
      const result = await discoverAvailableModels(deps);
      assert.strictEqual(result.models.length, 0);
      assert.ok(warnings.some(w => w.includes('Failed to discover')));
    });

    test('failure cache prevents rapid re-discovery', async () => {
      let clockValue = 1000000;
      const deps: ModelDiscoveryDeps = {
        spawner: createErrorSpawner('fail'),
        clock: () => clockValue,
        logger: createNoopLogger(),
      };

      // First call fails
      await discoverAvailableModels(deps);

      // Second call within cache TTL should return immediately without spawning
      let spawnCalled = false;
      deps.spawner = {
        spawn: () => {
          spawnCalled = true;
          return createFakeProcess('', 0);
        },
      };

      clockValue = 1000001; // Only 1ms later
      const result2 = await discoverAvailableModels(deps);
      assert.strictEqual(result2.models.length, 0);
      assert.strictEqual(spawnCalled, false, 'Should not have spawned again within failure cache TTL');
    });

    test('failure cache expires after TTL', async () => {
      let clockValue = 1000000;
      const deps: ModelDiscoveryDeps = {
        spawner: createErrorSpawner('fail'),
        clock: () => clockValue,
        logger: createNoopLogger(),
      };

      await discoverAvailableModels(deps);

      // Advance past failure cache TTL (5 minutes)
      clockValue = 1000000 + 6 * 60 * 1000;
      deps.spawner = createMockSpawner(HELP_OUTPUT_WITH_MODELS);

      const result = await discoverAvailableModels(deps);
      assert.ok(result.models.length > 0, 'Should re-discover after failure cache expires');
    });
  });

  // ====================================================================
  // getCachedModels with DI
  // ====================================================================
  suite('getCachedModels with DI', () => {
    test('returns cached result on second call', async () => {
      let clockValue = 1000000;
      const deps: ModelDiscoveryDeps = {
        spawner: createMockSpawner(HELP_OUTPUT_WITH_MODELS),
        clock: () => clockValue,
        logger: createNoopLogger(),
      };

      const result1 = await getCachedModels(deps);
      assert.strictEqual(result1.discoveredAt, 1000000);

      // Advance clock slightly — within TTL
      clockValue = 1000000 + 1000;
      const result2 = await getCachedModels(deps);
      assert.strictEqual(result2.discoveredAt, 1000000, 'Should use cached result');
    });

    test('re-discovers when cache expires', async () => {
      let clockValue = 1000000;
      const deps: ModelDiscoveryDeps = {
        spawner: createMockSpawner(HELP_OUTPUT_WITH_MODELS),
        clock: () => clockValue,
        logger: createNoopLogger(),
      };

      await getCachedModels(deps);

      // Advance past cache TTL (1 hour)
      clockValue = 1000000 + 2 * 60 * 60 * 1000;
      const result = await getCachedModels(deps);
      assert.strictEqual(result.discoveredAt, clockValue);
    });
  });

  // ====================================================================
  // refreshModelCache with DI
  // ====================================================================
  suite('refreshModelCache', () => {
    test('clears cache and re-discovers', async () => {
      const deps: ModelDiscoveryDeps = {
        spawner: createMockSpawner(HELP_OUTPUT_WITH_MODELS),
        clock: () => 5000000,
        logger: createNoopLogger(),
      };

      // Seed cache
      await getCachedModels(deps);

      // Refresh with new clock
      deps.clock = () => 6000000;
      const result = await refreshModelCache(deps);
      assert.strictEqual(result.discoveredAt, 6000000);
    });
  });

  // ====================================================================
  // isValidModel with DI
  // ====================================================================
  suite('isValidModel', () => {
    test('returns true for discovered model', async () => {
      const deps: ModelDiscoveryDeps = {
        spawner: createMockSpawner(HELP_OUTPUT_WITH_MODELS),
        clock: () => 1000000,
        logger: createNoopLogger(),
      };
      const valid = await isValidModel('claude-sonnet-4.5', deps);
      assert.strictEqual(valid, true);
    });

    test('returns false for unknown model', async () => {
      const deps: ModelDiscoveryDeps = {
        spawner: createMockSpawner(HELP_OUTPUT_WITH_MODELS),
        clock: () => 1000000,
        logger: createNoopLogger(),
      };
      const valid = await isValidModel('nonexistent-model', deps);
      assert.strictEqual(valid, false);
    });
  });

  // ====================================================================
  // suggestModel with DI
  // ====================================================================
  suite('suggestModel', () => {
    test('suggests fast-tier model', async () => {
      const deps: ModelDiscoveryDeps = {
        spawner: createMockSpawner(HELP_OUTPUT_WITH_MODELS),
        clock: () => 1000000,
        logger: createNoopLogger(),
      };
      const model = await suggestModel('fast', deps);
      assert.ok(model);
      assert.strictEqual(model!.tier, 'fast');
      assert.strictEqual(model!.id, 'gpt-5-mini');
    });

    test('suggests premium-tier model', async () => {
      const deps: ModelDiscoveryDeps = {
        spawner: createMockSpawner(HELP_OUTPUT_WITH_MODELS),
        clock: () => 1000000,
        logger: createNoopLogger(),
      };
      const model = await suggestModel('premium', deps);
      assert.ok(model);
      assert.strictEqual(model!.tier, 'premium');
      assert.strictEqual(model!.id, 'claude-opus-4.6');
    });

    test('suggests standard-tier model', async () => {
      const deps: ModelDiscoveryDeps = {
        spawner: createMockSpawner(HELP_OUTPUT_WITH_MODELS),
        clock: () => 1000000,
        logger: createNoopLogger(),
      };
      const model = await suggestModel('standard', deps);
      assert.ok(model);
      assert.strictEqual(model!.tier, 'standard');
    });

    test('returns undefined when no models available', async () => {
      const deps: ModelDiscoveryDeps = {
        spawner: createErrorSpawner('fail'),
        clock: () => 1000000,
        logger: createNoopLogger(),
      };
      const model = await suggestModel('standard', deps);
      assert.strictEqual(model, undefined);
    });

    test('falls back to standard when requested tier not found', async () => {
      // Help output with only standard-tier models
      const helpOutput = `--model <model>  (choices: "claude-sonnet-4.5", "gpt-5")`;
      const deps: ModelDiscoveryDeps = {
        spawner: createMockSpawner(helpOutput),
        clock: () => 1000000,
        logger: createNoopLogger(),
      };
      const model = await suggestModel('premium', deps);
      assert.ok(model);
      assert.strictEqual(model!.tier, 'standard');
    });
  });

  // ====================================================================
  // resetModelCache
  // ====================================================================
  suite('resetModelCache', () => {
    test('can be called multiple times safely', () => {
      assert.doesNotThrow(() => {
        resetModelCache();
        resetModelCache();
      });
    });

    test('clears cached data so next call re-discovers', async () => {
      const deps: ModelDiscoveryDeps = {
        spawner: createMockSpawner(HELP_OUTPUT_WITH_MODELS),
        clock: () => 1000000,
        logger: createNoopLogger(),
      };
      await getCachedModels(deps);
      resetModelCache();

      deps.clock = () => 2000000;
      const result = await getCachedModels(deps);
      assert.strictEqual(result.discoveredAt, 2000000, 'Should re-discover after reset');
    });
  });
});
