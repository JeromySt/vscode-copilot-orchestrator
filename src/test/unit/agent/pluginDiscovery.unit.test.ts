import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import {
  parsePluginListOutput,
  discoverCustomAgents,
  listInstalledPlugins,
  isAgentAvailable,
  installPlugin,
} from '../../../agent/pluginDiscovery';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

suite('pluginDiscovery', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('parsePluginListOutput', () => {
    test('returns empty array for "No plugins installed" message', () => {
      const result = parsePluginListOutput('No plugins installed.\nUse \'copilot plugin install <source>\' to install a plugin.');
      assert.deepStrictEqual(result, []);
    });

    test('returns empty array for empty string', () => {
      const result = parsePluginListOutput('');
      assert.deepStrictEqual(result, []);
    });

    test('parses plugin with source', () => {
      const result = parsePluginListOutput('my-plugin (source: owner/repo)');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'my-plugin');
      assert.strictEqual(result[0].source, 'owner/repo');
    });

    test('parses plugin without source', () => {
      const result = parsePluginListOutput('simple-plugin');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'simple-plugin');
      assert.strictEqual(result[0].source, undefined);
    });

    test('parses multiple plugins', () => {
      const output = 'plugin-a (source: org/repo-a)\nplugin-b (source: plugin-b@awesome-copilot)\nplugin-c';
      const result = parsePluginListOutput(output);
      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0].name, 'plugin-a');
      assert.strictEqual(result[0].source, 'org/repo-a');
      assert.strictEqual(result[1].name, 'plugin-b');
      assert.strictEqual(result[1].source, 'plugin-b@awesome-copilot');
      assert.strictEqual(result[2].name, 'plugin-c');
    });

    test('skips help text lines', () => {
      const output = 'No plugins installed.\nUse \'copilot plugin install <source>\' to install.';
      const result = parsePluginListOutput(output);
      assert.strictEqual(result.length, 0);
    });
  });

  suite('discoverCustomAgents', () => {
    test('returns empty array when directories do not exist', () => {
      const mockEnv: any = { env: { HOME: '/nonexistent/home' }, platform: 'linux' };
      const result = discoverCustomAgents(mockEnv, '/nonexistent/repo');
      assert.deepStrictEqual(result, []);
    });

    test('returns empty array when HOME not set', () => {
      const mockEnv: any = { env: {}, platform: 'linux' };
      const result = discoverCustomAgents(mockEnv);
      assert.deepStrictEqual(result, []);
    });

    test('uses USERPROFILE on Windows', () => {
      const mockEnv: any = { env: { USERPROFILE: '/nonexistent/profile' }, platform: 'win32' };
      const result = discoverCustomAgents(mockEnv);
      // Should not throw, returns empty since dirs don't exist
      assert.ok(Array.isArray(result));
    });

    test('discovers agent files from temp directory', () => {
      // Create a temp directory with agent files
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-test-'));
      const agentsDir = path.join(tmpDir, '.copilot', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });

      // Create a simple .agent.md file
      fs.writeFileSync(path.join(agentsDir, 'test-agent.agent.md'), '---\nname: test-agent\n---\n# Test Agent\n');
      // Create a .md file with no frontmatter
      fs.writeFileSync(path.join(agentsDir, 'simple.md'), '# Simple agent\n');

      try {
        const mockEnv: any = { env: { HOME: tmpDir }, platform: 'linux' };
        const result = discoverCustomAgents(mockEnv);
        assert.ok(result.length >= 2);
        const names = result.map(a => a.name);
        assert.ok(names.includes('test-agent'));
        assert.ok(names.includes('simple'));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test('discovers repo-level agents from .github/agents/', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-test-'));
      const agentsDir = path.join(tmpDir, '.github', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'repo-agent.agent.md'), '---\nname: repo-agent\n---\n# Repo Agent\n');

      try {
        const mockEnv: any = { env: {}, platform: 'linux' };
        const result = discoverCustomAgents(mockEnv, tmpDir);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'repo-agent');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test('extracts name from frontmatter with quotes', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-test-'));
      const agentsDir = path.join(tmpDir, '.copilot', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'quoted.agent.md'), '---\nname: "my-quoted-agent"\n---\n# Agent\n');

      try {
        const mockEnv: any = { env: { HOME: tmpDir }, platform: 'linux' };
        const result = discoverCustomAgents(mockEnv);
        assert.ok(result.some(a => a.name === 'my-quoted-agent'));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test('skips non-md files', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-test-'));
      const agentsDir = path.join(tmpDir, '.copilot', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'readme.txt'), 'not an agent');
      fs.writeFileSync(path.join(agentsDir, 'valid.agent.md'), '# Agent');

      try {
        const mockEnv: any = { env: { HOME: tmpDir }, platform: 'linux' };
        const result = discoverCustomAgents(mockEnv);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'valid');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test('handles unreadable directory gracefully', () => {
      // Stub readdirSync via require to bypass __importStar
      const fsModule = require('fs');
      const origExistsSync = fsModule.existsSync;
      const origReaddirSync = fsModule.readdirSync;
      fsModule.existsSync = () => true;
      fsModule.readdirSync = () => { throw new Error('EACCES: permission denied'); };

      try {
        const mockEnv: any = { env: { HOME: '/fake/home' }, platform: 'linux' };
        const result = discoverCustomAgents(mockEnv);
        // Should not throw, returns empty array
        assert.deepStrictEqual(result, []);
      } finally {
        fsModule.existsSync = origExistsSync;
        fsModule.readdirSync = origReaddirSync;
      }
    });

    test('handles unreadable agent file gracefully', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-test-'));
      const agentsDir = path.join(tmpDir, '.copilot', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      // Create agent file then make readFileSync fail for it
      const agentFile = path.join(agentsDir, 'broken.agent.md');
      fs.writeFileSync(agentFile, '---\nname: broken\n---\n');

      // Stub readFileSync via require to bypass __importStar
      const fsModule = require('fs');
      const origReadFileSync = fsModule.readFileSync;
      fsModule.readFileSync = (p: any, ...args: any[]) => {
        if (String(p).includes('broken.agent.md')) {
          throw new Error('EACCES: permission denied');
        }
        return origReadFileSync(p, ...args);
      };

      try {
        const mockEnv: any = { env: { HOME: tmpDir }, platform: 'linux' };
        const result = discoverCustomAgents(mockEnv);
        // Should still find the file but fall back to filename-derived name
        assert.ok(result.some(a => a.name === 'broken'));
      } finally {
        fsModule.readFileSync = origReadFileSync;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test('skips subdirectories with .md extension', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-test-'));
      const agentsDir = path.join(tmpDir, '.copilot', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      // Create a directory that ends with .md
      fs.mkdirSync(path.join(agentsDir, 'subdir.md'));
      fs.writeFileSync(path.join(agentsDir, 'real.agent.md'), '# Real Agent');

      try {
        const mockEnv: any = { env: { HOME: tmpDir }, platform: 'linux' };
        const result = discoverCustomAgents(mockEnv);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'real');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  suite('isAgentAvailable - custom agents', () => {
    test('finds custom agent file', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-test-'));
      const agentsDir = path.join(tmpDir, '.copilot', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'local-agent.agent.md'), '---\nname: local-agent\n---\n# Agent\n');

      // Spawner returns no plugins
      const spawner: any = {
        spawn: sandbox.stub().returns({
          stdout: { on: (evt: string, cb: any) => { if (evt === 'data') { cb('No plugins installed.\n'); } } },
          stderr: { on: () => {} },
          on: (evt: string, cb: any) => { if (evt === 'close') { cb(0); } },
          kill: sandbox.stub(),
        }),
      };

      try {
        const env: any = { env: { HOME: tmpDir }, platform: 'linux' };
        const result = await isAgentAvailable('local-agent', spawner, env);
        assert.strictEqual(result.available, true);
        assert.strictEqual(result.source, 'custom-agent');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  suite('listInstalledPlugins', () => {
    test('returns empty array when process fails', async () => {
      const mockSpawner: any = {
        spawn: sandbox.stub().returns({
          stdout: { on: (evt: string, cb: any) => { if (evt === 'data') { /* no data */ } } },
          stderr: { on: (evt: string, cb: any) => {} },
          on: (evt: string, cb: any) => { if (evt === 'close') { cb(1); } },
          kill: sandbox.stub(),
        }),
      };
      const result = await listInstalledPlugins(mockSpawner);
      assert.deepStrictEqual(result, []);
    });

    test('parses successful output', async () => {
      const mockSpawner: any = {
        spawn: sandbox.stub().returns({
          stdout: {
            on: (evt: string, cb: any) => {
              if (evt === 'data') { cb('my-plugin (source: org/repo)\n'); }
            },
          },
          stderr: { on: () => {} },
          on: (evt: string, cb: any) => { if (evt === 'close') { cb(0); } },
          kill: sandbox.stub(),
        }),
      };
      const result = await listInstalledPlugins(mockSpawner);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'my-plugin');
    });

    test('returns empty when spawn throws', async () => {
      const mockSpawner: any = {
        spawn: sandbox.stub().returns({
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          on: (evt: string, cb: any) => { if (evt === 'error') { cb(new Error('fail')); } },
          kill: sandbox.stub(),
        }),
      };
      const result = await listInstalledPlugins(mockSpawner);
      assert.deepStrictEqual(result, []);
    });
  });

  suite('isAgentAvailable', () => {
    function makeSpawnerReturning(plugins: string): any {
      return {
        spawn: sandbox.stub().returns({
          stdout: {
            on: (evt: string, cb: any) => { if (evt === 'data') { cb(plugins); } },
          },
          stderr: { on: () => {} },
          on: (evt: string, cb: any) => { if (evt === 'close') { cb(0); } },
          kill: sandbox.stub(),
        }),
      };
    }

    test('finds available plugin', async () => {
      const spawner = makeSpawnerReturning('my-plugin (source: org/repo)\n');
      const env: any = { env: {}, platform: 'linux' };
      const result = await isAgentAvailable('my-plugin', spawner, env);
      assert.strictEqual(result.available, true);
      assert.strictEqual(result.source, 'plugin');
    });

    test('returns not available for missing agent', async () => {
      const spawner = makeSpawnerReturning('other-plugin (source: org/repo)\n');
      const env: any = { env: {}, platform: 'linux' };
      const result = await isAgentAvailable('missing-agent', spawner, env);
      assert.strictEqual(result.available, false);
    });

    test('case-insensitive plugin matching', async () => {
      const spawner = makeSpawnerReturning('My-Plugin (source: org/repo)\n');
      const env: any = { env: {}, platform: 'linux' };
      const result = await isAgentAvailable('my-plugin', spawner, env);
      assert.strictEqual(result.available, true);
    });
  });

  suite('installPlugin', () => {
    test('returns success on exit code 0', async () => {
      const mockSpawner: any = {
        spawn: sandbox.stub().returns({
          stdout: {
            on: (evt: string, cb: any) => { if (evt === 'data') { cb('Installed!\n'); } },
          },
          stderr: { on: () => {} },
          on: (evt: string, cb: any) => { if (evt === 'close') { cb(0); } },
          kill: sandbox.stub(),
        }),
      };
      const result = await installPlugin('my-plugin@awesome-copilot', mockSpawner);
      assert.strictEqual(result.success, true);
    });

    test('returns failure on non-zero exit code', async () => {
      const mockSpawner: any = {
        spawn: sandbox.stub().returns({
          stdout: { on: () => {} },
          stderr: {
            on: (evt: string, cb: any) => { if (evt === 'data') { cb('Plugin not found\n'); } },
          },
          on: (evt: string, cb: any) => { if (evt === 'close') { cb(1); } },
          kill: sandbox.stub(),
        }),
      };
      const result = await installPlugin('nonexistent-plugin', mockSpawner);
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('Plugin not found'));
    });

    test('returns failure on spawn error', async () => {
      const mockSpawner: any = {
        spawn: sandbox.stub().returns({
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          on: (evt: string, cb: any) => {
            if (evt === 'error') { cb(new Error('spawn failed')); }
          },
          kill: sandbox.stub(),
        }),
      };
      const result = await installPlugin('test-plugin', mockSpawner);
      assert.strictEqual(result.success, false);
    });

    test('returns failure when spawner.spawn throws synchronously', async () => {
      const mockSpawner: any = {
        spawn: sandbox.stub().throws(new Error('spawn ENOENT')),
      };
      const result = await installPlugin('test-plugin', mockSpawner);
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('spawn ENOENT'));
    });

    test('passes correct arguments to spawn', async () => {
      const spawnStub = sandbox.stub().returns({
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (evt: string, cb: any) => { if (evt === 'close') { cb(0); } },
        kill: sandbox.stub(),
      });
      const mockSpawner: any = { spawn: spawnStub };
      await installPlugin('security-agent@copilot-plugins', mockSpawner);
      assert.ok(spawnStub.calledOnce);
      assert.deepStrictEqual(spawnStub.firstCall.args[0], 'copilot');
      assert.deepStrictEqual(spawnStub.firstCall.args[1], ['plugin', 'install', 'security-agent@copilot-plugins']);
    });
  });
});
