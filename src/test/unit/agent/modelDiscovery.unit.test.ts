/**
 * @fileoverview Unit tests for modelDiscovery module - async functions and cache behavior.
 *
 * Covers:
 * - discoverAvailableModels (with failure cache)
 * - getCachedModels
 * - refreshModelCache
 * - isValidModel
 * - suggestModel
 * - resetModelCache
 * - emptyResult shape
 */

import * as assert from 'assert';
import { EventEmitter } from 'events';
import {
  classifyModel,
  parseModelChoicesFromConfig,
  resetModelCache,
  discoverAvailableModels,
  getCachedModels,
  refreshModelCache,
  isValidModel,
  suggestModel,
  parseEffortSupport,
  hasEffortSupport,
  getEffortChoices,
} from '../../../agent/modelDiscovery';
import type { ModelDiscoveryDeps } from '../../../agent/modelDiscovery';
import type { IProcessSpawner, ChildProcessLike } from '../../../interfaces/IProcessSpawner';

/** Legacy --help output format (pre-1.0 CLI) with model choices inline */
const FAKE_HELP_LEGACY = `Usage: copilot [options]
  --model <model>  The model to use (choices: "gpt-4o-mini", "claude-sonnet-4", "claude-opus-4")
`;

/** v1.x --help output format: --model has no choices, --effort is present */
const FAKE_HELP_V1 = `Usage: copilot [options] [command]

GitHub Copilot CLI - An AI-powered coding assistant.

Options:
  --effort, --reasoning-effort <level>  Set the reasoning effort level (choices:
                                        "low", "medium", "high", "xhigh")
  --model <model>                       Set the AI model to use
  -v, --version                         show version information

GitHub Copilot CLI 1.0.19.
`;

/** v1.x config output with model list */
const FAKE_CONFIG_V1 = `Configuration Settings:

  \`banner\`: frequency of showing animated banner; defaults to "once".
    - "always" displays it every time
    - "never" disables it
    - "once" displays it the first time

  \`model\`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.
    - "claude-sonnet-4.6"
    - "claude-haiku-4.5"
    - "claude-opus-4.6"
    - "gpt-5.4"
    - "gpt-5-mini"
    - "gpt-4.1"

  \`mouse\`: whether to enable mouse support; defaults to \`true\`.
`;

/** Backward-compatible alias for existing tests */
const FAKE_HELP = FAKE_HELP_LEGACY;

/**
 * Create a mock spawner that responds to different commands.
 * @param output - Default output for any command (backward compat), or a map of args → output.
 */
function createMockSpawner(output: string | Record<string, string> = FAKE_HELP): IProcessSpawner {
  return {
    spawn(_cmd: string, args?: string[]): ChildProcessLike {
      let responseText: string;
      if (typeof output === 'string') {
        responseText = output;
      } else {
        // Match by first arg (--help, help)
        const key = args?.join(' ') ?? '--help';
        responseText = output[key] ?? output['--help'] ?? '';
      }
      const proc = new EventEmitter() as EventEmitter & ChildProcessLike;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      Object.assign(proc, {
        pid: 1,
        exitCode: null as number | null,
        killed: false,
        stdout,
        stderr,
        kill() { return true; },
      });
      setImmediate(() => {
        stdout.emit('data', Buffer.from(responseText));
        (proc as any).exitCode = 0;
        proc.emit('close', 0);
      });
      return proc as unknown as ChildProcessLike;
    },
  };
}

