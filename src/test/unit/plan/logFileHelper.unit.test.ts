/**
 * @fileoverview Unit tests for logFileHelper
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getLogFilePathByKey,
  appendToLogFile,
  readLogsFromFile,
  readLogsFromFileOffset,
} from '../../../plan/logFileHelper';
import type { LogEntry } from '../../../plan/types';

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logfile-test-'));
  tmpDirs.push(dir);
  return dir;
}

suite('logFileHelper', () => {
  teardown(() => {
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    tmpDirs = [];
  });

  suite('getLogFilePathByKey', () => {
    test('returns undefined when storagePath is undefined', () => {
      const logFiles = new Map<string, string>();
      assert.strictEqual(getLogFilePathByKey('key', undefined, logFiles), undefined);
    });

    test('returns a path under storagePath/plans', () => {
      const logFiles = new Map<string, string>();
      const result = getLogFilePathByKey('plan-1:node-1:1', '/storage', logFiles);
      assert.ok(result);
      assert.ok(result.includes('plans'));
    });

    test('caches the path in logFiles map', () => {
      const logFiles = new Map<string, string>();
      const first = getLogFilePathByKey('plan1:node1:1', '/storage', logFiles);
      const second = getLogFilePathByKey('plan1:node1:1', '/storage', logFiles);
      assert.strictEqual(first, second);
      assert.strictEqual(logFiles.size, 1);
    });

    test('sanitizes key to safe filename', () => {
      const logFiles = new Map<string, string>();
      const result = getLogFilePathByKey('plan:node:1', '/storage', logFiles);
      assert.ok(result);
      assert.ok(!path.basename(result!).includes(':'));
    });
  });

  suite('appendToLogFile', () => {
    test('creates log file with header on first append', () => {
      const dir = makeTmpDir();
      const logFiles = new Map<string, string>();
      const entry: LogEntry = {
        timestamp: Date.now(),
        phase: 'work',
        type: 'info',
        message: 'test message',
      };
      appendToLogFile('plan1:node1:1', entry, dir, logFiles);
      const logFile = logFiles.get('plan1:node1:1')!;
      assert.ok(fs.existsSync(logFile));
      const content = fs.readFileSync(logFile, 'utf8');
      assert.ok(content.includes('test message'));
      assert.ok(content.includes('[WORK]'));
      // Header should also be present
      assert.ok(content.includes('Copilot Orchestrator'));
    });

    test('does nothing when storagePath is undefined', () => {
      const logFiles = new Map<string, string>();
      const entry: LogEntry = { timestamp: Date.now(), phase: 'work', type: 'info', message: 'msg' };
      appendToLogFile('plan1:node1:1', entry, undefined, logFiles);
      assert.strictEqual(logFiles.size, 0);
    });

    test('handles stderr prefix', () => {
      const dir = makeTmpDir();
      const logFiles = new Map<string, string>();
      const entry: LogEntry = { timestamp: Date.now(), phase: 'work', type: 'stderr', message: 'error msg' };
      appendToLogFile('plan1:node1:1', entry, dir, logFiles);
      const content = fs.readFileSync(logFiles.get('plan1:node1:1')!, 'utf8');
      assert.ok(content.includes('[ERR]'));
    });

    test('handles error prefix', () => {
      const dir = makeTmpDir();
      const logFiles = new Map<string, string>();
      const entry: LogEntry = { timestamp: Date.now(), phase: 'work', type: 'error', message: 'err' };
      appendToLogFile('plan1:node1:1', entry, dir, logFiles);
      const content = fs.readFileSync(logFiles.get('plan1:node1:1')!, 'utf8');
      assert.ok(content.includes('[ERROR]'));
    });

    test('handles stdout prefix (empty)', () => {
      const dir = makeTmpDir();
      const logFiles = new Map<string, string>();
      const entry: LogEntry = { timestamp: Date.now(), phase: 'prechecks', type: 'stdout', message: 'out' };
      appendToLogFile('plan1:node1:1', entry, dir, logFiles);
      const content = fs.readFileSync(logFiles.get('plan1:node1:1')!, 'utf8');
      assert.ok(content.includes('[PRECHECKS]'));
    });
  });

  suite('readLogsFromFile', () => {
    test('returns "No log file found." when log file does not exist on disk', () => {
      const dir = makeTmpDir();
      const logFiles = new Map<string, string>();
      const result = readLogsFromFile('plan1:node1:1', dir, logFiles);
      // getLogFilePathByKey no longer auto-creates — read should report not found
      assert.ok(result.includes('No log file found'));
    });

    test('returns "No log file found." when storagePath is undefined', () => {
      const logFiles = new Map<string, string>();
      const result = readLogsFromFile('plan1:node1:1', undefined, logFiles);
      assert.ok(result.includes('No log file found'));
    });

    test('reads existing log file', () => {
      const dir = makeTmpDir();
      const logFiles = new Map<string, string>();
      const entry: LogEntry = { timestamp: Date.now(), phase: 'work', type: 'info', message: 'hello' };
      appendToLogFile('plan1:node1:1', entry, dir, logFiles);
      const result = readLogsFromFile('plan1:node1:1', dir, logFiles);
      assert.ok(result.includes('hello'));
    });
  });

  suite('readLogsFromFileOffset', () => {
    test('returns "No log file found." when no storagePath', () => {
      const logFiles = new Map<string, string>();
      const result = readLogsFromFileOffset('plan1:node1:1', 0, undefined, logFiles);
      assert.ok(result.includes('No log file found'));
    });

    test('reads full file when offset <= 0', () => {
      const dir = makeTmpDir();
      const logFiles = new Map<string, string>();
      const entry: LogEntry = { timestamp: Date.now(), phase: 'work', type: 'info', message: 'full read' };
      appendToLogFile('plan1:node1:1', entry, dir, logFiles);
      const result = readLogsFromFileOffset('plan1:node1:1', 0, dir, logFiles);
      assert.ok(result.includes('full read'));
    });

    test('reads from offset', () => {
      const dir = makeTmpDir();
      const logFiles = new Map<string, string>();
      appendToLogFile('plan1:node1:1', { timestamp: Date.now(), phase: 'work', type: 'info', message: 'line1' }, dir, logFiles);
      appendToLogFile('plan1:node1:1', { timestamp: Date.now(), phase: 'work', type: 'info', message: 'line2' }, dir, logFiles);
      const fullContent = readLogsFromFile('plan1:node1:1', dir, logFiles);
      const partialContent = readLogsFromFileOffset('plan1:node1:1', 10, dir, logFiles);
      assert.ok(partialContent.length < fullContent.length);
    });

    test('returns empty string when offset >= file size', () => {
      const dir = makeTmpDir();
      const logFiles = new Map<string, string>();
      appendToLogFile('plan1:node1:1', { timestamp: Date.now(), phase: 'work', type: 'info', message: 'x' }, dir, logFiles);
      const result = readLogsFromFileOffset('plan1:node1:1', 999999, dir, logFiles);
      assert.strictEqual(result, '');
    });

    test('returns "No log file found." for ENOENT', () => {
      const logFiles = new Map<string, string>();
      logFiles.set('plan1:node1:1', '/nonexistent/path.log');
      const result = readLogsFromFileOffset('plan1:node1:1', 5, '/nonexistent', logFiles);
      assert.ok(result.includes('No log file found'));
    });
  });
});
