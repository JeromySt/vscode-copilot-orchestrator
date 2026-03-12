/**
 * @fileoverview Unit tests for the shared path validation utility.
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import * as path from 'path';
import { validatePath } from '../../../../plan/store/pathValidation';

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