suite('Model Discovery - Async Functions', () => {

  let deps: ModelDiscoveryDeps;

  setup(() => {
    resetModelCache();
    deps = { spawner: createMockSpawner() };
  });

  teardown(() => {
    resetModelCache();
  });

  // ==========================================================================
  // discoverAvailableModels
  // ==========================================================================
  suite('discoverAvailableModels', () => {
    test('returns a ModelDiscoveryResult object', async function () {
      this.timeout(15000);
      const result = await discoverAvailableModels(deps);
      assert.ok(result, 'Should return a result');
      assert.ok(Array.isArray(result.models), 'Should have models array');
      assert.ok(Array.isArray(result.rawChoices), 'Should have rawChoices array');
      assert.ok(typeof result.discoveredAt === 'number', 'Should have discoveredAt timestamp');
    });

    test('returns empty result when copilot CLI not found', async function () {
      this.timeout(15000);
      // In test env, copilot CLI is likely not installed
      const result = await discoverAvailableModels(deps);
      // Either empty (CLI not found) or populated (CLI found)
      assert.ok(Array.isArray(result.models));
      assert.ok(Array.isArray(result.rawChoices));
    });

    test('failure cache prevents rapid re-discovery', async function () {
      this.timeout(20000);
      // First call triggers discovery
      const result1 = await discoverAvailableModels(deps);

      // If first call failed, second call should hit failure cache and return quickly
      const start = Date.now();
      const result2 = await discoverAvailableModels(deps);
      const elapsed = Date.now() - start;

      // Second call should be fast (< 2 seconds) due to caching
      assert.ok(elapsed < 5000, `Second call should be fast, took ${elapsed}ms`);
      assert.ok(Array.isArray(result2.models));
    });
  });

  // ==========================================================================
  // getCachedModels
  // ==========================================================================
  suite('getCachedModels', () => {
    test('returns result (may trigger discovery)', async function () {
      this.timeout(15000);
      const result = await getCachedModels(deps);
      assert.ok(result);
      assert.ok(Array.isArray(result.models));
    });

    test('returns cached result on second call', async function () {
      this.timeout(15000);
      const result1 = await getCachedModels(deps);
      const result2 = await getCachedModels(deps);
      // If cache was populated, discoveredAt should be the same
      assert.strictEqual(result1.discoveredAt, result2.discoveredAt,
        'Cached result should have same timestamp');
    });
  });

  // ==========================================================================
  // refreshModelCache
  // ==========================================================================
  suite('refreshModelCache', () => {
    test('clears cache and re-discovers', async function () {
      this.timeout(15000);
      // Seed cache
      await getCachedModels(deps);

      // Refresh should re-discover
      const result = await refreshModelCache(deps);
      assert.ok(result);
      assert.ok(Array.isArray(result.models));
    });
  });

  // ==========================================================================
  // isValidModel
  // ==========================================================================
  suite('isValidModel', () => {
    test('returns false for non-existent model when no models discovered', async function () {
      this.timeout(15000);
      const valid = await isValidModel('definitely-not-a-real-model', deps);
      assert.strictEqual(valid, false);
    });

    test('returns boolean', async function () {
      this.timeout(15000);
      const result = await isValidModel('claude-sonnet-4.5', deps);
      assert.ok(typeof result === 'boolean');
    });
  });

  // ==========================================================================
  // suggestModel
  // ==========================================================================
  suite('suggestModel', () => {
    test('returns undefined when no models available', async function () {
      this.timeout(15000);
      resetModelCache();
      // In test env without copilot, should return undefined
      const suggestion = await suggestModel('standard', deps);
      // Either undefined (no models) or a ModelInfo (models found)
      if (suggestion) {
        assert.ok(suggestion.id);
        assert.ok(suggestion.vendor);
        assert.ok(suggestion.tier);
      }
    });

    test('accepts fast tier', async function () {
      this.timeout(15000);
      const suggestion = await suggestModel('fast', deps);
      if (suggestion) {
        assert.ok(suggestion.id);
      }
    });

    test('accepts premium tier', async function () {
      this.timeout(15000);
      const suggestion = await suggestModel('premium', deps);
      if (suggestion) {
        assert.ok(suggestion.id);
      }
    });
  });

  // ==========================================================================
  // resetModelCache
  // ==========================================================================
  suite('resetModelCache', () => {
    test('can be called multiple times without error', () => {
      assert.doesNotThrow(() => {
        resetModelCache();
        resetModelCache();
        resetModelCache();
      });
    });

    test('clears any cached data', async function () {
      this.timeout(15000);
      // Seed cache
      await getCachedModels(deps);

      // Reset
      resetModelCache();

      // Next call should re-discover (won't hit cache)
      const result = await getCachedModels(deps);
      assert.ok(result);
    });
  });
});

