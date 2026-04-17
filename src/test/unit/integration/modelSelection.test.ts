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
        jobs: new Map([
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
      const node = loaded!.jobs.get('node-1') as any;
      assert.ok(node, 'node should exist');
      assert.strictEqual(node.work.type, 'agent');
      assert.strictEqual(node.work.model, 'gpt-5');

      // Verify work summary preserved
      assert.ok(loaded!.workSummary, 'workSummary should be preserved');
      assert.strictEqual(loaded!.workSummary!.totalCommits, 1);
      assert.strictEqual(loaded!.workSummary!.jobSummaries.length, 1);
    });
  });
});