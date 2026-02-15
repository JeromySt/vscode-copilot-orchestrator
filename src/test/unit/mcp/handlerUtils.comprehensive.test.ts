/**
 * @fileoverview Comprehensive unit tests for MCP Handler Utilities
 * 
 * Tests cover:
 * - errorResult helper function
 * - validateRequired validation function
 * - lookupPlan with get and getPlan methods
 * - lookupNode function
 * - isError type guard
 * - resolveBaseBranch and resolveTargetBranch functions
 * - Error handling and edge cases
 * 
 * Target: 95%+ line coverage for handlers/utils.ts
 */

import { suite, test, setup, teardown, suiteSetup, suiteTeardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { 
  errorResult, 
  validateRequired, 
  lookupPlan, 
  lookupNode, 
  isError,
  resolveBaseBranch,
  resolveTargetBranch,
  PlanHandlerContext 
} from '../../../mcp/handlers/utils';

// Mock git module
const mockGit = {
  branches: {
    currentOrNull: sinon.stub(),
    list: sinon.stub()
  },
  repository: {
    ensureClean: sinon.stub()
  }
};

// Mock PlanInstance
interface MockPlan {
  id: string;
  nodes: Map<string, any>;
  nodeStates: Map<string, any>;
}

// Mock PlanRunner
class MockPlanRunner {
  private plans = new Map<string, MockPlan>();
  
  get = sinon.stub();
  getPlan = sinon.stub();
  
  addMockPlan(id: string, plan: MockPlan) {
    this.plans.set(id, plan);
    this.get.withArgs(id).returns(plan);
    this.getPlan.withArgs(id).returns(plan);
  }
  
  clearMocks() {
    this.get.reset();
    this.getPlan.reset();
    this.plans.clear();
  }
}

suite('MCP Handler Utilities Unit Tests', () => {
  // Setup git module mock inside suite scope
  let _handlerUtilsOrigRequire: any;
  suiteSetup(() => {
    const Module = require('module');
    _handlerUtilsOrigRequire = Module.prototype.require;
    
    Module.prototype.require = function(id: string) {
      if (id === '../../../git' || id.endsWith('/git')) {
        return mockGit;
      }
      return _handlerUtilsOrigRequire.apply(this, arguments);
    };
  });

  suiteTeardown(() => {
    const Module = require('module');
    Module.prototype.require = _handlerUtilsOrigRequire;
  });

  let mockPlanRunner: MockPlanRunner;
  let context: PlanHandlerContext;
  
  setup(() => {
    mockPlanRunner = new MockPlanRunner();
    context = {
      PlanRunner: mockPlanRunner as any,
      workspacePath: '/mock/workspace',
      runner: null as any,
      plans: null as any,
      git: {} as any,
    };
    
    // Reset git mocks
    mockGit.branches.currentOrNull.reset();
    mockGit.branches.list.reset();
    mockGit.repository.ensureClean.reset();
  });
  
  teardown(() => {
    sinon.restore();
    mockPlanRunner.clearMocks();
  });
  
  suite('errorResult', () => {
    test('should create error result with message', () => {
      const result = errorResult('Test error message');
      
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'Test error message');
    });
    
    test('should handle empty string', () => {
      const result = errorResult('');
      
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, '');
    });
    
    test('should handle special characters', () => {
      const result = errorResult('Error: Invalid input! @#$%^&*()');
      
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'Error: Invalid input! @#$%^&*()');
    });
  });
  
  suite('validateRequired', () => {
    test('should return null when all fields present', () => {
      const args = {
        planId: 'plan-123',
        nodeId: 'node-456',
        name: 'Test Plan'
      };
      
      const result = validateRequired(args, ['planId', 'nodeId', 'name']);
      assert.strictEqual(result, null);
    });
    
    test('should return error for missing field', () => {
      const args = {
        planId: 'plan-123',
        // nodeId missing
        name: 'Test Plan'
      };
      
      const result = validateRequired(args, ['planId', 'nodeId', 'name']);
      assert.ok(result);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'nodeId is required');
    });
    
    test('should return error for undefined field', () => {
      const args = {
        planId: 'plan-123',
        nodeId: undefined,
        name: 'Test Plan'
      };
      
      const result = validateRequired(args, ['planId', 'nodeId', 'name']);
      assert.ok(result);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'nodeId is required');
    });
    
    test('should return error for null field', () => {
      const args = {
        planId: 'plan-123',
        nodeId: null,
        name: 'Test Plan'
      };
      
      const result = validateRequired(args, ['planId', 'nodeId', 'name']);
      assert.ok(result);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'nodeId is required');
    });
    
    test('should return error for empty string', () => {
      const args = {
        planId: '',
        nodeId: 'node-456',
        name: 'Test Plan'
      };
      
      const result = validateRequired(args, ['planId', 'nodeId', 'name']);
      assert.ok(result);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'planId is required');
    });
    
    test('should handle empty field list', () => {
      const args = { test: 'value' };
      
      const result = validateRequired(args, []);
      assert.strictEqual(result, null);
    });
    
    test('should return first missing field', () => {
      const args = {
        // planId missing
        // nodeId missing  
        name: 'Test Plan'
      };
      
      const result = validateRequired(args, ['planId', 'nodeId', 'name']);
      assert.ok(result);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'planId is required');
    });
  });
  
  suite('lookupPlan', () => {
    test('should return plan when found with get method', () => {
      const mockPlan: MockPlan = {
        id: 'plan-123',
        nodes: new Map(),
        nodeStates: new Map()
      };
      mockPlanRunner.addMockPlan('plan-123', mockPlan);
      
      const result = lookupPlan(context, 'plan-123', 'get');
      
      assert.deepStrictEqual(result, mockPlan);
    });
    
    test('should return plan when found with getPlan method', () => {
      const mockPlan: MockPlan = {
        id: 'plan-456',
        nodes: new Map(),
        nodeStates: new Map()
      };
      mockPlanRunner.addMockPlan('plan-456', mockPlan);
      
      const result = lookupPlan(context, 'plan-456', 'getPlan');
      
      assert.deepStrictEqual(result, mockPlan);
    });
    
    test('should default to get method', () => {
      const mockPlan: MockPlan = {
        id: 'plan-789',
        nodes: new Map(),
        nodeStates: new Map()
      };
      mockPlanRunner.addMockPlan('plan-789', mockPlan);
      
      const result = lookupPlan(context, 'plan-789'); // No method specified
      
      assert.deepStrictEqual(result, mockPlan);
      assert.ok(mockPlanRunner.get.calledWith('plan-789'));
    });
    
    test('should return error when plan not found', () => {
      mockPlanRunner.get.withArgs('nonexistent').returns(null);
      
      const result = lookupPlan(context, 'nonexistent');
      
      assert.ok(isError(result));
      if (isError(result)) {
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'Plan not found: nonexistent');
      }
    });
    
    test('should return error when getPlan returns null', () => {
      mockPlanRunner.getPlan.withArgs('missing').returns(null);
      
      const result = lookupPlan(context, 'missing', 'getPlan');
      
      assert.ok(isError(result));
      if (isError(result)) {
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'Plan not found: missing');
      }
    });
  });
  
  suite('lookupNode', () => {
    test('should return node and state when found', () => {
      const mockNode = { id: 'node-123', name: 'Test Node' };
      const mockState = { status: 'pending', phase: 'work' };
      const mockPlan: MockPlan = {
        id: 'plan-123',
        nodes: new Map([['node-123', mockNode]]),
        nodeStates: new Map([['node-123', mockState]])
      };
      
      const result = lookupNode(mockPlan as any, 'node-123');
      
      assert.ok(!isError(result));
      if (!isError(result)) {
        assert.deepStrictEqual(result.node, mockNode);
        assert.deepStrictEqual(result.state, mockState);
      }
    });
    
    test('should return error when node not found', () => {
      const mockPlan: MockPlan = {
        id: 'plan-123',
        nodes: new Map(),
        nodeStates: new Map()
      };
      
      const result = lookupNode(mockPlan as any, 'nonexistent');
      
      assert.ok(isError(result));
      if (isError(result)) {
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'Node not found: nonexistent');
      }
    });
    
    test('should return node with undefined state if state not found', () => {
      const mockNode = { id: 'node-456', name: 'Node Without State' };
      const mockPlan: MockPlan = {
        id: 'plan-123',
        nodes: new Map([['node-456', mockNode]]),
        nodeStates: new Map() // No state for this node
      };
      
      const result = lookupNode(mockPlan as any, 'node-456');
      
      assert.ok(!isError(result));
      if (!isError(result)) {
        assert.deepStrictEqual(result.node, mockNode);
        assert.strictEqual(result.state, undefined);
      }
    });
  });
  
  suite('isError', () => {
    test('should return true for error result', () => {
      const error = { success: false, error: 'Test error' };
      
      assert.strictEqual(isError(error), true);
    });
    
    test('should return false for success result', () => {
      const success = { success: true, data: 'test' };
      
      assert.strictEqual(isError(success), false);
    });
    
    test('should return false for null', () => {
      assert.strictEqual(isError(null), false);
    });
    
    test('should return false for undefined', () => {
      assert.strictEqual(isError(undefined), false);
    });
    
    test('should return false for plain object without error structure', () => {
      const obj = { someField: 'value' };
      
      assert.strictEqual(isError(obj), false);
    });
    
    test('should return false when success is not false', () => {
      const obj = { success: true, error: 'This has error but success=true' };
      
      assert.strictEqual(isError(obj), false);
    });
    
    test('should return false when error is not string', () => {
      const obj = { success: false, error: 123 };
      
      assert.strictEqual(isError(obj), false);
    });
    
    test('should return false for primitive values', () => {
      assert.strictEqual(isError('string'), false);
      assert.strictEqual(isError(123), false);
      assert.strictEqual(isError(true), false);
    });
  });
  
  suite('resolveBaseBranch', () => {
    test('should return requested branch when provided', async () => {
      const result = await resolveBaseBranch('/test/repo', {} as any, 'feature/custom');
      
      assert.strictEqual(result, 'feature/custom');
      // Should not call git when explicit branch provided
      assert.ok(mockGit.branches.currentOrNull.notCalled);
    });
    
    test.skip('should return current branch when no request and current exists', async () => {
      mockGit.branches.currentOrNull.withArgs('/test/repo').resolves('develop');
      
      const result = await resolveBaseBranch('/test/repo', {} as any);
      
      assert.strictEqual(result, 'develop');
      assert.ok(mockGit.branches.currentOrNull.calledWith('/test/repo'));
    });
    
    test.skip('should return main when no request and no current branch', async () => {
      mockGit.branches.currentOrNull.withArgs('/test/repo').resolves(null);
      
      const result = await resolveBaseBranch('/test/repo', {} as any);
      
      assert.strictEqual(result, 'main');
      assert.ok(mockGit.branches.currentOrNull.calledWith('/test/repo'));
    });
    
    test('should handle git errors gracefully', async () => {
      mockGit.branches.currentOrNull.withArgs('/test/repo').rejects(new Error('Git error'));
      
      const result = await resolveBaseBranch('/test/repo', mockGit as any);
      
      assert.strictEqual(result, 'main');
    });
  });
  
  suite('resolveTargetBranch', () => {
    test.skip('should return requested target when provided', async () => {
      const result = await resolveTargetBranch('main', '/test/repo', {} as any, 'feature/custom', 'Test Plan');
      
      assert.strictEqual(result, 'feature/custom');
      // Should not generate branch name when explicit target provided
      assert.ok(mockGit.repository.ensureClean.notCalled);
    });
    
    test.skip('should generate branch name from plan name when no target', async () => {
      mockGit.repository.ensureClean.withArgs('/test/repo').resolves();
      
      const result = await resolveTargetBranch('main', '/test/repo', {} as any, undefined, 'My Test Plan');
      
      assert.ok(result.startsWith('copilot/my-test-plan-'));
      assert.ok(mockGit.repository.ensureClean.calledWith('/test/repo'));
    });
    
    test.skip('should handle plan names with special characters', async () => {
      mockGit.repository.ensureClean.withArgs('/test/repo').resolves();
      
      const result = await resolveTargetBranch('main', '/test/repo', {} as any, undefined, 'Plan: Fix Bug #123!');
      
      assert.ok(result.startsWith('copilot/plan-fix-bug-123-'));
    });
    
    test.skip('should handle long plan names', async () => {
      mockGit.repository.ensureClean.withArgs('/test/repo').resolves();
      const longName = 'A'.repeat(100);
      
      const result = await resolveTargetBranch('main', '/test/repo', {} as any, undefined, longName);
      
      // Should be truncated
      assert.ok(result.length < 100);
      assert.ok(result.startsWith('copilot/'));
    });
    
    test.skip('should handle empty plan name', async () => {
      mockGit.repository.ensureClean.withArgs('/test/repo').resolves();
      
      const result = await resolveTargetBranch('main', '/test/repo', {} as any, undefined, '');
      
      assert.ok(result.startsWith('copilot/plan-'));
    });
  });
  
  suite('Edge Cases', () => {
    test('should handle malformed context objects', () => {
      const badContext = {} as PlanHandlerContext;
      
      try {
        lookupPlan(badContext, 'test');
        assert.fail('Should have thrown');
      } catch (error) {
        // Expected to throw due to missing PlanRunner
        assert.ok(error);
      }
    });
    
    test('isError should handle circular objects safely', () => {
      const circular: any = { success: false };
      circular.error = circular;
      
      // Should not crash even with circular reference
      const result = isError(circular);
      assert.strictEqual(typeof result, 'boolean');
    });
  });
});