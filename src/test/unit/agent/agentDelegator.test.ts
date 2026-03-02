/**
 * @fileoverview Unit tests for AgentDelegator.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { IGitOperations } from '../../../interfaces/IGitOperations';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegator-test-'));
  tmpDirs.push(dir);
  return dir;
}

function rmrf(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeLogger(): { log: (m: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { log: (m: string) => messages.push(m), messages };
}

const mockGitOps = {} as any as IGitOperations;

function makeOpts(tmpDir: string) {
  return {
    jobId: 'job-1', taskDescription: 'test', label: 'work',
    worktreePath: tmpDir, baseBranch: 'main', targetBranch: 'feat/x',
  };
}

suite('AgentDelegator', () => {
  let quiet: { restore: () => void };
  let sandbox: sinon.SinonSandbox;
  let cliCheck: typeof import('../../../agent/cliCheckCore');
  let gitExec: typeof import('../../../git/core/executor');
  let gitRepo: typeof import('../../../git/core/repository');
  let AgentDelegator: typeof import('../../../agent/agentDelegator').AgentDelegator;

  /** Create a mock ICopilotRunner that calls onProcess/onOutput and returns the given result. */
  function makeMockRunner(result: {
    success: boolean;
    exitCode?: number;
    sessionId?: string;
    error?: string;
  }, options?: {
    pid?: number;
    outputLines?: string[];
  }) {
    return {
      isAvailable: () => true,
      buildCommand: () => 'mock-cmd',
      writeInstructionsFile: () => ({ filePath: '/tmp/instr.md', dirPath: '/tmp' }),
      cleanupInstructionsFile: () => {},
      run: sinon.stub().callsFake(async (opts: any) => {
        // Simulate process spawn callback
        if (opts.onProcess) {
          opts.onProcess({ pid: options?.pid ?? 12345 });
        }
        // Simulate output callback (for session ID extraction via onOutput)
        if (opts.onOutput && options?.outputLines) {
          for (const line of options.outputLines) {
            opts.onOutput(line);
          }
        }
        return result;
      }),
    };
  }

  setup(() => {
    quiet = silenceConsole();
    sandbox = sinon.createSandbox();
    delete require.cache[require.resolve('../../../agent/cliCheckCore')];
    delete require.cache[require.resolve('../../../agent/copilotCliRunner')];
    delete require.cache[require.resolve('../../../agent/agentDelegator')];
    cliCheck = require('../../../agent/cliCheckCore');
    gitExec = require('../../../git/core/executor');
    gitRepo = require('../../../git/core/repository');
    const mod = require('../../../agent/agentDelegator');
    AgentDelegator = mod.AgentDelegator;
  });

  teardown(() => {
    sandbox.restore();
    quiet.restore();
    for (const d of tmpDirs) {rmrf(d);}
    tmpDirs = [];
  });

  suite('delegate() when Copilot unavailable', () => {
    test('creates task file and marker commit', async () => {
      const tmpDir = makeTmpDir();
      sandbox.stub(cliCheck, 'isCopilotCliAvailable').returns(false);
      sandbox.stub(gitExec, 'execAsync').resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      sandbox.stub(gitRepo, 'commit').resolves(true);
      const logger = makeLogger();
      const delegator = new AgentDelegator(logger, mockGitOps);
      const result = await delegator.delegate(makeOpts(tmpDir));
      assert.strictEqual(result.success, true);
      assert.ok(fs.existsSync(path.join(tmpDir, '.copilot-task.md')));
    });
  });

  suite('delegate() when Copilot available', () => {
    test('captures session from stdout', async () => {
      const tmpDir = makeTmpDir();
      sandbox.stub(cliCheck, 'isCopilotCliAvailable').returns(true);
      const sid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const mockRunner = makeMockRunner(
        { success: true, exitCode: 0, sessionId: sid },
        { outputLines: [`Session ID: ${sid}`, 'Done.'] }
      );
      sandbox.stub(gitExec, 'execAsync').resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      sandbox.stub(gitRepo, 'commit').resolves(true);
      const cbs = { onProcessSpawned: sandbox.stub(), onSessionCaptured: sandbox.stub(), onProcessExited: sandbox.stub() };
      const logger = makeLogger();
      const delegator = new AgentDelegator(logger, mockGitOps, cbs, mockRunner as any);
      const result = await delegator.delegate(makeOpts(tmpDir));
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.sessionId, sid);
      assert.ok(cbs.onProcessSpawned.calledOnce);
      assert.ok(cbs.onSessionCaptured.calledWith(sid));
    });

    test('captures session from stderr', async () => {
      const tmpDir = makeTmpDir();
      sandbox.stub(cliCheck, 'isCopilotCliAvailable').returns(true);
      const sid = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
      const mockRunner = makeMockRunner(
        { success: true, exitCode: 0, sessionId: sid },
        { outputLines: [`session: ${sid}`] }
      );
      sandbox.stub(gitExec, 'execAsync').resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      sandbox.stub(gitRepo, 'commit').resolves(true);
      const logger = makeLogger();
      const delegator = new AgentDelegator(logger, mockGitOps, {}, mockRunner as any);
      const result = await delegator.delegate(makeOpts(tmpDir));
      assert.strictEqual(result.sessionId, sid);
    });

    test('handles non-zero exit code', async () => {
      const tmpDir = makeTmpDir();
      sandbox.stub(cliCheck, 'isCopilotCliAvailable').returns(true);
      const mockRunner = makeMockRunner({ success: false, exitCode: 1, error: 'Process exited with code 1' });
      sandbox.stub(gitExec, 'execAsync').resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      sandbox.stub(gitRepo, 'commit').resolves(true);
      const logger = makeLogger();
      const delegator = new AgentDelegator(logger, mockGitOps, {}, mockRunner as any);
      const result = await delegator.delegate(makeOpts(tmpDir));
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('exited with code 1'));
    });

    test('handles process error event', async () => {
      const tmpDir = makeTmpDir();
      sandbox.stub(cliCheck, 'isCopilotCliAvailable').returns(true);
      const mockRunner = makeMockRunner({ success: false, error: 'spawn failed' });
      sandbox.stub(gitExec, 'execAsync').resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      sandbox.stub(gitRepo, 'commit').resolves(true);
      const logger = makeLogger();
      const delegator = new AgentDelegator(logger, mockGitOps, {}, mockRunner as any);
      const result = await delegator.delegate(makeOpts(tmpDir));
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('spawn failed'));
    });

    test('resumes existing session', async () => {
      const tmpDir = makeTmpDir();
      sandbox.stub(cliCheck, 'isCopilotCliAvailable').returns(true);
      const sid = 'c3d4e5f6-a7b8-9012-cdef-123456789012';
      const mockRunner = makeMockRunner({ success: true, exitCode: 0, sessionId: sid });
      sandbox.stub(gitExec, 'execAsync').resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      sandbox.stub(gitRepo, 'commit').resolves(true);
      const logger = makeLogger();
      const delegator = new AgentDelegator(logger, mockGitOps, {}, mockRunner as any);
      const result = await delegator.delegate({ ...makeOpts(tmpDir), sessionId: sid });
      assert.strictEqual(result.sessionId, sid);
    });

    test('extracts session from share file', async () => {
      const tmpDir = makeTmpDir();
      sandbox.stub(cliCheck, 'isCopilotCliAvailable').returns(true);
      const sid = 'd4e5f6a7-b8c9-0123-defa-234567890123';
      const mockRunner = makeMockRunner({ success: true, exitCode: 0 });
      const copilotDir = path.join(tmpDir, '.orchestrator', '.copilot-cli');
      fs.mkdirSync(path.join(copilotDir, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(copilotDir, `session-work.md`), `Session ID: ${sid}\nContent`);
      sandbox.stub(gitExec, 'execAsync').resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      sandbox.stub(gitRepo, 'commit').resolves(true);
      const logger = makeLogger();
      const delegator = new AgentDelegator(logger, mockGitOps, {}, mockRunner as any);
      const result = await delegator.delegate(makeOpts(tmpDir));
      assert.strictEqual(result.sessionId, sid);
    });

    test('extracts session from log filename', async () => {
      const tmpDir = makeTmpDir();
      sandbox.stub(cliCheck, 'isCopilotCliAvailable').returns(true);
      const sid = 'e5f6a7b8-c9d0-1234-efab-345678901234';
      const mockRunner = makeMockRunner({ success: true, exitCode: 0 });
      const logDir = path.join(tmpDir, '.orchestrator', '.copilot-cli', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, `copilot-2024-01-01-${sid}.log`), 'log');
      sandbox.stub(gitExec, 'execAsync').resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      sandbox.stub(gitRepo, 'commit').resolves(true);
      const logger = makeLogger();
      const delegator = new AgentDelegator(logger, mockGitOps, {}, mockRunner as any);
      const result = await delegator.delegate(makeOpts(tmpDir));
      assert.strictEqual(result.sessionId, sid);
    });
  });

  suite('isCopilotAvailable()', () => {
    test('delegates to cliCheckCore', () => {
      sandbox.stub(cliCheck, 'isCopilotCliAvailable').returns(true);
      const logger = makeLogger();
      const delegator = new AgentDelegator(logger, mockGitOps);
      assert.strictEqual(delegator.isCopilotAvailable(), true);
    });
  });

  suite('createMarkerCommit failure', () => {
    test('logs warning but does not throw', async () => {
      const tmpDir = makeTmpDir();
      sandbox.stub(cliCheck, 'isCopilotCliAvailable').returns(false);
      sandbox.stub(gitExec, 'execAsync').rejects(new Error('git fail'));
      const logger = makeLogger();
      const delegator = new AgentDelegator(logger, mockGitOps);
      const result = await delegator.delegate(makeOpts(tmpDir));
      assert.strictEqual(result.success, true);
      assert.ok(logger.messages.some(m => m.includes('Could not create marker commit')));
    });
  });
});
