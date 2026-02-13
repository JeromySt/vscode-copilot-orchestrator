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
  }
  return logFile;
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
