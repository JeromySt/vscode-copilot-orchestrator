import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { buildCommand, sanitizeUrl, CopilotCliRunner } from '../../../agent/copilotCliRunner';
import type { CopilotCliLogger } from '../../../agent/copilotCliRunner';

suite('copilotCliRunner', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('sanitizeUrl', () => {
    let mockLogger: CopilotCliLogger;

    setup(() => {
      mockLogger = {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
        debug: sandbox.stub(),
      };
    });

    test('should accept valid http URL', () => {
      const result = sanitizeUrl('http://example.com', mockLogger);
      assert.strictEqual(result, 'http://example.com');
    });

    test('should accept valid https URL', () => {
      const result = sanitizeUrl('https://example.com', mockLogger);
      assert.strictEqual(result, 'https://example.com');
    });

    test('should accept URL without protocol', () => {
      const result = sanitizeUrl('example.com', mockLogger);
      assert.strictEqual(result, 'example.com');
    });

    test('should accept wildcard domain', () => {
      const result = sanitizeUrl('*.github.com', mockLogger);
      assert.strictEqual(result, '*.github.com');
    });

    test('should trim whitespace', () => {
      const result = sanitizeUrl('  https://example.com  ', mockLogger);
      assert.strictEqual(result, 'https://example.com');
    });

    test('should reject empty string', () => {
      const result = sanitizeUrl('', mockLogger);
      assert.strictEqual(result, null);
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWith('[SECURITY] Rejected URL: empty or non-string input'));
    });

    test('should reject whitespace-only string', () => {
      const result = sanitizeUrl('   ', mockLogger);
      assert.strictEqual(result, null);
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWith('[SECURITY] Rejected URL: empty after trim'));
    });

    test('should reject null input', () => {
      const result = sanitizeUrl(null as any, mockLogger);
      assert.strictEqual(result, null);
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWith('[SECURITY] Rejected URL: empty or non-string input'));
    });

    test('should reject control characters', () => {
      const result = sanitizeUrl('https://example.com\x00', mockLogger);
      assert.strictEqual(result, null);
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWith('[SECURITY] Rejected URL containing control characters'));
    });

    test('should reject control character \\x7f', () => {
      const result = sanitizeUrl('https://example.com\x7f', mockLogger);
      assert.strictEqual(result, null);
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWith('[SECURITY] Rejected URL containing control characters'));
    });

    test('should reject backtick metacharacter', () => {
      const result = sanitizeUrl('https://example.com`', mockLogger);
      assert.strictEqual(result, null);
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWithMatch(/shell metacharacters/));
    });

    test('should reject pipe metacharacter', () => {
      const result = sanitizeUrl('https://example.com|whoami', mockLogger);
      assert.strictEqual(result, null);
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWithMatch(/shell metacharacters/));
    });

    test('should reject semicolon metacharacter', () => {
      const result = sanitizeUrl('https://example.com;ls', mockLogger);
      assert.strictEqual(result, null);
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWithMatch(/shell metacharacters/));
    });

    test('should reject newline in middle of URL', () => {
      const result = sanitizeUrl('https://exam\nple.com', mockLogger);
      assert.strictEqual(result, null);
      // \n (0x0a) is in the control character range [\x00-\x1f] so caught first
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWithMatch(/control characters/));
    });

    test('should reject carriage return in middle of URL', () => {
      const result = sanitizeUrl('https://exam\rple.com', mockLogger);
      assert.strictEqual(result, null);
      // \r (0x0d) is in the control character range [\x00-\x1f] so caught first
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWithMatch(/control characters/));
    });

    test('should reject backslash metacharacter', () => {
      const result = sanitizeUrl('https://example.com\\cmd', mockLogger);
      assert.strictEqual(result, null);
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWithMatch(/shell metacharacters/));
    });

    test('should reject command substitution $( pattern', () => {
      const result = sanitizeUrl('https://example.com$(whoami)', mockLogger);
      assert.strictEqual(result, null);
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWithMatch(/shell metacharacters/));
    });

    test('should reject && operator', () => {
      const result = sanitizeUrl('https://example.com&&whoami', mockLogger);
      assert.strictEqual(result, null);
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWithMatch(/&&/));
    });

    test('should reject dash-prefixed URL (argument injection)', () => {
      const result = sanitizeUrl('-example.com', mockLogger);
      assert.strictEqual(result, null);
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWithMatch(/dash.*argument injection/));
    });

    test('should reject embedded credentials', () => {
      const result = sanitizeUrl('https://user:pass@example.com', mockLogger);
      assert.strictEqual(result, null);
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWith('[SECURITY] Rejected URL containing embedded credentials'));
    });

    test('should reject file:// protocol', () => {
      const result = sanitizeUrl('file:///etc/passwd', mockLogger);
      assert.strictEqual(result, null);
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWithMatch(/disallowed scheme.*file:/));
    });

    test('should reject ftp:// protocol', () => {
      const result = sanitizeUrl('ftp://example.com', mockLogger);
      assert.strictEqual(result, null);
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWithMatch(/disallowed scheme.*ftp:/));
    });

    test('should reject javascript: protocol', () => {
      const result = sanitizeUrl('javascript:alert(1)', mockLogger);
      assert.strictEqual(result, null);
      // The URL constructor prepends https:// since there's no :// in the input
      // So it becomes 'https://javascript:alert(1)' which passes protocol check but has : in hostname
      // Actually, let's test it properly - javascript: alone won't parse, need invalid format
      assert.ok((mockLogger.warn as sinon.SinonStub).called);
    });

    test('should reject malformed URL', () => {
      const result = sanitizeUrl('not a valid url @#$%', mockLogger);
      assert.strictEqual(result, null);
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWithMatch(/invalid URL format/));
    });

    test('should work without logger', () => {
      const result = sanitizeUrl('https://example.com');
      assert.strictEqual(result, 'https://example.com');
    });
  });

  suite('buildCommand', () => {
    let mockLogger: CopilotCliLogger;
    let existsStub: sinon.SinonStub;

    setup(() => {
      mockLogger = {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
        debug: sandbox.stub(),
      };
      existsStub = sandbox.stub().returns(true);
    });

    test('should build basic command with task and cwd', () => {
      const cmd = buildCommand(
        { task: 'test task', cwd: 'C:\\worktree' },
        { logger: mockLogger, existsSync: existsStub, fallbackCwd: 'C:\\fallback' }
      );

      assert.ok(cmd.includes('copilot'));
      assert.ok(cmd.includes('-p "test task"'));
      assert.ok(cmd.includes('--add-dir "C:\\\\worktree"'));
      assert.ok(cmd.includes('--stream off'));
      assert.ok(cmd.includes('--allow-all-tools'));
      assert.ok(cmd.includes('--no-auto-update'));
    });

    test('should derive configDir from cwd by default', () => {
      const cmd = buildCommand(
        { task: 'test', cwd: 'C:\\worktree' },
        { logger: mockLogger, existsSync: existsStub, fallbackCwd: 'C:\\fallback' }
      );

      assert.ok(cmd.includes('--config-dir "C:\\\\worktree\\\\.orchestrator\\\\.copilot-cli"'));
    });

    test('should NOT add configDir to --add-dir (inside worktree)', () => {
      const cmd = buildCommand(
        { task: 'test', cwd: 'C:\\worktree' },
        { logger: mockLogger, existsSync: existsStub, fallbackCwd: 'C:\\fallback' }
      );

      // Should only have one --add-dir for cwd
      const addDirMatches = cmd.match(/--add-dir/g);
      assert.strictEqual(addDirMatches?.length, 1);
      assert.ok(cmd.includes('--add-dir "C:\\\\worktree"'));
    });

    test('should use explicit configDir if provided', () => {
      const cmd = buildCommand(
        { task: 'test', cwd: 'C:\\worktree', configDir: 'C:\\custom-config' },
        { logger: mockLogger, existsSync: existsStub, fallbackCwd: 'C:\\fallback' }
      );

      assert.ok(cmd.includes('--config-dir "C:\\\\custom-config"'));
      assert.ok(!cmd.includes('.orchestrator'));
    });

    test('should warn and skip non-existent allowedFolders', () => {
      existsStub.callsFake((p: string) => p === 'C:\\worktree');

      const cmd = buildCommand(
        {
          task: 'test',
          cwd: 'C:\\worktree',
          allowedFolders: ['C:\\does-not-exist'],
        },
        { logger: mockLogger, existsSync: existsStub, fallbackCwd: 'C:\\fallback' }
      );

      assert.ok((mockLogger.warn as sinon.SinonStub).calledWithMatch(/does not exist.*does-not-exist/));
      // Should only have cwd in --add-dir
      assert.ok(cmd.includes('--add-dir "C:\\\\worktree"'));
      assert.ok(!cmd.includes('does-not-exist'));
    });

    test('should skip relative paths in allowedFolders', () => {
      const cmd = buildCommand(
        {
          task: 'test',
          cwd: 'C:\\worktree',
          allowedFolders: ['../relative/path'],
        },
        { logger: mockLogger, existsSync: existsStub, fallbackCwd: 'C:\\fallback' }
      );

      assert.ok((mockLogger.warn as sinon.SinonStub).calledWithMatch(/relative.*must be absolute/));
      assert.ok(!cmd.includes('relative'));
    });

    test('should add valid allowedFolders', () => {
      existsStub.returns(true);

      const cmd = buildCommand(
        {
          task: 'test',
          cwd: 'C:\\worktree',
          allowedFolders: ['C:\\folder1', 'C:\\folder2'],
        },
        { logger: mockLogger, existsSync: existsStub, fallbackCwd: 'C:\\fallback' }
      );

      assert.ok(cmd.includes('--add-dir "C:\\\\worktree"'));
      assert.ok(cmd.includes('--add-dir "C:\\\\folder1"'));
      assert.ok(cmd.includes('--add-dir "C:\\\\folder2"'));
    });

    test('should sanitize and add allowedUrls', () => {
      const sanitizerStub = sandbox.stub();
      sanitizerStub.withArgs('https://example.com').returns('https://example.com');
      sanitizerStub.withArgs('*.github.com').returns('*.github.com');
      sanitizerStub.withArgs('bad-url$(cmd)').returns(null);

      const cmd = buildCommand(
        {
          task: 'test',
          cwd: 'C:\\worktree',
          allowedUrls: ['https://example.com', '*.github.com', 'bad-url$(cmd)'],
        },
        { logger: mockLogger, existsSync: existsStub, urlSanitizer: sanitizerStub, fallbackCwd: 'C:\\fallback' }
      );

      assert.ok(cmd.includes('--allow-url "https://example.com"'));
      assert.ok(cmd.includes('--allow-url "*.github.com"'));
      assert.ok(!cmd.includes('bad-url'));
      assert.ok((mockLogger.info as sinon.SinonStub).calledWithMatch(/2 of 3 passed validation/));
    });

    test('should warn if all allowedUrls fail validation', () => {
      const sanitizerStub = sandbox.stub().returns(null);

      const cmd = buildCommand(
        {
          task: 'test',
          cwd: 'C:\\worktree',
          allowedUrls: ['bad1', 'bad2'],
        },
        { logger: mockLogger, existsSync: existsStub, urlSanitizer: sanitizerStub, fallbackCwd: 'C:\\fallback' }
      );

      assert.ok(!cmd.includes('--allow-url'));
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWithMatch(/All 2.*failed validation.*network access disabled/));
    });

    test('should add model flag', () => {
      const cmd = buildCommand(
        { task: 'test', cwd: 'C:\\worktree', model: 'claude-sonnet-4.5' },
        { logger: mockLogger, existsSync: existsStub, fallbackCwd: 'C:\\fallback' }
      );

      assert.ok(cmd.includes('--model claude-sonnet-4.5'));
    });

    test('should add logDir flag', () => {
      const cmd = buildCommand(
        { task: 'test', cwd: 'C:\\worktree', logDir: 'C:\\logs' },
        { logger: mockLogger, existsSync: existsStub, fallbackCwd: 'C:\\fallback' }
      );

      assert.ok(cmd.includes('--log-dir "C:\\\\logs"'));
      assert.ok(cmd.includes('--log-level debug'));
    });

    test('should add sharePath flag', () => {
      const cmd = buildCommand(
        { task: 'test', cwd: 'C:\\worktree', sharePath: 'C:\\share.json' },
        { logger: mockLogger, existsSync: existsStub, fallbackCwd: 'C:\\fallback' }
      );

      assert.ok(cmd.includes('--share "C:\\\\share.json"'));
    });

    test('should add sessionId flag', () => {
      const cmd = buildCommand(
        { task: 'test', cwd: 'C:\\worktree', sessionId: 'abc-123' },
        { logger: mockLogger, existsSync: existsStub, fallbackCwd: 'C:\\fallback' }
      );

      assert.ok(cmd.includes('--resume abc-123'));
    });

    test('should add maxTurns flag', () => {
      const cmd = buildCommand(
        { task: 'test', cwd: 'C:\\worktree', maxTurns: 5 },
        { logger: mockLogger, existsSync: existsStub, fallbackCwd: 'C:\\fallback' }
      );

      assert.ok(cmd.includes('--max-turns 5'));
    });

    test('should not add maxTurns if zero', () => {
      const cmd = buildCommand(
        { task: 'test', cwd: 'C:\\worktree', maxTurns: 0 },
        { logger: mockLogger, existsSync: existsStub, fallbackCwd: 'C:\\fallback' }
      );

      assert.ok(!cmd.includes('--max-turns'));
    });

    test('should use fallback cwd when no cwd or allowedPaths', () => {
      const cmd = buildCommand(
        { task: 'test' },
        { logger: mockLogger, existsSync: existsStub, fallbackCwd: 'C:\\fallback' }
      );

      assert.ok(cmd.includes('--add-dir "C:\\\\fallback"'));
      assert.ok((mockLogger.warn as sinon.SinonStub).calledWithMatch(/No allowed paths.*explicit cwd.*fallback/));
    });

    test('should build command with all flags combined', () => {
      existsStub.returns(true);

      const cmd = buildCommand(
        {
          task: 'complex task',
          cwd: 'C:\\worktree',
          configDir: 'C:\\config',
          sessionId: 'session-123',
          model: 'gpt-5',
          logDir: 'C:\\logs',
          sharePath: 'C:\\share.json',
          allowedFolders: ['C:\\folder1'],
          allowedUrls: ['https://api.example.com'],
          maxTurns: 10,
        },
        {
          logger: mockLogger,
          existsSync: existsStub,
          urlSanitizer: () => 'https://api.example.com',
          fallbackCwd: 'C:\\fallback',
        }
      );

      assert.ok(cmd.includes('copilot'));
      assert.ok(cmd.includes('-p "complex task"'));
      assert.ok(cmd.includes('--add-dir "C:\\\\worktree"'));
      assert.ok(cmd.includes('--add-dir "C:\\\\folder1"'));
      assert.ok(cmd.includes('--allow-url "https://api.example.com"'));
      assert.ok(cmd.includes('--config-dir "C:\\\\config"'));
      assert.ok(cmd.includes('--model gpt-5'));
      assert.ok(cmd.includes('--log-dir "C:\\\\logs"'));
      assert.ok(cmd.includes('--share "C:\\\\share.json"'));
      assert.ok(cmd.includes('--resume session-123'));
      assert.ok(cmd.includes('--max-turns 10'));
    });

    test('should log error if cwd does not exist', () => {
      existsStub.returns(false);

      const cmd = buildCommand(
        { task: 'test', cwd: 'C:\\nonexistent' },
        { logger: mockLogger, existsSync: existsStub, fallbackCwd: 'C:\\fallback' }
      );

      assert.ok((mockLogger.error as sinon.SinonStub).calledWithMatch(/does not exist.*nonexistent/));
      // Still add it to the command
      assert.ok(cmd.includes('--add-dir "C:\\\\nonexistent"'));
    });
  });

  suite('CopilotCliRunner', () => {
    let runner: CopilotCliRunner;
    let mockLogger: CopilotCliLogger;
    let mockSpawner: any;
    let mockEnvironment: any;

    setup(() => {
      mockLogger = {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
        debug: sandbox.stub(),
      };
      mockSpawner = {
        spawn: sandbox.stub(),
      };
      mockEnvironment = {
        env: { PATH: '/usr/bin' },
        platform: 'win32',
        cwd: () => 'C:\\cwd',
      };
      runner = new CopilotCliRunner(mockLogger, mockSpawner, mockEnvironment);
    });

    suite('run', () => {
      test('should return error if CLI not available', async () => {
        sandbox.stub(runner, 'isAvailable').returns(false);

        const result = await runner.run({
          cwd: 'C:\\worktree',
          task: 'test task',
        });

        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('not available'));
        assert.strictEqual(result.exitCode, 127);
      });

      test('should write instructions file by default', async () => {
        sandbox.stub(runner, 'isAvailable').returns(true);
        const writeStub = sandbox.stub(runner, 'writeInstructionsFile').returns({
          filePath: 'C:\\worktree\\.github\\instructions\\orchestrator-job.instructions.md',
          dirPath: 'C:\\worktree\\.github\\instructions',
        });
        sandbox.stub(runner, 'buildCommand').returns('copilot -p "test"');
        const cleanupStub = sandbox.stub(runner, 'cleanupInstructionsFile');

        const mockProc = {
          pid: 1234,
          stdout: { on: sandbox.stub() },
          stderr: { on: sandbox.stub() },
          on: sandbox.stub(),
        };
        mockProc.on.withArgs('exit').callsArgWith(1, 0, null);
        mockSpawner.spawn.returns(mockProc);

        await runner.run({
          cwd: 'C:\\worktree',
          task: 'my task',
          instructions: 'extra context',
        });

        assert.ok(writeStub.calledOnce);
        assert.ok(writeStub.calledWith('C:\\worktree', 'my task', 'extra context', 'copilot', undefined));
        assert.ok(cleanupStub.calledOnce);
      });

      test('should skip instructions file when skipInstructionsFile is true', async () => {
        sandbox.stub(runner, 'isAvailable').returns(true);
        const writeStub = sandbox.stub(runner, 'writeInstructionsFile');
        sandbox.stub(runner, 'buildCommand').returns('copilot -p "test"');

        const mockProc = {
          pid: 1234,
          stdout: { on: sandbox.stub() },
          stderr: { on: sandbox.stub() },
          on: sandbox.stub(),
        };
        mockProc.on.withArgs('exit').callsArgWith(1, 0, null);
        mockSpawner.spawn.returns(mockProc);

        await runner.run({
          cwd: 'C:\\worktree',
          task: 'my task',
          skipInstructionsFile: true,
        });

        assert.ok(writeStub.notCalled);
      });

      test('should cleanup instructions file on success', async () => {
        sandbox.stub(runner, 'isAvailable').returns(true);
        const instructionsPath = 'C:\\worktree\\.github\\instructions\\orchestrator-job.instructions.md';
        sandbox.stub(runner, 'writeInstructionsFile').returns({
          filePath: instructionsPath,
          dirPath: 'C:\\worktree\\.github\\instructions',
        });
        sandbox.stub(runner, 'buildCommand').returns('copilot -p "test"');
        const cleanupStub = sandbox.stub(runner, 'cleanupInstructionsFile');

        const mockProc = {
          pid: 1234,
          stdout: { on: sandbox.stub() },
          stderr: { on: sandbox.stub() },
          on: sandbox.stub(),
        };
        mockProc.on.withArgs('exit').callsArgWith(1, 0, null);
        mockSpawner.spawn.returns(mockProc);

        await runner.run({
          cwd: 'C:\\worktree',
          task: 'my task',
        });

        assert.ok(cleanupStub.calledOnce);
        assert.ok(cleanupStub.calledWith(instructionsPath, 'C:\\worktree\\.github\\instructions', 'copilot'));
      });

      test('should cleanup instructions file on error', async () => {
        sandbox.stub(runner, 'isAvailable').returns(true);
        const instructionsPath = 'C:\\worktree\\.github\\instructions\\orchestrator-job.instructions.md';
        sandbox.stub(runner, 'writeInstructionsFile').returns({
          filePath: instructionsPath,
          dirPath: 'C:\\worktree\\.github\\instructions',
        });
        sandbox.stub(runner, 'buildCommand').returns('copilot -p "test"');
        const cleanupStub = sandbox.stub(runner, 'cleanupInstructionsFile');

        const mockProc = {
          pid: 1234,
          stdout: { on: sandbox.stub() },
          stderr: { on: sandbox.stub() },
          on: sandbox.stub(),
        };
        mockProc.on.withArgs('exit').callsArgWith(1, 1, null);
        mockSpawner.spawn.returns(mockProc);

        await runner.run({
          cwd: 'C:\\worktree',
          task: 'my task',
        });

        assert.ok(cleanupStub.calledOnce);
      });
    });

    suite('writeInstructionsFile', () => {
      let mkdirStub: sinon.SinonStub;
      let writeFileStub: sinon.SinonStub;
      const fsModule = require('fs');

      setup(() => {
        mkdirStub = sandbox.stub(fsModule, 'mkdirSync');
        writeFileStub = sandbox.stub(fsModule, 'writeFileSync');
      });

      test('should write instructions file with frontmatter', () => {
        const result = runner.writeInstructionsFile(
          'C:\\worktrees\\abc123',
          'Test task',
          'Extra instructions',
          'test-label'
        );

        assert.strictEqual(result.filePath, 'C:\\worktrees\\abc123\\.github\\instructions\\orchestrator-job.instructions.md');
        assert.strictEqual(result.dirPath, 'C:\\worktrees\\abc123\\.github\\instructions');

        assert.ok(mkdirStub.calledOnce);
        assert.ok(mkdirStub.calledWith('C:\\worktrees\\abc123\\.github\\instructions', { recursive: true }));

        assert.ok(writeFileStub.calledOnce);
        const writtenContent = writeFileStub.firstCall.args[1] as string;

        // The applyTo scope is constructed from path.basename(cwd) and path.basename(path.dirname(cwd))
        // For 'C:\\worktrees\\abc123', parent is 'worktrees' and folder is 'abc123'
        assert.ok(writtenContent.includes("applyTo: 'worktrees/abc123/**'"));
        assert.ok(writtenContent.includes('# Current Task'));
        assert.ok(writtenContent.includes('Test task'));
        assert.ok(writtenContent.includes('## Additional Context'));
        assert.ok(writtenContent.includes('Extra instructions'));
        assert.ok(writtenContent.includes('## Guidelines'));
      });

      test('should include jobId in filename when provided', () => {
        const result = runner.writeInstructionsFile(
          'C:\\worktrees\\abc123',
          'Test task',
          undefined,
          'test-label',
          'job-12345678-extra'
        );

        assert.ok(result.filePath.includes('orchestrator-job-job-1234.instructions.md'));
      });

      test('should omit Additional Context section when no instructions', () => {
        const result = runner.writeInstructionsFile(
          'C:\\worktrees\\abc123',
          'Test task',
          undefined,
          'test-label'
        );

        assert.ok(writeFileStub.calledOnce);
        const writtenContent = writeFileStub.firstCall.args[1] as string;

        assert.ok(writtenContent.includes('# Current Task'));
        assert.ok(writtenContent.includes('Test task'));
        assert.ok(!writtenContent.includes('## Additional Context'));
      });

      test('should handle write errors gracefully', () => {
        writeFileStub.throws(new Error('Write failed'));

        const result = runner.writeInstructionsFile(
          'C:\\worktrees\\abc123',
          'Test task',
          'Extra instructions',
          'test-label'
        );

        assert.ok((mockLogger.warn as sinon.SinonStub).calledWithMatch(/Failed to write instructions file/));
        assert.strictEqual(result.filePath, 'C:\\worktrees\\abc123\\.github\\instructions\\orchestrator-job.instructions.md');
      });
    });

    suite('cleanupInstructionsFile', () => {
      let existsStub: sinon.SinonStub;
      let unlinkStub: sinon.SinonStub;
      let readdirStub: sinon.SinonStub;
      let rmdirStub: sinon.SinonStub;
      const fsModule = require('fs');

      setup(() => {
        existsStub = sandbox.stub(fsModule, 'existsSync');
        unlinkStub = sandbox.stub(fsModule, 'unlinkSync');
        readdirStub = sandbox.stub(fsModule, 'readdirSync');
        rmdirStub = sandbox.stub(fsModule, 'rmdirSync');
      });

      test('should delete file and empty directory', () => {
        existsStub.returns(true);
        readdirStub.returns([]);

        runner.cleanupInstructionsFile(
          'C:\\worktree\\.github\\instructions\\orchestrator-job.instructions.md',
          'C:\\worktree\\.github\\instructions',
          'test-label'
        );

        assert.ok(unlinkStub.calledOnce);
        assert.ok(unlinkStub.calledWith('C:\\worktree\\.github\\instructions\\orchestrator-job.instructions.md'));
        assert.ok(rmdirStub.calledOnce);
        assert.ok(rmdirStub.calledWith('C:\\worktree\\.github\\instructions'));
      });

      test('should not delete directory if not empty', () => {
        existsStub.returns(true);
        readdirStub.returns(['other-file.md']);

        runner.cleanupInstructionsFile(
          'C:\\worktree\\.github\\instructions\\orchestrator-job.instructions.md',
          'C:\\worktree\\.github\\instructions',
          'test-label'
        );

        assert.ok(unlinkStub.calledOnce);
        assert.ok(rmdirStub.notCalled);
      });

      test('should do nothing if file does not exist', () => {
        existsStub.returns(false);

        runner.cleanupInstructionsFile(
          'C:\\worktree\\.github\\instructions\\orchestrator-job.instructions.md',
          'C:\\worktree\\.github\\instructions',
          'test-label'
        );

        assert.ok(unlinkStub.notCalled);
        assert.ok(rmdirStub.notCalled);
      });

      test('should handle cleanup errors gracefully', () => {
        existsStub.returns(true);
        unlinkStub.throws(new Error('Delete failed'));

        runner.cleanupInstructionsFile(
          'C:\\worktree\\.github\\instructions\\orchestrator-job.instructions.md',
          'C:\\worktree\\.github\\instructions',
          'test-label'
        );

        assert.ok((mockLogger.warn as sinon.SinonStub).calledWithMatch(/Failed to cleanup instructions file/));
      });

      test('should handle directory removal errors gracefully', () => {
        existsStub.returns(true);
        readdirStub.returns([]);
        rmdirStub.throws(new Error('rmdir failed'));

        runner.cleanupInstructionsFile(
          'C:\\worktree\\.github\\instructions\\orchestrator-job.instructions.md',
          'C:\\worktree\\.github\\instructions',
          'test-label'
        );

        // Should still delete the file
        assert.ok(unlinkStub.calledOnce);
        // Error is silently caught
      });
    });
  });
});
