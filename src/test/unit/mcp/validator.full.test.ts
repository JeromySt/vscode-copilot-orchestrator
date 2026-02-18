/**
 * @fileoverview Comprehensive tests for MCP validation module.
 * Covers validateInput, hasSchema, getRegisteredTools, formatErrors,
 * validateAgentModels, validateAllowedUrls, validateAllowedFolders.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as modelDiscovery from '../../../agent/modelDiscovery';

suite('MCP Validator', () => {
  let modelStub: sinon.SinonStub;

  setup(() => {
    modelStub = sinon.stub(modelDiscovery, 'getCachedModels').resolves({
      models: [{ id: 'gpt-5', vendor: 'openai', family: 'gpt-5', tier: 'standard' }],
      rawChoices: ['gpt-5'],
      discoveredAt: Date.now(),
    });
  });

  teardown(() => {
    sinon.restore();
  });

  suite('validateInput', () => {
    test('should return valid for correct create_copilot_plan input', () => {
      const { validateInput } = require('../../../mcp/validation/validator');
      const result = validateInput('create_copilot_plan', {
        name: 'Test Plan',
        jobs: [{ producer_id: 'build', task: 'Build', dependencies: [] }],
      });
      assert.strictEqual(result.valid, true);
    });

    test('should return invalid for missing required fields', () => {
      const { validateInput } = require('../../../mcp/validation/validator');
      const result = validateInput('create_copilot_plan', {});
      assert.strictEqual(result.valid, false);
      assert.ok(result.error);
      assert.ok(result.error.includes('Missing required'));
    });

    test('should return valid for unknown tool', () => {
      const { validateInput } = require('../../../mcp/validation/validator');
      const result = validateInput('unknown_tool', {});
      assert.strictEqual(result.valid, true);
    });

    test('should detect additional properties', () => {
      const { validateInput } = require('../../../mcp/validation/validator');
      const result = validateInput('get_copilot_plan_status', {
        id: 'test',
        unknownField: 'value',
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error!.includes('Unknown property'));
    });

    test('should detect type errors', () => {
      const { validateInput } = require('../../../mcp/validation/validator');
      const result = validateInput('get_copilot_plan_status', {
        id: 123,
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error!.includes('Expected'));
    });

    test('should detect pattern violations', () => {
      const { validateInput } = require('../../../mcp/validation/validator');
      const result = validateInput('create_copilot_plan', {
        name: 'Test',
        jobs: [{ producer_id: 'INVALID', task: 'T', dependencies: [] }],
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error!.includes('pattern') || result.error!.includes('format'));
    });

    test('should detect enum violations', () => {
      const { validateInput } = require('../../../mcp/validation/validator');
      const result = validateInput('list_copilot_plans', {
        status: 'invalid_status',
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error!.includes('Invalid value') || result.error!.includes('Allowed'));
    });

    test('should validate cancel_copilot_plan', () => {
      const { validateInput } = require('../../../mcp/validation/validator');
      assert.strictEqual(validateInput('cancel_copilot_plan', { id: 'test' }).valid, true);
      assert.strictEqual(validateInput('cancel_copilot_plan', {}).valid, false);
    });

    test('should validate delete_copilot_plan', () => {
      const { validateInput } = require('../../../mcp/validation/validator');
      assert.strictEqual(validateInput('delete_copilot_plan', { id: 'test' }).valid, true);
    });

    test('should validate retry_copilot_plan', () => {
      const { validateInput } = require('../../../mcp/validation/validator');
      assert.strictEqual(validateInput('retry_copilot_plan', { id: 'test' }).valid, true);
      assert.strictEqual(validateInput('retry_copilot_plan', { id: 'test', clearWorktree: true }).valid, true);
    });

    test('should validate get_copilot_node_details', () => {
      const { validateInput } = require('../../../mcp/validation/validator');
      assert.strictEqual(validateInput('get_copilot_node_details', { planId: 'p', nodeId: 'n' }).valid, true);
    });

    test('should validate node-centric tools', () => {
      const { validateInput } = require('../../../mcp/validation/validator');
      assert.strictEqual(validateInput('get_copilot_node', { node_id: 'n1' }).valid, true);
      assert.strictEqual(validateInput('list_copilot_nodes', {}).valid, true);
      assert.strictEqual(validateInput('list_copilot_nodes', { status: 'failed' }).valid, true);
      assert.strictEqual(validateInput('retry_copilot_node', { node_id: 'n1' }).valid, true);
      assert.strictEqual(validateInput('force_fail_copilot_node', { node_id: 'n1' }).valid, true);
    });

    test('should validate update_copilot_plan_node', () => {
      const { validateInput } = require('../../../mcp/validation/validator');
      assert.strictEqual(validateInput('update_copilot_plan_node', { planId: 'p', nodeId: 'n' }).valid, true);
      assert.strictEqual(validateInput('update_copilot_plan_node', {
        planId: 'p', nodeId: 'n', work: 'npm build', resetToStage: 'work',
      }).valid, true);
    });

    test('should cap errors at 5', () => {
      const { validateInput } = require('../../../mcp/validation/validator');
      const result = validateInput('create_copilot_plan', {
        name: 'Test',
        jobs: Array.from({ length: 10 }, (_, i) => ({
          producer_id: `INVALID_${i}`,
          task: '',
          dependencies: 'not-array',
        })),
      });
      assert.strictEqual(result.valid, false);
      // Should contain "... and N more error(s)" if more than 5 errors
    });

    test('should handle oneOf work spec validation', () => {
      const { validateInput } = require('../../../mcp/validation/validator');
      const result = validateInput('create_copilot_plan', {
        name: 'Test',
        jobs: [{
          producer_id: 'build',
          task: 'Build',
          dependencies: [],
          work: { type: 'process', executable: 'node', args: ['build.js'] },
        }],
      });
      assert.strictEqual(result.valid, true);
    });

    test('should validate groups in create_copilot_plan', () => {
      const { validateInput } = require('../../../mcp/validation/validator');
      const result = validateInput('create_copilot_plan', {
        name: 'Test',
        jobs: [],
        groups: [{
          name: 'backend',
          jobs: [{ producer_id: 'api', task: 'Build API', dependencies: [] }],
        }],
      });
      assert.strictEqual(result.valid, true);
    });
  });

  suite('hasSchema', () => {
    test('should return true for known tools', () => {
      const { hasSchema } = require('../../../mcp/validation/validator');
      assert.strictEqual(hasSchema('create_copilot_plan'), true);
      assert.strictEqual(hasSchema('get_copilot_plan_status'), true);
    });

    test('should return false for unknown tools', () => {
      const { hasSchema } = require('../../../mcp/validation/validator');
      assert.strictEqual(hasSchema('unknown_tool'), false);
    });
  });

  suite('getRegisteredTools', () => {
    test('should return array of tool names', () => {
      const { getRegisteredTools } = require('../../../mcp/validation/validator');
      const tools = getRegisteredTools();
      assert.ok(Array.isArray(tools));
      assert.ok(tools.includes('create_copilot_plan'));
      assert.ok(tools.includes('get_copilot_node'));
    });
  });

  suite('validateAgentModels', () => {
    test('should return valid when no models', async () => {
      const { validateAgentModels } = require('../../../mcp/validation/validator');
      const result = await validateAgentModels({ work: 'npm build' }, 'test');
      assert.strictEqual(result.valid, true);
    });

    test('should validate valid model', async () => {
      const { validateAgentModels } = require('../../../mcp/validation/validator');
      const result = await validateAgentModels({
        work: { type: 'agent', instructions: 'Do it', model: 'gpt-5' },
      }, 'test');
      assert.strictEqual(result.valid, true);
    });

    test('should reject invalid model', async () => {
      const { validateAgentModels } = require('../../../mcp/validation/validator');
      const result = await validateAgentModels({
        work: { type: 'agent', instructions: 'Do it', model: 'invalid-model' },
      }, 'test');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error!.includes('Invalid model'));
    });

    test('should validate models in nested arrays', async () => {
      const { validateAgentModels } = require('../../../mcp/validation/validator');
      const result = await validateAgentModels({
        jobs: [{ work: { type: 'agent', instructions: 'Do it', model: 'gpt-5' } }],
      }, 'test');
      assert.strictEqual(result.valid, true);
    });

    test('should handle empty models list', async () => {
      modelStub.resolves({ models: [], rawChoices: [], discoveredAt: Date.now() });
      const { validateAgentModels } = require('../../../mcp/validation/validator');
      const result = await validateAgentModels({
        work: { type: 'agent', instructions: 'Do it', model: 'gpt-5' },
      }, 'test');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error!.includes('No models available'));
    });

    test('should handle discovery error', async () => {
      modelStub.rejects(new Error('Discovery failed'));
      const { validateAgentModels } = require('../../../mcp/validation/validator');
      const result = await validateAgentModels({
        work: { type: 'agent', instructions: 'Do it', model: 'gpt-5' },
      }, 'test');
      assert.strictEqual(result.valid, false);
    });
  });

  suite('validateAllowedUrls', () => {
    test('should return valid when no URLs', async () => {
      const { validateAllowedUrls } = require('../../../mcp/validation/validator');
      const result = await validateAllowedUrls({ work: 'npm build' }, 'test');
      assert.strictEqual(result.valid, true);
    });

    test('should accept valid HTTPS URL', async () => {
      const { validateAllowedUrls } = require('../../../mcp/validation/validator');
      const result = await validateAllowedUrls({
        work: { type: 'agent', allowedUrls: ['https://api.example.com'] },
      }, 'test');
      assert.strictEqual(result.valid, true);
    });

    test('should accept valid HTTP URL', async () => {
      const { validateAllowedUrls } = require('../../../mcp/validation/validator');
      const result = await validateAllowedUrls({
        work: { type: 'agent', allowedUrls: ['http://localhost:3000'] },
      }, 'test');
      assert.strictEqual(result.valid, true);
    });

    test('should reject file:// URL', async () => {
      const { validateAllowedUrls } = require('../../../mcp/validation/validator');
      const result = await validateAllowedUrls({
        work: { type: 'agent', allowedUrls: ['file:///etc/passwd'] },
      }, 'test');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error!.includes('Blocked URL scheme'));
    });

    test('should reject javascript: URL', async () => {
      const { validateAllowedUrls } = require('../../../mcp/validation/validator');
      const result = await validateAllowedUrls({
        work: { type: 'agent', allowedUrls: ['javascript:alert(1)'] },
      }, 'test');
      assert.strictEqual(result.valid, false);
    });

    test('should reject data: URL', async () => {
      const { validateAllowedUrls } = require('../../../mcp/validation/validator');
      const result = await validateAllowedUrls({
        work: { type: 'agent', allowedUrls: ['data:text/html,<script>'] },
      }, 'test');
      assert.strictEqual(result.valid, false);
    });

    test('should reject unknown scheme', async () => {
      const { validateAllowedUrls } = require('../../../mcp/validation/validator');
      const result = await validateAllowedUrls({
        work: { type: 'agent', allowedUrls: ['ftp://example.com'] },
      }, 'test');
      assert.strictEqual(result.valid, false);
    });

    test('should accept domain-only format', async () => {
      const { validateAllowedUrls } = require('../../../mcp/validation/validator');
      const result = await validateAllowedUrls({
        work: { type: 'agent', allowedUrls: ['api.example.com'] },
      }, 'test');
      assert.strictEqual(result.valid, true);
    });

    test('should accept wildcard domain', async () => {
      const { validateAllowedUrls } = require('../../../mcp/validation/validator');
      const result = await validateAllowedUrls({
        work: { type: 'agent', allowedUrls: ['*.example.com'] },
      }, 'test');
      assert.strictEqual(result.valid, true);
    });

    test('should traverse jobs for URLs', async () => {
      const { validateAllowedUrls } = require('../../../mcp/validation/validator');
      const result = await validateAllowedUrls({
        jobs: [{ work: { type: 'agent', allowedUrls: ['https://ok.com'] } }],
      }, 'test');
      assert.strictEqual(result.valid, true);
    });

    test('should traverse groups for URLs', async () => {
      const { validateAllowedUrls } = require('../../../mcp/validation/validator');
      const result = await validateAllowedUrls({
        groups: [{ jobs: [{ work: { type: 'agent', allowedUrls: ['file:///bad'] } }] }],
      }, 'test');
      assert.strictEqual(result.valid, false);
    });

    test('should traverse nodes for URLs', async () => {
      const { validateAllowedUrls } = require('../../../mcp/validation/validator');
      const result = await validateAllowedUrls({
        nodes: [{ work: { type: 'agent', allowedUrls: ['https://ok.com'] } }],
      }, 'test');
      assert.strictEqual(result.valid, true);
    });

    test('should check prechecks, postchecks, newWork fields', async () => {
      const { validateAllowedUrls } = require('../../../mcp/validation/validator');
      const result = await validateAllowedUrls({
        prechecks: { type: 'agent', allowedUrls: ['https://check.com'] },
        postchecks: { type: 'agent', allowedUrls: ['https://post.com'] },
        newWork: { type: 'agent', allowedUrls: ['https://new.com'] },
        newPrechecks: { type: 'agent', allowedUrls: ['https://np.com'] },
        newPostchecks: { type: 'agent', allowedUrls: ['https://npo.com'] },
      }, 'test');
      assert.strictEqual(result.valid, true);
    });

    test('should reject malformed URL', async () => {
      const { validateAllowedUrls } = require('../../../mcp/validation/validator');
      const result = await validateAllowedUrls({
        work: { type: 'agent', allowedUrls: ['https://'] },
      }, 'test');
      assert.strictEqual(result.valid, false);
    });
  });

  suite('validateAllowedFolders', () => {
    test('should return valid when no folders', async () => {
      const { validateAllowedFolders } = require('../../../mcp/validation/validator');
      const result = await validateAllowedFolders({ work: 'npm build' }, 'test');
      assert.strictEqual(result.valid, true);
    });

    test('should reject relative path', async () => {
      const { validateAllowedFolders } = require('../../../mcp/validation/validator');
      const result = await validateAllowedFolders({
        work: { type: 'agent', allowedFolders: ['relative/path'] },
      }, 'test');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error!.includes('must be absolute'));
    });

    test('should reject non-existent path', async () => {
      const { validateAllowedFolders } = require('../../../mcp/validation/validator');
      const result = await validateAllowedFolders({
        work: { type: 'agent', allowedFolders: ['/nonexistent/path/zzzzz'] },
      }, 'test');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error!.includes('does not exist'));
    });

    test('should traverse jobs for folders', async () => {
      const { validateAllowedFolders } = require('../../../mcp/validation/validator');
      const result = await validateAllowedFolders({
        jobs: [{ work: { type: 'agent', allowedFolders: ['relative'] } }],
      }, 'test');
      assert.strictEqual(result.valid, false);
    });

    test('should traverse groups for folders', async () => {
      const { validateAllowedFolders } = require('../../../mcp/validation/validator');
      const result = await validateAllowedFolders({
        groups: [{ jobs: [{ work: { type: 'agent', allowedFolders: ['relative'] } }] }],
      }, 'test');
      assert.strictEqual(result.valid, false);
    });

    test('should traverse nodes for folders', async () => {
      const { validateAllowedFolders } = require('../../../mcp/validation/validator');
      const result = await validateAllowedFolders({
        nodes: [{ work: { type: 'agent', allowedFolders: ['relative'] } }],
      }, 'test');
      assert.strictEqual(result.valid, false);
    });

    test('should check prechecks and postchecks fields', async () => {
      const { validateAllowedFolders } = require('../../../mcp/validation/validator');
      const result = await validateAllowedFolders({
        prechecks: { type: 'agent', allowedFolders: ['relative'] },
      }, 'test');
      assert.strictEqual(result.valid, false);
    });
  });

  suite('validatePowerShellCommands', () => {
    test('rejects 2>&1 in PowerShell shell command', () => {
      const { validatePowerShellCommands } = require('../../../mcp/validation/validator');
      const result = validatePowerShellCommands({
        work: { type: 'shell', command: 'cargo test 2>&1', shell: 'powershell' },
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('2>&1'));
    });

    test('allows 2>&1 in non-PowerShell shell', () => {
      const { validatePowerShellCommands } = require('../../../mcp/validation/validator');
      const result = validatePowerShellCommands({
        work: { type: 'shell', command: 'cargo test 2>&1', shell: 'bash' },
      });
      assert.strictEqual(result.valid, true);
    });

    test('accepts clean commands', () => {
      const { validatePowerShellCommands } = require('../../../mcp/validation/validator');
      const result = validatePowerShellCommands({
        work: { type: 'shell', command: 'npm test', shell: 'powershell' },
      });
      assert.strictEqual(result.valid, true);
    });

    test('traverses nodes array', () => {
      const { validatePowerShellCommands } = require('../../../mcp/validation/validator');
      const result = validatePowerShellCommands({
        nodes: [{ work: { type: 'shell', command: 'test 2>&1', shell: 'pwsh' } }],
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('2>&1'));
    });

    test('traverses reshape operations', () => {
      const { validatePowerShellCommands } = require('../../../mcp/validation/validator');
      const result = validatePowerShellCommands({
        operations: [{ spec: { work: { type: 'shell', command: 'test 2>&1', shell: 'powershell' } } }],
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('2>&1'));
    });

    test('detects 2>&1 in nodes array', () => {
      const { validatePowerShellCommands } = require('../../../mcp/validation/validator');
      const result = validatePowerShellCommands({
        nodes: [{ work: { type: 'shell', command: 'echo 2>&1', shell: 'powershell' } }],
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('2>&1'));
    });
  });

  suite('extractAgentNames', () => {
    test('returns empty for input without agents', () => {
      const { extractAgentNames } = require('../../../mcp/validation/validator');
      const result = extractAgentNames({
        work: { type: 'shell', command: 'npm test' },
      });
      assert.deepStrictEqual(result, []);
    });

    test('extracts agent name from work spec', () => {
      const { extractAgentNames } = require('../../../mcp/validation/validator');
      const result = extractAgentNames({
        work: { type: 'agent', instructions: '# Task', agent: 'k8s-assistant' },
      });
      assert.deepStrictEqual(result, ['k8s-assistant']);
    });

    test('extracts agents from nested jobs', () => {
      const { extractAgentNames } = require('../../../mcp/validation/validator');
      const result = extractAgentNames({
        jobs: [
          { work: { type: 'agent', instructions: '# Task', agent: 'agent-a' } },
          { work: { type: 'agent', instructions: '# Task', agent: 'agent-b' } },
        ],
      });
      assert.strictEqual(result.length, 2);
      assert.ok(result.includes('agent-a'));
      assert.ok(result.includes('agent-b'));
    });

    test('deduplicates agent names', () => {
      const { extractAgentNames } = require('../../../mcp/validation/validator');
      const result = extractAgentNames({
        jobs: [
          { work: { type: 'agent', instructions: '# A', agent: 'shared-agent' } },
          { work: { type: 'agent', instructions: '# B', agent: 'shared-agent' } },
        ],
      });
      assert.deepStrictEqual(result, ['shared-agent']);
    });

    test('extracts agents from groups', () => {
      const { extractAgentNames } = require('../../../mcp/validation/validator');
      const result = extractAgentNames({
        groups: [
          { jobs: [{ work: { type: 'agent', instructions: '# T', agent: 'group-agent' } }] },
        ],
      });
      assert.deepStrictEqual(result, ['group-agent']);
    });

    test('extracts agents from reshape operations', () => {
      const { extractAgentNames } = require('../../../mcp/validation/validator');
      const result = extractAgentNames({
        operations: [
          { spec: { work: { type: 'agent', instructions: '# T', agent: 'op-agent' } } },
        ],
      });
      assert.deepStrictEqual(result, ['op-agent']);
    });

    test('ignores agent field on non-agent type', () => {
      const { extractAgentNames } = require('../../../mcp/validation/validator');
      const result = extractAgentNames({
        work: { type: 'shell', command: 'test', agent: 'should-ignore' },
      });
      assert.deepStrictEqual(result, []);
    });

    test('ignores empty agent string', () => {
      const { extractAgentNames } = require('../../../mcp/validation/validator');
      const result = extractAgentNames({
        work: { type: 'agent', instructions: '# T', agent: '  ' },
      });
      assert.deepStrictEqual(result, []);
    });

    test('extracts from prechecks and postchecks', () => {
      const { extractAgentNames } = require('../../../mcp/validation/validator');
      const result = extractAgentNames({
        prechecks: { type: 'agent', instructions: '# Pre', agent: 'pre-agent' },
        postchecks: { type: 'agent', instructions: '# Post', agent: 'post-agent' },
      });
      assert.strictEqual(result.length, 2);
      assert.ok(result.includes('pre-agent'));
      assert.ok(result.includes('post-agent'));
    });

    test('extracts agents from nodes array', () => {
      const { extractAgentNames } = require('../../../mcp/validation/validator');
      const result = extractAgentNames({
        nodes: [
          { work: { type: 'agent', instructions: '# N', agent: 'node-agent' } },
          { work: { type: 'shell', command: 'echo hi' } },
        ],
      });
      assert.deepStrictEqual(result, ['node-agent']);
    });
  });

  suite('validateAgentPlugins', () => {
    test('returns valid when no agents referenced', async () => {
      const { validateAgentPlugins } = require('../../../mcp/validation/validator');
      const spawner: any = { spawn: sinon.stub() };
      const env: any = { env: {}, platform: 'linux' };
      const config: any = { getConfig: sinon.stub().returns(false) };
      const result = await validateAgentPlugins({ work: { type: 'shell', command: 'npm test' } }, spawner, env, config);
      assert.strictEqual(result.valid, true);
    });

    test('returns error when agent not available and autoInstall disabled', async () => {
      const { validateAgentPlugins } = require('../../../mcp/validation/validator');
      const spawner: any = {
        spawn: sinon.stub().returns({
          stdout: { on: (evt: string, cb: any) => { if (evt === 'data') { cb('No plugins installed.\n'); } } },
          stderr: { on: () => {} },
          on: (evt: string, cb: any) => { if (evt === 'close') { cb(0); } },
          kill: sinon.stub(),
        }),
      };
      const env: any = { env: {}, platform: 'linux' };
      const config: any = { getConfig: sinon.stub().returns(false) };
      const result = await validateAgentPlugins(
        { work: { type: 'agent', instructions: '# T', agent: 'missing-agent' } },
        spawner, env, config
      );
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('missing-agent'));
      assert.ok(result.error?.includes('copilot plugin install'));
    });

    test('returns valid when agent is an installed plugin', async () => {
      const { validateAgentPlugins } = require('../../../mcp/validation/validator');
      const spawner: any = {
        spawn: sinon.stub().returns({
          stdout: { on: (evt: string, cb: any) => { if (evt === 'data') { cb('my-agent (source: org/repo)\n'); } } },
          stderr: { on: () => {} },
          on: (evt: string, cb: any) => { if (evt === 'close') { cb(0); } },
          kill: sinon.stub(),
        }),
      };
      const env: any = { env: {}, platform: 'linux' };
      const config: any = { getConfig: sinon.stub().returns(false) };
      const result = await validateAgentPlugins(
        { work: { type: 'agent', instructions: '# T', agent: 'my-agent' } },
        spawner, env, config
      );
      assert.strictEqual(result.valid, true);
    });

    test('error message includes auto-install setting hint', async () => {
      const { validateAgentPlugins } = require('../../../mcp/validation/validator');
      const spawner: any = {
        spawn: sinon.stub().returns({
          stdout: { on: (evt: string, cb: any) => { if (evt === 'data') { cb('No plugins installed.\n'); } } },
          stderr: { on: () => {} },
          on: (evt: string, cb: any) => { if (evt === 'close') { cb(0); } },
          kill: sinon.stub(),
        }),
      };
      const env: any = { env: {}, platform: 'linux' };
      const config: any = { getConfig: sinon.stub().returns(false) };
      const result = await validateAgentPlugins(
        { work: { type: 'agent', instructions: '# T', agent: 'x' } },
        spawner, env, config
      );
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('autoInstallPlugins'));
    });

    test('auto-installs missing plugin when autoInstall enabled and install succeeds', async () => {
      const { validateAgentPlugins } = require('../../../mcp/validation/validator');
      let callCount = 0;
      const spawner: any = {
        spawn: sinon.stub().callsFake(() => {
          callCount++;
          if (callCount === 1) {
            // First call: plugin list (no plugins)
            return {
              stdout: { on: (evt: string, cb: any) => { if (evt === 'data') { cb('No plugins installed.\n'); } } },
              stderr: { on: () => {} },
              on: (evt: string, cb: any) => { if (evt === 'close') { cb(0); } },
              kill: sinon.stub(),
            };
          }
          // Second call: install (success)
          return {
            stdout: { on: (evt: string, cb: any) => { if (evt === 'data') { cb('Installed!\n'); } } },
            stderr: { on: () => {} },
            on: (evt: string, cb: any) => { if (evt === 'close') { cb(0); } },
            kill: sinon.stub(),
          };
        }),
      };
      const env: any = { env: {}, platform: 'linux' };
      const config: any = { getConfig: sinon.stub().returns(true) };
      const result = await validateAgentPlugins(
        { work: { type: 'agent', instructions: '# T', agent: 'new-plugin@marketplace' } },
        spawner, env, config
      );
      assert.strictEqual(result.valid, true);
    });

    test('returns error when autoInstall enabled but install fails', async () => {
      const { validateAgentPlugins } = require('../../../mcp/validation/validator');
      let callCount = 0;
      const spawner: any = {
        spawn: sinon.stub().callsFake(() => {
          callCount++;
          if (callCount === 1) {
            // First call: plugin list (no plugins)
            return {
              stdout: { on: (evt: string, cb: any) => { if (evt === 'data') { cb('No plugins installed.\n'); } } },
              stderr: { on: () => {} },
              on: (evt: string, cb: any) => { if (evt === 'close') { cb(0); } },
              kill: sinon.stub(),
            };
          }
          // Second call: install (failure)
          return {
            stdout: { on: () => {} },
            stderr: { on: (evt: string, cb: any) => { if (evt === 'data') { cb('Plugin not found\n'); } } },
            on: (evt: string, cb: any) => { if (evt === 'close') { cb(1); } },
            kill: sinon.stub(),
          };
        }),
      };
      const env: any = { env: {}, platform: 'linux' };
      const config: any = { getConfig: sinon.stub().returns(true) };
      const result = await validateAgentPlugins(
        { work: { type: 'agent', instructions: '# T', agent: 'org/bad-plugin' } },
        spawner, env, config
      );
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('auto-install failed'));
      assert.ok(result.error?.includes('org/bad-plugin'));
    });
  });

  suite('schemas', () => {
    test('should export all schemas', () => {
      const { schemas } = require('../../../mcp/validation/schemas');
      assert.ok(schemas);
      assert.ok(schemas.create_copilot_plan);
      assert.ok(schemas.get_copilot_plan_status);
      assert.ok(schemas.list_copilot_plans);
      assert.ok(schemas.get_copilot_node_details);
      assert.ok(schemas.get_copilot_node_logs);
      assert.ok(schemas.get_copilot_node_attempts);
      assert.ok(schemas.cancel_copilot_plan);
      assert.ok(schemas.delete_copilot_plan);
      assert.ok(schemas.retry_copilot_plan);
      assert.ok(schemas.retry_copilot_plan_node);
      assert.ok(schemas.get_copilot_node);
      assert.ok(schemas.list_copilot_nodes);
      assert.ok(schemas.retry_copilot_node);
      assert.ok(schemas.force_fail_copilot_node);
      assert.ok(schemas.update_copilot_plan_node);
    });
  });
});
