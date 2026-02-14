/**
 * @fileoverview Unit tests for core utilities
 * 
 * Tests cover:
 * - Synchronous file/directory operations
 * - Asynchronous file/directory operations  
 * - JSON read/write operations
 * - System utilities
 * - Directory initialization utilities
 * - Error handling and edge cases
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ensureDir,
  readJSON,
  writeJSON,
  ensureDirAsync,
  readJSONAsync,
  writeJSONAsync,
  existsAsync,
  cpuCountMinusOne,
  ensureOrchestratorDirs
} from '../../../core/utils';

suite('Utils Unit Tests', () => {
  let tempDir: string;
  let sandbox: sinon.SinonSandbox;

  setup(async () => {
    sandbox = sinon.createSandbox();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utils-test-'));
  });

  teardown(async () => {
    sandbox.restore();
    if (tempDir && fs.existsSync(tempDir)) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // Synchronous utilities
  // =========================================================================

  suite('ensureDir', () => {
    test('creates directory if it does not exist', () => {
      const testDir = path.join(tempDir, 'new-dir');
      assert.ok(!fs.existsSync(testDir));
      
      ensureDir(testDir);
      
      assert.ok(fs.existsSync(testDir));
      assert.ok(fs.statSync(testDir).isDirectory());
    });

    test('does not error if directory already exists', () => {
      const testDir = path.join(tempDir, 'existing-dir');
      fs.mkdirSync(testDir);
      
      // Should not throw
      ensureDir(testDir);
      
      assert.ok(fs.existsSync(testDir));
    });

    test('creates parent directories recursively', () => {
      const testDir = path.join(tempDir, 'deep', 'nested', 'dir');
      
      ensureDir(testDir);
      
      assert.ok(fs.existsSync(testDir));
      assert.ok(fs.existsSync(path.dirname(testDir)));
    });
  });

  suite('readJSON', () => {
    test('reads and parses valid JSON file', () => {
      const testFile = path.join(tempDir, 'test.json');
      const testData = { foo: 'bar', num: 42 };
      fs.writeFileSync(testFile, JSON.stringify(testData));
      
      const result = readJSON(testFile, {});
      
      assert.deepStrictEqual(result, testData);
    });

    test('returns fallback for non-existent file', () => {
      const testFile = path.join(tempDir, 'non-existent.json');
      const fallback = { default: true };
      
      const result = readJSON(testFile, fallback);
      
      assert.deepStrictEqual(result, fallback);
    });

    test('returns fallback for invalid JSON', () => {
      const testFile = path.join(tempDir, 'invalid.json');
      fs.writeFileSync(testFile, 'invalid json content');
      const fallback = { error: true };
      
      const result = readJSON(testFile, fallback);
      
      assert.deepStrictEqual(result, fallback);
    });

    test('preserves fallback type', () => {
      const testFile = path.join(tempDir, 'missing.json');
      
      const stringResult = readJSON(testFile, 'default');
      const numberResult = readJSON(testFile, 42);
      const arrayResult = readJSON(testFile, [1, 2, 3]);
      
      assert.strictEqual(stringResult, 'default');
      assert.strictEqual(numberResult, 42);
      assert.deepStrictEqual(arrayResult, [1, 2, 3]);
    });
  });

  suite('writeJSON', () => {
    test('writes object to JSON file with formatting', () => {
      const testFile = path.join(tempDir, 'output.json');
      const testData = { name: 'test', value: 123, nested: { prop: true } };
      
      writeJSON(testFile, testData);
      
      assert.ok(fs.existsSync(testFile));
      const content = fs.readFileSync(testFile, 'utf8');
      const parsed = JSON.parse(content);
      assert.deepStrictEqual(parsed, testData);
      
      // Should be formatted (with spaces)
      assert.ok(content.includes('  "name"'));
    });

    test('creates parent directories if needed', () => {
      const testFile = path.join(tempDir, 'deep', 'nested', 'output.json');
      const testData = { created: 'dirs' };
      
      writeJSON(testFile, testData);
      
      assert.ok(fs.existsSync(testFile));
      const parsed = JSON.parse(fs.readFileSync(testFile, 'utf8'));
      assert.deepStrictEqual(parsed, testData);
    });

    test('overwrites existing file', () => {
      const testFile = path.join(tempDir, 'overwrite.json');
      writeJSON(testFile, { first: 'data' });
      
      writeJSON(testFile, { second: 'data' });
      
      const result = JSON.parse(fs.readFileSync(testFile, 'utf8'));
      assert.deepStrictEqual(result, { second: 'data' });
    });
  });

  // =========================================================================
  // Async utilities
  // =========================================================================

  suite('ensureDirAsync', () => {
    test('creates directory if it does not exist', async () => {
      const testDir = path.join(tempDir, 'async-dir');
      assert.ok(!fs.existsSync(testDir));
      
      await ensureDirAsync(testDir);
      
      assert.ok(fs.existsSync(testDir));
      assert.ok(fs.statSync(testDir).isDirectory());
    });

    test('does not error if directory already exists', async () => {
      const testDir = path.join(tempDir, 'existing-async-dir');
      await fs.promises.mkdir(testDir);
      
      await ensureDirAsync(testDir);
      
      assert.ok(fs.existsSync(testDir));
    });

    test('creates parent directories recursively', async () => {
      const testDir = path.join(tempDir, 'async', 'deep', 'nested');
      
      await ensureDirAsync(testDir);
      
      assert.ok(fs.existsSync(testDir));
      assert.ok(fs.existsSync(path.dirname(testDir)));
    });
  });

  suite('readJSONAsync', () => {
    test('reads and parses valid JSON file', async () => {
      const testFile = path.join(tempDir, 'async-test.json');
      const testData = { async: true, count: 99 };
      await fs.promises.writeFile(testFile, JSON.stringify(testData));
      
      const result = await readJSONAsync(testFile, {});
      
      assert.deepStrictEqual(result, testData);
    });

    test('returns fallback for non-existent file', async () => {
      const testFile = path.join(tempDir, 'async-missing.json');
      const fallback = { notFound: true };
      
      const result = await readJSONAsync(testFile, fallback);
      
      assert.deepStrictEqual(result, fallback);
    });

    test('returns fallback for invalid JSON', async () => {
      const testFile = path.join(tempDir, 'async-invalid.json');
      await fs.promises.writeFile(testFile, 'not json');
      const fallback = { parseError: true };
      
      const result = await readJSONAsync(testFile, fallback);
      
      assert.deepStrictEqual(result, fallback);
    });

    test('handles permission errors', async () => {
      const testFile = path.join(tempDir, 'no-access.json');
      await fs.promises.writeFile(testFile, '{"data": true}');
      
      // Mock access failure
      sandbox.stub(fs.promises, 'readFile').rejects(new Error('EACCES: permission denied'));
      
      const fallback = { accessDenied: true };
      const result = await readJSONAsync(testFile, fallback);
      
      assert.deepStrictEqual(result, fallback);
    });
  });

  suite('writeJSONAsync', () => {
    test('writes object to JSON file with formatting', async () => {
      const testFile = path.join(tempDir, 'async-output.json');
      const testData = { async: 'write', timestamp: Date.now() };
      
      await writeJSONAsync(testFile, testData);
      
      assert.ok(fs.existsSync(testFile));
      const content = await fs.promises.readFile(testFile, 'utf8');
      const parsed = JSON.parse(content);
      assert.deepStrictEqual(parsed, testData);
    });

    test('creates parent directories asynchronously', async () => {
      const testFile = path.join(tempDir, 'async-deep', 'nested', 'file.json');
      const testData = { deepAsync: true };
      
      await writeJSONAsync(testFile, testData);
      
      assert.ok(fs.existsSync(testFile));
      const parsed = JSON.parse(await fs.promises.readFile(testFile, 'utf8'));
      assert.deepStrictEqual(parsed, testData);
    });
  });

  suite('existsAsync', () => {
    test('returns true for existing file', async () => {
      const testFile = path.join(tempDir, 'exists.txt');
      await fs.promises.writeFile(testFile, 'content');
      
      const result = await existsAsync(testFile);
      
      assert.strictEqual(result, true);
    });

    test('returns true for existing directory', async () => {
      const testDir = path.join(tempDir, 'exists-dir');
      await fs.promises.mkdir(testDir);
      
      const result = await existsAsync(testDir);
      
      assert.strictEqual(result, true);
    });

    test('returns false for non-existent path', async () => {
      const testPath = path.join(tempDir, 'does-not-exist');
      
      const result = await existsAsync(testPath);
      
      assert.strictEqual(result, false);
    });

    test('returns false on access error', async () => {
      sandbox.stub(fs.promises, 'access').rejects(new Error('ENOENT'));
      
      const result = await existsAsync('/some/path');
      
      assert.strictEqual(result, false);
    });
  });

  // =========================================================================
  // System utilities
  // =========================================================================

  suite('cpuCountMinusOne', () => {
    test('returns CPU count minus one for multi-core systems', () => {
      // Test indirectly by checking the function returns a reasonable value
      const result = cpuCountMinusOne();
      
      // Should return at least 1 and likely less than 64 cores
      assert.ok(result >= 1);
      assert.ok(result <= 64);
      assert.strictEqual(typeof result, 'number');
    });

    test('returns positive number', () => {
      const result = cpuCountMinusOne();
      
      // Should always return a positive integer
      assert.ok(result > 0);
      assert.ok(Number.isInteger(result));
    });
  });

  // =========================================================================
  // Directory initialization utilities
  // =========================================================================

  suite('ensureOrchestratorDirs', () => {
    test('creates .orchestrator and all subdirectories', () => {
      const workspaceDir = path.join(tempDir, 'workspace');
      fs.mkdirSync(workspaceDir);
      
      const result = ensureOrchestratorDirs(workspaceDir);
      
      const expectedPath = path.join(workspaceDir, '.orchestrator');
      assert.strictEqual(result, expectedPath);
      assert.ok(fs.existsSync(expectedPath));
      
      // Check all subdirectories
      const subdirs = ['plans', 'logs', 'evidence', '.copilot'];
      for (const subdir of subdirs) {
        const subdirPath = path.join(expectedPath, subdir);
        assert.ok(fs.existsSync(subdirPath), `Missing subdir: ${subdir}`);
        assert.ok(fs.statSync(subdirPath).isDirectory(), `Not a directory: ${subdir}`);
      }
    });

    test('does not error if .orchestrator already exists', () => {
      const workspaceDir = path.join(tempDir, 'existing-workspace');
      const orchestratorDir = path.join(workspaceDir, '.orchestrator');
      fs.mkdirSync(orchestratorDir, { recursive: true });
      
      const result = ensureOrchestratorDirs(workspaceDir);
      
      assert.strictEqual(result, orchestratorDir);
      assert.ok(fs.existsSync(orchestratorDir));
    });

    test('creates missing subdirectories if some exist', () => {
      const workspaceDir = path.join(tempDir, 'partial-workspace');
      const orchestratorDir = path.join(workspaceDir, '.orchestrator');
      const plansDir = path.join(orchestratorDir, 'plans');
      
      fs.mkdirSync(plansDir, { recursive: true });
      
      const result = ensureOrchestratorDirs(workspaceDir);
      
      assert.strictEqual(result, orchestratorDir);
      
      // Check all subdirectories exist now
      const subdirs = ['plans', 'logs', 'evidence', '.copilot'];
      for (const subdir of subdirs) {
        const subdirPath = path.join(orchestratorDir, subdir);
        assert.ok(fs.existsSync(subdirPath), `Missing subdir: ${subdir}`);
      }
    });
  });

  suite('ensureDir', () => {
    test('creates directory if it does not exist', () => {
      const testDir = path.join(tempDir, 'ensure-test');
      assert.ok(!fs.existsSync(testDir));
      
      ensureDir(testDir);
      
      assert.ok(fs.existsSync(testDir));
      assert.ok(fs.statSync(testDir).isDirectory());
    });

    test('does not error if directory already exists', () => {
      const testDir = path.join(tempDir, 'ensure-existing');
      fs.mkdirSync(testDir);
      
      ensureDir(testDir);
      
      assert.ok(fs.existsSync(testDir));
    });

    test('creates parent directories recursively', () => {
      const testDir = path.join(tempDir, 'ensure', 'deep', 'path');
      
      ensureDir(testDir);
      
      assert.ok(fs.existsSync(testDir));
      assert.ok(fs.existsSync(path.dirname(testDir)));
    });
  });

  // =========================================================================
  // Integration tests
  // =========================================================================

  suite('integration', () => {
    test('sync and async operations produce same results', async () => {
      const testData = { integration: true, value: 'test' };
      
      // Write with sync
      const syncFile = path.join(tempDir, 'sync.json');
      writeJSON(syncFile, testData);
      
      // Write with async
      const asyncFile = path.join(tempDir, 'async.json');
      await writeJSONAsync(asyncFile, testData);
      
      // Read both
      const syncResult = readJSON(syncFile, {});
      const asyncResult = await readJSONAsync(asyncFile, {});
      
      assert.deepStrictEqual(syncResult, testData);
      assert.deepStrictEqual(asyncResult, testData);
      assert.deepStrictEqual(syncResult, asyncResult);
    });

    test('directory utilities work together', async () => {
      const workspaceDir = path.join(tempDir, 'integration-workspace');
      
      // Use ensureOrchestratorDirs
      const orchestratorDir = ensureOrchestratorDirs(workspaceDir);
      
      // Use other directory utilities
      const customDir = path.join(workspaceDir, 'custom');
      ensureDir(customDir);
      
      const asyncDir = path.join(workspaceDir, 'async-custom');
      await ensureDirAsync(asyncDir);
      
      // Verify all exist
      assert.ok(fs.existsSync(orchestratorDir));
      assert.ok(fs.existsSync(customDir));
      assert.ok(fs.existsSync(asyncDir));
      
      // Use existsAsync to verify
      assert.ok(await existsAsync(orchestratorDir));
      assert.ok(await existsAsync(customDir));
      assert.ok(await existsAsync(asyncDir));
    });
  });
});