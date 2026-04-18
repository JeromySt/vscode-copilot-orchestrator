/**
 * @fileoverview Unit tests for hookInstaller (preToolUse + postToolUse hook
 * file installation/uninstallation in a worktree).
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installOrchestratorHooks, uninstallOrchestratorHooks } from '../../../agent/hookInstaller';
import { DefaultFileSystem } from '../../../core/defaultFileSystem';

const fsx = new DefaultFileSystem();

suite('hookInstaller', () => {
    let tmpRoot: string;

    setup(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-hooks-'));
    });

    teardown(() => {
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    test('installOrchestratorHooks writes 5 hook files into .github/hooks', () => {
        const result = installOrchestratorHooks(tmpRoot, fsx);
        assert.ok(result.configPath.length > 0, 'configPath should be set');
        assert.strictEqual(result.scriptPaths.length, 4, 'should write 4 script files');

        const hooksDir = path.join(tmpRoot, '.github', 'hooks');
        assert.ok(fs.existsSync(path.join(hooksDir, 'orchestrator-hooks.json')));
        assert.ok(fs.existsSync(path.join(hooksDir, 'orchestrator-pressure-gate.ps1')));
        assert.ok(fs.existsSync(path.join(hooksDir, 'orchestrator-pressure-gate.sh')));
        assert.ok(fs.existsSync(path.join(hooksDir, 'orchestrator-post-tool.ps1')));
        assert.ok(fs.existsSync(path.join(hooksDir, 'orchestrator-post-tool.sh')));
    });

    test('orchestrator-hooks.json declares preToolUse and postToolUse', () => {
        installOrchestratorHooks(tmpRoot, fsx);
        const cfgPath = path.join(tmpRoot, '.github', 'hooks', 'orchestrator-hooks.json');
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        assert.strictEqual(cfg.version, 1);
        assert.ok(Array.isArray(cfg.hooks.preToolUse), 'preToolUse must be an array');
        assert.ok(Array.isArray(cfg.hooks.postToolUse), 'postToolUse must be an array');
        assert.strictEqual(cfg.hooks.preToolUse.length, 1);
        assert.strictEqual(cfg.hooks.postToolUse.length, 1);
        // Each hook entry must declare both shells
        for (const arr of [cfg.hooks.preToolUse, cfg.hooks.postToolUse]) {
            assert.strictEqual(arr[0].type, 'command');
            assert.ok(typeof arr[0].bash === 'string' && arr[0].bash.length > 0);
            assert.ok(typeof arr[0].powershell === 'string' && arr[0].powershell.length > 0);
        }
    });

    test('installOrchestratorHooks is idempotent (overwrites)', () => {
        installOrchestratorHooks(tmpRoot, fsx);
        const cfgPath = path.join(tmpRoot, '.github', 'hooks', 'orchestrator-hooks.json');
        // Tamper
        fs.writeFileSync(cfgPath, '{"corrupt": true}', 'utf8');
        installOrchestratorHooks(tmpRoot, fsx);
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        assert.strictEqual(cfg.version, 1, 'second install should overwrite');
    });

    test('preToolUse script body references the sentinel and manifest paths', () => {
        installOrchestratorHooks(tmpRoot, fsx);
        const sh = fs.readFileSync(path.join(tmpRoot, '.github', 'hooks', 'orchestrator-pressure-gate.sh'), 'utf8');
        const ps1 = fs.readFileSync(path.join(tmpRoot, '.github', 'hooks', 'orchestrator-pressure-gate.ps1'), 'utf8');
        for (const body of [sh, ps1]) {
            assert.match(body, /CHECKPOINT_REQUIRED/);
            assert.match(body, /checkpoint-manifest\.json/);
            assert.match(body, /permissionDecision/);
            assert.match(body, /deny/);
        }
    });

    test('uninstallOrchestratorHooks removes all hook files', () => {
        installOrchestratorHooks(tmpRoot, fsx);
        const hooksDir = path.join(tmpRoot, '.github', 'hooks');
        assert.ok(fs.existsSync(path.join(hooksDir, 'orchestrator-hooks.json')));
        uninstallOrchestratorHooks(tmpRoot, fsx);
        for (const name of [
            'orchestrator-hooks.json',
            'orchestrator-pressure-gate.ps1',
            'orchestrator-pressure-gate.sh',
            'orchestrator-post-tool.ps1',
            'orchestrator-post-tool.sh',
        ]) {
            assert.strictEqual(fs.existsSync(path.join(hooksDir, name)), false, `${name} should be removed`);
        }
    });

    test('uninstallOrchestratorHooks is safe when nothing is installed', () => {
        // Should not throw even though .github/hooks does not exist
        assert.doesNotThrow(() => uninstallOrchestratorHooks(tmpRoot, fsx));
    });

    test('installOrchestratorHooks accepts an optional logger', () => {
        const logs: string[] = [];
        const logger = {
            debug: (m: string) => logs.push(`debug:${m}`),
            warn: (m: string) => logs.push(`warn:${m}`),
            error: (m: string) => logs.push(`error:${m}`),
            info: (m: string) => logs.push(`info:${m}`),
        };
        const result = installOrchestratorHooks(tmpRoot, fsx, logger as never);
        assert.ok(result.configPath.length > 0);
        // At least one debug log about installation should be emitted
        assert.ok(logs.some(l => l.startsWith('debug:') && l.includes('Installed orchestrator hooks')), 'should log installation');
    });
});
