/**
 * @fileoverview Unit tests for CopilotCliRunner writeInstructionsFile and cleanup methods
 * 
 * Tests methods that can be tested in isolation without complex mocking.
 */

import * as assert from 'assert';
import * as path from 'path';
import { CopilotCliRunner } from '../../../agent/copilotCliRunner';

suite('CopilotCliRunner Instructions Tests', () => {
  let runner: CopilotCliRunner;

  setup(() => {
    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    runner = new CopilotCliRunner(logger);
  });

  suite('writeInstructionsFile method', () => {
    test('generates correct file path without jobId', () => {
      const result = runner.writeInstructionsFile(
        '/test/worktree',
        'Test task',
        'Test instructions',
        'test-label'
      );

      assert.strictEqual(
        result.filePath,
        path.join('/test/worktree', '.github', 'instructions', 'orchestrator-job.instructions.md')
      );
      assert.strictEqual(
        result.dirPath,
        path.join('/test/worktree', '.github', 'instructions')
      );
    });

    test('generates correct file path with jobId', () => {
      const result = runner.writeInstructionsFile(
        '/test/worktree',
        'Test task',
        'Test instructions',
        'test-label',
        'job-123-abc'
      );

      assert.strictEqual(
        result.filePath,
        path.join('/test/worktree', '.github', 'instructions', 'orchestrator-job-job-123-.instructions.md')
      );
    });

    test('truncates jobId to 8 characters', () => {
      const result = runner.writeInstructionsFile(
        '/test/worktree',
        'Test task',
        undefined,
        'test-label',
        'very-long-job-id-that-should-be-truncated'
      );

      assert.ok(result.filePath.includes('orchestrator-job-very-lon'));
      assert.ok(!result.filePath.includes('very-long-job-id-that-should-be-truncated'));
    });

    test('derives applyTo scope from worktree path', () => {
      const result = runner.writeInstructionsFile(
        '/repos/my-project/.worktrees/feature-branch',
        'Test task',
        'Test instructions',
        'test-label'
      );

      // Should derive scope from parent/worktree folder names
      assert.ok(result.filePath);
    });

    test('handles undefined instructions', () => {
      const result = runner.writeInstructionsFile(
        '/test/worktree',
        'Test task',
        undefined,
        'test-label'
      );

      assert.ok(result.filePath);
      assert.ok(result.dirPath);
    });

    test('handles Windows paths correctly', () => {
      const result = runner.writeInstructionsFile(
        'C:\\repos\\project\\.worktrees\\feature',
        'Test task',
        'Test instructions',
        'test-label',
        'job123'
      );

      if (process.platform === 'win32') {
        assert.ok(result.filePath.includes('C:'));
        assert.ok(result.filePath.includes('.github'));
      }
      assert.ok(result.filePath.includes('orchestrator-job-job123'));
    });
  });

  suite('isAvailable method', () => {
    test('returns boolean value', () => {
      const result = runner.isAvailable();
      assert.ok(typeof result === 'boolean');
    });
  });

  suite('edge case handling', () => {
    test('handles empty task string', () => {
      const result = runner.writeInstructionsFile(
        '/test/worktree',
        '',
        'Some instructions',
        'test'
      );

      assert.ok(result.filePath);
      assert.ok(result.dirPath);
    });

    test('handles special characters in task', () => {
      const result = runner.writeInstructionsFile(
        '/test/worktree',
        'Task with "quotes" and \\backslashes',
        'Instructions with <tags> and &entities;',
        'test'
      );

      assert.ok(result.filePath);
      assert.ok(result.dirPath);
    });

    test('handles very long task description', () => {
      const longTask = 'A'.repeat(10000);
      const result = runner.writeInstructionsFile(
        '/test/worktree',
        longTask,
        'Instructions',
        'test'
      );

      assert.ok(result.filePath);
      assert.ok(result.dirPath);
    });

    test('handles Unicode characters in paths and content', () => {
      const result = runner.writeInstructionsFile(
        '/test/worktree/子目录',
        'Task with émojis 🚀 and 中文',
        'Instructions with Ñoñó and αβγ',
        'test-ëmoji'
      );

      assert.ok(result.filePath);
      assert.ok(result.dirPath);
    });

    test('generates unique filenames for different jobIds', () => {
      const result1 = runner.writeInstructionsFile('/test', 'Task', 'Inst', 'test', 'job1');
      const result2 = runner.writeInstructionsFile('/test', 'Task', 'Inst', 'test', 'job2');
      const result3 = runner.writeInstructionsFile('/test', 'Task', 'Inst', 'test'); // No jobId

      assert.notStrictEqual(result1.filePath, result2.filePath);
      assert.notStrictEqual(result1.filePath, result3.filePath);
      assert.notStrictEqual(result2.filePath, result3.filePath);
    });
  });

  suite('buildCommand edge cases', () => {
    test('handles undefined values gracefully', () => {
      const cmd = runner.buildCommand({
        task: 'test',
        sessionId: undefined,
        model: undefined,
        logDir: undefined,
        sharePath: undefined,
        configDir: undefined,
        cwd: undefined,
        allowedFolders: undefined,
        allowedUrls: undefined
      });

      assert.ok(cmd.includes('test'));
      assert.ok(cmd.includes('copilot'));
    });

    test('handles empty strings', () => {
      const cmd = runner.buildCommand({
        task: '',
        sessionId: '',
        model: '',
        configDir: '',
        cwd: ''
      });

      assert.ok(cmd.includes('copilot'));
    });

    test('handles null values gracefully', () => {
      const cmd = runner.buildCommand({
        task: 'test',
        sessionId: null as any,
        model: null as any,
        configDir: null as any
      });

      assert.ok(cmd.includes('test'));
      assert.ok(cmd.includes('copilot'));
    });

    test('quotes paths with spaces correctly', () => {
      const cmd = runner.buildCommand({
        task: 'test',
        configDir: '/path with spaces/config',
        logDir: '/another path with spaces/logs',
        sharePath: '/yet another/path with spaces/share.md'
      });

      assert.ok(cmd.includes('"'));
      assert.ok(cmd.includes('/path with spaces/config'));
    });

    test('includes all expected flags', () => {
      const cmd = runner.buildCommand({
        task: 'comprehensive test',
        sessionId: 'test-session',
        model: 'test-model',
        logDir: '/logs',
        sharePath: '/share.md',
        configDir: '/config',
        allowedFolders: ['/folder1', '/folder2'],
        allowedUrls: ['https://example.com']
      });

      assert.ok(cmd.includes('--stream off'));
      assert.ok(cmd.includes('--allow-all-tools'));
      assert.ok(cmd.includes('--model test-model'));
      assert.ok(cmd.includes('--resume test-session'));
      assert.ok(cmd.includes('--config-dir'));
      assert.ok(cmd.includes('--log-dir'));
      assert.ok(cmd.includes('--log-level debug'));
      assert.ok(cmd.includes('--share'));
      assert.ok(cmd.includes('--add-dir'));
      assert.ok(cmd.includes('--allow-url'));
    });
  });
});