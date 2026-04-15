/**
 * @fileoverview Model Discovery Module
 * 
 * Dynamically discovers available models from `copilot --help` output.
 * Provides caching, validation, and model suggestion capabilities.
 * 
 * @module agent/modelDiscovery
 */

import type { IProcessSpawner } from '../interfaces/IProcessSpawner';
import { DefaultProcessSpawner } from '../interfaces/IProcessSpawner';
import type { ILogger } from '../interfaces/ILogger';

// ============================================================================
// TYPES
// ============================================================================

export interface ModelInfo {
  id: string;
  vendor: 'openai' | 'anthropic' | 'google' | 'unknown';
  family: string;
  tier: 'fast' | 'standard' | 'premium';
}

export interface ModelDiscoveryResult {
  models: ModelInfo[];
  rawChoices: string[];
  discoveredAt: number;
  cliVersion?: string;
  /** Capabilities detected from CLI --help output. */
  capabilities?: CliCapabilities;
}

/**
 * Capabilities detected dynamically from the installed Copilot CLI.
 * Each capability maps to a CLI flag discovered via `copilot --help`.
 */
export interface CliCapabilities {
  /** Whether the CLI supports the --effort flag. */
  effort: boolean;
  /** Valid effort choices if supported (e.g., ['low', 'medium', 'high']). */
  effortChoices?: string[];
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const FAILURE_CACHE_TTL_MS = 30 * 1000; // 30 seconds

// ============================================================================
// DI OPTIONS
// ============================================================================

/** Optional dependency overrides for testability. */
export interface ModelDiscoveryDeps {
  /** Process spawner for running `copilot --help`. */
  spawner?: IProcessSpawner;
  /** Clock function returning current timestamp in ms. */
  clock?: () => number;
  /** Logger for warning messages. */
  logger?: ILogger;
  /** Cache TTL in milliseconds (default: 30 minutes). Injectable for testing. */
  cacheTtlMs?: number;
}

// ============================================================================
// CACHE (keyed by CLI version)
// ============================================================================

let cachedResult: ModelDiscoveryResult | null = null;
let lastFailureTime: number | null = null;

// ============================================================================
// VENDOR / TIER CLASSIFICATION
// ============================================================================

/**
 * Known model cost tiers based on GitHub Copilot pricing (premium request multiplier).
 *
 * Source: VS Code Copilot model picker displays the cost multiplier per model.
 * - `fast`     = fractional cost (mini/haiku models)
 * - `standard` = 1x base cost
 * - `premium`  = 3x+ base cost (opus models, large-context variants)
 *
 * When a model isn't in this map, {@link classifyModel} falls back to keyword
 * heuristics (mini/haiku → fast, opus/max → premium, else standard).
 *
 * Update this map when new models appear in `copilot help config` or the
 * VS Code model picker.
 */
const KNOWN_MODEL_TIERS: Record<string, ModelInfo['tier']> = {
  // ── Anthropic ──────────────────────────────────────────────────────
  'claude-haiku-4.5':       'fast',      // fractional cost
  'claude-sonnet-4':        'standard',  // 1x
  'claude-sonnet-4.5':      'standard',  // 1x
  'claude-sonnet-4.6':      'standard',  // 1x (High reasoning, but 1x cost)
  'claude-opus-4.5':        'premium',   // 3x+
  'claude-opus-4.6':        'premium',   // 3x
  'claude-opus-4.6-fast':   'premium',   // 3x (lower latency variant)

  // ── OpenAI ─────────────────────────────────────────────────────────
  'gpt-4.1':                'standard',  // 1x
  'gpt-5.1':                'standard',  // 1x
  'gpt-5.2':                'standard',  // 1x
  'gpt-5.2-codex':          'standard',  // 1x (coding specialized)
  'gpt-5.3-codex':          'standard',  // 1x (coding specialized)
  'gpt-5.4':                'standard',  // 1x (Medium reasoning per VS Code picker)
  'gpt-5.4-mini':           'fast',      // fractional cost
  'gpt-5-mini':             'fast',      // fractional cost
};

/**
 * Classify a model ID into vendor, family, and cost tier.
 *
 * Uses a static lookup table ({@link KNOWN_MODEL_TIERS}) for models whose
 * cost tier has been verified via the VS Code Copilot model picker, with
 * keyword-based heuristics as a fallback for unrecognized models.
 */
export function classifyModel(id: string): Pick<ModelInfo, 'vendor' | 'family' | 'tier'> {
  const lower = id.toLowerCase();

  // Vendor + family
  let vendor: ModelInfo['vendor'] = 'unknown';
  let family = id;
  if (lower.startsWith('claude-')) {
    vendor = 'anthropic';
    family = 'claude';
  } else if (lower.startsWith('gpt-')) {
    vendor = 'openai';
    family = lower.includes('codex') ? 'codex' : 'gpt';
  } else if (lower.startsWith('gemini-')) {
    vendor = 'google';
    family = 'gemini';
  }

  // Tier: static lookup first, keyword heuristic fallback
  const knownTier = KNOWN_MODEL_TIERS[lower];
  let tier: ModelInfo['tier'];
  if (knownTier) {
    tier = knownTier;
  } else if (/\bmini\b/.test(lower) || /\bhaiku\b/.test(lower)) {
    tier = 'fast';
  } else if (/\bopus\b/.test(lower) || /\bmax\b/.test(lower)) {
    tier = 'premium';
  } else {
    tier = 'standard';
  }

  return { vendor, family, tier };
}

// ============================================================================
// PARSING
// ============================================================================

/**
 * Parse model choices from `copilot --help` output (legacy format).
 *
 * Matches the older CLI format where `--model` listed choices inline:
 *   `--model <model> (choices: "gpt-4o-mini", "claude-sonnet-4")`
 *
 * CLI v1.x removed choices from `--help`; use {@link parseModelChoicesFromConfig}
 * for the new format.
 */
export function parseModelChoices(helpOutput: string): string[] {
  const match = helpOutput.match(/--model\s+<\w+>\s+.*?\(choices:\s*([^)]+)\)/i);
  if (!match) {
    return [];
  }
  const raw = match[1];
  // Extract quoted strings
  const choices: string[] = [];
  const quotePattern = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = quotePattern.exec(raw)) !== null) {
    choices.push(m[1]);
  }
  return choices;
}

