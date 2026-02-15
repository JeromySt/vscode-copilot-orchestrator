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

    test('returns a path under storagePath/logs', () => {
      const logFiles = new Map<string, string>();
      const result = getLogFilePathByKey('plan-1:node-1:1', '/storage', logFiles);
      assert.ok(result);
      assert.ok(result.includes('logs'));
    });

    test('caches the path in logFiles map', () => {
      const logFiles = new Map<string, string>();
      const first = getLogFilePathByKey('key1', '/storage', logFiles);
      const second = getLogFilePathByKey('key1', '/storage', logFiles);
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
    test('creates log file and appends entry', () => {
      const dir = makeTmpDir();
      const orchDir = path.join(dir, '.orchestrator');
      fs.mkdirSync(path.join(orchDir, 'logs'), { recursive: true });
      const logFiles = new Map<string, string>();
      const entry: LogEntry = {
        timestamp: Date.now(),
        phase: 'work',
        type: 'info',
        message: 'test message',
      };
      appendToLogFile('key1', entry, orchDir, logFiles);
      const logFile = logFiles.get('key1')!;
      assert.ok(fs.existsSync(logFile));
      const content = fs.readFileSync(logFile, 'utf8');
      assert.ok(content.includes('test message'));
      assert.ok(content.includes('[WORK]'));
    });

    test('does nothing when storagePath is undefined', () => {
      const logFiles = new Map<string, string>();
      const entry: LogEntry = { timestamp: Date.now(), phase: 'work', type: 'info', message: 'msg' };
      appendToLogFile('key1', entry, undefined, logFiles);
      assert.strictEqual(logFiles.size, 0);
    });

    test('handles stderr prefix', () => {
      const dir = makeTmpDir();
      const orchDir = path.join(dir, '.orchestrator');
      fs.mkdirSync(path.join(orchDir, 'logs'), { recursive: true });
      const logFiles = new Map<string, string>();
      const entry: LogEntry = { timestamp: Date.now(), phase: 'work', type: 'stderr', message: 'error msg' };
      appendToLogFile('key1', entry, orchDir, logFiles);
      const content = fs.readFileSync(logFiles.get('key1')!, 'utf8');
      assert.ok(content.includes('[ERR]'));
    });

    test('handles error prefix', () => {
      const dir = makeTmpDir();
      const orchDir = path.join(dir, '.orchestrator');
      fs.mkdirSync(path.join(orchDir, 'logs'), { recursive: true });
      const logFiles = new Map<string, string>();
      const entry: LogEntry = { timestamp: Date.now(), phase: 'work', type: 'error', message: 'err' };
      appendToLogFile('key1', entry, orchDir, logFiles);
      const content = fs.readFileSync(logFiles.get('key1')!, 'utf8');
      assert.ok(content.includes('[ERROR]'));
    });

    test('handles stdout prefix (empty)', () => {
      const dir = makeTmpDir();
      const orchDir = path.join(dir, '.orchestrator');
      fs.mkdirSync(path.join(orchDir, 'logs'), { recursive: true });
      const logFiles = new Map<string, string>();
      const entry: LogEntry = { timestamp: Date.now(), phase: 'prechecks', type: 'stdout', message: 'out' };
      appendToLogFile('key1', entry, orchDir, logFiles);
      const content = fs.readFileSync(logFiles.get('key1')!, 'utf8');
      assert.ok(content.includes('[PRECHECKS]'));
    });
  });

  suite('readLogsFromFile', () => {
    test('returns header content when storagePath is provided (file auto-created)', () => {
      const dir = makeTmpDir();
      const orchDir = path.join(dir, '.orchestrator');
      fs.mkdirSync(path.join(orchDir, 'logs'), { recursive: true });
      const logFiles = new Map<string, string>();
      const result = readLogsFromFile('key1', orchDir, logFiles);
      // getLogFilePathByKey now auto-creates the log file with a header
      assert.ok(result.includes('Copilot Orchestrator'));
    });

    test('returns "No log file found." when storagePath is undefined', () => {
      const logFiles = new Map<string, string>();
      const result = readLogsFromFile('key1', undefined, logFiles);
      assert.ok(result.includes('No log file found'));
    });

    test('reads existing log file', () => {
      const dir = makeTmpDir();
      const orchDir = path.join(dir, '.orchestrator');
      fs.mkdirSync(path.join(orchDir, 'logs'), { recursive: true });
      const logFiles = new Map<string, string>();
      const entry: LogEntry = { timestamp: Date.now(), phase: 'work', type: 'info', message: 'hello' };
      appendToLogFile('key1', entry, orchDir, logFiles);
      const result = readLogsFromFile('key1', orchDir, logFiles);
      assert.ok(result.includes('hello'));
    });
  });

  suite('readLogsFromFileOffset', () => {
    test('returns "No log file found." when no storagePath', () => {
      const logFiles = new Map<string, string>();
      const result = readLogsFromFileOffset('key1', 0, undefined, logFiles);
      assert.ok(result.includes('No log file found'));
    });

    test('reads full file when offset <= 0', () => {
      const dir = makeTmpDir();
      const orchDir = path.join(dir, '.orchestrator');
      fs.mkdirSync(path.join(orchDir, 'logs'), { recursive: true });
      const logFiles = new Map<string, string>();
      const entry: LogEntry = { timestamp: Date.now(), phase: 'work', type: 'info', message: 'full read' };
      appendToLogFile('key1', entry, orchDir, logFiles);
      const result = readLogsFromFileOffset('key1', 0, orchDir, logFiles);
      assert.ok(result.includes('full read'));
    });

    test('reads from offset', () => {
      const dir = makeTmpDir();
      const orchDir = path.join(dir, '.orchestrator');
      fs.mkdirSync(path.join(orchDir, 'logs'), { recursive: true });
      const logFiles = new Map<string, string>();
      appendToLogFile('key1', { timestamp: Date.now(), phase: 'work', type: 'info', message: 'line1' }, orchDir, logFiles);
      appendToLogFile('key1', { timestamp: Date.now(), phase: 'work', type: 'info', message: 'line2' }, orchDir, logFiles);
      const fullContent = readLogsFromFile('key1', orchDir, logFiles);
      const partialContent = readLogsFromFileOffset('key1', 10, orchDir, logFiles);
      assert.ok(partialContent.length < fullContent.length);
    });

    test('returns empty string when offset >= file size', () => {
      const dir = makeTmpDir();
      const orchDir = path.join(dir, '.orchestrator');
      fs.mkdirSync(path.join(orchDir, 'logs'), { recursive: true });
      const logFiles = new Map<string, string>();
      appendToLogFile('key1', { timestamp: Date.now(), phase: 'work', type: 'info', message: 'x' }, orchDir, logFiles);
      const result = readLogsFromFileOffset('key1', 999999, orchDir, logFiles);
      assert.strictEqual(result, '');
    });

    test('returns "No log file found." for ENOENT', () => {
      const logFiles = new Map<string, string>();
      logFiles.set('key1', '/nonexistent/path.log');
      const result = readLogsFromFileOffset('key1', 5, '/nonexistent', logFiles);
      assert.ok(result.includes('No log file found'));
    });
  });
});
