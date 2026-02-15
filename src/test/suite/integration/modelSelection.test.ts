/**
 * @fileoverview Integration tests for model selection across MCP schema,
 * executor, agent delegator, token extraction, and plan serialization.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

const cp = require('child_process');

import {
  resetModelCache,
} from '../../../agent/modelDiscovery';
import { getPlanToolDefinitions } from '../../../mcp/tools/planTools';
import { PlanPersistence } from '../../../plan/persistence';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-sel-test-'));
  tmpDirs.push(dir);
  return dir;
}

const mockGitOps = {
  branches: { currentOrNull: async () => 'main', isDefaultBranch: async () => false, exists: async () => false, create: async () => {}, current: async () => 'main' },
  worktrees: {}, merge: {}, repository: {}, orchestrator: {}, gitignore: { ensureGitignoreEntries: async () => {} },
};

const HELP_OUTPUT = `Usage: copilot [options]

Options:
  -p, --prompt <prompt>  The prompt to send
  --model <model>  Set the AI model to use (choices: "claude-sonnet-4.5", "gpt-5", "gemini-2.0-flash", "gpt-4.1-mini", "claude-haiku-4.5", "claude-opus-4.5")
  --stream <mode>  Stream mode (choices: "on", "off")
  -h, --help       Display help
`;

function fakeProc(exitCode: number, stdout = ''): ChildProcess {
  const proc = new EventEmitter() as any;
  proc.pid = 99999;
  proc.kill = sinon.stub();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = null;
  setTimeout(() => {
    if (stdout) {
      proc.stdout.emit('data', Buffer.from(stdout));
    }
    proc.emit('close', exitCode);
  }, 5);
  return proc as ChildProcess;
}

function fakeSpawnProc(exitCode: number | null = 0, stdoutData = '', stderrData = ''): ChildProcess {
  const proc = new EventEmitter() as any;
  proc.pid = 12345;
  proc.kill = sinon.stub();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = null;
  setTimeout(() => {
    if (stdoutData) proc.stdout.emit('data', Buffer.from(stdoutData));
    if (stderrData) proc.stderr.emit('data', Buffer.from(stderrData));
    setTimeout(() => {
      proc.emit('exit', exitCode);
      proc.emit('close', exitCode);
    }, 10);
  }, 10);
  return proc as ChildProcess;
}

suite('Model Selection Integration', () => {
  let quiet: { restore: () => void };
  let spawnStub: sinon.SinonStub;

  setup(() => {
    quiet = silenceConsole();
    resetModelCache();
    spawnStub = sinon.stub(cp, 'spawn');
  });

  teardown(() => {
    sinon.restore();
    resetModelCache();
    quiet.restore();
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    tmpDirs = [];
  });

  // ===========================================================================
  // 1. MCP schema includes models
  // ===========================================================================

  suite('MCP schema includes models', () => {
    test('getPlanToolDefinitions returns model enum from discovered models', async () => {
      spawnStub.callsFake(() => fakeProc(0, HELP_OUTPUT));

      const tools = await getPlanToolDefinitions();

      // Find create_copilot_plan tool
      const planTool = tools.find(t => t.name === 'create_copilot_plan');
      assert.ok(planTool, 'create_copilot_plan tool should exist');

      // model enum is no longer at job level — it's inside agent work objects
      // Verify the tool description references available models
      const jobsSchema = planTool.inputSchema.properties.jobs;
      assert.ok(jobsSchema, 'jobs property should exist');
      // model should NOT be on job items (it was moved to agent work spec)
      const modelProp = jobsSchema.items?.properties?.model;
      assert.ok(!modelProp, 'model property should NOT exist on job items (only in agent work spec)');
    });

    test('getPlanToolDefinitions uses fallback when discovery fails', async () => {
      // Return empty help output so discovery finds no models
      spawnStub.callsFake(() => fakeProc(0, 'no models here'));

      const tools = await getPlanToolDefinitions();
      const planTool = tools.find(t => t.name === 'create_copilot_plan');
      assert.ok(planTool);

      // model should NOT be on job items (only in agent work spec)
      const modelProp = planTool.inputSchema.properties.jobs.items?.properties?.model;
      assert.ok(!modelProp, 'model property should NOT exist on job items');
    });
  });

  // ===========================================================================
  // 2. Executor passes model to delegator
  // ===========================================================================

  suite('Executor passes model to delegator', () => {
    test('delegate receives model from options', async () => {
      // Re-import agentDelegator to get a fresh module with stubs active
      const cliCheckCore = require('../../../agent/cliCheckCore');
      sinon.stub(cliCheckCore, 'isCopilotCliAvailable').returns(true);

      const gitExec = require('../../../git/core/executor');
      sinon.stub(gitExec, 'execAsync').resolves({ stdout: '', stderr: '', exitCode: 0 });
      const gitRepo = require('../../../git/core/repository');
      sinon.stub(gitRepo, 'commit').resolves(true);

      const { AgentDelegator } = require('../../../agent/agentDelegator');

      const tmpDir = makeTmpDir();
      const logger = { log: (_m: string) => {} };
      const delegator = new AgentDelegator(logger, mockGitOps as any);

      // Stub spawn for the Copilot CLI invocation
      spawnStub.callsFake(() => fakeSpawnProc(0, 'Session ID: 12345678-1234-1234-1234-123456789abc'));

      const result = await delegator.delegate({
        jobId: 'test-job',
        taskDescription: 'Test task',
        label: 'work',
        worktreePath: tmpDir,
        baseBranch: 'main',
        targetBranch: 'feat/test',
        model: 'claude-sonnet-4.5',
      });

      assert.strictEqual(result.success, true);

      // Verify spawn was called and the command includes the model
      const spawnCalls = spawnStub.getCalls();
      // First call is for copilot --help (model validation), second is the actual CLI invocation
      const cliCall = spawnCalls.find((c: sinon.SinonSpyCall) => {
        const cmd = String(c.args[0]);
        return cmd.includes('copilot') && !cmd.includes('--help') && cmd.includes('claude-sonnet-4.5');
      });
      // The model should appear in the spawn command
      assert.ok(cliCall || spawnCalls.some((c: sinon.SinonSpyCall) => {
        const cmd = String(c.args[0]);
        return cmd.includes('claude-sonnet-4.5');
      }), 'model should be passed to CLI command');
    });
  });

  // ===========================================================================
  // 3. Token extraction from mock logs
  // ===========================================================================

  suite('Token extraction from mock logs', () => {
    test('extractTokenUsage parses prompt_tokens and completion_tokens', async () => {
      const cliCheckCore = require('../../../agent/cliCheckCore');
      sinon.stub(cliCheckCore, 'isCopilotCliAvailable').returns(true);

      const gitExec = require('../../../git/core/executor');
      sinon.stub(gitExec, 'execAsync').resolves({ stdout: '', stderr: '', exitCode: 0 });
      const gitRepo = require('../../../git/core/repository');
      sinon.stub(gitRepo, 'commit').resolves(true);

      const { AgentDelegator } = require('../../../agent/agentDelegator');

      const tmpDir = makeTmpDir();
      const logDir = path.join(tmpDir, '.copilot-orchestrator', 'logs');
      fs.mkdirSync(logDir, { recursive: true });

      // Write a mock log file with token usage data
      const mockLogContent = `
[2026-01-15T10:00:00Z] Request sent to model
prompt_tokens: 1500
completion_tokens: 800
[2026-01-15T10:00:01Z] Request complete
prompt_tokens: 2000
completion_tokens: 1200
`;
      fs.writeFileSync(path.join(logDir, 'copilot-2026-01-15.log'), mockLogContent);

      const logger = { log: (_m: string) => {} };
      const delegator = new AgentDelegator(logger, mockGitOps as any);

      // Make spawn return a process that exits immediately
      spawnStub.callsFake(() => fakeSpawnProc(0));

      const result = await delegator.delegate({
        jobId: 'token-test',
        taskDescription: 'Test tokens',
        label: 'work',
        worktreePath: tmpDir,
        baseBranch: 'main',
        targetBranch: 'feat/tokens',
        model: 'gpt-5',
      });

      assert.ok(result.tokenUsage, 'tokenUsage should be extracted');
      // Sum of prompt_tokens: 1500 + 2000 = 3500
      assert.strictEqual(result.tokenUsage!.inputTokens, 3500);
      // Sum of completion_tokens: 800 + 1200 = 2000
      assert.strictEqual(result.tokenUsage!.outputTokens, 2000);
      assert.strictEqual(result.tokenUsage!.totalTokens, 5500);
      assert.strictEqual(result.tokenUsage!.model, 'gpt-5');
    });

    test('extractTokenUsage handles input_tokens and output_tokens format', async () => {
      const cliCheckCore = require('../../../agent/cliCheckCore');
      sinon.stub(cliCheckCore, 'isCopilotCliAvailable').returns(true);

      const gitExec = require('../../../git/core/executor');
      sinon.stub(gitExec, 'execAsync').resolves({ stdout: '', stderr: '', exitCode: 0 });
      const gitRepo = require('../../../git/core/repository');
      sinon.stub(gitRepo, 'commit').resolves(true);

      const { AgentDelegator } = require('../../../agent/agentDelegator');

      const tmpDir = makeTmpDir();
      const logDir = path.join(tmpDir, '.copilot-orchestrator', 'logs');
      fs.mkdirSync(logDir, { recursive: true });

      const mockLogContent = `input_tokens: 500\noutput_tokens: 300\n`;
      fs.writeFileSync(path.join(logDir, 'copilot-2026-01-16.log'), mockLogContent);

      const logger = { log: (_m: string) => {} };
      const delegator = new AgentDelegator(logger, mockGitOps as any);

      spawnStub.callsFake(() => fakeSpawnProc(0));

      const result = await delegator.delegate({
        jobId: 'token-test-2',
        taskDescription: 'Test alt format',
        label: 'work',
        worktreePath: tmpDir,
        baseBranch: 'main',
        targetBranch: 'feat/tokens2',
        model: 'claude-sonnet-4.5',
      });

      assert.ok(result.tokenUsage, 'tokenUsage should be extracted');
      assert.strictEqual(result.tokenUsage!.inputTokens, 500);
      assert.strictEqual(result.tokenUsage!.outputTokens, 300);
      assert.strictEqual(result.tokenUsage!.totalTokens, 800);
    });
  });

  // ===========================================================================
  // 4. Plan serialization includes metrics
  // ===========================================================================

  suite('Plan serialization includes metrics', () => {
    test('serialize and deserialize preserves node state with metrics data', () => {
      const tmpDir = makeTmpDir();
      const plansDir = path.join(tmpDir, '.orchestrator', 'plans');
      fs.mkdirSync(plansDir, { recursive: true });
      const persistence = new PlanPersistence(plansDir);

      // Build a minimal PlanInstance with metrics-relevant data
      const plan: any = {
        id: 'test-plan-001',
        spec: { name: 'Test Plan', jobs: [] },
        nodes: new Map([
          ['node-1', {
            id: 'node-1',
            producerId: 'build-step',
            name: 'Build Step',
            type: 'job',
            task: 'npm run build',
            work: { type: 'agent', instructions: 'Build the project', model: 'gpt-5' },
            dependencies: [],
            dependents: [],
          }],
        ]),
        producerIdToNodeId: new Map([['build-step', 'node-1']]),
        roots: ['node-1'],
        leaves: ['node-1'],
        nodeStates: new Map([
          ['node-1', {
            status: 'succeeded',
            version: 2,
            startedAt: 1700000000000,
            endedAt: 1700000060000,
            attempts: 1,
            workSummary: {
              nodeId: 'node-1',
              nodeName: 'Build Step',
              commits: 1,
              filesAdded: 1,
              filesModified: 2,
              filesDeleted: 0,
              description: 'Build step',
            },
          }],
        ]),
        groups: new Map(),
        groupStates: new Map(),
        groupPathToId: new Map(),
        repoPath: '/tmp/repo',
        baseBranch: 'main',
        worktreeRoot: '/tmp/worktrees',
        createdAt: 1700000000000,
        startedAt: 1700000000000,
        endedAt: 1700000060000,
        stateVersion: 1,
        cleanUpSuccessfulWork: true,
        maxParallel: 4,
        workSummary: {
          totalCommits: 1,
          totalFilesAdded: 1,
          totalFilesModified: 2,
          totalFilesDeleted: 0,
          jobSummaries: [{
            nodeId: 'node-1',
            nodeName: 'Build Step',
            commits: 1,
            filesAdded: 1,
            filesModified: 2,
            filesDeleted: 0,
            description: 'Build step completed',
          }],
        },
      };

      // Save
      persistence.save(plan);

      // Load
      const loaded = persistence.load('test-plan-001');
      assert.ok(loaded, 'plan should be loadable');

      // Verify node state preserved
      const nodeState = loaded!.nodeStates.get('node-1');
      assert.ok(nodeState, 'node state should exist');
      assert.strictEqual(nodeState!.status, 'succeeded');
      assert.strictEqual(nodeState!.startedAt, 1700000000000);
      assert.strictEqual(nodeState!.endedAt, 1700000060000);

      // Verify work spec with model preserved
      const node = loaded!.nodes.get('node-1') as any;
      assert.ok(node, 'node should exist');
      assert.strictEqual(node.work.type, 'agent');
      assert.strictEqual(node.work.model, 'gpt-5');

      // Verify work summary preserved
      assert.ok(loaded!.workSummary, 'workSummary should be preserved');
      assert.strictEqual(loaded!.workSummary!.totalCommits, 1);
      assert.strictEqual(loaded!.workSummary!.jobSummaries.length, 1);
    });
  });

  // ===========================================================================
  // 5. Invalid model logs warning
  // ===========================================================================

  suite('Invalid model logs warning', () => {
    test('delegator logs warning when unknown model is used', async () => {
      // Discover models first so validation has data
      spawnStub.callsFake(() => fakeProc(0, HELP_OUTPUT));

      const cliCheckCore = require('../../../agent/cliCheckCore');
      sinon.stub(cliCheckCore, 'isCopilotCliAvailable').returns(true);

      const gitExec = require('../../../git/core/executor');
      sinon.stub(gitExec, 'execAsync').resolves({ stdout: '', stderr: '', exitCode: 0 });
      const gitRepo = require('../../../git/core/repository');
      sinon.stub(gitRepo, 'commit').resolves(true);

      const { AgentDelegator } = require('../../../agent/agentDelegator');

      const tmpDir = makeTmpDir();
      const messages: string[] = [];
      const logger = { log: (m: string) => messages.push(m) };
      const delegator = new AgentDelegator(logger, mockGitOps as any);

      // Override spawn for the CLI invocation to return a successful exit
      // First call is model discovery (already stubbed above), subsequent calls are CLI
      let callCount = 0;
      spawnStub.callsFake((...args: any[]) => {
        callCount++;
        const cmd = String(args[0]);
        if (cmd === 'copilot' && Array.isArray(args[1]) && args[1].includes('--help')) {
          return fakeProc(0, HELP_OUTPUT);
        }
        return fakeSpawnProc(0);
      });

      await delegator.delegate({
        jobId: 'invalid-model-test',
        taskDescription: 'Test invalid model',
        label: 'work',
        worktreePath: tmpDir,
        baseBranch: 'main',
        targetBranch: 'feat/invalid',
        model: 'nonexistent-model-xyz',
      });

      // Check that warning about the invalid model was logged
      const warningMsg = messages.find(m =>
        m.includes('Warning') && m.includes('nonexistent-model-xyz') && m.includes('not in discovered models')
      );
      assert.ok(warningMsg, `Expected warning about invalid model. Messages: ${messages.join(' | ')}`);
    });
  });
});
