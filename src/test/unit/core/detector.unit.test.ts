/**
 * @fileoverview Unit tests for detector.ts workspace detection
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectWorkspace, Detected } from '../../../core/detector';

suite('detectWorkspace', () => {
  let tempDir: string;

  setup(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-test-'));
  });

  teardown(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('detects node workspace when package.json exists', () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');

    const result = detectWorkspace(tempDir);

    assert.strictEqual(result.kind, 'node');
    assert.ok(result.steps.pre.includes('npm ci'));
    assert.ok(result.steps.work.includes('npm run'));
    assert.ok(result.steps.post.includes('npm test'));
  });

  test('detects dotnet workspace when .sln file exists', () => {
    fs.writeFileSync(path.join(tempDir, 'MyApp.sln'), '');

    const result = detectWorkspace(tempDir);

    assert.strictEqual(result.kind, 'dotnet');
    assert.ok(result.steps.pre.includes('dotnet restore'));
    assert.ok(result.steps.work.includes('dotnet build'));
    assert.ok(result.steps.post.includes('dotnet test'));
  });

  test('detects dotnet workspace when .csproj file exists', () => {
    fs.writeFileSync(path.join(tempDir, 'App.csproj'), '');

    const result = detectWorkspace(tempDir);

    assert.strictEqual(result.kind, 'dotnet');
  });

  test('detects python workspace when pyproject.toml exists', () => {
    fs.writeFileSync(path.join(tempDir, 'pyproject.toml'), '');

    const result = detectWorkspace(tempDir);

    assert.strictEqual(result.kind, 'python');
    assert.ok(result.steps.pre.includes('pip install'));
    assert.ok(result.steps.work.includes('pytest'));
  });

  test('detects python workspace when requirements.txt exists', () => {
    fs.writeFileSync(path.join(tempDir, 'requirements.txt'), '');

    const result = detectWorkspace(tempDir);

    assert.strictEqual(result.kind, 'python');
  });

  test('returns unknown when no markers found', () => {
    const result = detectWorkspace(tempDir);

    assert.strictEqual(result.kind, 'unknown');
    assert.strictEqual(result.steps.pre, 'echo pre');
    assert.strictEqual(result.steps.work, 'echo work');
    assert.strictEqual(result.steps.post, 'echo post');
  });

  test('node takes priority over dotnet', () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
    fs.writeFileSync(path.join(tempDir, 'App.csproj'), '');

    const result = detectWorkspace(tempDir);

    assert.strictEqual(result.kind, 'node');
  });

  test('dotnet takes priority over python', () => {
    fs.writeFileSync(path.join(tempDir, 'App.sln'), '');
    fs.writeFileSync(path.join(tempDir, 'requirements.txt'), '');

    const result = detectWorkspace(tempDir);

    assert.strictEqual(result.kind, 'dotnet');
  });

  test('returns correct Detected structure shape', () => {
    const result: Detected = detectWorkspace(tempDir);

    assert.ok('kind' in result);
    assert.ok('steps' in result);
    assert.ok('pre' in result.steps);
    assert.ok('work' in result.steps);
    assert.ok('post' in result.steps);
  });
});
