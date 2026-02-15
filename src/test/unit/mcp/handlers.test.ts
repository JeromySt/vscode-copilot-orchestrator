/**
 * @fileoverview Unit tests for MCP handler utilities
 *
 * Tests cover:
 * - errorResult helper
 * - validateRequired helper
 * - lookupPlan helper
 * - lookupNode helper
 * - isError type guard
 */

import * as assert from 'assert';
import {
  errorResult,
  validateRequired,
  lookupPlan,
  lookupNode,
  isError,
  PlanHandlerContext,
} from '../../../mcp/handlers/utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Suppress Logger console output to avoid hanging test workers. */
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

function makeMockContext(overrides?: Record<string, any>): PlanHandlerContext {
  return {
    PlanRunner: {
      get: () => undefined,
      getPlan: () => undefined,
      ...overrides,
    } as any,
    runner: null as any,
    plans: null as any,
    workspacePath: '/workspace',
    git: {} as any,
  };
}

function makeMockPlan(overrides?: Record<string, any>): any {
  return {
    id: 'plan-1',
    spec: { name: 'Test Plan', jobs: [] },
    nodes: new Map(),
    producerIdToNodeId: new Map(),
    roots: [],
    leaves: [],
    nodeStates: new Map(),
    repoPath: '/workspace',
    baseBranch: 'main',
    worktreeRoot: '/worktrees',
    createdAt: Date.now(),
    maxParallel: 4,
    cleanUpSuccessfulWork: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('MCP Handler Utilities', () => {
  let quiet: { restore: () => void };

  setup(() => {
    quiet = silenceConsole();
  });

  teardown(() => {
    quiet.restore();
  });

  // =========================================================================
  // errorResult
  // =========================================================================
  suite('errorResult', () => {
    test('returns object with success false and error message', () => {
      const result = errorResult('something went wrong');
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'something went wrong');
    });

    test('works with empty string', () => {
      const result = errorResult('');
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, '');
    });
  });

  // =========================================================================
  // validateRequired
  // =========================================================================
  suite('validateRequired', () => {
    test('returns null when all fields present', () => {
      const result = validateRequired({ id: 'abc', name: 'test' }, ['id', 'name']);
      assert.strictEqual(result, null);
    });

    test('returns error when field is missing', () => {
      const result = validateRequired({ id: 'abc' }, ['id', 'name']);
      assert.ok(result);
      assert.strictEqual(result!.success, false);
      assert.ok(result!.error.includes('name'));
    });

    test('returns error when field is empty string', () => {
      const result = validateRequired({ id: '' }, ['id']);
      assert.ok(result);
      assert.strictEqual(result!.success, false);
      assert.ok(result!.error.includes('id'));
    });

    test('returns error when field is undefined', () => {
      const result = validateRequired({ id: undefined }, ['id']);
      assert.ok(result);
      assert.strictEqual(result!.success, false);
    });

    test('returns null for empty fields array', () => {
      const result = validateRequired({}, []);
      assert.strictEqual(result, null);
    });

    test('reports first missing field', () => {
      const result = validateRequired({}, ['alpha', 'beta']);
      assert.ok(result);
      assert.ok(result!.error.includes('alpha'));
    });
  });

  // =========================================================================
  // isError
  // =========================================================================
  suite('isError', () => {
    test('returns true for ErrorResult objects', () => {
      assert.strictEqual(isError({ success: false, error: 'oops' }), true);
    });

    test('returns false for success objects', () => {
      assert.strictEqual(isError({ success: true, data: 'ok' }), false);
    });

    test('returns false for null', () => {
      assert.strictEqual(isError(null), false);
    });

    test('returns false for undefined', () => {
      assert.strictEqual(isError(undefined), false);
    });

    test('returns false for non-objects', () => {
      assert.strictEqual(isError('string'), false);
      assert.strictEqual(isError(42), false);
    });

    test('returns false when error is not a string', () => {
      assert.strictEqual(isError({ success: false, error: 123 }), false);
    });
  });

  // =========================================================================
  // lookupPlan
  // =========================================================================
  suite('lookupPlan', () => {
    test('returns plan when found via get()', () => {
      const mockPlan = makeMockPlan();
      const ctx = makeMockContext({
        get: (id: string) => id === 'plan-1' ? mockPlan : undefined,
      });

      const result = lookupPlan(ctx, 'plan-1');
      assert.ok(!isError(result));
      assert.strictEqual((result as any).id, 'plan-1');
    });

    test('returns error when plan not found', () => {
      const ctx = makeMockContext({
        get: () => undefined,
      });

      const result = lookupPlan(ctx, 'nonexistent');
      assert.ok(isError(result));
      assert.ok((result as any).error.includes('not found'));
    });

    test('uses getPlan method when specified', () => {
      const mockPlan = makeMockPlan();
      const ctx = makeMockContext({
        get: () => undefined,
        getPlan: (id: string) => id === 'plan-1' ? mockPlan : undefined,
      });

      const result = lookupPlan(ctx, 'plan-1', 'getPlan');
      assert.ok(!isError(result));
      assert.strictEqual((result as any).id, 'plan-1');
    });
  });

  // =========================================================================
  // lookupNode
  // =========================================================================
  suite('lookupNode', () => {
    test('returns node and state when found', () => {
      const node = { id: 'node-1', name: 'Build', type: 'job' };
      const state = { status: 'pending', attempts: 0 };
      const plan = makeMockPlan({
        nodes: new Map([['node-1', node]]),
        nodeStates: new Map([['node-1', state]]),
      });

      const result = lookupNode(plan, 'node-1');
      assert.ok(!isError(result));
      assert.strictEqual((result as any).node.id, 'node-1');
      assert.strictEqual((result as any).state.status, 'pending');
    });

    test('returns error when node not found', () => {
      const plan = makeMockPlan();

      const result = lookupNode(plan, 'nonexistent');
      assert.ok(isError(result));
      assert.ok((result as any).error.includes('not found'));
    });
  });
});
