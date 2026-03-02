/**
 * @fileoverview Coverage tests for uncovered paths in logFileHelper.ts
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { suite, test, teardown } from 'mocha';
import {
  getLegacyLogFilePath,
  getLogFilePathForAttempt,
  getLogFilePathByKey,
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
});
