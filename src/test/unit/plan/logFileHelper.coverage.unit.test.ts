/**
 * @fileoverview Coverage tests for uncovered paths in logFileHelper.ts
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import { suite, test, setup, teardown } from 'mocha';
import {
  getLegacyLogFilePath,
  getLogFilePathForAttempt,
  getLogFilePathByKey,
  readLogsFromFileOffset,
} from '../../../plan/logFileHelper';

let tmpDirs: string[] = [];

suite('logFileHelper coverage', () => {
  teardown(() => {
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    tmpDirs = [];
  });

  suite('getLegacyLogFilePath', () => {
    test('returns path under storagePath/logs', () => {
      const result = getLegacyLogFilePath('plan-1', 'node-1', 1, '/storage');
      assert.ok(result.includes('logs'));
      assert.ok(result.endsWith('.log'));
    });

    test('encodes planId, nodeId and attempt in filename', () => {
      const result = getLegacyLogFilePath('p1', 'n2', 3, '/storage');
      assert.ok(result.includes('p1_n2_3'));
    });
  });

  suite('getLogFilePathForAttempt', () => {
    test('returns undefined when storagePath is undefined', () => {
      assert.strictEqual(getLogFilePathForAttempt('p', 'n', 1, undefined), undefined);
    });

    test('returns path with attempt number', () => {
      const result = getLogFilePathForAttempt('p1', 'n1', 2, '/storage');
      assert.ok(result);
      assert.ok(result!.includes('attempts'));
      assert.ok(result!.includes('2'));
    });
  });

  suite('getLogFilePathByKey edge cases', () => {
    test('returns undefined for key with missing nodeId', () => {
      const logFiles = new Map<string, string>();
      const result = getLogFilePathByKey('planOnly', '/storage', logFiles);
      assert.strictEqual(result, undefined);
    });
  });

  suite('readLogsFromFileOffset – error paths (lines 188-191)', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
      sandbox = sinon.createSandbox();
    });

    teardown(() => {
      sandbox.restore();
    });

    test('returns "No log file found." when readFileSync throws ENOENT (line 189)', () => {
      const logFiles = new Map<string, string>([['plan-1:node-1:1', '/fake/log/file.log']]);
      const fsModule = require('fs');
      const origReadFileSync = fsModule.readFileSync;
      fsModule.readFileSync = (file: string, ...args: any[]) => {
        if (file === '/fake/log/file.log') {
          throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
        }
        return origReadFileSync(file, ...args);
      };
      try {
        const result = readLogsFromFileOffset('plan-1:node-1:1', 0, '/storage', logFiles);
        assert.strictEqual(result, 'No log file found.');
      } finally {
        fsModule.readFileSync = origReadFileSync;
      }
    });

    test('returns error message when readFileSync throws non-ENOENT error (line 190)', () => {
      const logFiles = new Map<string, string>([['plan-1:node-1:1', '/fake/log/file.log']]);
      const fsModule = require('fs');
      const origReadFileSync = fsModule.readFileSync;
      fsModule.readFileSync = (file: string, ...args: any[]) => {
        if (file === '/fake/log/file.log') {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        return origReadFileSync(file, ...args);
      };
      try {
        const result = readLogsFromFileOffset('plan-1:node-1:1', 0, '/storage', logFiles);
        assert.ok(result.startsWith('Error reading log file:'));
      } finally {
        fsModule.readFileSync = origReadFileSync;
      }
    });
  });
});
