/**
 * @fileoverview Unit tests for AgentDelegator.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { IGitOperations } from '../../../interfaces/IGitOperations';

const cp = require('child_process');

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

function makeFakeProc(exitCode: number | null = 0, stdoutData = '', stderrData = ''): ChildProcess {
  const proc = new EventEmitter() as any;
  proc.pid = 12345;
  proc.kill = sinon.stub();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = null;
  setTimeout(() => {
    if (stdoutData) {proc.stdout.emit('data', Buffer.from(stdoutData));}
    if (stderrData) {proc.stderr.emit('data', Buffer.from(stderrData));}
    setTimeout(() => proc.emit('exit', exitCode), 10);
  }, 10);
  return proc as ChildProcess;
}

function makeFakeErrorProc(err: Error = new Error('spawn ENOENT')): ChildProcess {
  const proc = new EventEmitter() as any;
  proc.pid = 12345;
  proc.kill = sinon.stub();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = null;
  setTimeout(() => proc.emit('error', err), 10);
  return proc as ChildProcess;
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
  let spawnStub: sinon.SinonStub;
  let cliCheck: typeof import('../../../agent/cliCheckCore');
  let gitExec: typeof import('../../../git/core/executor');
  let gitRepo: typeof import('../../../git/core/repository');
  let AgentDelegator: typeof import('../../../agent/agentDelegator').AgentDelegator;

  setup(() => {
    quiet = silenceConsole();
    sandbox = sinon.createSandbox();
    spawnStub = sandbox.stub(cp, 'spawn');
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
      spawnStub.returns(makeFakeProc(0, `Session ID: ${sid}\nDone.`));
      sandbox.stub(gitExec, 'execAsync').resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      sandbox.stub(gitRepo, 'commit').resolves(true);
      const cbs = { onProcessSpawned: sandbox.stub(), onSessionCaptured: sandbox.stub(), onProcessExited: sandbox.stub() };
      const logger = makeLogger();
      const delegator = new AgentDelegator(logger, mockGitOps, cbs);
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
      spawnStub.returns(makeFakeProc(0, '', `session: ${sid}`));
      sandbox.stub(gitExec, 'execAsync').resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      sandbox.stub(gitRepo, 'commit').resolves(true);
      const logger = makeLogger();
      const delegator = new AgentDelegator(logger, mockGitOps);
      const result = await delegator.delegate(makeOpts(tmpDir));
      assert.strictEqual(result.sessionId, sid);
    });

    test('handles non-zero exit code', async () => {
      const tmpDir = makeTmpDir();
      sandbox.stub(cliCheck, 'isCopilotCliAvailable').returns(true);
      spawnStub.returns(makeFakeProc(1, '', 'error'));
      sandbox.stub(gitExec, 'execAsync').resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      sandbox.stub(gitRepo, 'commit').resolves(true);
      const logger = makeLogger();
      const delegator = new AgentDelegator(logger, mockGitOps);
      const result = await delegator.delegate(makeOpts(tmpDir));
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('exited with code 1'));
    });

    test('handles process error event', async () => {
      const tmpDir = makeTmpDir();
      sandbox.stub(cliCheck, 'isCopilotCliAvailable').returns(true);
      spawnStub.returns(makeFakeErrorProc(new Error('spawn failed')));
      sandbox.stub(gitExec, 'execAsync').resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      sandbox.stub(gitRepo, 'commit').resolves(true);
      const logger = makeLogger();
      const delegator = new AgentDelegator(logger, mockGitOps);
      const result = await delegator.delegate(makeOpts(tmpDir));
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('spawn failed'));
    });

    test('resumes existing session', async () => {
      const tmpDir = makeTmpDir();
      sandbox.stub(cliCheck, 'isCopilotCliAvailable').returns(true);
      const sid = 'c3d4e5f6-a7b8-9012-cdef-123456789012';
      spawnStub.returns(makeFakeProc(0, 'done'));
      sandbox.stub(gitExec, 'execAsync').resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      sandbox.stub(gitRepo, 'commit').resolves(true);
      const logger = makeLogger();
      const delegator = new AgentDelegator(logger, mockGitOps);
      const result = await delegator.delegate({ ...makeOpts(tmpDir), sessionId: sid });
      assert.strictEqual(result.sessionId, sid);
    });

    test('extracts session from share file', async () => {
      const tmpDir = makeTmpDir();
      sandbox.stub(cliCheck, 'isCopilotCliAvailable').returns(true);
      const sid = 'd4e5f6a7-b8c9-0123-defa-234567890123';
      spawnStub.returns(makeFakeProc(0, 'no session'));
      const copilotDir = path.join(tmpDir, '.copilot-orchestrator');
      fs.mkdirSync(path.join(copilotDir, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(copilotDir, 'session-work.md'), `Session ID: ${sid}\nContent`);
      sandbox.stub(gitExec, 'execAsync').resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      sandbox.stub(gitRepo, 'commit').resolves(true);
      const logger = makeLogger();
      const delegator = new AgentDelegator(logger, mockGitOps);
      const result = await delegator.delegate(makeOpts(tmpDir));
      assert.strictEqual(result.sessionId, sid);
    });

    test('extracts session from log filename', async () => {
      const tmpDir = makeTmpDir();
      sandbox.stub(cliCheck, 'isCopilotCliAvailable').returns(true);
      const sid = 'e5f6a7b8-c9d0-1234-efab-345678901234';
      spawnStub.returns(makeFakeProc(0, 'no session'));
      const logDir = path.join(tmpDir, '.copilot-orchestrator', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, `copilot-2024-01-01-${sid}.log`), 'log');
      sandbox.stub(gitExec, 'execAsync').resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      sandbox.stub(gitRepo, 'commit').resolves(true);
      const logger = makeLogger();
      const delegator = new AgentDelegator(logger, mockGitOps);
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
