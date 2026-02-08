/**
 * @fileoverview Tests for PlanPersistence (src/plan/persistence.ts).
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PlanPersistence } from '../../../plan/persistence';
import { PlanInstance, NodeExecutionState, JobNode, GroupInstance, GroupExecutionState } from '../../../plan/types';

function silenceConsole() {
  sinon.stub(console, 'error');
  sinon.stub(console, 'warn');
}

/** Create a minimal PlanInstance for testing. */
function createTestPlan(id: string, name: string = 'Test Plan'): PlanInstance {
  const nodeId = `node-${id}`;
  const node: JobNode = {
    id: nodeId,
    producerId: 'job-1',
    name: 'Test Job',
    type: 'job',
    task: 'do something',
    dependencies: [],
    dependents: [],
  };

  const nodeState: NodeExecutionState = {
    status: 'pending',
    version: 0,
    attempts: 0,
  };

  const nodes = new Map<string, JobNode>();
  nodes.set(nodeId, node);

  const nodeStates = new Map<string, NodeExecutionState>();
  nodeStates.set(nodeId, nodeState);

  const producerIdToNodeId = new Map<string, string>();
  producerIdToNodeId.set('job-1', nodeId);

  return {
    id,
    spec: { name, jobs: [] },
    nodes: nodes as any,
    producerIdToNodeId,
    roots: [nodeId],
    leaves: [nodeId],
    nodeStates,
    groups: new Map<string, GroupInstance>(),
    groupStates: new Map<string, GroupExecutionState>(),
    groupPathToId: new Map<string, string>(),
    repoPath: '/repo',
    baseBranch: 'main',
    worktreeRoot: '.worktrees',
    createdAt: Date.now(),
    stateVersion: 0,
    cleanUpSuccessfulWork: true,
    maxParallel: 4,
  };
}