/**
 * Parse model choices from `copilot help config` output (v1.x+ format).
 *
 * In CLI v1.x, the `--help` flag no longer lists model choices. Instead,
 * `copilot help config` lists available models under the `model:` setting:
 * ```
 *   `model`: AI model to use for Copilot CLI; ...
 *     - "claude-sonnet-4.6"
 *     - "gpt-5.4"
 *     ...
 *
 *   `mouse`: ...
 * ```
 *
 * The parser extracts lines matching `- "model-name"` between the `model:`
 * definition and the next backtick-quoted config key.
 */
export function parseModelChoicesFromConfig(configOutput: string): string[] {
  const choices: string[] = [];
  const lines = configOutput.split('\n');
  let inModelSection = false;

  for (const line of lines) {
    // Detect start: backtick-quoted `model` key at line start (with optional indentation)
    if (/^\s*`model`/.test(line)) {
      inModelSection = true;
      continue;
    }

    // Detect end: next backtick-quoted config key (e.g., `mouse`, `theme`)
    if (inModelSection && /^\s*`\w+`/.test(line)) {
      break;
    }

    // Extract model name from "  - "model-name"" lines
    if (inModelSection) {
      const m = line.match(/^\s+-\s+"([^"]+)"/);
      if (m) {
        choices.push(m[1]);
      }
    }
  }

  return choices;
}

/**
 * Detect whether `copilot --help` lists the `--effort` flag and extract its valid choices.
 *
 * Looks for patterns like:
 *   `--effort <effort>  (choices: "low", "medium", "high")`
 *   `--effort <effort>  Reasoning effort level`
 *
 * @returns An object with `supported` boolean and optional `choices` array.
 */
export function parseEffortSupport(helpOutput: string): { supported: boolean; choices?: string[] } {
  // Check if --effort appears at all
  if (!/--effort\b/i.test(helpOutput)) {
    return { supported: false };
  }

  // Try to extract choices if listed (same format as --model)
  const choicesMatch = helpOutput.match(/--effort\s+<\w+>\s+.*?\(choices:\s*([^)]+)\)/i);
  if (choicesMatch) {
    const choices: string[] = [];
    const quotePattern = /"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = quotePattern.exec(choicesMatch[1])) !== null) {
      choices.push(m[1]);
    }
    if (choices.length > 0) {
      return { supported: true, choices };
    }
  }

  // --effort flag exists but no parseable choices — assume standard set
  return { supported: true, choices: ['low', 'medium', 'high', 'xhigh'] };
}

// ============================================================================
// DISCOVERY
// ============================================================================

