/**
 * @fileoverview Log File Helper
 *
 * Manages persisting execution logs to disk. Extracted from executor.ts
 * to keep the orchestrator slim.
 *
 * @module plan/logFileHelper
 */

import * as fs from 'fs';
import * as path from 'path';
import type { LogEntry } from './types';
import { ensureOrchestratorDirs } from '../core';

export function getLogFilePathByKey(
  executionKey: string,
  storagePath: string | undefined,
  logFiles: Map<string, string>,
): string | undefined {
  if (!storagePath) return undefined;
  let logFile = logFiles.get(executionKey);
  if (!logFile) {
    const logsDir = path.join(storagePath, 'logs');
    const safeKey = executionKey.replace(/[^a-zA-Z0-9-_]/g, '_');
    logFile = path.join(logsDir, `${safeKey}.log`);
    logFiles.set(executionKey, logFile);
    
    // Write log file header with version info on first creation
    try {
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      const header = buildLogFileHeader(executionKey);
      fs.writeFileSync(logFile, header, 'utf8');
    } catch { /* ignore header write errors */ }
  }
  return logFile;
}

/**
 * Build a diagnostic header for log files.
 * Includes extension version, git commit, platform, and node version.
 */
function buildLogFileHeader(executionKey: string): string {
  const now = new Date().toISOString();
  let version = 'unknown';
  let commit = 'unknown';
  
  // Read version from package.json (bundled in dist/)
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      version = pkg.version || 'unknown';
    }
  } catch { /* ignore */ }
  
  // Try to get git commit from the workspace
  try {
    const { execSync } = require('child_process');
    commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8', timeout: 3000 }).trim();
  } catch { /* ignore - not in a git repo or git not available */ }
  
  // Parse execution key to extract plan/node/attempt info
  // Key format: planId:nodeId:attemptNumber
  const keyParts = executionKey.split(':');
  const planId = keyParts[0] || 'unknown';
  const nodeId = keyParts[1] || 'unknown';
  const attempt = keyParts[2] || '1';
  
  const lines = [
    `================================================================================`,
    `  Copilot Orchestrator - Node Execution Log`,
    `================================================================================`,
    `  Version:    ${version}`,
    `  Commit:     ${commit}`,
    `  Platform:   ${process.platform} ${process.arch}`,
    `  Node.js:    ${process.version}`,
    `  Created:    ${now}`,
    `  Plan ID:    ${planId}`,
    `  Node ID:    ${nodeId}`,
    `  Attempt:    ${attempt}`,
    `================================================================================`,
    ``,
  ];
  return lines.join('\n') + '\n';
}

export function appendToLogFile(
  executionKey: string,
  entry: LogEntry,
  storagePath: string | undefined,
  logFiles: Map<string, string>,
): void {
  const logFile = getLogFilePathByKey(executionKey, storagePath, logFiles);
  if (!logFile) return;
  try {
    if (storagePath) {
      const workspacePath = path.resolve(storagePath, '..');
      ensureOrchestratorDirs(workspacePath);
    }
    const time = new Date(entry.timestamp).toISOString();
    const prefix = entry.type === 'stderr' ? '[ERR]' :
                   entry.type === 'error' ? '[ERROR]' :
                   entry.type === 'info' ? '[INFO]' : '';
    const line = `[${time}] [${entry.phase.toUpperCase()}] ${prefix} ${entry.message}\n`;
    fs.appendFileSync(logFile, line, 'utf8');
  } catch { /* ignore file write errors */ }
}

export function readLogsFromFile(
  executionKey: string,
  storagePath: string | undefined,
  logFiles: Map<string, string>,
): string {
  const logFile = getLogFilePathByKey(executionKey, storagePath, logFiles);
  if (!logFile || !fs.existsSync(logFile)) return 'No log file found.';
  try { return fs.readFileSync(logFile, 'utf8'); } catch (err) { return `Error reading log file: ${err}`; }
}

export function readLogsFromFileOffset(
  executionKey: string,
  byteOffset: number,
  storagePath: string | undefined,
  logFiles: Map<string, string>,
): string {
  const logFile = getLogFilePathByKey(executionKey, storagePath, logFiles);
  if (!logFile) return 'No log file found.';
  try {
    if (byteOffset <= 0) return fs.readFileSync(logFile, 'utf8');
    const fd = fs.openSync(logFile, 'r');
    try {
      const fileSize = fs.fstatSync(fd).size;
      if (byteOffset >= fileSize) return '';
      const length = fileSize - byteOffset;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, byteOffset);
      return buffer.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (err: any) {
    if (err.code === 'ENOENT') return 'No log file found.';
    return `Error reading log file: ${err}`;
  }
}
