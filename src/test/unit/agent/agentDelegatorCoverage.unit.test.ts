/**
 * @fileoverview Unit tests for AgentDelegator private methods and delegate flow.
 *
 * Covers:
 * - extractSessionFromFile (via direct access)
 * - extractTokenUsage (via direct access)
 * - createTaskFile (via delegate)
 * - delegate() full flow
 * - isCopilotAvailable()
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentDelegator } from '../../../agent/agentDelegator';
import type { IGitOperations } from '../../../interfaces/IGitOperations';

suite('AgentDelegator - Private Methods & Flow', () => {
  let delegator: AgentDelegator;
  let logMessages: string[];

  setup(() => {
    logMessages = [];
    const logger = { log: (msg: string) => logMessages.push(msg) };
    delegator = new AgentDelegator(logger, {} as any as IGitOperations);
  });

  // ==========================================================================
  // extractSessionFromFile
  // ==========================================================================
  suite('extractSessionFromFile', () => {
    let tmpDir: string;

    setup(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegator-test-'));
    });

    teardown(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    test('extracts session ID from share file with "Session ID: uuid" format', () => {
      const shareFile = path.join(tmpDir, 'session-share.md');
      fs.writeFileSync(shareFile, 'Session ID: 12345678-1234-5678-9abc-123456789abc\nSome other content');

      const result = (delegator as any).extractSessionFromFile(shareFile, tmpDir, 'test');
      assert.strictEqual(result, '12345678-1234-5678-9abc-123456789abc');
    });

    test('extracts session ID from share file with UUID pattern', () => {
      const shareFile = path.join(tmpDir, 'session-share.md');
      fs.writeFileSync(shareFile, 'Some prefix abcd1234-5678-9012-3456-789abcdef012 some suffix');

      const result = (delegator as any).extractSessionFromFile(shareFile, tmpDir, 'test');
      assert.strictEqual(result, 'abcd1234-5678-9012-3456-789abcdef012');
    });

    test('extracts session ID from vscode URI pattern', () => {
      const shareFile = path.join(tmpDir, 'session-share.md');
      fs.writeFileSync(shareFile, 'vscode-chat-session://default/abcdef01-2345-6789-abcd-ef0123456789');

      const result = (delegator as any).extractSessionFromFile(shareFile, tmpDir, 'test');
      assert.strictEqual(result, 'abcdef01-2345-6789-abcd-ef0123456789');
    });

    test('extracts session ID from log filename', () => {
      const logDir = path.join(tmpDir, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, 'copilot-2026-01-15-aabbccdd-1234-5678-9abc-112233445566.log');
      fs.writeFileSync(logFile, 'log content');

      const noShareFile = path.join(tmpDir, 'nonexistent-share.md');
      const result = (delegator as any).extractSessionFromFile(noShareFile, logDir, 'test');
      assert.strictEqual(result, 'aabbccdd-1234-5678-9abc-112233445566');
    });

    test('returns undefined when no share file and no log files', () => {
      const noShareFile = path.join(tmpDir, 'nonexistent-share.md');
      const emptyLogDir = path.join(tmpDir, 'empty-logs');
      fs.mkdirSync(emptyLogDir, { recursive: true });

      const result = (delegator as any).extractSessionFromFile(noShareFile, emptyLogDir, 'test');
      assert.strictEqual(result, undefined);
    });

    test('returns undefined for share file without session ID', () => {
      const shareFile = path.join(tmpDir, 'session-share.md');
      fs.writeFileSync(shareFile, 'No session info here, just text.');

      const result = (delegator as any).extractSessionFromFile(shareFile, tmpDir, 'test');
      assert.strictEqual(result, undefined);
    });

    test('returns undefined when directories do not exist', () => {
      const result = (delegator as any).extractSessionFromFile(
        path.join(tmpDir, 'none', 'share.md'),
        path.join(tmpDir, 'none', 'logs'),
        'test'
      );
      assert.strictEqual(result, undefined);
    });

    test('handles errors gracefully', () => {
      // Pass an invalid path that might cause errors
      const result = (delegator as any).extractSessionFromFile('', '', 'test');
      assert.strictEqual(result, undefined);
    });
  });

  // ==========================================================================
  // extractTokenUsage
  // ==========================================================================
  suite('extractTokenUsage', () => {
    let tmpDir: string;

    setup(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegator-token-test-'));
    });

    teardown(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    test('extracts token usage from log file with prompt_tokens/completion_tokens', async () => {
      const logDir = path.join(tmpDir, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, 'copilot.log');
      fs.writeFileSync(logFile, [
        '{"prompt_tokens": 1000, "completion_tokens": 200}',
        '{"prompt_tokens": 500, "completion_tokens": 100}',
      ].join('\n'));

      const result = await (delegator as any).extractTokenUsage(logDir, 'gpt-5');
      assert.ok(result);
      assert.strictEqual(result.inputTokens, 1500);
      assert.strictEqual(result.outputTokens, 300);
      assert.strictEqual(result.totalTokens, 1800);
      assert.strictEqual(result.model, 'gpt-5');
    });

    test('extracts token usage from log file with input_tokens/output_tokens', async () => {
      const logDir = path.join(tmpDir, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, 'copilot.log');
      fs.writeFileSync(logFile, [
        'input_tokens: 800',
        'output_tokens: 150',
      ].join('\n'));

      const result = await (delegator as any).extractTokenUsage(logDir, 'claude-sonnet-4.5');
      assert.ok(result);
      assert.strictEqual(result.inputTokens, 800);
      assert.strictEqual(result.outputTokens, 150);
      assert.strictEqual(result.totalTokens, 950);
    });

    test('returns undefined for non-existent log directory', async () => {
      const result = await (delegator as any).extractTokenUsage(
        path.join(tmpDir, 'nonexistent'),
        'model'
      );
      assert.strictEqual(result, undefined);
    });

    test('returns undefined for empty log directory', async () => {
      const logDir = path.join(tmpDir, 'empty-logs');
      fs.mkdirSync(logDir, { recursive: true });

      const result = await (delegator as any).extractTokenUsage(logDir, 'model');
      assert.strictEqual(result, undefined);
    });

    test('returns undefined when log has no token patterns', async () => {
      const logDir = path.join(tmpDir, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, 'copilot.log'), 'Just some regular log content');

      const result = await (delegator as any).extractTokenUsage(logDir, 'model');
      assert.strictEqual(result, undefined);
    });

    test('uses "unknown" as default model', async () => {
      const logDir = path.join(tmpDir, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, 'copilot.log'), 'prompt_tokens: 100, completion_tokens: 50');

      const result = await (delegator as any).extractTokenUsage(logDir);
      assert.ok(result);
      assert.strictEqual(result.model, 'unknown');
    });

    test('reads most recent log file', async () => {
      const logDir = path.join(tmpDir, 'logs');
      fs.mkdirSync(logDir, { recursive: true });

      // Create older file
      const oldFile = path.join(logDir, 'old.log');
      fs.writeFileSync(oldFile, 'prompt_tokens: 100, completion_tokens: 50');

      // Wait a bit, then create newer file
      await new Promise(resolve => setTimeout(resolve, 50));
      const newFile = path.join(logDir, 'new.log');
      fs.writeFileSync(newFile, 'prompt_tokens: 999, completion_tokens: 888');

      const result = await (delegator as any).extractTokenUsage(logDir, 'test');
      assert.ok(result);
      assert.strictEqual(result.inputTokens, 999);
      assert.strictEqual(result.outputTokens, 888);
    });
  });

  // ==========================================================================
  // createTaskFile
  // ==========================================================================
  suite('createTaskFile', () => {
    let tmpDir: string;

    setup(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegator-task-test-'));
    });

    teardown(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    test('creates task file with correct content', async () => {
      const result = await (delegator as any).createTaskFile({
        jobId: 'test-job',
        taskDescription: 'Implement feature X',
        worktreePath: tmpDir,
        baseBranch: 'main',
        targetBranch: 'feature/x',
        instructions: 'Use TypeScript',
        sessionId: 'sess-123',
      });

      assert.ok(fs.existsSync(result), 'Task file should exist');
      const content = fs.readFileSync(result, 'utf-8');
      assert.ok(content.includes('test-job'), 'Should contain job ID');
      assert.ok(content.includes('Implement feature X'), 'Should contain task description');
      assert.ok(content.includes('Use TypeScript'), 'Should contain instructions');
      assert.ok(content.includes('main'), 'Should contain base branch');
      assert.ok(content.includes('feature/x'), 'Should contain target branch');
      assert.ok(content.includes('sess-123'), 'Should contain session ID');
      assert.ok(content.includes(tmpDir), 'Should contain worktree path');
    });

    test('creates task file without instructions', async () => {
      const result = await (delegator as any).createTaskFile({
        jobId: 'test-job',
        taskDescription: 'Do work',
        worktreePath: tmpDir,
        baseBranch: 'main',
        targetBranch: 'branch-1',
      });

      assert.ok(fs.existsSync(result));
      const content = fs.readFileSync(result, 'utf-8');
      assert.ok(content.includes('No additional instructions provided'));
    });

    test('creates task file without session ID', async () => {
      const result = await (delegator as any).createTaskFile({
        jobId: 'test-job',
        taskDescription: 'Do work',
        worktreePath: tmpDir,
        baseBranch: 'main',
        targetBranch: 'branch-1',
      });

      assert.ok(fs.existsSync(result));
      const content = fs.readFileSync(result, 'utf-8');
      assert.ok(content.includes('No active session yet'));
    });

    test('creates .copilot-task.md at worktree root', async () => {
      const result = await (delegator as any).createTaskFile({
        jobId: 'test-job',
        taskDescription: 'Do work',
        worktreePath: tmpDir,
        baseBranch: 'main',
        targetBranch: 'branch-1',
      });

      assert.strictEqual(result, path.join(tmpDir, '.copilot-task.md'));
    });

    test('includes work evidence section', async () => {
      const result = await (delegator as any).createTaskFile({
        jobId: 'my-job-id',
        taskDescription: 'Do work',
        worktreePath: tmpDir,
        baseBranch: 'main',
        targetBranch: 'branch-1',
      });

      const content = fs.readFileSync(result, 'utf-8');
      assert.ok(content.includes('Work Evidence'), 'Should have work evidence section');
      assert.ok(content.includes('.orchestrator/evidence/my-job-id.json'), 'Should include evidence path');
    });
  });

  // ==========================================================================
  // isCopilotAvailable
  // ==========================================================================
  suite('isCopilotAvailable', () => {
    test('returns boolean', () => {
      const result = delegator.isCopilotAvailable();
      assert.ok(typeof result === 'boolean');
    });
  });

  // ==========================================================================
  // delegate() end-to-end (covers delegateViaCopilot + createMarkerCommit)
  // Uses module cache override to avoid copilot CLI hanging
  // ==========================================================================
  suite('delegate() end-to-end', () => {
    let tmpDir: string;
    let savedCliRunnerCache: any;
    let savedCliCheckCache: any;
    let savedModelDiscoveryCache: any;
    let savedGitCache: any;

    const cliRunnerPath = require.resolve('../../../agent/copilotCliRunner');
    const cliCheckPath = require.resolve('../../../agent/cliCheckCore');
    const modelDiscoveryPath = require.resolve('../../../agent/modelDiscovery');
    const delegatorPath = require.resolve('../../../agent/agentDelegator');

    function setupModuleMocks() {
      // Save originals
      savedCliRunnerCache = require.cache[cliRunnerPath];
      savedCliCheckCache = require.cache[cliCheckPath];
      savedModelDiscoveryCache = require.cache[modelDiscoveryPath];

      // Mock CopilotCliRunner
      class MockCopilotCliRunner {
        constructor(_logger?: any) {}
        isAvailable() { return true; }
        async run(opts: any) {
          return {
            success: true,
            sessionId: 'mock-session-123',
            exitCode: 0,
            metrics: { durationMs: 100, premiumRequests: 1 },
          };
        }
        buildCommand(opts: any) { return 'echo mock'; }
        writeInstructionsFile(cwd: string, task: string, inst: string | undefined, label: string, jobId?: string) {
          const dir = path.join(cwd, '.github', 'instructions');
          const suffix = jobId ? `-${jobId.slice(0, 8)}` : '';
          const file = path.join(dir, `orchestrator-job${suffix}.instructions.md`);
          return { filePath: file, dirPath: dir };
        }
        cleanupInstructionsFile() {}
      }

      require.cache[cliRunnerPath] = {
        ...require.cache[cliRunnerPath]!,
        exports: {
          CopilotCliRunner: MockCopilotCliRunner,
          CopilotCliLogger: {},
          getCopilotCliRunner: () => new MockCopilotCliRunner(),
          runCopilotCli: async () => ({ success: true }),
        },
      } as any;

      // Mock cliCheckCore
      require.cache[cliCheckPath] = {
        ...require.cache[cliCheckPath]!,
        exports: {
          isCopilotCliAvailable: () => true,
          checkCopilotCliAsync: async () => true,
          resetCliCache: () => {},
          isCliCachePopulated: () => true,
        },
      } as any;

      // Mock modelDiscovery
      require.cache[modelDiscoveryPath] = {
        ...require.cache[modelDiscoveryPath]!,
        exports: {
          ...require.cache[modelDiscoveryPath]?.exports,
          isValidModel: async () => true,
          classifyModel: require.cache[modelDiscoveryPath]?.exports?.classifyModel,
          parseModelChoices: require.cache[modelDiscoveryPath]?.exports?.parseModelChoices,
          resetModelCache: () => {},
        },
      } as any;

      // Clear agentDelegator cache so it picks up mocked dependencies
      delete require.cache[delegatorPath];
    }

    function restoreModuleMocks() {
      if (savedCliRunnerCache) {
        require.cache[cliRunnerPath] = savedCliRunnerCache;
      } else {
        delete require.cache[cliRunnerPath];
      }
      if (savedCliCheckCache) {
        require.cache[cliCheckPath] = savedCliCheckCache;
      } else {
        delete require.cache[cliCheckPath];
      }
      if (savedModelDiscoveryCache) {
        require.cache[modelDiscoveryPath] = savedModelDiscoveryCache;
      } else {
        delete require.cache[modelDiscoveryPath];
      }
      delete require.cache[delegatorPath];
    }

    setup(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegator-e2e-'));
    });

    teardown(() => {
      restoreModuleMocks();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    test('delegate with copilot available calls delegateViaCopilot', async function () {
      this.timeout(15000);
      setupModuleMocks();

      // Also mock git module to avoid real git operations
      const gitExecPath = require.resolve('../../../git');
      const savedGit = require.cache[gitExecPath];
      require.cache[gitExecPath] = {
        ...require.cache[gitExecPath]!,
        exports: {
          executor: { execAsync: async () => '' },
          repository: { commit: async () => true },
        },
      } as any;

      try {
        const { AgentDelegator: FreshDelegator } = require('../../../agent/agentDelegator');
        const msgs: string[] = [];
        const callbacks = {
          onProcessSpawned: () => {},
          onProcessExited: () => {},
          onSessionCaptured: () => {},
        };

        const d = new FreshDelegator(
          { log: (msg: string) => msgs.push(msg) },
          callbacks
        );

        const result = await d.delegate({
          jobId: 'test-e2e-job',
          taskDescription: 'Test delegation task',
          label: 'test',
          worktreePath: tmpDir,
          baseBranch: 'main',
          targetBranch: 'test-branch',
          instructions: 'Run all tests',
          allowedFolders: [tmpDir],
          allowedUrls: ['https://api.example.com'],
        });

        assert.ok(result, 'Should return a result');
        assert.strictEqual(result.success, true, 'Should succeed');
        assert.ok(result.sessionId, 'Should have session ID from mock');
        assert.ok(msgs.some((m: string) => m.includes('Attempting automated delegation')),
          'Should log automated delegation attempt');
        assert.ok(msgs.some((m: string) => m.includes('Delegation step completed')),
          'Should log completion');
      } finally {
        if (savedGit) {
          require.cache[gitExecPath] = savedGit;
        } else {
          delete require.cache[gitExecPath];
        }
      }
    });

    test('delegate with model calls isValidModel', async function () {
      this.timeout(15000);
      setupModuleMocks();

      const gitExecPath = require.resolve('../../../git');
      const savedGit = require.cache[gitExecPath];
      require.cache[gitExecPath] = {
        ...require.cache[gitExecPath]!,
        exports: {
          executor: { execAsync: async () => '' },
          repository: { commit: async () => true },
        },
      } as any;

      try {
        const { AgentDelegator: FreshDelegator } = require('../../../agent/agentDelegator');
        const d = new FreshDelegator({ log: () => {} });

        const result = await d.delegate({
          jobId: 'model-test',
          taskDescription: 'Test with model',
          label: 'work',
          worktreePath: tmpDir,
          baseBranch: 'main',
          targetBranch: 'test-branch',
          model: 'claude-sonnet-4.5',
        });

        assert.ok(result);
        assert.strictEqual(result.success, true);
      } finally {
        if (savedGit) {
          require.cache[gitExecPath] = savedGit;
        } else {
          delete require.cache[gitExecPath];
        }
      }
    });

    test('delegate with session ID resumes', async function () {
      this.timeout(15000);
      setupModuleMocks();

      const gitExecPath = require.resolve('../../../git');
      const savedGit = require.cache[gitExecPath];
      require.cache[gitExecPath] = {
        ...require.cache[gitExecPath]!,
        exports: {
          executor: { execAsync: async () => '' },
          repository: { commit: async () => true },
        },
      } as any;

      try {
        const { AgentDelegator: FreshDelegator } = require('../../../agent/agentDelegator');
        const msgs: string[] = [];
        const d = new FreshDelegator({ log: (msg: string) => msgs.push(msg) });

        const result = await d.delegate({
          jobId: 'resume-test',
          taskDescription: 'Test session resume',
          label: 'work',
          worktreePath: tmpDir,
          baseBranch: 'main',
          targetBranch: 'test-branch',
          sessionId: 'existing-session-uuid',
        });

        assert.ok(result);
        assert.ok(msgs.some((m: string) => m.includes('Resuming')),
          'Should log resuming session');
      } finally {
        if (savedGit) {
          require.cache[gitExecPath] = savedGit;
        } else {
          delete require.cache[gitExecPath];
        }
      }
    });

    test('delegate with configDir creates directory', async function () {
      this.timeout(15000);
      setupModuleMocks();

      const gitExecPath = require.resolve('../../../git');
      const savedGit = require.cache[gitExecPath];
      require.cache[gitExecPath] = {
        ...require.cache[gitExecPath]!,
        exports: {
          executor: { execAsync: async () => '' },
          repository: { commit: async () => true },
        },
      } as any;

      try {
        const { AgentDelegator: FreshDelegator } = require('../../../agent/agentDelegator');
        const d = new FreshDelegator({ log: () => {} });

        const configDir = path.join(tmpDir, '.orchestrator', '.copilot');
        const result = await d.delegate({
          jobId: 'config-test',
          taskDescription: 'Test configDir',
          label: 'work',
          worktreePath: tmpDir,
          baseBranch: 'main',
          targetBranch: 'test-branch',
          configDir,
        });

        assert.ok(result);
      } finally {
        if (savedGit) {
          require.cache[gitExecPath] = savedGit;
        } else {
          delete require.cache[gitExecPath];
        }
      }
    });

    test('delegate with failed CopilotCliRunner returns failure', async function () {
      this.timeout(15000);

      // Override with a failing mock
      savedCliRunnerCache = require.cache[cliRunnerPath];
      savedCliCheckCache = require.cache[cliCheckPath];
      savedModelDiscoveryCache = require.cache[modelDiscoveryPath];

      class FailingMockRunner {
        constructor(_logger?: any) {}
        async run() {
          return {
            success: false,
            error: 'CLI failed',
            exitCode: 1,
          };
        }
        writeInstructionsFile(cwd: string) {
          return { filePath: path.join(cwd, 'test.md'), dirPath: cwd };
        }
        cleanupInstructionsFile() {}
      }

      require.cache[cliRunnerPath] = {
        ...require.cache[cliRunnerPath]!,
        exports: { CopilotCliRunner: FailingMockRunner },
      } as any;
      require.cache[cliCheckPath] = {
        ...require.cache[cliCheckPath]!,
        exports: {
          isCopilotCliAvailable: () => true,
          checkCopilotCliAsync: async () => true,
          resetCliCache: () => {},
          isCliCachePopulated: () => true,
        },
      } as any;
      require.cache[modelDiscoveryPath] = {
        ...require.cache[modelDiscoveryPath]!,
        exports: {
          ...require.cache[modelDiscoveryPath]?.exports,
          isValidModel: async () => true,
        },
      } as any;
      delete require.cache[delegatorPath];

      const gitExecPath = require.resolve('../../../git');
      const savedGit = require.cache[gitExecPath];
      require.cache[gitExecPath] = {
        ...require.cache[gitExecPath]!,
        exports: {
          executor: { execAsync: async () => '' },
          repository: { commit: async () => true },
        },
      } as any;

      try {
        const { AgentDelegator: FreshDelegator } = require('../../../agent/agentDelegator');
        const d = new FreshDelegator({ log: () => {} });

        const result = await d.delegate({
          jobId: 'fail-test',
          taskDescription: 'Test failure',
          label: 'work',
          worktreePath: tmpDir,
          baseBranch: 'main',
          targetBranch: 'test-branch',
        });

        assert.strictEqual(result.success, false, 'Should propagate failure');
        assert.ok(result.error, 'Should have error message');
      } finally {
        if (savedGit) {
          require.cache[gitExecPath] = savedGit;
        } else {
          delete require.cache[gitExecPath];
        }
      }
    });

    test('delegate when copilot not available skips delegateViaCopilot', async function () {
      this.timeout(15000);

      savedCliCheckCache = require.cache[cliCheckPath];
      require.cache[cliCheckPath] = {
        ...require.cache[cliCheckPath]!,
        exports: {
          isCopilotCliAvailable: () => false,
          checkCopilotCliAsync: async () => false,
          resetCliCache: () => {},
          isCliCachePopulated: () => true,
        },
      } as any;
      delete require.cache[delegatorPath];

      const gitExecPath = require.resolve('../../../git');
      const savedGit = require.cache[gitExecPath];
      require.cache[gitExecPath] = {
        ...require.cache[gitExecPath]!,
        exports: {
          executor: { execAsync: async () => '' },
          repository: { commit: async () => true },
        },
      } as any;

      try {
        const { AgentDelegator: FreshDelegator } = require('../../../agent/agentDelegator');
        const msgs: string[] = [];
        const d = new FreshDelegator({ log: (msg: string) => msgs.push(msg) });

        const result = await d.delegate({
          jobId: 'no-copilot',
          taskDescription: 'Test without copilot',
          label: 'work',
          worktreePath: tmpDir,
          baseBranch: 'main',
          targetBranch: 'test-branch',
        });

        assert.strictEqual(result.success, true, 'Should succeed without copilot');
        assert.ok(!msgs.some((m: string) => m.includes('Attempting automated')),
          'Should NOT attempt automated delegation');
      } finally {
        if (savedGit) {
          require.cache[gitExecPath] = savedGit;
        } else {
          delete require.cache[gitExecPath];
        }
      }
    });

    test('delegate handles createMarkerCommit failure gracefully', async function () {
      this.timeout(15000);

      savedCliCheckCache = require.cache[cliCheckPath];
      require.cache[cliCheckPath] = {
        ...require.cache[cliCheckPath]!,
        exports: {
          isCopilotCliAvailable: () => false,
          checkCopilotCliAsync: async () => false,
          resetCliCache: () => {},
          isCliCachePopulated: () => true,
        },
      } as any;
      delete require.cache[delegatorPath];

      const gitExecPath = require.resolve('../../../git');
      const savedGit = require.cache[gitExecPath];
      require.cache[gitExecPath] = {
        ...require.cache[gitExecPath]!,
        exports: {
          executor: { execAsync: async () => { throw new Error('git not available'); } },
          repository: { commit: async () => { throw new Error('git not available'); } },
        },
      } as any;

      try {
        const { AgentDelegator: FreshDelegator } = require('../../../agent/agentDelegator');
        const d = new FreshDelegator({ log: () => {} });

        const result = await d.delegate({
          jobId: 'git-fail',
          taskDescription: 'Test git failure',
          label: 'work',
          worktreePath: tmpDir,
          baseBranch: 'main',
          targetBranch: 'test-branch',
        });

        // Should complete despite git failure
        assert.ok(result);
        assert.strictEqual(result.success, true);
      } finally {
        if (savedGit) {
          require.cache[gitExecPath] = savedGit;
        } else {
          delete require.cache[gitExecPath];
        }
      }
    });
  });
});
