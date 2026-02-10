
import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Synchronous utilities (use sparingly - blocks event loop)
// ─────────────────────────────────────────────────────────────────────────────

export function ensureDir(p: string) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
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

// FI-CHAIN-TEST-MARKER: This comment was added by the FI chain test plan.
// If this comment appears in downstream nodes, the FI chain is working correctly.
// Added: 2026-02-09
