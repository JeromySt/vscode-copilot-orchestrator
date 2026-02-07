/**
 * @fileoverview Unit tests for simplified node types
 *
 * Tests cover:
 * - NodeSpec type structure
 * - NodeInstance type structure
 * - GroupInfo type structure
 * - GroupStatus type
 * - GroupStatusSnapshot type
 * - Type exports from plan/types barrel
 */

import * as assert from 'assert';
import type {
  NodeSpec,
  NodeInstance,
  GroupInfo,
  GroupStatus,
  GroupStatusSnapshot,
  AttemptContext,
  NodeStatus,
} from '../../../plan/types';

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('Simplified Node Types', () => {
  let quiet: { restore: () => void };

  setup(() => {
    quiet = silenceConsole();
  });

  teardown(() => {
    quiet.restore();
  });

  // =========================================================================
  // NodeSpec
  // =========================================================================
  suite('NodeSpec', () => {
    test('can create a minimal NodeSpec', () => {
      const spec: NodeSpec = {
        producerId: 'build',
        task: 'Build the project',
        dependencies: [],
      };
      assert.strictEqual(spec.producerId, 'build');
      assert.strictEqual(spec.task, 'Build the project');
      assert.deepStrictEqual(spec.dependencies, []);
    });

    test('can create a full NodeSpec with all optional fields', () => {
      const spec: NodeSpec = {
        producerId: 'test',
        name: 'Test Step',
        task: 'Run tests',
        work: 'npm test',
        prechecks: 'npm run lint',
        postchecks: 'npm run check',
        instructions: '# Run Tests\n1. Install deps\n2. Run tests',
        dependencies: ['build'],
        baseBranch: 'develop',
      };
      assert.strictEqual(spec.name, 'Test Step');
      assert.strictEqual(spec.work, 'npm test');
      assert.strictEqual(spec.baseBranch, 'develop');
    });
  });

  // =========================================================================
  // NodeInstance
  // =========================================================================
  suite('NodeInstance', () => {
    test('can create a minimal NodeInstance', () => {
      const node: NodeInstance = {
        id: 'uuid-1',
        producerId: 'build',
        name: 'build',
        task: 'Build the project',
        dependencies: [],
        dependents: [],
        status: 'pending',
        repoPath: '/repo',
        attempts: 0,
      };
      assert.strictEqual(node.id, 'uuid-1');
      assert.strictEqual(node.status, 'pending');
      assert.strictEqual(node.attempts, 0);
    });

    test('can create a NodeInstance with group', () => {
      const group: GroupInfo = {
        id: 'group-1',
        name: 'Test Group',
        baseBranch: 'main',
        maxParallel: 4,
        cleanUpSuccessfulWork: true,
        worktreeRoot: '/worktrees',
        createdAt: 1000,
      };

      const node: NodeInstance = {
        id: 'uuid-1',
        producerId: 'build',
        name: 'build',
        task: 'Build',
        dependencies: [],
        dependents: [],
        group,
        status: 'ready',
        repoPath: '/repo',
        attempts: 0,
      };
      assert.strictEqual(node.group?.id, 'group-1');
      assert.strictEqual(node.group?.name, 'Test Group');
    });

    test('can include execution state fields', () => {
      const node: NodeInstance = {
        id: 'uuid-1',
        producerId: 'build',
        name: 'build',
        task: 'Build',
        dependencies: [],
        dependents: [],
        status: 'succeeded',
        repoPath: '/repo',
        attempts: 1,
        scheduledAt: 1000,
        startedAt: 1001,
        endedAt: 1010,
        baseCommit: 'abc123',
        completedCommit: 'def456',
        worktreePath: '/worktrees/abc',
        mergedToTarget: true,
        worktreeCleanedUp: false,
      };
      assert.strictEqual(node.status, 'succeeded');
      assert.strictEqual(node.completedCommit, 'def456');
      assert.strictEqual(node.mergedToTarget, true);
    });
  });

  // =========================================================================
  // GroupInfo
  // =========================================================================
  suite('GroupInfo', () => {
    test('can create a GroupInfo', () => {
      const group: GroupInfo = {
        id: 'group-1',
        name: 'Feature Work',
        baseBranch: 'main',
        maxParallel: 4,
        cleanUpSuccessfulWork: true,
        worktreeRoot: '/worktrees',
        createdAt: Date.now(),
      };
      assert.strictEqual(group.name, 'Feature Work');
      assert.strictEqual(group.maxParallel, 4);
    });

    test('can include parent group for sub-groups', () => {
      const group: GroupInfo = {
        id: 'sub-group-1',
        name: 'Sub Feature',
        baseBranch: 'main',
        maxParallel: 2,
        cleanUpSuccessfulWork: true,
        worktreeRoot: '/worktrees',
        parentGroupId: 'parent-group-1',
        createdAt: Date.now(),
      };
      assert.strictEqual(group.parentGroupId, 'parent-group-1');
    });
  });

  // =========================================================================
  // GroupStatus
  // =========================================================================
  suite('GroupStatus', () => {
    test('supports all expected values', () => {
      const statuses: GroupStatus[] = [
        'pending', 'running', 'succeeded', 'failed', 'partial', 'canceled'
      ];
      assert.strictEqual(statuses.length, 6);
    });
  });

  // =========================================================================
  // AttemptContext
  // =========================================================================
  suite('AttemptContext', () => {
    test('can create an AttemptContext', () => {
      const ctx: AttemptContext = {
        phase: 'work',
        startTime: 1000,
        endTime: 2000,
        error: 'Build failed',
        exitCode: 1,
      };
      assert.strictEqual(ctx.phase, 'work');
      assert.strictEqual(ctx.exitCode, 1);
    });
  });
});
