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
}

// ============================================================================
// CONSTANTS
// ============================================================================

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FAILURE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
}

// ============================================================================
// CACHE
// ============================================================================

let cachedResult: ModelDiscoveryResult | null = null;
let lastFailureTime: number | null = null;

// ============================================================================
// VENDOR / TIER CLASSIFICATION
// ============================================================================

/**
 * Classify a model ID into vendor and tier information.
 */
export function classifyModel(id: string): Pick<ModelInfo, 'vendor' | 'family' | 'tier'> {
  const lower = id.toLowerCase();

  // Vendor
  let vendor: ModelInfo['vendor'] = 'unknown';
  let family = id;
  if (lower.startsWith('claude-')) {
    vendor = 'anthropic';
    family = 'claude';
  } else if (lower.startsWith('gpt-')) {
    vendor = 'openai';
    family = 'gpt';
  } else if (lower.startsWith('gemini-')) {
    vendor = 'google';
    family = 'gemini';
  }

  // Tier — match on word boundaries to avoid false positives (e.g. "gemini" ≠ "mini")
  let tier: ModelInfo['tier'] = 'standard';
  if (/\bmini\b/.test(lower) || /\bhaiku\b/.test(lower)) {
    tier = 'fast';
  } else if (/\bopus\b/.test(lower) || /\bmax\b/.test(lower)) {
    tier = 'premium';
  }

  return { vendor, family, tier };
}

// ============================================================================
// PARSING
// ============================================================================

/**
 * Parse model choices from `copilot --help` output.
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

// ============================================================================
// DISCOVERY
// ============================================================================

/**
 * Run `copilot --help` and parse available model choices.
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
    const rawChoices = parseModelChoices(helpOutput);

    if (rawChoices.length === 0) {
      if (logger) {
        logger.warn('[modelDiscovery] No model choices found in copilot --help output');
      } else {
        console.warn('[modelDiscovery] No model choices found in copilot --help output');
      }
      lastFailureTime = clock();
      return emptyResult(clock);
    }

    const models: ModelInfo[] = rawChoices.map(id => ({
      id,
      ...classifyModel(id),
    }));

    const result: ModelDiscoveryResult = {
      models,
      rawChoices,
      discoveredAt: clock(),
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
 * Return cached models if fresh (within TTL), otherwise re-discover.
 */
export async function getCachedModels(deps?: ModelDiscoveryDeps): Promise<ModelDiscoveryResult> {
  const clock = deps?.clock ?? Date.now;
  if (cachedResult && (clock() - cachedResult.discoveredAt) < CACHE_TTL_MS) {
    return cachedResult;
  }
  return discoverAvailableModels(deps);
}

/**
 * Force re-discovery of available models, ignoring cache.
 */
export async function refreshModelCache(deps?: ModelDiscoveryDeps): Promise<ModelDiscoveryResult> {
  cachedResult = null;
  lastFailureTime = null;
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
 * Run `copilot --help` and return its output.
 * Exported for testing with injected spawner.
 */
export function runCopilotHelp(spawner: IProcessSpawner): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawner.spawn('copilot', ['--help'], { shell: true });
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
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(stdout || stderr);
    });

    proc.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    // Timeout after 10 seconds
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (!proc.killed && proc.exitCode === null) {
        proc.kill();
      }
      reject(new Error('copilot --help timed out'));
    }, 10000);
    (timeout as unknown as { unref?: () => void }).unref?.();
  });
}
