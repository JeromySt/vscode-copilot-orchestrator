/**
 * @fileoverview Coverage tests for DefaultEnvironment class in IEnvironment.ts
 */
import * as assert from 'assert';
import { suite, test } from 'mocha';
import { DefaultEnvironment } from '../../../interfaces/IEnvironment';

suite('DefaultEnvironment', () => {
  test('env getter returns process.env', () => {
    const env = new DefaultEnvironment();
    assert.strictEqual(env.env, process.env);
  });

  test('platform getter returns process.platform', () => {
    const env = new DefaultEnvironment();
    assert.strictEqual(env.platform, process.platform);
  });

  test('cwd() returns process.cwd()', () => {
    const env = new DefaultEnvironment();
    assert.strictEqual(env.cwd(), process.cwd());
  });
});
