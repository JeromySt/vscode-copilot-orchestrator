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
    
    test('includes --config-dir when cwd is provided', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task',
        cwd: '/path/to/worktree'
      });
      
      assert.ok(cmd.includes('--config-dir'), 'Command should include --config-dir flag');
      assert.ok(cmd.includes('.orchestrator'), 'Config dir should be derived from cwd');
      assert.ok(cmd.includes('.copilot-cli'), 'Config dir should use .copilot-cli suffix');
    });
    
    test('omits --config-dir when cwd not provided', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task'
      });
      
      assert.ok(!cmd.includes('--config-dir'), 'Command should not include --config-dir when cwd not provided');
    });
    
    test('config dir path with spaces is properly quoted', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task',
        cwd: '/path/with spaces/worktree'
      });
      
      assert.ok(cmd.includes('--config-dir'), 'Command should include --config-dir flag');
      // The path should be JSON-quoted in the command and contain the worktree path
      assert.ok(cmd.includes('with spaces'), 'Config dir should preserve spaces from cwd');
      assert.ok(cmd.includes('.copilot-cli"'), 'Config dir path should be quoted');
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
      assert.ok(cmd.includes('--add-dir'), 'Command should include --add-dir for secure path handling');
      assert.ok(cmd.includes('--allow-all-tools'), 'Command should include --allow-all-tools');
      assert.ok(!cmd.includes('--allow-all-urls'), 'Command should NOT include --allow-all-urls for security');
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
        cwd: '/worktree',
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
  
  suite('URL Security', () => {
    test('by default no URLs are allowed', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task'
      });
      
      assert.ok(!cmd.includes('--allow-url'), 'Command should not include --allow-url by default');
      assert.ok(!cmd.includes('--allow-all-urls'), 'Command should not include --allow-all-urls');
    });
    
    test('includes --allow-url flags when allowedUrls provided', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task',
        allowedUrls: ['https://api.github.com', 'https://registry.npmjs.org']
      });
      
      assert.ok(cmd.includes('--allow-url "https://api.github.com"'), 'Command should include first allowed URL');
      assert.ok(cmd.includes('--allow-url "https://registry.npmjs.org"'), 'Command should include second allowed URL');
      assert.ok(!cmd.includes('--allow-all-urls'), 'Command should not include --allow-all-urls');
    });
    
    test('handles empty allowedUrls array', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task',
        allowedUrls: []
      });
      
      assert.ok(!cmd.includes('--allow-url'), 'Command should not include --allow-url with empty array');
      assert.ok(!cmd.includes('--allow-all-urls'), 'Command should not include --allow-all-urls');
    });
    
    test('properly quotes URLs with special characters', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task',
        allowedUrls: ['https://api.example.com/v1?key=value&other=param']
      });
      
      assert.ok(cmd.includes('--allow-url "https://api.example.com/v1?key=value&other=param"'), 'Command should properly quote URL with query params');
    });
  });

  suite('buildCommand - Agent Flag', () => {
    test('includes --agent when agent is specified', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task',
        agent: 'k8s-assistant'
      });
      assert.ok(cmd.includes('--agent "k8s-assistant"'), 'Command should include --agent flag');
    });

    test('omits --agent when not specified', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task'
      });
      assert.ok(!cmd.includes('--agent'), 'Command should not include --agent when not specified');
    });

    test('quotes agent name with special characters', () => {
      const runner = new CopilotCliRunner();
      const cmd = runner.buildCommand({
        task: 'test task',
        agent: 'my-plugin@awesome-copilot'
      });
      assert.ok(cmd.includes('--agent "my-plugin@awesome-copilot"'), 'Command should JSON-quote agent name');
    });
  });
});
