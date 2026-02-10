/**
 * @fileoverview Model Discovery Module
 * 
 * Dynamically discovers available models from `copilot --help` output.
 * Provides caching, validation, and model suggestion capabilities.
 * 
 * @module agent/modelDiscovery
 */

import * as cp from 'child_process';

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
export async function discoverAvailableModels(): Promise<ModelDiscoveryResult> {
  // Check if we recently failed and should wait
  if (lastFailureTime !== null && (Date.now() - lastFailureTime) < FAILURE_CACHE_TTL_MS) {
    return emptyResult();
  }

  try {
    const helpOutput = await runCopilotHelp();
    const rawChoices = parseModelChoices(helpOutput);

    if (rawChoices.length === 0) {
      console.warn('[modelDiscovery] No model choices found in copilot --help output');
      lastFailureTime = Date.now();
      return emptyResult();
    }

    const models: ModelInfo[] = rawChoices.map(id => ({
      id,
      ...classifyModel(id),
    }));

    const result: ModelDiscoveryResult = {
      models,
      rawChoices,
      discoveredAt: Date.now(),
    };

    cachedResult = result;
    lastFailureTime = null;
    return result;
  } catch (e) {
    console.warn(`[modelDiscovery] Failed to discover models: ${e}`);
    lastFailureTime = Date.now();
    return emptyResult();
  }
}

/**
 * Return cached models if fresh (within TTL), otherwise re-discover.
 */
export async function getCachedModels(): Promise<ModelDiscoveryResult> {
  if (cachedResult && (Date.now() - cachedResult.discoveredAt) < CACHE_TTL_MS) {
    return cachedResult;
  }
  return discoverAvailableModels();
}

/**
 * Force re-discovery of available models, ignoring cache.
 */
export async function refreshModelCache(): Promise<ModelDiscoveryResult> {
  cachedResult = null;
  lastFailureTime = null;
  return discoverAvailableModels();
}

/**
 * Validate whether a model ID is in the discovered model list.
 */
export async function isValidModel(modelId: string): Promise<boolean> {
  const result = await getCachedModels();
  return result.models.some(m => m.id === modelId);
}

/**
 * Suggest a model based on task complexity.
 * 
 * @param taskType - 'fast' for simple tasks, 'standard' for normal tasks, 'premium' for complex tasks
 */
export async function suggestModel(taskType: 'fast' | 'standard' | 'premium'): Promise<ModelInfo | undefined> {
  const result = await getCachedModels();
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

function emptyResult(): ModelDiscoveryResult {
  return {
    models: [],
    rawChoices: [],
    discoveredAt: Date.now(),
  };
}

function runCopilotHelp(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = cp.spawn('copilot', ['--help'], { shell: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // Accept any exit code since --help may return non-zero on some systems
      resolve(stdout || stderr);
    });

    proc.on('error', (err) => {
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