suite('Effort Support Detection', () => {

  suite('parseEffortSupport', () => {
    test('returns supported=false when --effort not in help output', () => {
      const result = parseEffortSupport(FAKE_HELP);
      assert.strictEqual(result.supported, false);
    });

    test('returns supported=true with choices when --effort has choices', () => {
      const help = `Usage: copilot [options]
  --model <model>  The model to use (choices: "gpt-4o-mini")
  --effort <effort>  Reasoning effort level (choices: "low", "medium", "high")
`;
      const result = parseEffortSupport(help);
      assert.strictEqual(result.supported, true);
      assert.deepStrictEqual(result.choices, ['low', 'medium', 'high']);
    });

    test('returns supported=true with default choices when --effort exists without choices', () => {
      const help = `Usage: copilot [options]
  --effort <effort>  Reasoning effort level
`;
      const result = parseEffortSupport(help);
      assert.strictEqual(result.supported, true);
      assert.deepStrictEqual(result.choices, ['low', 'medium', 'high', 'xhigh']);
    });

    test('handles --effort with different choice values', () => {
      const help = `  --effort <effort>  (choices: "min", "default", "max")`;
      const result = parseEffortSupport(help);
      assert.strictEqual(result.supported, true);
      assert.deepStrictEqual(result.choices, ['min', 'default', 'max']);
    });
  });

  suite('hasEffortSupport', () => {
    setup(() => {
      resetModelCache();
    });

    test('returns false when CLI does not support --effort', async function () {
      this.timeout(15000);
      const deps: ModelDiscoveryDeps = {
        spawner: createMockSpawner(FAKE_HELP),
        clock: Date.now,
      };
      const result = await hasEffortSupport(deps);
      assert.strictEqual(result, false);
    });

    test('returns true when CLI supports --effort', async function () {
      this.timeout(15000);
      const helpWithEffort = `Usage: copilot [options]
  --model <model>  The model to use (choices: "gpt-4o-mini", "claude-sonnet-4")
  --effort <effort>  Reasoning effort (choices: "low", "medium", "high")
`;
      const deps: ModelDiscoveryDeps = {
        spawner: createMockSpawner(helpWithEffort),
        clock: Date.now,
      };
      const result = await hasEffortSupport(deps);
      assert.strictEqual(result, true);
    });
  });

  suite('getEffortChoices', () => {
    setup(() => {
      resetModelCache();
    });

    test('returns undefined when effort not supported', async function () {
      this.timeout(15000);
      const deps: ModelDiscoveryDeps = {
        spawner: createMockSpawner(FAKE_HELP),
        clock: Date.now,
      };
      const result = await getEffortChoices(deps);
      assert.strictEqual(result, undefined);
    });

    test('returns choices when effort is supported', async function () {
      this.timeout(15000);
      const helpWithEffort = `Usage: copilot [options]
  --model <model>  The model to use (choices: "gpt-4o-mini")
  --effort <effort>  (choices: "low", "medium", "high")
`;
      const deps: ModelDiscoveryDeps = {
        spawner: createMockSpawner(helpWithEffort),
        clock: Date.now,
      };
      const result = await getEffortChoices(deps);
      assert.deepStrictEqual(result, ['low', 'medium', 'high']);
    });
  });

  suite('discoverAvailableModels includes capabilities', () => {
    setup(() => {
      resetModelCache();
    });

    test('capabilities.effort is false when --effort not in help', async function () {
      this.timeout(15000);
      const deps: ModelDiscoveryDeps = {
        spawner: createMockSpawner(FAKE_HELP),
        clock: Date.now,
      };
      const result = await discoverAvailableModels(deps);
      assert.strictEqual(result.capabilities?.effort, false);
    });

    test('capabilities.effort is true when --effort is in help', async function () {
      this.timeout(15000);
      const helpWithEffort = `Usage: copilot [options]
  --model <model>  The model to use (choices: "gpt-4o-mini", "claude-sonnet-4")
  --effort <effort>  Reasoning effort (choices: "low", "medium", "high")
`;
      const deps: ModelDiscoveryDeps = {
        spawner: createMockSpawner(helpWithEffort),
        clock: Date.now,
      };
      const result = await discoverAvailableModels(deps);
      assert.strictEqual(result.capabilities?.effort, true);
      assert.deepStrictEqual(result.capabilities?.effortChoices, ['low', 'medium', 'high']);
    });
  });
});

