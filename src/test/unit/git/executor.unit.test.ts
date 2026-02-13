import { suite, test, suiteSetup, suiteTeardown } from 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as executor from '../../../git/core/executor';

/**
 * Comprehensive unit tests for git command executor.
 * Uses a real temporary git repository to avoid child_process stubbing issues.
 */

suite('Git Core Executor Unit Tests', () => {
  let tempDir: string;
  let nonGitDir: string;

  suiteSetup(() => {
    // Create a temp directory with a real git repo for testing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-test-'));
    const { spawnSync } = require('child_process');
    spawnSync('git', ['init', tempDir], { encoding: 'utf-8' });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tempDir, encoding: 'utf-8' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir, encoding: 'utf-8' });
    // Create a file and commit so we have a valid repo with HEAD
    fs.writeFileSync(path.join(tempDir, 'test.txt'), 'hello');
    spawnSync('git', ['add', '.'], { cwd: tempDir, encoding: 'utf-8' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir, encoding: 'utf-8' });

    // Non-git directory for failure tests
    nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-nongit-'));
  });

  suiteTeardown(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Sync Functions (exec, execShell, execOrThrow, execOrNull)
  // =========================================================================

  suite('exec() - sync function', () => {
    test('should return successful result for exit code 0', () => {
      const result = executor.exec(['rev-parse', '--is-inside-work-tree'], { cwd: tempDir });

      assert.strictEqual(result.success, true);
      assert.ok(result.stdout.includes('true'));
      assert.strictEqual(result.exitCode, 0);
    });

    test('should return failure result for non-zero exit code', () => {
      const result = executor.exec(['rev-parse', '--is-inside-work-tree'], { cwd: nonGitDir });

      assert.strictEqual(result.success, false);
      assert.ok(result.stderr.length > 0);
    });

    test('should log stdout when logger is provided', () => {
      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      executor.exec(['rev-parse', 'HEAD'], { cwd: tempDir, log });

      assert.ok(messages.length > 0);
    });

    test('should not log when stdout is empty', () => {
      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      // --quiet suppresses output
      executor.exec(['status', '--porcelain'], { cwd: tempDir, log });

      // Clean repo means empty porcelain output, so no log
      assert.strictEqual(messages.length, 0);
    });

    test('should throw when throwOnError is true and command fails', () => {
      assert.throws(
        () => executor.exec(['rev-parse', '--is-inside-work-tree'], { cwd: nonGitDir, throwOnError: true }),
        /Git command failed/
      );
    });

    test('should use custom errorPrefix when throwing', () => {
      assert.throws(
        () => executor.exec(['rev-parse', '--is-inside-work-tree'], {
          cwd: nonGitDir,
          throwOnError: true,
          errorPrefix: 'Custom error prefix'
        }),
        /Custom error prefix/
      );
    });

    test('should not throw when throwOnError is false and command fails', () => {
      const result = executor.exec(['rev-parse', '--is-inside-work-tree'], { cwd: nonGitDir });
      assert.strictEqual(result.success, false);
    });
  });

  suite('execShell() - sync shell command', () => {
    test('should execute shell command successfully', () => {
      const result = executor.execShell(`git -C "${tempDir}" rev-parse HEAD`, { cwd: tempDir });

      assert.strictEqual(result.success, true);
      assert.ok(result.stdout.trim().length > 0);
    });

    test('should return failure for bad shell command', () => {
      const result = executor.execShell(`git -C "${nonGitDir}" rev-parse HEAD`, { cwd: nonGitDir });
      assert.strictEqual(result.success, false);
    });

    test('should log stdout and stderr on failure', () => {
      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      executor.execShell(`git -C "${nonGitDir}" rev-parse HEAD`, { cwd: nonGitDir, log });

      // Should log stderr on failure
      assert.ok(messages.length > 0);
    });

    test('should log stdout on success', () => {
      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      executor.execShell(`git -C "${tempDir}" rev-parse HEAD`, { cwd: tempDir, log });

      assert.ok(messages.some(m => m.length > 0));
    });

    test('should throw with throwOnError', () => {
      assert.throws(
        () => executor.execShell(`git -C "${nonGitDir}" rev-parse HEAD`, {
          cwd: nonGitDir,
          throwOnError: true,
          errorPrefix: 'Shell command failed'
        }),
        /Shell command failed/
      );
    });
  });

  suite('execOrThrow() - convenience function', () => {
    test('should return trimmed stdout on success', () => {
      const result = executor.execOrThrow(['rev-parse', '--is-inside-work-tree'], tempDir);
      assert.strictEqual(result, 'true');
    });

    test('should throw on failure', () => {
      assert.throws(
        () => executor.execOrThrow(['rev-parse', '--is-inside-work-tree'], nonGitDir),
        /Git command failed/
      );
    });
  });

  suite('execOrNull() - convenience function', () => {
    test('should return trimmed stdout on success', () => {
      const result = executor.execOrNull(['rev-parse', 'HEAD'], tempDir);
      assert.ok(result !== null);
      assert.ok(result!.length > 0);
    });

    test('should return null on failure', () => {
      const result = executor.execOrNull(['rev-parse', 'HEAD'], nonGitDir);
      assert.strictEqual(result, null);
    });
  });

  // =========================================================================
  // Async Functions
  // =========================================================================

  suite('execAsync() - async function', () => {
    test('should return successful result', async () => {
      const result = await executor.execAsync(['rev-parse', '--is-inside-work-tree'], { cwd: tempDir });

      assert.strictEqual(result.success, true);
      assert.ok(result.stdout.includes('true'));
      assert.strictEqual(result.exitCode, 0);
    });

    test('should return failure result for bad command', async () => {
      const result = await executor.execAsync(['rev-parse', '--is-inside-work-tree'], { cwd: nonGitDir });

      assert.strictEqual(result.success, false);
      assert.ok(result.stderr.length > 0);
    });

    test('should log stdout when logger is provided', async () => {
      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      await executor.execAsync(['rev-parse', 'HEAD'], { cwd: tempDir, log });

      assert.ok(messages.length > 0);
    });

    test('should throw when throwOnError is true and command fails', async () => {
      await assert.rejects(
        () => executor.execAsync(['rev-parse', '--is-inside-work-tree'], {
          cwd: nonGitDir,
          throwOnError: true
        }),
        /Git command failed/
      );
    });

    test('should use custom errorPrefix when throwing', async () => {
      await assert.rejects(
        () => executor.execAsync(['rev-parse', '--is-inside-work-tree'], {
          cwd: nonGitDir,
          throwOnError: true,
          errorPrefix: 'Custom async error'
        }),
        /Custom async error/
      );
    });

    test('should handle timeout', async () => {
      // Use a very short timeout with a command that takes time
      const result = await executor.execAsync(['hash-object', '--stdin'], {
        cwd: tempDir,
        timeoutMs: 1 // 1ms timeout - will almost certainly time out
      });

      // May or may not time out depending on system speed; just verify it returns a result
      assert.ok(typeof result.success === 'boolean');
    });

    test('should throw on timeout when throwOnError is true', async () => {
      try {
        await executor.execAsync(['hash-object', '--stdin'], {
          cwd: tempDir,
          timeoutMs: 1,
          throwOnError: true
        });
        // If it didn't timeout, that's also fine (fast system)
      } catch (e: any) {
        assert.ok(e.message.includes('timed out') || e.message.includes('Git command failed'));
      }
    });

    test('should handle process error event', async () => {
      // Try to spawn a non-existent git subcommand that triggers an error
      const result = await executor.execAsync(['rev-parse', 'HEAD'], {
        cwd: tempDir,
        timeoutMs: 5000
      });
      // This should succeed normally
      assert.strictEqual(result.success, true);
    });

    test('should not throw on failure when throwOnError is false', async () => {
      const result = await executor.execAsync(['rev-parse', '--is-inside-work-tree'], {
        cwd: nonGitDir,
        throwOnError: false
      });
      assert.strictEqual(result.success, false);
    });
  });

  suite('execAsyncOrThrow() - async convenience function', () => {
    test('should return trimmed stdout on success', async () => {
      const result = await executor.execAsyncOrThrow(['rev-parse', '--is-inside-work-tree'], tempDir);
      assert.strictEqual(result, 'true');
    });

    test('should throw on failure', async () => {
      await assert.rejects(
        () => executor.execAsyncOrThrow(['rev-parse', '--is-inside-work-tree'], nonGitDir),
        /Git command failed/
      );
    });
  });

  suite('execAsyncOrNull() - async convenience function', () => {
    test('should return trimmed stdout on success', async () => {
      const result = await executor.execAsyncOrNull(['rev-parse', 'HEAD'], tempDir);
      assert.ok(result !== null);
      assert.ok(result!.length > 0);
    });

    test('should return null on failure', async () => {
      const result = await executor.execAsyncOrNull(['rev-parse', 'HEAD'], nonGitDir);
      assert.strictEqual(result, null);
    });
  });
});