suite('PlanPersistence', () => {
  let tmpDir: string;
  let persistence: PlanPersistence;

  setup(() => {
    silenceConsole();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-persistence-test-'));
    persistence = new PlanPersistence(tmpDir);
  });

  teardown(() => {
    sinon.restore();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // =========================================================================
  // save
  // =========================================================================

  suite('save', () => {
    test('saves plan to disk as JSON', () => {
      const plan = createTestPlan('plan-1');
      persistence.save(plan);

      const filePath = path.join(tmpDir, 'plan-plan-1.json');
      assert.ok(fs.existsSync(filePath));

      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      assert.strictEqual(content.id, 'plan-1');
    });

    test('updates index file on save', () => {
      const plan = createTestPlan('plan-1', 'My Plan');
      persistence.save(plan);

      const indexPath = path.join(tmpDir, 'plans-index.json');
      assert.ok(fs.existsSync(indexPath));

      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      assert.ok(index.plans['plan-1']);
      assert.strictEqual(index.plans['plan-1'].name, 'My Plan');
    });
  });

  // =========================================================================
  // load
  // =========================================================================

  suite('load', () => {
    test('loads a saved plan', () => {
      const plan = createTestPlan('plan-2', 'Loaded Plan');
      persistence.save(plan);

      const loaded = persistence.load('plan-2');
      assert.ok(loaded);
      assert.strictEqual(loaded!.id, 'plan-2');
      assert.strictEqual(loaded!.spec.name, 'Loaded Plan');
      assert.ok(loaded!.nodes instanceof Map);
      assert.ok(loaded!.nodeStates instanceof Map);
    });

    test('returns undefined for nonexistent plan', () => {
      const loaded = persistence.load('nonexistent');
      assert.strictEqual(loaded, undefined);
    });

    test('returns undefined for corrupt file', () => {
      const filePath = path.join(tmpDir, 'plan-corrupt.json');
      fs.writeFileSync(filePath, '{ invalid json');

      const loaded = persistence.load('corrupt');
      assert.strictEqual(loaded, undefined);
    });

    test('preserves node data through save/load cycle', () => {
      const plan = createTestPlan('plan-3');
      const nodeId = plan.roots[0];
      plan.nodeStates.get(nodeId)!.status = 'succeeded';
      plan.nodeStates.get(nodeId)!.startedAt = 1000;
      plan.nodeStates.get(nodeId)!.endedAt = 2000;

      persistence.save(plan);
      const loaded = persistence.load('plan-3')!;

      const loadedState = loaded.nodeStates.get(nodeId);
      assert.strictEqual(loadedState?.status, 'succeeded');
      assert.strictEqual(loadedState?.startedAt, 1000);
      assert.strictEqual(loadedState?.endedAt, 2000);
    });
  });

  // =========================================================================
  // delete
  // =========================================================================

  suite('delete', () => {
    test('deletes plan file from disk', () => {
      const plan = createTestPlan('plan-del');
      persistence.save(plan);
      assert.ok(fs.existsSync(path.join(tmpDir, 'plan-plan-del.json')));

      const result = persistence.delete('plan-del');
      assert.strictEqual(result, true);
      assert.ok(!fs.existsSync(path.join(tmpDir, 'plan-plan-del.json')));
    });

    test('returns false for nonexistent plan', () => {
      const result = persistence.delete('nonexistent');
      assert.strictEqual(result, false);
    });

    test('removes plan from index', () => {
      const plan = createTestPlan('plan-del2');
      persistence.save(plan);
      persistence.delete('plan-del2');

      const indexPath = path.join(tmpDir, 'plans-index.json');
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      assert.strictEqual(index.plans['plan-del2'], undefined);
    });
  });

  // =========================================================================
  // listplanIds
  // =========================================================================

  suite('listplanIds', () => {
    test('returns empty array when no plans', () => {
      const ids = persistence.listplanIds();
      assert.deepStrictEqual(ids, []);
    });

    test('lists saved plan IDs', () => {
      persistence.save(createTestPlan('a'));
      persistence.save(createTestPlan('b'));

      const ids = persistence.listplanIds();
      assert.ok(ids.includes('a'));
      assert.ok(ids.includes('b'));
    });
  });

  // =========================================================================
  // loadAll
  // =========================================================================

  suite('loadAll', () => {
    test('returns empty array when no plans', () => {
      const plans = persistence.loadAll();
      assert.deepStrictEqual(plans, []);
    });

    test('loads all saved plans', () => {
      persistence.save(createTestPlan('x'));
      persistence.save(createTestPlan('y'));

      const plans = persistence.loadAll();
      assert.strictEqual(plans.length, 2);
      const ids = plans.map(p => p.id).sort();
      assert.deepStrictEqual(ids, ['x', 'y']);
    });

    test('skips corrupt files gracefully', () => {
      persistence.save(createTestPlan('good'));
      fs.writeFileSync(path.join(tmpDir, 'plan-bad.json'), '{ corrupt');

      const plans = persistence.loadAll();
      assert.strictEqual(plans.length, 1);
      assert.strictEqual(plans[0].id, 'good');
    });
  });

  // =========================================================================
  // saveSync
  // =========================================================================

  suite('saveSync', () => {
    test('delegates to save', () => {
      const plan = createTestPlan('sync-1');
      persistence.saveSync(plan);
      const loaded = persistence.load('sync-1');
      assert.ok(loaded);
      assert.strictEqual(loaded!.id, 'sync-1');
    });
  });

  // =========================================================================
  // groups roundtrip
  // =========================================================================

  suite('groups serialization', () => {
    test('preserves groups through save/load', () => {
      const plan = createTestPlan('grp-1');
      const groupId = 'group-1';
      plan.groups.set(groupId, {
        id: groupId,
        name: 'Test Group',
        path: 'Test Group',
        childGroupIds: [],
        nodeIds: [plan.roots[0]],
        allNodeIds: [plan.roots[0]],
        totalNodes: 1,
      });
      plan.groupStates.set(groupId, {
        status: 'running',
        version: 1,
        runningCount: 1,
        succeededCount: 0,
        failedCount: 0,
        blockedCount: 0,
        canceledCount: 0,
        startedAt: 1000,
      });
      plan.groupPathToId.set('Test Group', groupId);

      persistence.save(plan);
      const loaded = persistence.load('grp-1')!;

      assert.ok(loaded.groups instanceof Map);
      assert.ok(loaded.groupStates instanceof Map);
      assert.ok(loaded.groupPathToId instanceof Map);
      assert.strictEqual(loaded.groups.get(groupId)?.name, 'Test Group');
      assert.strictEqual(loaded.groupStates.get(groupId)?.status, 'running');
      assert.strictEqual(loaded.groupPathToId.get('Test Group'), groupId);
    });
  });

  // =========================================================================
  // index corruption recovery
  // =========================================================================

  suite('index corruption recovery', () => {
    test('handles corrupt index file on save', () => {
      const indexPath = path.join(tmpDir, 'plans-index.json');
      fs.writeFileSync(indexPath, '{ corrupt index');
      
      const plan = createTestPlan('idx-1');
      persistence.save(plan); // should not throw

      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      assert.ok(index.plans['idx-1']);
    });

    test('handles corrupt index file on listplanIds', () => {
      const indexPath = path.join(tmpDir, 'plans-index.json');
      fs.writeFileSync(indexPath, '{ corrupt index');
      
      const ids = persistence.listplanIds();
      assert.deepStrictEqual(ids, []);
    });
  });
});