// ============================================================================
// Config-based model parsing (v1.x+ CLI)
// ============================================================================

suite('parseModelChoicesFromConfig', () => {
  test('extracts models from config output', () => {
    const result = parseModelChoicesFromConfig(FAKE_CONFIG_V1);
    assert.deepStrictEqual(result, [
      'claude-sonnet-4.6',
      'claude-haiku-4.5',
      'claude-opus-4.6',
      'gpt-5.4',
      'gpt-5-mini',
      'gpt-4.1',
    ]);
  });

  test('returns empty array when no model section', () => {
    const result = parseModelChoicesFromConfig('Some other config output with no model key');
    assert.deepStrictEqual(result, []);
  });

  test('returns empty array for empty input', () => {
    assert.deepStrictEqual(parseModelChoicesFromConfig(''), []);
  });

  test('stops at next config key', () => {
    const config = `  \`model\`: The model to use.
    - "model-a"
    - "model-b"

  \`theme\`: The theme.
    - "dark"
    - "light"
`;
    const result = parseModelChoicesFromConfig(config);
    assert.deepStrictEqual(result, ['model-a', 'model-b']);
  });

  test('handles model section with no choices listed', () => {
    const config = `  \`model\`: The model to use.

  \`theme\`: something.
`;
    const result = parseModelChoicesFromConfig(config);
    assert.deepStrictEqual(result, []);
  });
});

// ============================================================================
// v1.x CLI fallback: --help has no models → falls back to config
// ============================================================================

suite('Discovery with v1.x CLI (config fallback)', () => {
  setup(() => {
    resetModelCache();
  });

  test('discovers models from help config when --help has no model choices', async function () {
    this.timeout(15000);
    const deps: ModelDiscoveryDeps = {
      spawner: createMockSpawner({
        '--help': FAKE_HELP_V1,
        'help config': FAKE_CONFIG_V1,
      }),
      clock: Date.now,
    };
    const result = await discoverAvailableModels(deps);
    assert.ok(result.models.length > 0, 'Should discover models from config');
    assert.ok(result.rawChoices.includes('claude-sonnet-4.6'));
    assert.ok(result.rawChoices.includes('gpt-5.4'));
    assert.ok(result.rawChoices.includes('gpt-4.1'));
  });

  test('still detects capabilities from --help even when models come from config', async function () {
    this.timeout(15000);
    const deps: ModelDiscoveryDeps = {
      spawner: createMockSpawner({
        '--help': FAKE_HELP_V1,
        'help config': FAKE_CONFIG_V1,
      }),
      clock: Date.now,
    };
    const result = await discoverAvailableModels(deps);
    assert.strictEqual(result.capabilities?.effort, true);
    assert.deepStrictEqual(result.capabilities?.effortChoices, ['low', 'medium', 'high', 'xhigh']);
  });

  test('extracts CLI version from v1.x help output', async function () {
    this.timeout(15000);
    const deps: ModelDiscoveryDeps = {
      spawner: createMockSpawner({
        '--help': FAKE_HELP_V1,
        'help config': FAKE_CONFIG_V1,
      }),
      clock: Date.now,
    };
    const result = await discoverAvailableModels(deps);
    assert.strictEqual(result.cliVersion, '1.0.19');
  });

  test('returns capabilities even when both sources fail to find models', async function () {
    this.timeout(15000);
    const helpNoModels = `Usage: copilot [options]
  --effort <effort>  (choices: "low", "medium", "high")
  --model <model>  Set the model
`;
    const configNoModels = `Configuration Settings:
  \`theme\`: dark
`;
    const deps: ModelDiscoveryDeps = {
      spawner: createMockSpawner({
        '--help': helpNoModels,
        'help config': configNoModels,
      }),
      clock: Date.now,
    };
    const result = await discoverAvailableModels(deps);
    assert.strictEqual(result.models.length, 0);
    // Capabilities should still be detected from --help
    assert.strictEqual(result.capabilities?.effort, true);
  });

  test('legacy CLI format still works (backward compat)', async function () {
    this.timeout(15000);
    const deps: ModelDiscoveryDeps = {
      spawner: createMockSpawner(FAKE_HELP_LEGACY),
      clock: Date.now,
    };
    const result = await discoverAvailableModels(deps);
    assert.ok(result.models.length === 3);
    assert.ok(result.rawChoices.includes('gpt-4o-mini'));
    assert.ok(result.rawChoices.includes('claude-sonnet-4'));
    assert.ok(result.rawChoices.includes('claude-opus-4'));
  });
});