/**
 * Run `copilot --help` (and optionally `copilot help config`) to parse available model choices.
 *
 * Strategy (backward compatible):
 * 1. Run `copilot --help` — parse model choices (legacy pre-1.0 format), effort support, CLI version
 * 2. If no models found in `--help` (v1.x+ CLI), run `copilot help config` and parse models from there
 * 3. Capabilities (effort, etc.) always come from `--help` output regardless of model source
 */
export async function discoverAvailableModels(deps?: ModelDiscoveryDeps): Promise<ModelDiscoveryResult> {
  const clock = deps?.clock ?? Date.now;
  const logger = deps?.logger;
  const spawner = deps?.spawner;

  if (!spawner) {
    throw new Error('ModelDiscoveryDeps.spawner is required but was not provided. Ensure a ProcessSpawner is passed via the deps parameter, or call discoverAvailableModelsLegacy() for backward compatibility.');
  }

  // Check if we recently failed and should wait
  if (lastFailureTime !== null && (clock() - lastFailureTime) < FAILURE_CACHE_TTL_MS) {
    return emptyResult(clock);
  }

  try {
    const helpOutput = await runCopilotHelp(spawner);

    // Extract CLI version from help output (e.g. "GitHub Copilot CLI 1.0.19.")
    const cliVersion = parseCliVersion(helpOutput);

    // Detect CLI capabilities from --help (effort, etc.)
    const effortSupport = parseEffortSupport(helpOutput);
    const capabilities: CliCapabilities = {
      effort: effortSupport.supported,
      effortChoices: effortSupport.choices,
    };

    // Strategy 1: Try legacy --help model choices (pre-1.0 CLI)
    let rawChoices = parseModelChoices(helpOutput);

    // Strategy 2: If no models in --help, try `copilot help config` (v1.x+ CLI)
    if (rawChoices.length === 0) {
      try {
        const configOutput = await runCopilotHelpConfig(spawner);
        rawChoices = parseModelChoicesFromConfig(configOutput);
        if (rawChoices.length > 0) {
          if (logger) {
            logger.info(`[modelDiscovery] Discovered ${rawChoices.length} models from 'copilot help config'`);
          }
        }
      } catch (configError) {
        if (logger) {
          logger.warn(`[modelDiscovery] 'copilot help config' failed: ${configError}`);
        }
      }
    }

    if (rawChoices.length === 0) {
      if (logger) {
        logger.warn('[modelDiscovery] No model choices found in copilot --help or copilot help config');
      } else {
        console.warn('[modelDiscovery] No model choices found in copilot --help or copilot help config');
      }
      // Still return capabilities even if models couldn't be discovered
      const partialResult: ModelDiscoveryResult = {
        models: [],
        rawChoices: [],
        discoveredAt: clock(),
        cliVersion,
        capabilities,
      };
      cachedResult = partialResult;
      lastFailureTime = clock();
      return partialResult;
    }

    const models: ModelInfo[] = rawChoices.map(id => ({
      id,
      ...classifyModel(id),
    }));

    const result: ModelDiscoveryResult = {
      models,
      rawChoices,
      discoveredAt: clock(),
      cliVersion,
      capabilities,
    };

    cachedResult = result;
    lastFailureTime = null;
    return result;
  } catch (e) {
    if (logger) {
      logger.warn(`[modelDiscovery] Failed to discover models: ${e}`);
    } else {
      console.warn(`[modelDiscovery] Failed to discover models: ${e}`);
    }
    lastFailureTime = clock();
    return emptyResult(clock);
  }
}

/**
 * Convenience function for legacy callers that don't use DI.
 * 
 * @deprecated Use discoverAvailableModels with proper DI instead
 */
export async function discoverAvailableModelsLegacy(deps?: Omit<ModelDiscoveryDeps, 'spawner'>): Promise<ModelDiscoveryResult> {
  // eslint-disable-next-line no-restricted-syntax
  const spawner = new DefaultProcessSpawner();
  return discoverAvailableModels({
    ...deps,
    spawner,
  });
}

/**
 * Return cached models if fresh (within TTL and same CLI version), otherwise re-discover.
 * Falls back to legacy discovery (DefaultProcessSpawner) when no spawner is provided.
 */
export async function getCachedModels(deps?: ModelDiscoveryDeps): Promise<ModelDiscoveryResult> {
  const clock = deps?.clock ?? Date.now;
  const ttl = deps?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  
  if (cachedResult && (clock() - cachedResult.discoveredAt) < ttl) {
    return cachedResult;
  }
  
  // Cache expired or missing — re-discover
  if (!deps?.spawner) {
    return discoverAvailableModelsLegacy(deps);
  }
  return discoverAvailableModels(deps);
}

