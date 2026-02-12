/**
 * @fileoverview Unit tests for CopilotCliRunner buildCommand method
 * 
 * Tests cover:
 * - Config directory parameter handling
 * - Command construction with and without configDir
 * - Path quoting for paths with spaces
 */

import * as assert from 'assert';
import { CopilotCliRunner } from '../../../agent/copilotCliRunner';

suite('CopilotCliRunner', () => {
  
  suite('buildCommand - Config Directory', () => {
    
    test('includes --config-dir when provided', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task',
        configDir: '/path/to/worktree/.orchestrator/.copilot'
      });
      
      assert.ok(cmd.includes('--config-dir'), 'Command should include --config-dir flag');
      assert.ok(cmd.includes('/path/to/worktree/.orchestrator/.copilot'), 'Command should include the config directory path');
    });
    
    test('omits --config-dir when not provided', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task'
      });
      
      assert.ok(!cmd.includes('--config-dir'), 'Command should not include --config-dir when not provided');
    });
    
    test('config dir path with spaces is properly quoted', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task',
        configDir: '/path/with spaces/.orchestrator/.copilot'
      });
      
      assert.ok(cmd.includes('--config-dir'), 'Command should include --config-dir flag');
      // The path should be JSON-quoted in the command
      assert.ok(cmd.includes('"/path/with spaces/.orchestrator/.copilot"'), 'Config dir path with spaces should be JSON-quoted');
    });
    
    test('includes task parameter', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task'
      });
      
      assert.ok(cmd.includes('-p "test task"'), 'Command should include the task parameter');
    });
    
    test('includes all standard flags', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task'
      });
      
      assert.ok(cmd.includes('--stream off'), 'Command should include --stream off');
      assert.ok(cmd.includes('--allow-paths'), 'Command should include --allow-paths');
      assert.ok(cmd.includes('--allow-all-urls'), 'Command should include --allow-all-urls');
      assert.ok(cmd.includes('--allow-all-tools'), 'Command should include --allow-all-tools');
    });
    
    test('includes model when provided', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task',
        model: 'claude-sonnet-4.5'
      });
      
      assert.ok(cmd.includes('--model claude-sonnet-4.5'), 'Command should include the model parameter');
    });
    
    test('includes logDir when provided', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task',
        logDir: '/path/to/logs'
      });
      
      assert.ok(cmd.includes('--log-dir'), 'Command should include --log-dir flag');
      assert.ok(cmd.includes('/path/to/logs'), 'Command should include the log directory path');
      assert.ok(cmd.includes('--log-level debug'), 'Command should include --log-level debug');
    });
    
    test('includes sharePath when provided', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task',
        sharePath: '/path/to/share.json'
      });
      
      assert.ok(cmd.includes('--share'), 'Command should include --share flag');
      assert.ok(cmd.includes('/path/to/share.json'), 'Command should include the share path');
    });
    
    test('includes sessionId when provided', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task',
        sessionId: 'test-session-123'
      });
      
      assert.ok(cmd.includes('--resume test-session-123'), 'Command should include --resume with session ID');
    });
    
    test('combines multiple options correctly', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task',
        configDir: '/config',
        model: 'gpt-5',
        logDir: '/logs',
        sharePath: '/share.json',
        sessionId: 'session-123'
      });
      
      assert.ok(cmd.includes('--config-dir'), 'Command should include --config-dir');
      assert.ok(cmd.includes('--model gpt-5'), 'Command should include --model');
      assert.ok(cmd.includes('--log-dir'), 'Command should include --log-dir');
      assert.ok(cmd.includes('--share'), 'Command should include --share');
      assert.ok(cmd.includes('--resume session-123'), 'Command should include --resume');
    });
  });
});