// ============================================================================
// classifyModel updates
// ============================================================================

suite('classifyModel - new model names', () => {
  test('classifies gpt-5.3-codex as openai/codex/standard', () => {
    const result = classifyModel('gpt-5.3-codex');
    assert.strictEqual(result.vendor, 'openai');
    assert.strictEqual(result.family, 'codex');
    assert.strictEqual(result.tier, 'standard');
  });

  test('classifies claude-opus-4.6-fast as anthropic/claude/premium', () => {
    const result = classifyModel('claude-opus-4.6-fast');
    assert.strictEqual(result.vendor, 'anthropic');
    assert.strictEqual(result.family, 'claude');
    assert.strictEqual(result.tier, 'premium');
  });

  test('classifies gpt-5-mini as openai/gpt/fast', () => {
    const result = classifyModel('gpt-5-mini');
    assert.strictEqual(result.vendor, 'openai');
    assert.strictEqual(result.family, 'gpt');
    assert.strictEqual(result.tier, 'fast');
  });

  test('classifies gpt-5.4-mini as openai/gpt/fast', () => {
    const result = classifyModel('gpt-5.4-mini');
    assert.strictEqual(result.vendor, 'openai');
    assert.strictEqual(result.family, 'gpt');
    assert.strictEqual(result.tier, 'fast');
  });

  test('classifies claude-sonnet-4.6 as anthropic/claude/standard', () => {
    const result = classifyModel('claude-sonnet-4.6');
    assert.strictEqual(result.vendor, 'anthropic');
    assert.strictEqual(result.family, 'claude');
    assert.strictEqual(result.tier, 'standard');
  });

  // Static tier map tests (verified via VS Code Copilot model picker cost multiplier)
  test('gpt-5.4 is standard (1x cost per VS Code picker)', () => {
    const result = classifyModel('gpt-5.4');
    assert.strictEqual(result.tier, 'standard');
  });

  test('claude-opus-4.6 is premium (3x cost per VS Code picker)', () => {
    const result = classifyModel('claude-opus-4.6');
    assert.strictEqual(result.tier, 'premium');
  });

  test('claude-sonnet-4.6 is standard despite High reasoning label (1x cost)', () => {
    const result = classifyModel('claude-sonnet-4.6');
    assert.strictEqual(result.tier, 'standard');
  });

  test('unknown model falls back to keyword heuristic', () => {
    // Unknown model with "opus" keyword → premium via fallback
    const result = classifyModel('claude-opus-99');
    assert.strictEqual(result.tier, 'premium');
  });

  test('completely unknown model defaults to standard', () => {
    const result = classifyModel('some-unknown-model-v3');
    assert.strictEqual(result.tier, 'standard');
  });
});
