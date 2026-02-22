/**
 * Coverage tests for src/core/buildInfo.ts
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';

suite('buildInfo', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test('BUILD_COMMIT falls back to dev when undefined', () => {
    const { BUILD_COMMIT } = require('../../../core/buildInfo');
    assert.ok(BUILD_COMMIT);
    assert.strictEqual(typeof BUILD_COMMIT, 'string');
  });

  test('BUILD_TIMESTAMP falls back to ISO string when undefined', () => {
    const { BUILD_TIMESTAMP } = require('../../../core/buildInfo');
    assert.ok(BUILD_TIMESTAMP);
    assert.strictEqual(typeof BUILD_TIMESTAMP, 'string');
  });

  test('BUILD_VERSION falls back to dev when undefined', () => {
    const { BUILD_VERSION } = require('../../../core/buildInfo');
    assert.ok(BUILD_VERSION);
    assert.strictEqual(typeof BUILD_VERSION, 'string');
  });

  test('getBuildVersion returns version string', () => {
    const { getBuildVersion } = require('../../../core/buildInfo');
    const result = getBuildVersion();
    assert.ok(result);
    assert.strictEqual(typeof result, 'string');
    assert.ok(result.includes('('));
    assert.ok(result.includes('@'));
  });

  test('getBuildVersion handles missing package.json', () => {
    const fs = require('fs');
    const origExists = fs.existsSync;
    fs.existsSync = () => false;
    
    try {
      // Force reload to test fallback
      delete require.cache[require.resolve('../../../core/buildInfo')];
      const { getBuildVersion } = require('../../../core/buildInfo');
      const result = getBuildVersion();
      assert.ok(result.includes('unknown'));
    } finally {
      fs.existsSync = origExists;
    }
  });

  test('getBuildVersion handles read error', () => {
    const fs = require('fs');
    const origReadFile = fs.readFileSync;
    const origExists = fs.existsSync;
    
    // Load the module first with original fs
    delete require.cache[require.resolve('../../../core/buildInfo')];
    const mod = require('../../../core/buildInfo');
    
    // Now stub fs to simulate read error
    fs.existsSync = () => true;
    fs.readFileSync = () => { throw new Error('Read error'); };
    
    try {
      const result = mod.getBuildVersion();
      assert.ok(result.includes('unknown'));
    } finally {
      fs.readFileSync = origReadFile;
      fs.existsSync = origExists;
    }
  });
});
