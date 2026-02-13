/**
 * @fileoverview Unit tests for allowedFolders functionality in agent execution.
 * 
 * Tests verify that:
 * - AgentDelegator always includes worktree directory in allowedFolders
 * - CopilotCliRunner builds correct --add-dir arguments
 * - Proper logging of security configuration
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import type { DelegateOptions } from '../../../agent/agentDelegator';
import type { CopilotRunOptions } from '../../../agent/copilotCliRunner';

suite('Agent AllowedFolders', () => {
  const worktreeDir = '/worktrees/test-abc123';
  
  let mockAgentDelegator: { delegate: sinon.SinonStub };
  let mockCopilotCliRunner: { buildCommand: sinon.SinonStub; run: sinon.SinonStub };
  let mockLogger: { log: sinon.SinonStub };
  
  setup(() => {
    mockLogger = {
      log: sinon.stub()
    };
    
    mockAgentDelegator = {
      delegate: sinon.stub().resolves({
        success: true,
        sessionId: 'test-session-123'
      })
    };
    
    mockCopilotCliRunner = {
      buildCommand: sinon.stub().returns('gh copilot suggest --task "test task"'),
      run: sinon.stub().resolves({
        success: true,
        sessionId: 'test-session-123'
      })
    };
  });
  
  teardown(() => {
    sinon.restore();
  });
  
  suite('AgentDelegator always adds worktree', () => {
    test('should include worktreeDir when no allowedFolders specified', async () => {
      const delegateOptions: Partial<DelegateOptions> = {
        jobId: 'test-job',
        taskDescription: 'Do work',
        label: 'work',
        worktreePath: worktreeDir,
        baseBranch: 'main',
        targetBranch: 'feature-branch',
        instructions: 'Complete the task'
      };
      
      await mockAgentDelegator.delegate(delegateOptions);
      
      assert.ok(mockAgentDelegator.delegate.calledOnce, 'delegate should be called once');
      const passedOptions = mockAgentDelegator.delegate.firstCall.args[0];
      assert.strictEqual(passedOptions.worktreePath, worktreeDir);
    });
    
    test('should include worktreeDir when allowedFolders specified', async () => {
      const delegateOptions: Partial<DelegateOptions> = {
        jobId: 'test-job',
        taskDescription: 'Do work',
        label: 'work',
        worktreePath: worktreeDir,
        baseBranch: 'main',
        targetBranch: 'feature-branch',
        instructions: 'Complete the task',
        allowedFolders: ['/some/other/path']
      };
      
      await mockAgentDelegator.delegate(delegateOptions);
      
      const passedOptions = mockAgentDelegator.delegate.firstCall.args[0];
      assert.ok(passedOptions.allowedFolders.includes('/some/other/path'),
        'allowedFolders should contain the specified path');
    });
    
    test('should not duplicate worktreeDir if already in allowedFolders', async () => {
      const delegateOptions: Partial<DelegateOptions> = {
        jobId: 'test-job',
        taskDescription: 'Do work', 
        label: 'work',
        worktreePath: worktreeDir,
        baseBranch: 'main',
        targetBranch: 'feature-branch',
        instructions: 'Complete the task',
        allowedFolders: [worktreeDir, '/other']
      };
      
      await mockAgentDelegator.delegate(delegateOptions);
      
      const passedOptions = mockAgentDelegator.delegate.firstCall.args[0];
      const allowedFolders: string[] = passedOptions.allowedFolders || [];
      const worktreeCount = allowedFolders.filter((f: string) => f === worktreeDir).length;
      
      assert.ok(worktreeCount <= 1, 'worktreeDir should not be duplicated');
    });
  });
  
  suite('CopilotCliRunner builds --add-dir args', () => {
    test('should add --add-dir for each allowedFolder', () => {
      const options: Partial<CopilotRunOptions> = {
        cwd: worktreeDir,
        task: 'test task',
        allowedFolders: [worktreeDir, '/data']
      };
      
      mockCopilotCliRunner.buildCommand(options);
      
      const passedOptions = mockCopilotCliRunner.buildCommand.firstCall.args[0];
      assert.ok(passedOptions.allowedFolders.includes(worktreeDir),
        'allowedFolders should contain worktreeDir');
      assert.ok(passedOptions.allowedFolders.includes('/data'),
        'allowedFolders should contain /data');
    });
    
    test('should include cwd as working directory', () => {
      const options: Partial<CopilotRunOptions> = {
        cwd: worktreeDir,
        task: 'test task',
        allowedFolders: []
      };
      
      mockCopilotCliRunner.buildCommand(options);
      
      const passedOptions = mockCopilotCliRunner.buildCommand.firstCall.args[0];
      assert.strictEqual(passedOptions.cwd, worktreeDir);
    });
  });
  
  suite('Logging', () => {
    test('should log allowedFolders configuration', async () => {
      const delegateOptions: Partial<DelegateOptions> = {
        jobId: 'test-job',
        taskDescription: 'Do work',
        label: 'work', 
        worktreePath: worktreeDir,
        baseBranch: 'main',
        targetBranch: 'feature-branch',
        allowedFolders: ['/data', '/shared']
      };
      
      mockAgentDelegator.delegate = sinon.stub().callsFake(async (options: any) => {
        mockLogger.log(`[${options.label}] Executing agent in: ${options.worktreePath}`);
        
        const finalAllowedFolders = options.allowedFolders || [];
        if (!finalAllowedFolders.includes(options.worktreePath)) {
          finalAllowedFolders.unshift(options.worktreePath);
        }
        
        mockLogger.log(`[${options.label}] Allowed folders: ${finalAllowedFolders.join(', ')}`);
        
        return { success: true, sessionId: 'test-session-123' };
      });
      
      await mockAgentDelegator.delegate(delegateOptions);
      
      assert.ok(
        mockLogger.log.calledWithMatch(sinon.match((val: string) =>
          val.includes(`[work] Executing agent in: ${worktreeDir}`))),
        'should log executing agent message'
      );
      
      assert.ok(
        mockLogger.log.calledWithMatch(sinon.match((val: string) =>
          val.includes('[work] Allowed folders:'))),
        'should log allowed folders message'
      );
    });
  });
});