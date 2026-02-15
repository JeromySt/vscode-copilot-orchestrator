
import type { IProcessSpawner } from '../interfaces/IProcessSpawner';

// Cache the CLI availability result - it doesn't change during extension lifetime
let cachedCliAvailable: boolean | null = null;
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
    return cachedCliAvailable;
  }
  
  // First call - trigger async check and return optimistic true
  // (most users will have it available, and we'll update on next call)
  if (!checkInProgress) {
    checkInProgress = checkCopilotCliAsync().then(result => {
      cachedCliAvailable = result;
      checkInProgress = null;
      return result;
    });
  }
  
  // Return true optimistically on first call to avoid blocking
  // The actual check will update the cache
  return true;
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
  return result;
}

/**
 * Reset the cache (useful for testing or after installation).
 */
export function resetCliCache(): void {
  cachedCliAvailable = null;
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
