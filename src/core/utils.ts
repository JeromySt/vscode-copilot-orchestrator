
import * as fs from 'fs';
import * as path from 'path';
export function ensureDir(p: string) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
export function readJSON<T>(file: string, fallback: T): T { try { return JSON.parse(fs.readFileSync(file,'utf8')) as T; } catch { return fallback; } }
export function writeJSON(file: string, obj: any) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(obj,null,2)); }
export function cpuCountMinusOne(): number { const os = require('os'); const n: number = os.cpus()?.length || 2; return Math.max(1, n-1); }
