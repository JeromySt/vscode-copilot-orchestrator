/**
 * @fileoverview Unit tests for PlanPersistence.
 *
 * Uses real temporary directories so we exercise the actual filesystem
 * code paths (mkdirSync, writeFileSync, readFileSync, unlinkSync, etc.)
 * and clean up afterwards.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PlanPersistence } from '../../../plan/persistence';
import {
  PlanInstance,
  PlanNode,
  JobNode,
  NodeExecutionState,
} from '../../../plan/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

/** Create a fresh temp directory for one test and track it for cleanup. */
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-persist-test-'));
  tmpDirs.push(dir);
  return dir;
}

/** Remove a directory tree (best-effort). */
function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore – CI clean-up is best-effort
  }
}

/** Build a minimal valid PlanInstance for testing. */
function makePlan(overrides: Partial<PlanInstance> = {}): PlanInstance {
  const nodeId = 'node-1';
  const producerId = 'build';

  const jobNode: JobNode = {
    id: nodeId,
    producerId,
    name: 'Build project',
    type: 'job',
    task: 'npm run build',
    work: { type: 'shell', command: 'npm run build' },
    dependencies: [],
    dependents: [],
  };

  const nodes = new Map<string, PlanNode>();
  nodes.set(nodeId, jobNode);

  const producerIdToNodeId = new Map<string, string>();
  producerIdToNodeId.set(producerId, nodeId);

  const nodeStates = new Map<string, NodeExecutionState>();
  nodeStates.set(nodeId, { status: 'pending', attempts: 0 });

  return {
    id: 'plan-001',
    spec: { name: 'Test Plan', jobs: [], baseBranch: 'main' },
    nodes,
    producerIdToNodeId,
    roots: [nodeId],
    leaves: [nodeId],
    nodeStates,
    groups: new Map(),
    groupStates: new Map(),
    groupPathToId: new Map(),
    repoPath: '/repo',
    baseBranch: 'main',
    worktreeRoot: '/worktrees',
    createdAt: Date.now(),
    cleanUpSuccessfulWork: true,
    maxParallel: 4,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('PlanPersistence', () => {
  // Clean up all temp dirs after each test to avoid cross-test contamination.
  teardown(() => {
    for (const d of tmpDirs) {
      rmrf(d);
    }
    tmpDirs = [];
  });

  // -----------------------------------------------------------------------
  // CRUD basics
  // -----------------------------------------------------------------------

  suite('save & load', () => {
    test('round-trips a plan through save then load', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);
      const plan = makePlan();

      persistence.save(plan);

      const loaded = persistence.load(plan.id);
      assert.ok(loaded, 'loaded plan should be defined');
      assert.strictEqual(loaded!.id, plan.id);
      assert.strictEqual(loaded!.spec.name, plan.spec.name);
      assert.strictEqual(loaded!.baseBranch, plan.baseBranch);
      assert.strictEqual(loaded!.repoPath, plan.repoPath);
      assert.strictEqual(loaded!.maxParallel, plan.maxParallel);
      assert.strictEqual(loaded!.cleanUpSuccessfulWork, plan.cleanUpSuccessfulWork);
    });

    test('preserves node data through serialization', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);
      const plan = makePlan();

      persistence.save(plan);
      const loaded = persistence.load(plan.id)!;

      assert.strictEqual(loaded.nodes.size, 1);
      const node = loaded.nodes.get('node-1') as JobNode;
      assert.ok(node);
      assert.strictEqual(node.type, 'job');
      assert.strictEqual(node.task, 'npm run build');
      assert.strictEqual(node.producerId, 'build');
      assert.strictEqual(node.name, 'Build project');
    });

    test('preserves nodeStates through serialization', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);
      const plan = makePlan();
      plan.nodeStates.set('node-1', {
        status: 'succeeded',
        attempts: 2,
        startedAt: 1000,
        endedAt: 2000,
      });

      persistence.save(plan);
      const loaded = persistence.load(plan.id)!;

      const state = loaded.nodeStates.get('node-1');
      assert.ok(state);
      assert.strictEqual(state!.status, 'succeeded');
      assert.strictEqual(state!.attempts, 2);
      assert.strictEqual(state!.startedAt, 1000);
      assert.strictEqual(state!.endedAt, 2000);
    });

    test('preserves producerIdToNodeId map', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);
      const plan = makePlan();

      persistence.save(plan);
      const loaded = persistence.load(plan.id)!;

      assert.strictEqual(loaded.producerIdToNodeId.get('build'), 'node-1');
    });

    test('preserves optional fields when set', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);
      const plan = makePlan({
        parentPlanId: 'parent-1',
        parentNodeId: 'pnode-1',
        targetBranch: 'feature/x',
        startedAt: 1000,
        endedAt: 5000,
      });

      persistence.save(plan);
      const loaded = persistence.load(plan.id)!;

      assert.strictEqual(loaded.parentPlanId, 'parent-1');
      assert.strictEqual(loaded.parentNodeId, 'pnode-1');
      assert.strictEqual(loaded.targetBranch, 'feature/x');
      assert.strictEqual(loaded.startedAt, 1000);
      assert.strictEqual(loaded.endedAt, 5000);
    });
  });

  // -----------------------------------------------------------------------
  // Update (re-save)
  // -----------------------------------------------------------------------

  suite('update (re-save)', () => {
    test('overwrites an existing plan file on re-save', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);
      const plan = makePlan();

      persistence.save(plan);
      assert.strictEqual(persistence.load(plan.id)!.spec.name, 'Test Plan');

      plan.spec = { ...plan.spec, name: 'Updated Plan' };
      persistence.save(plan);

      const loaded = persistence.load(plan.id)!;
      assert.strictEqual(loaded.spec.name, 'Updated Plan');
    });

    test('updates the index on re-save', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);
      const plan = makePlan();

      persistence.save(plan);
      let ids = persistence.listplanIds();
      assert.ok(ids.includes(plan.id));

      // Re-save should not duplicate the entry
      persistence.save(plan);
      ids = persistence.listplanIds();
      assert.strictEqual(ids.filter(id => id === plan.id).length, 1);
    });
  });

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  suite('delete', () => {
    test('removes plan file and returns true', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);
      const plan = makePlan();
      persistence.save(plan);

      const result = persistence.delete(plan.id);
      assert.strictEqual(result, true);
      assert.strictEqual(persistence.load(plan.id), undefined);
    });

    test('removes plan from index', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);
      const plan = makePlan();
      persistence.save(plan);

      persistence.delete(plan.id);
      const ids = persistence.listplanIds();
      assert.ok(!ids.includes(plan.id));
    });

    test('returns false for non-existent plan', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);
      assert.strictEqual(persistence.delete('does-not-exist'), false);
    });
  });

  // -----------------------------------------------------------------------
  // loadAll
  // -----------------------------------------------------------------------

  suite('loadAll', () => {
    test('returns all saved plans', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);

      const plan1 = makePlan({ id: 'plan-a' });
      const plan2 = makePlan({ id: 'plan-b' });
      persistence.save(plan1);
      persistence.save(plan2);

      const all = persistence.loadAll();
      const ids = all.map(p => p.id).sort();
      assert.deepStrictEqual(ids, ['plan-a', 'plan-b']);
    });

    test('returns empty array when no plans exist', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);
      assert.deepStrictEqual(persistence.loadAll(), []);
    });

    test('skips corrupted plan files gracefully', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);

      const good = makePlan({ id: 'good-plan' });
      persistence.save(good);

      // Write a corrupted plan file
      fs.writeFileSync(path.join(dir, 'plan-corrupt.json'), '{{{invalid json');

      const all = persistence.loadAll();
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0].id, 'good-plan');
    });
  });

  // -----------------------------------------------------------------------
  // listplanIds
  // -----------------------------------------------------------------------

  suite('listplanIds', () => {
    test('returns ids of saved plans from the index', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);

      persistence.save(makePlan({ id: 'p1' }));
      persistence.save(makePlan({ id: 'p2' }));

      const ids = persistence.listplanIds().sort();
      assert.deepStrictEqual(ids, ['p1', 'p2']);
    });

    test('returns empty array when index does not exist', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);
      assert.deepStrictEqual(persistence.listplanIds(), []);
    });

    test('returns empty array when index is corrupted', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);
      fs.writeFileSync(path.join(dir, 'plans-index.json'), 'NOT_JSON');
      assert.deepStrictEqual(persistence.listplanIds(), []);
    });
  });

  // -----------------------------------------------------------------------
  // Corrupted / missing data
  // -----------------------------------------------------------------------

  suite('error handling', () => {
    test('load returns undefined for non-existent plan', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);
      assert.strictEqual(persistence.load('missing'), undefined);
    });

    test('load returns undefined for corrupted JSON', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);
      fs.writeFileSync(path.join(dir, 'plan-bad.json'), 'oops');
      assert.strictEqual(persistence.load('bad'), undefined);
    });

    test('constructor creates storage directory if it does not exist', () => {
      const dir = path.join(makeTmpDir(), 'nested', 'deep');
      assert.ok(!fs.existsSync(dir));

      new PlanPersistence(dir);
      assert.ok(fs.existsSync(dir));
    });
  });

  // -----------------------------------------------------------------------
  // Large plan handling
  // -----------------------------------------------------------------------

  suite('large plans', () => {
    test('handles a plan with many nodes', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);

      const plan = makePlan();
      // Add 100 nodes
      for (let i = 0; i < 100; i++) {
        const nodeId = `node-${i + 100}`;
        const node: JobNode = {
          id: nodeId,
          producerId: `task-${i}`,
          name: `Task ${i}`,
          type: 'job',
          task: `Do thing ${i}`,
          dependencies: i > 0 ? [`node-${i + 99}`] : [],
          dependents: i < 99 ? [`node-${i + 101}`] : [],
        };
        plan.nodes.set(nodeId, node);
        plan.producerIdToNodeId.set(`task-${i}`, nodeId);
        plan.nodeStates.set(nodeId, { status: 'pending', attempts: 0 });
      }

      persistence.save(plan);
      const loaded = persistence.load(plan.id)!;

      assert.ok(loaded);
      // 1 original + 100 added
      assert.strictEqual(loaded.nodes.size, 101);
      const node50 = loaded.nodes.get('node-150') as JobNode;
      assert.ok(node50);
      assert.strictEqual(node50.task, 'Do thing 50');
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent access patterns
  // -----------------------------------------------------------------------

  suite('concurrent access', () => {
    test('multiple persistence instances sharing same directory see each other\'s writes', () => {
      const dir = makeTmpDir();
      const writer = new PlanPersistence(dir);
      const reader = new PlanPersistence(dir);

      const plan = makePlan();
      writer.save(plan);

      const loaded = reader.load(plan.id);
      assert.ok(loaded);
      assert.strictEqual(loaded!.id, plan.id);
    });

    test('last writer wins on concurrent saves', () => {
      const dir = makeTmpDir();
      const p1 = new PlanPersistence(dir);
      const p2 = new PlanPersistence(dir);

      const planA = makePlan({ id: 'shared' });
      const planB = makePlan({ id: 'shared' });
      planA.spec = { ...planA.spec, name: 'Writer A' };
      planB.spec = { ...planB.spec, name: 'Writer B' };

      p1.save(planA);
      p2.save(planB);

      const reader = new PlanPersistence(dir);
      const loaded = reader.load('shared')!;
      assert.strictEqual(loaded.spec.name, 'Writer B');
    });

    test('delete by one instance is visible to another', () => {
      const dir = makeTmpDir();
      const writer = new PlanPersistence(dir);
      const other = new PlanPersistence(dir);

      const plan = makePlan();
      writer.save(plan);
      assert.ok(other.load(plan.id));

      writer.delete(plan.id);
      assert.strictEqual(other.load(plan.id), undefined);
    });
  });

  // -----------------------------------------------------------------------
  // Data integrity – Maps survive round-trip
  // -----------------------------------------------------------------------

  suite('data integrity', () => {
    test('Maps are deserialized back from plain objects', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);
      const plan = makePlan();

      persistence.save(plan);
      const loaded = persistence.load(plan.id)!;

      // Verify the Maps are real Map instances (not plain objects)
      assert.ok(loaded.nodes instanceof Map, 'nodes should be a Map');
      assert.ok(loaded.nodeStates instanceof Map, 'nodeStates should be a Map');
      assert.ok(loaded.producerIdToNodeId instanceof Map, 'producerIdToNodeId should be a Map');
    });

    test('on-disk format is valid JSON', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);
      const plan = makePlan();
      persistence.save(plan);

      const raw = fs.readFileSync(path.join(dir, `plan-${plan.id}.json`), 'utf-8');
      const parsed = JSON.parse(raw);
      assert.strictEqual(parsed.id, plan.id);
      assert.ok(Array.isArray(parsed.nodes));
    });

    test('index file tracks all saved plans', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);

      persistence.save(makePlan({ id: 'x1' }));
      persistence.save(makePlan({ id: 'x2' }));

      const raw = fs.readFileSync(path.join(dir, 'plans-index.json'), 'utf-8');
      const index = JSON.parse(raw);
      assert.ok(index.plans['x1']);
      assert.ok(index.plans['x2']);
    });

    test('saveSync behaves identically to save', () => {
      const dir = makeTmpDir();
      const persistence = new PlanPersistence(dir);
      const plan = makePlan();

      persistence.saveSync(plan);
      const loaded = persistence.load(plan.id)!;
      assert.ok(loaded);
      assert.strictEqual(loaded.id, plan.id);
    });
  });
});