/**
 * Force re-discovery of available models, ignoring cache.
 * Falls back to legacy discovery (DefaultProcessSpawner) when no spawner is provided.
 */
export async function refreshModelCache(deps?: ModelDiscoveryDeps): Promise<ModelDiscoveryResult> {
  cachedResult = null;
  lastFailureTime = null;
  if (!deps?.spawner) {
    return discoverAvailableModelsLegacy(deps);
  }
  return discoverAvailableModels(deps);
}

/**
 * Validate whether a model ID is in the discovered model list.
 */
export async function isValidModel(modelId: string, deps?: ModelDiscoveryDeps): Promise<boolean> {
  const discoverer = deps?.spawner ? getCachedModels : discoverAvailableModelsLegacy;
  const result = await discoverer(deps);
  return result.models.some(m => m.id === modelId);
}

/**
 * Check whether the installed Copilot CLI supports the `--effort` flag.
 * Uses cached discovery results when available.
 */
export async function hasEffortSupport(deps?: ModelDiscoveryDeps): Promise<boolean> {
  const result = await getCachedModels(deps);
  return result.capabilities?.effort ?? false;
}

/**
 * Get the valid effort choices from the installed Copilot CLI.
 * Returns undefined if effort is not supported.
 */
export async function getEffortChoices(deps?: ModelDiscoveryDeps): Promise<string[] | undefined> {
  const result = await getCachedModels(deps);
  if (!result.capabilities?.effort) { return undefined; }
  return result.capabilities.effortChoices;
}

/**
 * Suggest a model based on task complexity.
 * 
 * @param taskType - 'fast' for simple tasks, 'standard' for normal tasks, 'premium' for complex tasks
 */
export async function suggestModel(taskType: 'fast' | 'standard' | 'premium', deps?: ModelDiscoveryDeps): Promise<ModelInfo | undefined> {
  const result = await getCachedModels(deps);
  if (result.models.length === 0) {
    return undefined;
  }

  const candidates = result.models.filter(m => m.tier === taskType);
  if (candidates.length > 0) {
    return candidates[0];
  }

  // Fallback: return first standard model, or first model overall
  const standard = result.models.filter(m => m.tier === 'standard');
  return standard.length > 0 ? standard[0] : result.models[0];
}

// ============================================================================
// INTERNAL: Reset cache (for testing)
// ============================================================================

export function resetModelCache(): void {
  cachedResult = null;
  lastFailureTime = null;
}

// ============================================================================
// HELPERS
// ============================================================================

function emptyResult(clock?: () => number): ModelDiscoveryResult {
  return {
    models: [],
    rawChoices: [],
    discoveredAt: (clock ?? Date.now)(),
  };
}

/**
 * Extract CLI version from `copilot --help` or `copilot --version` output.
 * Matches patterns like:
 *   - "GitHub Copilot CLI 0.0.412-1" (pre-1.0 format)
 *   - "GitHub Copilot CLI 1.0.19." (v1.x format, trailing dot)
 *   - "1.0.19" (plain version string)
 */
export function parseCliVersion(output: string): string | undefined {
  const match = output.match(/(?:Copilot\s+CLI\s+)?(\d+\.\d+\.\d+(?:-\d+)?)/i);
  return match?.[1];
}

/**
 * Run `copilot --help` and return its output.
 * Exported for testing with injected spawner.
 */
export function runCopilotHelp(spawner: IProcessSpawner): Promise<string> {
  return runCopilotCommand(spawner, ['--help']);
}

/**
 * Run `copilot help config` and return its output.
 * Used by v1.x+ CLI to discover available models from the config help topic.
 * Exported for testing with injected spawner.
 */
export function runCopilotHelpConfig(spawner: IProcessSpawner): Promise<string> {
  return runCopilotCommand(spawner, ['help', 'config']);
}

/**
 * Run a copilot subcommand and return its output.
 */
function runCopilotCommand(spawner: IProcessSpawner, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawner.spawn('copilot', args, { shell: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code: number | null) => {
      if (settled) {return;}
      settled = true;
      clearTimeout(timeout);
      resolve(stdout || stderr);
    });

    proc.on('error', (err: Error) => {
      if (settled) {return;}
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    // Timeout after 10 seconds
    const timeout = setTimeout(() => {
      if (settled) {return;}
      settled = true;
      if (!proc.killed && proc.exitCode === null) {
        proc.kill();
      }
      reject(new Error('copilot --help timed out'));
    }, 10000);
    (timeout as unknown as { unref?: () => void }).unref?.();
  });
}
