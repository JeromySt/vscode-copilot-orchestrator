/**
 * @fileoverview Unit tests for DefaultFileSystem
 * 
 * Tests cover all IFileSystem interface methods implemented by DefaultFileSystem:
 * - Sync file operations (ensureDir, readJSON, writeJSON, existsSync, etc.)
 * - Async file operations (ensureDirAsync, readJSONAsync, writeJSONAsync, etc.)
 * - Low-level file operations (rename, unlink, mkdir, readdir, etc.)
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DefaultFileSystem } from '../../../core/defaultFileSystem';

suite('DefaultFileSystem', () => {
  let sandbox: sinon.SinonSandbox;
  let tempDir: string;
  let fileSystem: DefaultFileSystem;

  setup(async () => {
    sandbox = sinon.createSandbox();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dfs-test-'));
    fileSystem = new DefaultFileSystem();
  });

  teardown(async () => {
    sandbox.restore();
    if (tempDir && fs.existsSync(tempDir)) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // Sync Operations
  // =========================================================================

  suite('ensureDir', () => {
    test('creates directory if it does not exist', () => {
      const testDir = path.join(tempDir, 'new-dir');
      assert.ok(!fs.existsSync(testDir));

      fileSystem.ensureDir(testDir);

      assert.ok(fs.existsSync(testDir));
      assert.ok(fs.statSync(testDir).isDirectory());
    });

    test('does not error if directory already exists', () => {
      const testDir = path.join(tempDir, 'existing-dir');
      fs.mkdirSync(testDir);

      // Should not throw
      fileSystem.ensureDir(testDir);

      assert.ok(fs.existsSync(testDir));
    });

    test('creates parent directories recursively', () => {
      const testDir = path.join(tempDir, 'deep', 'nested', 'dir');

      fileSystem.ensureDir(testDir);

      assert.ok(fs.existsSync(testDir));
      assert.ok(fs.existsSync(path.dirname(testDir)));
    });
  });

  suite('readJSON', () => {
    test('reads and parses valid JSON file', () => {
      const testFile = path.join(tempDir, 'test.json');
      const testData = { foo: 'bar', num: 42 };
      fs.writeFileSync(testFile, JSON.stringify(testData));

      const result = fileSystem.readJSON(testFile, {});

      assert.deepStrictEqual(result, testData);
    });

    test('returns fallback for non-existent file', () => {
      const testFile = path.join(tempDir, 'non-existent.json');
      const fallback = { default: true };

      const result = fileSystem.readJSON(testFile, fallback);

      assert.deepStrictEqual(result, fallback);
    });

    test('returns fallback for invalid JSON', () => {
      const testFile = path.join(tempDir, 'invalid.json');
      fs.writeFileSync(testFile, 'invalid json content');
      const fallback = { error: true };

      const result = fileSystem.readJSON(testFile, fallback);

      assert.deepStrictEqual(result, fallback);
    });

    test('preserves fallback type', () => {
      const testFile = path.join(tempDir, 'missing.json');

      const stringResult = fileSystem.readJSON(testFile, 'default');
      const numberResult = fileSystem.readJSON(testFile, 42);
      const arrayResult = fileSystem.readJSON(testFile, [1, 2, 3]);

      assert.strictEqual(stringResult, 'default');
      assert.strictEqual(numberResult, 42);
      assert.deepStrictEqual(arrayResult, [1, 2, 3]);
    });
  });

  suite('writeJSON', () => {
    test('writes object to JSON file with formatting', () => {
      const testFile = path.join(tempDir, 'output.json');
      const testData = { name: 'test', value: 123, nested: { prop: true } };

      fileSystem.writeJSON(testFile, testData);

      assert.ok(fs.existsSync(testFile));
      const content = fs.readFileSync(testFile, 'utf8');
      const parsed = JSON.parse(content);
      assert.deepStrictEqual(parsed, testData);

      // Should be formatted (with 2-space indent)
      assert.ok(content.includes('  "name"'));
    });

    test('creates parent directories if needed', () => {
      const testFile = path.join(tempDir, 'deep', 'nested', 'output.json');
      const testData = { created: 'dirs' };

      fileSystem.writeJSON(testFile, testData);

      assert.ok(fs.existsSync(testFile));
      const parsed = JSON.parse(fs.readFileSync(testFile, 'utf8'));
      assert.deepStrictEqual(parsed, testData);
    });

    test('overwrites existing file', () => {
      const testFile = path.join(tempDir, 'overwrite.json');
      fileSystem.writeJSON(testFile, { first: 'data' });

      fileSystem.writeJSON(testFile, { second: 'data' });

      const result = JSON.parse(fs.readFileSync(testFile, 'utf8'));
      assert.deepStrictEqual(result, { second: 'data' });
    });
  });

  suite('existsSync', () => {
    test('returns true for existing file', () => {
      const testFile = path.join(tempDir, 'exists.txt');
      fs.writeFileSync(testFile, 'content');

      assert.strictEqual(fileSystem.existsSync(testFile), true);
    });

    test('returns true for existing directory', () => {
      const testDir = path.join(tempDir, 'exists-dir');
      fs.mkdirSync(testDir);

      assert.strictEqual(fileSystem.existsSync(testDir), true);
    });

    test('returns false for non-existent path', () => {
      const testPath = path.join(tempDir, 'does-not-exist');

      assert.strictEqual(fileSystem.existsSync(testPath), false);
    });
  });

  suite('writeFileSync', () => {
    test('writes content to file', () => {
      const testFile = path.join(tempDir, 'sync-write.txt');

      fileSystem.writeFileSync(testFile, 'test content');

      const content = fs.readFileSync(testFile, 'utf8');
      assert.strictEqual(content, 'test content');
    });
  });

  suite('renameSync', () => {
    test('renames file', () => {
      const oldPath = path.join(tempDir, 'old-name.txt');
      const newPath = path.join(tempDir, 'new-name.txt');
      fs.writeFileSync(oldPath, 'content');

      fileSystem.renameSync(oldPath, newPath);

      assert.ok(!fs.existsSync(oldPath));
      assert.ok(fs.existsSync(newPath));
      assert.strictEqual(fs.readFileSync(newPath, 'utf8'), 'content');
    });
  });

  suite('unlinkSync', () => {
    test('deletes file', () => {
      const testFile = path.join(tempDir, 'to-delete.txt');
      fs.writeFileSync(testFile, 'content');
      assert.ok(fs.existsSync(testFile));

      fileSystem.unlinkSync(testFile);

      assert.ok(!fs.existsSync(testFile));
    });
  });

  suite('mkdirSync', () => {
    test('creates directory', () => {
      const testDir = path.join(tempDir, 'mkdir-test');

      fileSystem.mkdirSync(testDir);

      assert.ok(fs.existsSync(testDir));
      assert.ok(fs.statSync(testDir).isDirectory());
    });

    test('creates directories recursively with options', () => {
      const testDir = path.join(tempDir, 'deep', 'mkdir', 'test');

      fileSystem.mkdirSync(testDir, { recursive: true });

      assert.ok(fs.existsSync(testDir));
    });
  });

  // =========================================================================
  // Async Operations
  // =========================================================================

  suite('ensureDirAsync', () => {
    test('creates directory if it does not exist', async () => {
      const testDir = path.join(tempDir, 'async-dir');
      assert.ok(!fs.existsSync(testDir));

      await fileSystem.ensureDirAsync(testDir);

      assert.ok(fs.existsSync(testDir));
      assert.ok(fs.statSync(testDir).isDirectory());
    });

    test('does not error if directory already exists', async () => {
      const testDir = path.join(tempDir, 'existing-async-dir');
      await fs.promises.mkdir(testDir);

      await fileSystem.ensureDirAsync(testDir);

      assert.ok(fs.existsSync(testDir));
    });

    test('creates parent directories recursively', async () => {
      const testDir = path.join(tempDir, 'async', 'deep', 'nested');

      await fileSystem.ensureDirAsync(testDir);

      assert.ok(fs.existsSync(testDir));
      assert.ok(fs.existsSync(path.dirname(testDir)));
    });
  });

  suite('readJSONAsync', () => {
    test('reads and parses valid JSON file', async () => {
      const testFile = path.join(tempDir, 'async-test.json');
      const testData = { async: true, count: 99 };
      await fs.promises.writeFile(testFile, JSON.stringify(testData));

      const result = await fileSystem.readJSONAsync(testFile, {});

      assert.deepStrictEqual(result, testData);
    });

    test('returns fallback for non-existent file', async () => {
      const testFile = path.join(tempDir, 'async-missing.json');
      const fallback = { notFound: true };

      const result = await fileSystem.readJSONAsync(testFile, fallback);

      assert.deepStrictEqual(result, fallback);
    });

    test('returns fallback for invalid JSON', async () => {
      const testFile = path.join(tempDir, 'async-invalid.json');
      await fs.promises.writeFile(testFile, 'not json');
      const fallback = { parseError: true };

      const result = await fileSystem.readJSONAsync(testFile, fallback);

      assert.deepStrictEqual(result, fallback);
    });
  });

  suite('writeJSONAsync', () => {
    test('writes object to JSON file with formatting', async () => {
      const testFile = path.join(tempDir, 'async-output.json');
      const testData = { async: 'write', timestamp: Date.now() };

      await fileSystem.writeJSONAsync(testFile, testData);

      assert.ok(fs.existsSync(testFile));
      const content = await fs.promises.readFile(testFile, 'utf8');
      const parsed = JSON.parse(content);
      assert.deepStrictEqual(parsed, testData);
    });

    test('creates parent directories asynchronously', async () => {
      const testFile = path.join(tempDir, 'async-deep', 'nested', 'file.json');
      const testData = { deepAsync: true };

      await fileSystem.writeJSONAsync(testFile, testData);

      assert.ok(fs.existsSync(testFile));
      const parsed = JSON.parse(await fs.promises.readFile(testFile, 'utf8'));
      assert.deepStrictEqual(parsed, testData);
    });
  });

  suite('existsAsync', () => {
    test('returns true for existing file', async () => {
      const testFile = path.join(tempDir, 'exists-async.txt');
      await fs.promises.writeFile(testFile, 'content');

      const result = await fileSystem.existsAsync(testFile);

      assert.strictEqual(result, true);
    });

    test('returns true for existing directory', async () => {
      const testDir = path.join(tempDir, 'exists-async-dir');
      await fs.promises.mkdir(testDir);

      const result = await fileSystem.existsAsync(testDir);

      assert.strictEqual(result, true);
    });

    test('returns false for non-existent path', async () => {
      const testPath = path.join(tempDir, 'does-not-exist-async');

      const result = await fileSystem.existsAsync(testPath);

      assert.strictEqual(result, false);
    });
  });

  suite('readFileAsync', () => {
    test('reads file content as string', async () => {
      const testFile = path.join(tempDir, 'read-async.txt');
      await fs.promises.writeFile(testFile, 'hello world');

      const content = await fileSystem.readFileAsync(testFile);

      assert.strictEqual(content, 'hello world');
    });
  });

  suite('writeFileAsync', () => {
    test('writes content to file', async () => {
      const testFile = path.join(tempDir, 'write-async.txt');

      await fileSystem.writeFileAsync(testFile, 'async content');

      const content = await fs.promises.readFile(testFile, 'utf8');
      assert.strictEqual(content, 'async content');
    });
  });

  suite('renameAsync', () => {
    test('renames file asynchronously', async () => {
      const oldPath = path.join(tempDir, 'old-async.txt');
      const newPath = path.join(tempDir, 'new-async.txt');
      await fs.promises.writeFile(oldPath, 'content');

      await fileSystem.renameAsync(oldPath, newPath);

      assert.ok(!fs.existsSync(oldPath));
      assert.ok(fs.existsSync(newPath));
      const content = await fs.promises.readFile(newPath, 'utf8');
      assert.strictEqual(content, 'content');
    });
  });

  suite('unlinkAsync', () => {
    test('deletes file asynchronously', async () => {
      const testFile = path.join(tempDir, 'to-unlink-async.txt');
      await fs.promises.writeFile(testFile, 'content');
      assert.ok(fs.existsSync(testFile));

      await fileSystem.unlinkAsync(testFile);

      assert.ok(!fs.existsSync(testFile));
    });
  });

  suite('rmAsync', () => {
    test('removes file', async () => {
      const testFile = path.join(tempDir, 'to-rm.txt');
      await fs.promises.writeFile(testFile, 'content');

      await fileSystem.rmAsync(testFile);

      assert.ok(!fs.existsSync(testFile));
    });

    test('removes directory recursively', async () => {
      const testDir = path.join(tempDir, 'rm-recursive');
      await fs.promises.mkdir(path.join(testDir, 'nested'), { recursive: true });
      await fs.promises.writeFile(path.join(testDir, 'file.txt'), 'content');
      await fs.promises.writeFile(path.join(testDir, 'nested', 'file.txt'), 'nested');

      await fileSystem.rmAsync(testDir, { recursive: true });

      assert.ok(!fs.existsSync(testDir));
    });

    test('force removes even if path does not exist', async () => {
      const testPath = path.join(tempDir, 'non-existent-rm');

      // Should not throw
      await fileSystem.rmAsync(testPath, { force: true });
    });
  });

  suite('rmdirAsync', () => {
    test('removes empty directory', async () => {
      const testDir = path.join(tempDir, 'empty-dir');
      await fs.promises.mkdir(testDir);

      await fileSystem.rmdirAsync(testDir);

      assert.ok(!fs.existsSync(testDir));
    });
  });

  suite('mkdirAsync', () => {
    test('creates directory', async () => {
      const testDir = path.join(tempDir, 'mkdir-async');

      await fileSystem.mkdirAsync(testDir);

      assert.ok(fs.existsSync(testDir));
      assert.ok(fs.statSync(testDir).isDirectory());
    });

    test('creates directories recursively with options', async () => {
      const testDir = path.join(tempDir, 'deep', 'async', 'mkdir');

      await fileSystem.mkdirAsync(testDir, { recursive: true });

      assert.ok(fs.existsSync(testDir));
    });
  });

  suite('readdirAsync', () => {
    test('lists directory contents', async () => {
      const testDir = path.join(tempDir, 'readdir-test');
      await fs.promises.mkdir(testDir);
      await fs.promises.writeFile(path.join(testDir, 'file1.txt'), '1');
      await fs.promises.writeFile(path.join(testDir, 'file2.txt'), '2');
      await fs.promises.mkdir(path.join(testDir, 'subdir'));

      const entries = await fileSystem.readdirAsync(testDir);

      assert.ok(entries.includes('file1.txt'));
      assert.ok(entries.includes('file2.txt'));
      assert.ok(entries.includes('subdir'));
      assert.strictEqual(entries.length, 3);
    });
  });

  suite('lstatAsync', () => {
    test('returns stats for file', async () => {
      const testFile = path.join(tempDir, 'lstat-file.txt');
      await fs.promises.writeFile(testFile, 'content');

      const stats = await fileSystem.lstatAsync(testFile);

      assert.strictEqual(stats.isFile(), true);
      assert.strictEqual(stats.isDirectory(), false);
      assert.strictEqual(stats.isSymbolicLink(), false);
    });

    test('returns stats for directory', async () => {
      const testDir = path.join(tempDir, 'lstat-dir');
      await fs.promises.mkdir(testDir);

      const stats = await fileSystem.lstatAsync(testDir);

      assert.strictEqual(stats.isFile(), false);
      assert.strictEqual(stats.isDirectory(), true);
      assert.strictEqual(stats.isSymbolicLink(), false);
    });
  });

  suite('symlinkAsync', () => {
    test('creates symbolic link', async () => {
      const target = path.join(tempDir, 'symlink-target.txt');
      const linkPath = path.join(tempDir, 'symlink-link.txt');
      await fs.promises.writeFile(target, 'target content');

      await fileSystem.symlinkAsync(target, linkPath);

      const stats = await fs.promises.lstat(linkPath);
      assert.strictEqual(stats.isSymbolicLink(), true);
    });
  });

  suite('readlinkAsync', () => {
    test('reads symbolic link target', async () => {
      const target = path.join(tempDir, 'readlink-target.txt');
      const linkPath = path.join(tempDir, 'readlink-link.txt');
      await fs.promises.writeFile(target, 'content');
      await fs.promises.symlink(target, linkPath);

      const result = await fileSystem.readlinkAsync(linkPath);

      assert.strictEqual(result, target);
    });
  });

  suite('accessAsync', () => {
    test('does not throw for existing file', async () => {
      const testFile = path.join(tempDir, 'access-test.txt');
      await fs.promises.writeFile(testFile, 'content');

      // Should not throw
      await fileSystem.accessAsync(testFile);
    });

    test('throws for non-existent file', async () => {
      const testFile = path.join(tempDir, 'non-existent-access.txt');

      await assert.rejects(
        () => fileSystem.accessAsync(testFile),
        /ENOENT/
      );
    });
  });

  suite('copyFileAsync', () => {
    test('copies file', async () => {
      const src = path.join(tempDir, 'copy-src.txt');
      const dest = path.join(tempDir, 'copy-dest.txt');
      await fs.promises.writeFile(src, 'copy content');

      await fileSystem.copyFileAsync(src, dest);

      assert.ok(fs.existsSync(src));
      assert.ok(fs.existsSync(dest));
      const content = await fs.promises.readFile(dest, 'utf8');
      assert.strictEqual(content, 'copy content');
    });
  });
});
