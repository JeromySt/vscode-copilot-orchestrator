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
import { ensureOrchestratorDirs } from '../core/utils';

const ensuredDirs = new Set<string>();

export function getLogFilePathByKey(
  executionKey: string,
  storagePath: string | undefined,
  logFiles: Map<string, string>,
): string | undefined {
  if (!storagePath) {return undefined;}
  let logFile = logFiles.get(executionKey);
  if (!logFile) {
    // Parse execution key: "planId:nodeId:attemptNumber"
    const keyParts = executionKey.split(':');
    const planId = keyParts[0];
    const nodeId = keyParts[1];
    if (!planId || !nodeId) {return undefined;}
    // Write to specs/<nodeId>/current/execution.log (resolves through symlink to attempts/<n>/)
    logFile = path.join(storagePath, 'plans', planId, 'specs', nodeId, 'current', 'execution.log');
    logFiles.set(executionKey, logFile);
  }
  return logFile;
}

/**
 * Get the log file path for a specific attempt (reads from attempts/<n>/ directly).
 */
export function getLogFilePathForAttempt(
  planId: string,
  nodeId: string,
  attemptNumber: number,
  storagePath: string | undefined,
): string | undefined {
  if (!storagePath) {return undefined;}
  return path.join(storagePath, 'plans', planId, 'specs', nodeId, 'attempts', String(attemptNumber), 'execution.log');
}

/**
 * Get legacy log file path (for migration and fallback reads).
 */
export function getLegacyLogFilePath(
  planId: string,
  nodeId: string,
  attemptNumber: number,
  storagePath: string,
): string {
  const safeKey = `${planId}_${nodeId}_${attemptNumber}`;
  return path.join(storagePath, 'logs', `${safeKey}.log`);
}

/**
 * Ensure the log file exists on disk with a diagnostic header.
 * Called only when we are about to *write* a log entry.
 */
function ensureLogFile(logFile: string, executionKey: string): void {
  if (fs.existsSync(logFile)) {return;}
  try {
    const logsDir = path.dirname(logFile);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const header = buildLogFileHeader(executionKey);
    fs.writeFileSync(logFile, header, 'utf8');
  } catch { /* ignore header write errors */ }
}

/**
 * Build a diagnostic header for log files.
 * Includes extension version, git commit, platform, and node version.
 */
function buildLogFileHeader(executionKey: string): string {
  const now = new Date().toISOString();
  
  // Use build-time constants (injected by esbuild) for reliable version info
  let version = 'unknown';
  let commit = 'unknown';
  let buildTimestamp = '';
  try {
    const { BUILD_VERSION, BUILD_COMMIT, BUILD_TIMESTAMP } = require('../core/buildInfo');
    version = BUILD_VERSION || 'unknown';
    commit = BUILD_COMMIT || 'unknown';
    buildTimestamp = BUILD_TIMESTAMP || '';
  } catch {
    // Fallback for dev/test: read from package.json + runtime git
    try {
      const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
      if (fs.existsSync(pkgPath)) {
        version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || 'unknown';
      }
    } catch { /* ignore */ }
    try {
      const { execSync } = require('child_process'); // eslint-disable-line no-restricted-syntax
      commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8', timeout: 3000 }).trim();
    } catch { /* ignore */ }
  }
  
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
    `  Built:      ${buildTimestamp}`,
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
  if (!logFile) {return;}
  try {
    ensureLogFile(logFile, executionKey);
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
  if (!logFile || !fs.existsSync(logFile)) {return 'No log file found.';}
  try { return fs.readFileSync(logFile, 'utf8'); } catch (err) { return `Error reading log file: ${err}`; }
}

export function readLogsFromFileOffset(
  executionKey: string,
  byteOffset: number,
  storagePath: string | undefined,
  logFiles: Map<string, string>,
): string {
  const logFile = getLogFilePathByKey(executionKey, storagePath, logFiles);
  if (!logFile) {return 'No log file found.';}
  try {
    if (byteOffset <= 0) {return fs.readFileSync(logFile, 'utf8');}
    const fd = fs.openSync(logFile, 'r');
    try {
      const fileSize = fs.fstatSync(fd).size;
      if (byteOffset >= fileSize) {return '';}
      const length = fileSize - byteOffset;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, byteOffset);
      return buffer.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (err: any) {
    if (err.code === 'ENOENT') {return 'No log file found.';}
    return `Error reading log file: ${err}`;
  }
}
