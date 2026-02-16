/**
 * @fileoverview Unit tests for DI interfaces
 *
 * Tests verify that interfaces can be implemented and that the
 * module exports are correct.
 */

import * as assert from 'assert';
import type {
  INodeRegistry,
  INodeRunner,
  INodeExecutor,
  INodeStateMachine,
  INodePersistence,
  NodeExecutionContext,
  NodeExecutionResult,
} from '../../../interfaces/INodeRunner';
import type { NodeInstance, NodeStatus, GroupInfo } from '../../../plan/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silenceConsole(): { restore: () => void } {
  const origLog = console.log;
  const origDebug = console.debug;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = () => {};
  console.debug = () => {};
  console.warn = () => {};
  console.error = () => {};
  return {
    restore() {
      console.log = origLog;
      console.debug = origDebug;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

function makeNodeInstance(id: string, overrides?: Partial<NodeInstance>): NodeInstance {
  return {
    id,
    producerId: id,
    name: id,
    task: `Task ${id}`,
    dependencies: [],
    dependents: [],
    status: 'pending',
    repoPath: '/repo',
    attempts: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('DI Interfaces', () => {
  let quiet: { restore: () => void };

  setup(() => {
    quiet = silenceConsole();
  });

  teardown(() => {
    quiet.restore();
  });

  // =========================================================================
  // INodeRegistry
  // =========================================================================
  suite('INodeRegistry', () => {
    test('can be implemented with a Map-based registry', () => {
      class MapRegistry implements INodeRegistry {
        private nodes = new Map<string, NodeInstance>();

        register(node: NodeInstance): void {
          this.nodes.set(node.id, node);
        }

        get(nodeId: string): NodeInstance | undefined {
          return this.nodes.get(nodeId);
        }

        getByProducerId(producerId: string, groupId?: string): NodeInstance | undefined {
          for (const node of this.nodes.values()) {
            if (node.producerId === producerId) {
              if (!groupId || node.group?.id === groupId) {return node;}
            }
          }
          return undefined;
        }

        getByGroup(groupId: string): NodeInstance[] {
          return Array.from(this.nodes.values()).filter(n => n.group?.id === groupId);
        }

        getUngrouped(): NodeInstance[] {
          return Array.from(this.nodes.values()).filter(n => !n.group);
        }

        getAll(): NodeInstance[] {
          return Array.from(this.nodes.values());
        }

        delete(nodeId: string): boolean {
          return this.nodes.delete(nodeId);
        }

        has(nodeId: string): boolean {
          return this.nodes.has(nodeId);
        }
      }

      const registry = new MapRegistry();
      const node = makeNodeInstance('node-1');

      // Register and retrieve
      registry.register(node);
      assert.ok(registry.has('node-1'));
      assert.strictEqual(registry.get('node-1')?.producerId, 'node-1');
      assert.strictEqual(registry.getAll().length, 1);

      // Get by producerId
      assert.strictEqual(registry.getByProducerId('node-1')?.id, 'node-1');

      // Delete
      assert.ok(registry.delete('node-1'));
      assert.strictEqual(registry.has('node-1'), false);
      assert.strictEqual(registry.getAll().length, 0);
    });

    test('getByGroup filters correctly', () => {
      class MapRegistry implements INodeRegistry {
        private nodes = new Map<string, NodeInstance>();
        register(node: NodeInstance): void { this.nodes.set(node.id, node); }
        get(nodeId: string): NodeInstance | undefined { return this.nodes.get(nodeId); }
        getByProducerId(): NodeInstance | undefined { return undefined; }
        getByGroup(groupId: string): NodeInstance[] {
          return Array.from(this.nodes.values()).filter(n => n.group?.id === groupId);
        }
        getUngrouped(): NodeInstance[] {
          return Array.from(this.nodes.values()).filter(n => !n.group);
        }
        getAll(): NodeInstance[] { return Array.from(this.nodes.values()); }
        delete(nodeId: string): boolean { return this.nodes.delete(nodeId); }
        has(nodeId: string): boolean { return this.nodes.has(nodeId); }
      }

      const registry = new MapRegistry();
      const group: GroupInfo = {
        id: 'group-1', name: 'G1', baseBranch: 'main',
        maxParallel: 4, cleanUpSuccessfulWork: true,
        worktreeRoot: '/wt', createdAt: 1000,
      };

      registry.register(makeNodeInstance('n1', { group }));
      registry.register(makeNodeInstance('n2', { group }));
      registry.register(makeNodeInstance('n3'));

      assert.strictEqual(registry.getByGroup('group-1').length, 2);
      assert.strictEqual(registry.getUngrouped().length, 1);
    });
  });

  // =========================================================================
  // INodeExecutor
  // =========================================================================
  suite('INodeExecutor', () => {
    test('can be implemented with a mock executor', async () => {
      class MockExecutor implements INodeExecutor {
        async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
          return { success: true };
        }
        cancel(_nodeId: string): void {}
      }

      const executor = new MockExecutor();
      const ctx: NodeExecutionContext = {
        node: makeNodeInstance('node-1'),
        baseCommit: 'abc123',
        worktreePath: '/wt/node-1',
      };

      const result = await executor.execute(ctx);
      assert.strictEqual(result.success, true);
    });
  });

  // =========================================================================
  // INodeStateMachine
  // =========================================================================
  suite('INodeStateMachine', () => {
    test('can be implemented with basic state tracking', () => {
      class MockStateMachine implements INodeStateMachine {
        private nodes = new Map<string, NodeInstance>();

        addNode(node: NodeInstance): void {
          this.nodes.set(node.id, node);
        }

        transition(nodeId: string, newStatus: NodeStatus): boolean {
          const node = this.nodes.get(nodeId);
          if (!node) {return false;}
          node.status = newStatus;
          return true;
        }

        areDependenciesMet(nodeId: string): boolean {
          const node = this.nodes.get(nodeId);
          if (!node) {return false;}
          return node.dependencies.every(depId => {
            const dep = this.nodes.get(depId);
            return dep?.status === 'succeeded';
          });
        }

        propagateBlocked(failedNodeId: string): void {
          const failed = this.nodes.get(failedNodeId);
          if (!failed) {return;}
          for (const depId of failed.dependents) {
            this.transition(depId, 'blocked');
          }
        }

        getReadyNodes(_groupId?: string): NodeInstance[] {
          return Array.from(this.nodes.values()).filter(n => n.status === 'ready');
        }

        computeGroupStatus(_groupId: string): 'pending' | 'running' | 'succeeded' | 'failed' | 'partial' | 'canceled' {
          return 'pending';
        }

        resetNodeToPending(nodeId: string): void {
          this.transition(nodeId, 'pending');
        }
      }

      const sm = new MockStateMachine();
      const node = makeNodeInstance('n1', { status: 'pending' });
      sm.addNode(node);

      assert.ok(sm.transition('n1', 'ready'));
      assert.deepStrictEqual(sm.getReadyNodes().length, 1);
    });
  });
});
