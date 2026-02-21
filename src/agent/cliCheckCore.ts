
import type { IProcessSpawner } from '../interfaces/IProcessSpawner';

// Cache the CLI availability result - it doesn't change during extension lifetime
let cachedCliAvailable: boolean | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds for negative results
let checkInProgress: Promise<boolean> | null = null;

/** @internal Lazy-loaded process spawner for fallback. Production code must inject via DI. */
function getFallbackSpawner(): IProcessSpawner {
  const mod = require('../interfaces/IProcessSpawner');
  return new mod.DefaultProcessSpawner();
}

/**
 * Check if Copilot CLI is available (cached, non-blocking after first call).
 * Returns cached result immediately if available, otherwise returns false
 * and triggers async check in background.
 */
export function isCopilotCliAvailable(): boolean {
  if (cachedCliAvailable !== null) {
    // Positive results are cached indefinitely (CLI won't disappear mid-session)
    // Negative results expire after TTL so fresh installs are detected
    if (cachedCliAvailable === true || (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
      return cachedCliAvailable;
    }
    // Negative cache expired — reset and re-check
    cachedCliAvailable = null;
  }
  
  // First call or expired - trigger async check
  if (!checkInProgress) {
    checkInProgress = checkCopilotCliAsync().then(result => {
      cachedCliAvailable = result;
      cacheTimestamp = Date.now();
      checkInProgress = null;
      return result;
    });
  }
  
  // Return false when cache is expired/unknown (don't optimistically return true)
  return false;
}

/**
 * Force a fresh check of Copilot CLI availability (async).
 * Updates the cache and returns the result.
 */
export async function checkCopilotCliAsync(spawner?: IProcessSpawner): Promise<boolean> {
  const result = await cmdOkAsync('gh copilot --help', spawner) || 
                 await hasGhCopilotAsync(spawner) || 
                 await cmdOkAsync('copilot --help', spawner) || 
                 await cmdOkAsync('github-copilot --help', spawner) || 
                 await cmdOkAsync('github-copilot-cli --help', spawner);
  cachedCliAvailable = result;
  cacheTimestamp = Date.now();
  return result;
}

/**
 * Reset the cache (useful for testing or after installation).
 */
export function resetCliCache(): void {
  cachedCliAvailable = null;
  cacheTimestamp = 0;
  checkInProgress = null;
}

/**
 * Check if cache is populated.
 */
export function isCliCachePopulated(): boolean {
  return cachedCliAvailable !== null;
}

// Async command check using spawn
export async function cmdOkAsync(cmd: string, spawner?: IProcessSpawner): Promise<boolean> {
  return new Promise((resolve) => {
    const actualSpawner = spawner ?? getFallbackSpawner();
    
    const proc = actualSpawner.spawn(cmd, [], { shell: true, stdio: 'ignore' });
    proc.on('close', (code: number | null) => resolve(code === 0));
    proc.on('error', () => resolve(false));
    // Timeout after 5 seconds
    setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 5000);
  });
}

async function hasGhCopilotAsync(spawner?: IProcessSpawner): Promise<boolean> {
  return new Promise((resolve) => {
    const actualSpawner = spawner ?? getFallbackSpawner();
    
    const proc = actualSpawner.spawn('gh', ['extension', 'list'], { shell: true });
    let output = '';
    proc.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
    proc.on('close', () => resolve(/github\/gh-copilot/i.test(output)));
    proc.on('error', () => resolve(false));
    setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 5000);
  });
}

/**
 * Check if Copilot CLI is authenticated (can access GitHub).
 * Runs `gh auth status` and checks exit code.
 */
export async function checkCopilotAuthAsync(spawner?: IProcessSpawner): Promise<{ authenticated: boolean; method: 'gh' | 'standalone' | 'unknown' }> {
  // Try gh auth status first
  const ghAuth = await cmdOkAsync('gh auth status', spawner);
  if (ghAuth) return { authenticated: true, method: 'gh' };
  
  // Try standalone copilot auth
  const copilotAuth = await cmdOkAsync('copilot auth status', spawner);
  if (copilotAuth) return { authenticated: true, method: 'standalone' };
  
  // Try to determine which CLI variant is installed
  const hasGh = await cmdOkAsync('gh --version', spawner);
  if (hasGh) return { authenticated: false, method: 'gh' };
  
  const hasCopilot = await cmdOkAsync('copilot --version', spawner);
  if (hasCopilot) return { authenticated: false, method: 'standalone' };
  
  return { authenticated: false, method: 'unknown' };
}
