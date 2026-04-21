// Node-side smoke tests for the AiOrchestrator bindings (job 036 / PC-3).
// Verifies the shape of the published TypeScript declaration file without
// loading the native addon (which requires the .NET runtime + node-gyp build).

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const dtsPath = path.resolve(__dirname, '..', '..', '..', '..', 'bindings', 'node', 'src', 'index.ts');

test('declaration file exists and exports AioOrchestrator', () => {
    assert.ok(fs.existsSync(dtsPath), `missing ${dtsPath}`);
    const text = fs.readFileSync(dtsPath, 'utf8');
    assert.match(text, /export interface AioOrchestrator/);
    assert.match(text, /export interface PlanHandle/);
    assert.match(text, /export interface JobHandle/);
});

test('PlanHandle surface matches job-036 spec', () => {
    const text = fs.readFileSync(dtsPath, 'utf8');
    for (const m of ['addJob', 'finalize', 'status', 'watch', 'cancel']) {
        assert.match(text, new RegExp(`\\b${m}\\b`), `PlanHandle missing member ${m}`);
    }
});

test('AsyncIterable protocol used for watch()', () => {
    const text = fs.readFileSync(dtsPath, 'utf8');
    assert.match(text, /watch\(\)\s*:\s*AsyncIterable<PlanEvent>/);
});

test('Error objects carry a code field (INV-8)', () => {
    const text = fs.readFileSync(dtsPath, 'utf8');
    assert.match(text, /AioError[\s\S]*readonly code: string/);
});
