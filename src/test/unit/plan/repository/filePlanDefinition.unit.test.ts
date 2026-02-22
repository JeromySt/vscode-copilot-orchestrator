/**
 * @fileoverview Unit tests for FilePlanDefinition.
 *
 * Tests the lazy loading plan definition implementation including
 * work spec retrieval and property delegation.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { FilePlanDefinition } from '../../../../plan/repository/FilePlanDefinition';
import type { StoredPlanMetadata, IPlanRepositoryStore } from '../../../../interfaces/IPlanRepositoryStore';
import type { WorkSpec, AgentSpec, ShellSpec } from '../../../../plan/types/specs';

suite('FilePlanDefinition', () => {
  let sandbox: sinon.SinonSandbox;
  let mockStore: any;
  let metadata: StoredPlanMetadata;
  let definition: FilePlanDefinition;

  setup(() => {
    sandbox = sinon.createSandbox();
    
    mockStore = {
      readPlanMetadata: sandbox.stub(),
      writePlanMetadata: sandbox.stub(),
      writePlanMetadataSync: sandbox.stub(),
      readNodeSpec: sandbox.stub(),
      writeNodeSpec: sandbox.stub(),
      moveFileToSpec: sandbox.stub(),
      hasNodeSpec: sandbox.stub(),
      listPlanIds: sandbox.stub().returns([]),
      deletePlan: sandbox.stub(),
      exists: sandbox.stub(),
      migrateLegacy: sandbox.stub(),
    };

    metadata = {
      id: 'test-plan',
      spec: {
        name: 'Test Plan',
        status: 'pending',
        baseBranch: 'main',
        targetBranch: 'feature-branch',
        maxParallel: 4,
        cleanUpSuccessfulWork: true,
        jobs: [],
        groups: []
      },
      jobs: [
        {
          id: 'node-1',
          producerId: 'producer-1',
          name: 'Agent Node',
          task: 'Agent task',
          dependencies: [],
          hasWork: true,
          hasPrechecks: false,
          hasPostchecks: false
        },
        {
          id: 'node-2',
          producerId: 'producer-2',
          name: 'Shell Node',
          task: 'Shell task',
          dependencies: ['producer-1'],
          hasWork: true,
          hasPrechecks: false,
          hasPostchecks: false
        },
        {
          id: 'node-3',
          producerId: 'producer-3',
          name: 'No Work Node',
          task: 'No work task',
          dependencies: [],
          hasWork: false,
          hasPrechecks: false,
          hasPostchecks: false
        }
      ],
      producerIdToNodeId: {
        'producer-1': 'node-1',
        'producer-2': 'node-2',
        'producer-3': 'node-3'
      },
      roots: ['node-1', 'node-3'],
      leaves: ['node-2', 'node-3'],
      nodeStates: {},
      groups: {},
      groupStates: {},
      groupPathToId: {},
      repoPath: '/test/repo',
      baseBranch: 'main',
      targetBranch: 'feature-branch',
      worktreeRoot: '/test/worktrees',
      createdAt: Date.now(),
      maxParallel: 4,
      cleanUpSuccessfulWork: true
    };

    definition = new FilePlanDefinition(metadata, mockStore);
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('property accessors', () => {
    test('should delegate id to metadata correctly', () => {
      assert.strictEqual(definition.id, 'test-plan');
    });

    test('should delegate name to metadata correctly', () => {
      assert.strictEqual(definition.name, 'Test Plan');
    });

    test('should delegate status to metadata correctly', () => {
      assert.strictEqual(definition.status, 'pending');
    });

    test('should delegate baseBranch to metadata correctly', () => {
      assert.strictEqual(definition.baseBranch, 'main');
    });

    test('should delegate targetBranch to metadata correctly', () => {
      assert.strictEqual(definition.targetBranch, 'feature-branch');
    });

    test('should handle undefined targetBranch', () => {
      const metadataNoTarget = { ...metadata, targetBranch: undefined };
      const defNoTarget = new FilePlanDefinition(metadataNoTarget, mockStore);
      
      assert.strictEqual(defNoTarget.targetBranch, undefined);
    });

    test('should delegate createdAt to metadata correctly', () => {
      const expectedTime = metadata.createdAt;
      assert.strictEqual(definition.createdAt, expectedTime);
    });

    test('should delegate maxParallel to metadata correctly', () => {
      assert.strictEqual(definition.maxParallel, 4);
    });
  });

  suite('getWorkSpec lazy loading', () => {
    test('should read from store per call - call twice, store called twice', async () => {
      const expectedSpec = '# Agent Instructions\nDo the work';
      mockStore.readNodeSpec.resolves(expectedSpec);

      // First call (use node id, not producer id)
      const spec1 = await definition.getWorkSpec('node-1');
      
      // Second call
      const spec2 = await definition.getWorkSpec('node-1');

      // Store should be called twice (no caching)
      assert.strictEqual(mockStore.readNodeSpec.callCount, 2);
      assert.ok(mockStore.readNodeSpec.calledWith('test-plan', 'node-1', 'work'));
      assert.strictEqual(spec1, expectedSpec);
      assert.strictEqual(spec2, expectedSpec);
    });

    test('should read shell/process specs from disk (no inline)', async () => {
      const shellSpec = { type: 'shell', command: 'npm test' };
      mockStore.readNodeSpec.resolves(shellSpec);

      const spec = await definition.getWorkSpec('node-2');

      // Should call store since all specs are on disk now
      assert.ok(mockStore.readNodeSpec.calledOnce);
      assert.deepStrictEqual(spec, shellSpec);
    });

    test('should return undefined for nodes without work', async () => {
      const spec = await definition.getWorkSpec('node-3');

      // Should not call store for nodes without work
      assert.strictEqual(mockStore.readNodeSpec.callCount, 0);
      
      assert.strictEqual(spec, undefined);
    });

    test('should return undefined for non-existent producers', async () => {
      const spec = await definition.getWorkSpec('non-existent-node');

      // Should not call store for non-existent nodes
      assert.strictEqual(mockStore.readNodeSpec.callCount, 0);
      
      assert.strictEqual(spec, undefined);
    });

    test('should handle store errors gracefully', async () => {
      mockStore.readNodeSpec.rejects(new Error('Store error'));

      await assert.rejects(
        () => definition.getWorkSpec('node-1'),
        /Store error/
      );
    });
  });

  suite('node access', () => {
    test('should provide access to node definitions via getNodeIds and getNode', () => {
      const nodeIds = definition.getNodeIds();
      
      assert.strictEqual(nodeIds.length, 3);
      
      const node1 = definition.getNode('node-1');
      assert.ok(node1);
      assert.strictEqual(node1.id, 'node-1');
      assert.strictEqual(node1.producerId, 'producer-1');
      assert.strictEqual(node1.name, 'Agent Node');
      assert.deepStrictEqual(node1.dependencies, []);
    });

    test('should provide access to nodes by producer ID', () => {
      const node1 = definition.getNodeByProducerId('producer-1');
      const node2 = definition.getNodeByProducerId('producer-2');
      const node3 = definition.getNodeByProducerId('producer-3');
      
      assert.ok(node1);
      assert.ok(node2);
      assert.ok(node3);
      assert.strictEqual(node1.id, 'node-1');
      assert.strictEqual(node2.id, 'node-2');
      assert.strictEqual(node3.id, 'node-3');
    });

    test('should return undefined for non-existent node', () => {
      const node = definition.getNode('non-existent');
      assert.strictEqual(node, undefined);
    });

    test('should return undefined for non-existent producer ID', () => {
      const node = definition.getNodeByProducerId('non-existent');
      assert.strictEqual(node, undefined);
    });
  });

  suite('additional metadata access', () => {
    test('should handle missing optional properties', () => {
      const minimalMetadata = {
        ...metadata,
        targetBranch: undefined,
        groups: undefined,
        groupStates: undefined
      };
      const minimalDef = new FilePlanDefinition(minimalMetadata, mockStore);

      assert.strictEqual(minimalDef.targetBranch, undefined);
    });
  });
});