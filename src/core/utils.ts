import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Synchronous utilities (use sparingly - blocks event loop)
// ─────────────────────────────────────────────────────────────────────────────

export function ensureDir(p: string) { if (!fs.existsSync(p)) {fs.mkdirSync(p, { recursive: true });} }
export function readJSON<T>(file: string, fallback: T): T { try { return JSON.parse(fs.readFileSync(file,'utf8')) as T; } catch { return fallback; } }
export function writeJSON(file: string, obj: any) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(obj,null,2)); }

// ─────────────────────────────────────────────────────────────────────────────
// Async utilities (prefer these - uses libuv thread pool)
// ─────────────────────────────────────────────────────────────────────────────

export async function ensureDirAsync(p: string): Promise<void> {
  try {
    await fs.promises.access(p);
  } catch {
    await fs.promises.mkdir(p, { recursive: true });
  }
}

export async function readJSONAsync<T>(file: string, fallback: T): Promise<T> {
  try {
    const content = await fs.promises.readFile(file, 'utf8');
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

export async function writeJSONAsync(file: string, obj: any): Promise<void> {
  await ensureDirAsync(path.dirname(file));
  await fs.promises.writeFile(file, JSON.stringify(obj, null, 2));
}

export async function existsAsync(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// System utilities
// ─────────────────────────────────────────────────────────────────────────────

export function cpuCountMinusOne(): number { const os = require('os'); const n: number = os.cpus()?.length || 2; return Math.max(1, n-1); }

// ─────────────────────────────────────────────────────────────────────────────
// Directory initialization utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Required subdirectories under .orchestrator/
 * These are created on-demand before any filesystem operation.
 */
const ORCHESTRATOR_SUBDIRS = [
  'plans',
  'logs', 
  'evidence',
  '.copilot'  // Session storage
] as const;

/**
 * Ensure the .orchestrator directory structure exists.
 * 
 * Called before any filesystem write operation to handle cases where
 * the directory was deleted externally (e.g., `git clean -dfx`).
 * 
 * Creates:
 * - .orchestrator/
 * - .orchestrator/plans/
 * - .orchestrator/logs/
 * - .orchestrator/evidence/
 * - .orchestrator/.copilot/
 * 
 * @param workspacePath - Root path of the workspace
 * @returns Path to the .orchestrator directory
 */
export function ensureOrchestratorDirs(workspacePath: string): string {
  const orchestratorPath = path.join(workspacePath, '.orchestrator');
  
  // Create root .orchestrator if missing
  if (!fs.existsSync(orchestratorPath)) {
    fs.mkdirSync(orchestratorPath, { recursive: true });
  }
  
  // Create each subdirectory
  for (const subdir of ORCHESTRATOR_SUBDIRS) {
    const subdirPath = path.join(orchestratorPath, subdir);
    if (!fs.existsSync(subdirPath)) {
      fs.mkdirSync(subdirPath, { recursive: true });
    }
  }
  
  return orchestratorPath;
}


