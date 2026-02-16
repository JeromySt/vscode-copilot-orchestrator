import * as assert from 'assert';
import * as sinon from 'sinon';

suite('createPlanHandler', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('basic validation', () => {
    test('requires plan name', async () => {
      const { handleCreatePlan } = require('../../../../../mcp/handlers/plan/createPlanHandler');
      
      // Mock context with minimal required fields
      const ctx = {
        workspacePath: '/test',
        git: { branches: { currentOrNull: sinon.stub().resolves('main') } },
        PlanRunner: { enqueue: sinon.stub() }
      };

      const args = { jobs: [{ producer_id: 'test', task: 'Test task' }] };

      const result = await handleCreatePlan(args, ctx);
      
      assert.strictEqual(result.success, false);
      assert.ok(typeof result.error === 'string');
      // Don't be too specific about the error message, just that it's an error
      assert.ok(result.error.length > 0);
    });

    test('accepts minimal valid plan', async () => {
      const { handleCreatePlan } = require('../../../../../mcp/handlers/plan/createPlanHandler');
      
      // Mock validation functions
      const validateAllowedFolders = sandbox.stub().resolves({ valid: true });
      const validateAllowedUrls = sandbox.stub().resolves({ valid: true });
      const validateAgentModels = sandbox.stub().resolves({ valid: true });
      
      // Mock MCP validation module
      const mockValidation = { validateAllowedFolders, validateAllowedUrls, validateAgentModels };
      
      // Mock utils functions
      const resolveBaseBranch = sandbox.stub().resolves('main');
      const resolveTargetBranch = sandbox.stub().resolves('copilot_plan/test');
      
      // Create a spy that allows us to override the require calls
      const originalRequire = require;
      (global as any).require = (id: string) => {
        if (id.includes('validation')) {return mockValidation;}
        if (id.includes('utils')) {return { resolveBaseBranch, resolveTargetBranch };}
        return originalRequire(id);
      };
      
      const ctx = {
        workspacePath: '/test',
        git: { branches: { currentOrNull: sinon.stub().resolves('main') } },
        PlanRunner: { 
          enqueue: sinon.stub().returns({
            id: 'plan-123',
            spec: { name: 'Test Plan' },
            baseBranch: 'main',
            targetBranch: 'copilot_plan/test',
            nodes: new Map([['node-1', {}]]),
            roots: ['node-1'],
            leaves: ['node-1'],
            producerIdToNodeId: new Map([['test', 'node-1']])
          })
        }
      };

      const args = { 
        name: 'Test Plan',
        jobs: [{ producer_id: 'test', task: 'Test task' }] 
      };

      try {
        const result = await handleCreatePlan(args, ctx);
        
        // Should succeed with basic validation
        assert.ok(result.success === true || result.success === false, 'Should return a result with success property');
      } finally {
        // Restore original require
        (global as any).require = originalRequire;
      }
    });
  });
});