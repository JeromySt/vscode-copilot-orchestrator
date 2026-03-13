/**
 * @fileoverview Unit tests for the shared path validation utility.
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validatePath, validatePathAsync } from '../../../../plan/store/pathValidation';

suite('validatePath', () => {
  const base = path.resolve('/some/base/dir');

  test('allows a path directly inside the base directory', () => {
    const target = path.join(base, 'child', 'file.json');
    assert.doesNotThrow(() => validatePath(base, target));
  });

  test('allows a nested path inside the base directory', () => {
    const target = path.join(base, 'a', 'b', 'c', 'file.json');
    assert.doesNotThrow(() => validatePath(base, target));
  });

  test('blocks a path equal to the base directory (no trailing sep)', () => {
    assert.throws(() => validatePath(base, base), /Path traversal blocked/);
  });

  test('blocks a path outside the base directory', () => {
    const outside = path.resolve('/some/other/dir/file.json');
    assert.throws(() => validatePath(base, outside), /Path traversal blocked/);
  });

  test('blocks a path traversal using .. segments', () => {
    const traversal = path.join(base, '..', 'etc', 'passwd');
    assert.throws(() => validatePath(base, traversal), /Path traversal blocked/);
  });

  test('blocks a path traversal that leaves the base root', () => {
    const traversal = path.join(base, '..', '..', '..', 'sensitive');
    assert.throws(() => validatePath(base, traversal), /Path traversal blocked/);
  });

  test('throws with the offending path in the message', () => {
    const outside = '/completely/different/path';
    let err: Error | undefined;
    try {
      validatePath(base, outside);
    } catch (e: any) {
      err = e;
    }
    assert.ok(err);
    assert.ok(err!.message.includes(outside), `Expected message to contain "${outside}", got: "${err!.message}"`);
  });
});

suite('validatePathAsync', () => {
  let tempDir: string;

  // Create a real temp directory for symlink tests
  async function setup() {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'path-val-test-'));
  }

  async function teardown() {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  test('allows a nested path inside the base directory (existing)', async () => {
    await setup();
    try {
      const child = path.join(tempDir, 'child');
      await fs.promises.mkdir(child);
      const target = path.join(child, 'file.json');
      await fs.promises.writeFile(target, '{}');
      await assert.doesNotReject(() => validatePathAsync(tempDir, target, fs.promises.realpath));
    } finally {
      await teardown();
    }
  });

  test('skips realpath check for non-existent target (ENOENT), uses lexical check', async () => {
    const base = path.resolve('/some/base/dir');
    const target = path.join(base, 'nonexistent', 'file.json');
    // Should not throw — lexical check passes and ENOENT is silenced
    const enoentFn = async (_p: string): Promise<string> => { const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
    await assert.doesNotReject(() => validatePathAsync(base, target, enoentFn));
  });

  test('rejects lexical traversal even when path does not exist', async () => {
    const base = path.resolve('/some/base/dir');
    const outside = path.join(base, '..', 'etc', 'passwd');
    await assert.rejects(() => validatePathAsync(base, outside, fs.promises.realpath), /Path traversal blocked/);
  });

  test('detects symlink escape to outside base directory', async () => {
    await setup();
    try {
      // Create a target directory outside the base
      const outsideDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'path-val-outside-'));
      try {
        const base = path.join(tempDir, 'base');
        await fs.promises.mkdir(base);

        // Create a symlink inside base that points outside
        const symlink = path.join(base, 'escaped');
        await fs.promises.symlink(outsideDir, symlink);

        // validatePathAsync should detect the symlink escape
        await assert.rejects(() => validatePathAsync(base, symlink, fs.promises.realpath), /Path traversal blocked \(symlink\)/);
      } finally {
        await fs.promises.rm(outsideDir, { recursive: true, force: true }).catch(() => {});
      }
    } finally {
      await teardown();
    }
  });
});
