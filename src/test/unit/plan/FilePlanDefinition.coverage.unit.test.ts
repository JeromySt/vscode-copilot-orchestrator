/**
 * @fileoverview Coverage tests for FilePlanDefinition.
 * Covers: getPrechecksSpec (135-151), getPostchecksSpec (153-176),
 * getDependencies (178-186), and getVerifyRiSpec (188-191).
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { FilePlanDefinition } from '../../../plan/repository/FilePlanDefinition';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function makeMetadata(overrides?: any): any {
  return {
    id: 'plan-1',
    baseBranch: 'main',
    targetBranch: 'feature/test',
    maxParallel: 4,
    createdAt: 1000000,
    spec: {
      name: 'Test Plan',
      status: 'running',
      verifyRiSpec: undefined,
    },
    jobs: [],
    ...overrides,
  };
}

function makeJob(id: string, overrides?: any): any {
  return {
    id,
    producerId: `prod-${id}`,
    name: `Job ${id}`,
    task: 'Do something',
    dependencies: [],
    group: undefined,
    hasWork: false,
    hasPrechecks: false,
    hasPostchecks: false,
    ...overrides,
  };
}

suite('FilePlanDefinition coverage', () => {
  let sandbox: sinon.SinonSandbox;
  let quiet: { restore: () => void };
  let mockStore: any;

  setup(() => {
    sandbox = sinon.createSandbox();
    quiet = silenceConsole();
    mockStore = {
      readNodeSpec: sandbox.stub().resolves(undefined),
      writeNodeSpec: sandbox.stub().resolves(),
    };
  });

  teardown(() => {
    quiet.restore();
    sandbox.restore();
  });

  // ── getPrechecksSpec ──────────────────────────────────────────────────────

  suite('getPrechecksSpec', () => {
    test('returns undefined when node not found', async () => {
      const metadata = makeMetadata({ jobs: [] });
      const def = new FilePlanDefinition(metadata, mockStore);

      const result = await def.getPrechecksSpec('nonexistent');

      assert.strictEqual(result, undefined);
      assert.ok(mockStore.readNodeSpec.notCalled);
    });

    test('returns spec when hasPrechecks=true and spec exists on disk', async () => {
      const spec = { instructions: 'Run tsc', command: 'npx tsc --noEmit', cwd: '/repo' };
      mockStore.readNodeSpec.resolves(spec);
      const metadata = makeMetadata({
        jobs: [makeJob('node-1', { hasPrechecks: true })],
      });
      const def = new FilePlanDefinition(metadata, mockStore);

      const result = await def.getPrechecksSpec('node-1');

      assert.deepStrictEqual(result, spec);
      assert.ok(mockStore.readNodeSpec.calledWith('plan-1', 'node-1', 'prechecks'));
    });

    test('returns undefined when hasPrechecks=true but no spec on disk', async () => {
      mockStore.readNodeSpec.resolves(undefined);
      const metadata = makeMetadata({
        jobs: [makeJob('node-1', { hasPrechecks: true })],
      });
      const def = new FilePlanDefinition(metadata, mockStore);

      const result = await def.getPrechecksSpec('node-1');

      assert.strictEqual(result, undefined);
      assert.ok(mockStore.readNodeSpec.calledWith('plan-1', 'node-1', 'prechecks'));
    });

    test('returns undefined without reading disk when hasPrechecks=false', async () => {
      const metadata = makeMetadata({
        jobs: [makeJob('node-1', { hasPrechecks: false })],
      });
      const def = new FilePlanDefinition(metadata, mockStore);

      const result = await def.getPrechecksSpec('node-1');

      assert.strictEqual(result, undefined);
      assert.ok(mockStore.readNodeSpec.notCalled);
    });
  });

  // ── getPostchecksSpec ─────────────────────────────────────────────────────

  suite('getPostchecksSpec', () => {
    test('returns undefined when node not found', async () => {
      const metadata = makeMetadata({ jobs: [] });
      const def = new FilePlanDefinition(metadata, mockStore);

      const result = await def.getPostchecksSpec('missing-node');

      assert.strictEqual(result, undefined);
      assert.ok(mockStore.readNodeSpec.notCalled);
    });

    test('returns spec when hasPostchecks=true and spec exists on disk', async () => {
      const spec = { instructions: 'Run tests', command: 'npm test', cwd: '/repo' };
      mockStore.readNodeSpec.resolves(spec);
      const metadata = makeMetadata({
        jobs: [makeJob('node-2', { hasPostchecks: true })],
      });
      const def = new FilePlanDefinition(metadata, mockStore);

      const result = await def.getPostchecksSpec('node-2');

      assert.deepStrictEqual(result, spec);
      assert.ok(mockStore.readNodeSpec.calledWith('plan-1', 'node-2', 'postchecks'));
    });

    test('returns undefined when hasPostchecks=true but no spec on disk', async () => {
      mockStore.readNodeSpec.resolves(undefined);
      const metadata = makeMetadata({
        jobs: [makeJob('node-2', { hasPostchecks: true })],
      });
      const def = new FilePlanDefinition(metadata, mockStore);

      const result = await def.getPostchecksSpec('node-2');

      assert.strictEqual(result, undefined);
    });

    test('returns undefined without reading disk when hasPostchecks=false', async () => {
      const metadata = makeMetadata({
        jobs: [makeJob('node-2', { hasPostchecks: false })],
      });
      const def = new FilePlanDefinition(metadata, mockStore);

      const result = await def.getPostchecksSpec('node-2');

      assert.strictEqual(result, undefined);
      assert.ok(mockStore.readNodeSpec.notCalled);
    });
  });

  // ── getDependencies ───────────────────────────────────────────────────────

  suite('getDependencies', () => {
    test('returns empty array when node not found', () => {
      const metadata = makeMetadata({ jobs: [] });
      const def = new FilePlanDefinition(metadata, mockStore);

      const deps = def.getDependencies('nonexistent');

      assert.deepStrictEqual(deps, []);
    });

    test('returns copy of dependencies when node found', () => {
      const metadata = makeMetadata({
        jobs: [makeJob('node-3', { dependencies: ['node-1', 'node-2'] })],
      });
      const def = new FilePlanDefinition(metadata, mockStore);

      const deps = def.getDependencies('node-3');

      assert.deepStrictEqual(deps, ['node-1', 'node-2']);
    });

    test('returns copy (mutation does not affect internal state)', () => {
      const metadata = makeMetadata({
        jobs: [makeJob('node-3', { dependencies: ['node-1'] })],
      });
      const def = new FilePlanDefinition(metadata, mockStore);

      const deps = def.getDependencies('node-3');
      deps.push('injected');

      // Second call should still return original
      const deps2 = def.getDependencies('node-3');
      assert.deepStrictEqual(deps2, ['node-1']);
    });

    test('returns empty array for node with no dependencies', () => {
      const metadata = makeMetadata({
        jobs: [makeJob('node-4', { dependencies: [] })],
      });
      const def = new FilePlanDefinition(metadata, mockStore);

      const deps = def.getDependencies('node-4');

      assert.deepStrictEqual(deps, []);
    });
  });

  // ── getVerifyRiSpec ───────────────────────────────────────────────────────

  suite('getVerifyRiSpec', () => {
    test('returns verifyRiSpec from metadata spec when present', () => {
      const verifySpec = { instructions: 'Verify RI', command: 'npm test', cwd: '/repo' };
      const metadata = makeMetadata({
        spec: { name: 'Plan', status: 'running', verifyRiSpec: verifySpec },
      });
      const def = new FilePlanDefinition(metadata, mockStore);

      const result = def.getVerifyRiSpec();

      assert.deepStrictEqual(result, verifySpec);
    });

    test('returns undefined when verifyRiSpec is not set in metadata', () => {
      const metadata = makeMetadata({
        spec: { name: 'Plan', status: 'running', verifyRiSpec: undefined },
      });
      const def = new FilePlanDefinition(metadata, mockStore);

      const result = def.getVerifyRiSpec();

      assert.strictEqual(result, undefined);
    });
  });

  // ── getWorkSpec ──────────────────────────────────────────────────────────

  suite('getWorkSpec', () => {
    test('returns spec when hasWork=true and spec exists on disk', async () => {
      const spec = { instructions: 'Do work', command: undefined, cwd: '/repo' };
      mockStore.readNodeSpec.resolves(spec);
      const metadata = makeMetadata({
        jobs: [makeJob('node-5', { hasWork: true })],
      });
      const def = new FilePlanDefinition(metadata, mockStore);

      const result = await def.getWorkSpec('node-5');

      assert.deepStrictEqual(result, spec);
      assert.ok(mockStore.readNodeSpec.calledWith('plan-1', 'node-5', 'work'));
    });

    test('returns undefined when hasWork=true but no spec on disk', async () => {
      mockStore.readNodeSpec.resolves(undefined);
      const metadata = makeMetadata({
        jobs: [makeJob('node-5', { hasWork: true })],
      });
      const def = new FilePlanDefinition(metadata, mockStore);

      const result = await def.getWorkSpec('node-5');

      assert.strictEqual(result, undefined);
    });
  });

  // ── Basic property accessors ──────────────────────────────────────────────

  suite('basic properties', () => {
    test('returns correct id, name, status, baseBranch, targetBranch', () => {
      const metadata = makeMetadata();
      const def = new FilePlanDefinition(metadata, mockStore);

      assert.strictEqual(def.id, 'plan-1');
      assert.strictEqual(def.name, 'Test Plan');
      assert.strictEqual(def.status, 'running');
      assert.strictEqual(def.baseBranch, 'main');
      assert.strictEqual(def.targetBranch, 'feature/test');
      assert.strictEqual(def.maxParallel, 4);
      assert.strictEqual(def.createdAt, 1000000);
    });

    test('getNodeIds returns all job ids', () => {
      const metadata = makeMetadata({
        jobs: [makeJob('node-a'), makeJob('node-b'), makeJob('node-c')],
      });
      const def = new FilePlanDefinition(metadata, mockStore);

      assert.deepStrictEqual(def.getNodeIds(), ['node-a', 'node-b', 'node-c']);
    });

    test('getNode returns undefined for missing node', () => {
      const metadata = makeMetadata({ jobs: [] });
      const def = new FilePlanDefinition(metadata, mockStore);

      assert.strictEqual(def.getNode('missing'), undefined);
    });

    test('getNodeByProducerId returns undefined for missing producerId', () => {
      const metadata = makeMetadata({ jobs: [] });
      const def = new FilePlanDefinition(metadata, mockStore);

      assert.strictEqual(def.getNodeByProducerId('missing-prod'), undefined);
    });

    test('getNodeByProducerId returns node when found', () => {
      const metadata = makeMetadata({
        jobs: [makeJob('node-x', { producerId: 'prod-x' })],
      });
      const def = new FilePlanDefinition(metadata, mockStore);

      const node = def.getNodeByProducerId('prod-x');
      assert.ok(node);
      assert.strictEqual(node.id, 'node-x');
    });
  });
});
