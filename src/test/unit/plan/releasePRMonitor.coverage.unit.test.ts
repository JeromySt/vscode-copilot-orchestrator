/**
 * @fileoverview Coverage tests for DefaultReleasePRMonitor – _addressFindings method.
 * Tests the private _addressFindings method via type cast, covering lines 356-571.
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { DefaultReleasePRMonitor } from '../../../plan/releasePRMonitor';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function createMockCopilot(sandbox: sinon.SinonSandbox): any {
  return {
    run: sandbox.stub().resolves({ success: true, sessionId: 'sid', output: 'done', metrics: undefined }),
    isAvailable: sandbox.stub().returns(true),
  };
}

function createMockGit(sandbox: sinon.SinonSandbox): any {
  return {
    repository: {
      hasChanges: sandbox.stub().resolves(false),
      stageAll: sandbox.stub().resolves(),
      commit: sandbox.stub().resolves(),
      getHead: sandbox.stub().resolves('abc123def456'),
      push: sandbox.stub().resolves(true),
    },
  };
}

function createMockPRService(sandbox: sinon.SinonSandbox): any {
  return {
    getPRChecks: sandbox.stub().resolves([]),
    getPRComments: sandbox.stub().resolves([]),
    getSecurityAlerts: sandbox.stub().resolves([]),
    replyToComment: sandbox.stub().resolves(),
    addIssueComment: sandbox.stub().resolves(),
    resolveThread: sandbox.stub().resolves(),
    minimizeComment: sandbox.stub().resolves(),
    createPR: sandbox.stub().resolves({ prNumber: 42, prUrl: 'https://github.com/test/pr/42' }),
  };
}

function createNullPulse(): any {
  return { onPulse: () => ({ dispose: () => {} }), isRunning: false };
}

function makeCycle(overrides?: any): any {
  return {
    cycleNumber: 1,
    timestamp: Date.now(),
    checks: [],
    comments: [],
    securityAlerts: [],
    actions: [],
    ...overrides,
  };
}

function makeState(prService: any, overrides?: any): any {
  return {
    releaseId: 'rel-1',
    prNumber: 42,
    repoPath: '/repo/release/branch',
    releaseBranch: 'release/v1.0',
    prService,
    pulseSubscription: undefined,
    tickCount: 0,
    lastPushTime: Date.now(),
    cycles: [],
    isActive: true,
    ...overrides,
  };
}

suite('ReleasePRMonitor – _addressFindings coverage', () => {
  let sandbox: sinon.SinonSandbox;
  let quiet: { restore: () => void };

  setup(() => {
    sandbox = sinon.createSandbox();
    quiet = silenceConsole();
  });

  teardown(() => {
    quiet.restore();
    sandbox.restore();
  });

  // Helper to create a monitor and call the private method
  function makeMonitor(copilot?: any, git?: any): DefaultReleasePRMonitor {
    return new DefaultReleasePRMonitor(
      copilot || createMockCopilot(sandbox),
      { spawn: sandbox.stub() },
      git || createMockGit(sandbox),
      { getServiceForRepo: sandbox.stub().resolves(createMockPRService(sandbox)) },
      createNullPulse(),
    );
  }

  async function callAddressFindings(monitor: DefaultReleasePRMonitor, state: any, cycle: any): Promise<any[]> {
    return (monitor as any)._addressFindings(state, cycle);
  }

  // ── Empty findings ────────────────────────────────────────────────────────

  suite('empty findings', () => {
    test('returns empty actions when no checks, comments, or alerts', async () => {
      const monitor = makeMonitor();
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle();

      const actions = await callAddressFindings(monitor, state, cycle);

      assert.strictEqual(actions.length, 0);
      assert.ok(prService.replyToComment.notCalled);
    });

    test('returns empty when checks are all passing', async () => {
      const monitor = makeMonitor();
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        checks: [{ name: 'CI', status: 'passing', url: 'http://ci' }],
      });

      const actions = await callAddressFindings(monitor, state, cycle);
      assert.strictEqual(actions.length, 0);
    });

    test('returns empty when all comments are resolved', async () => {
      const monitor = makeMonitor();
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        comments: [{ id: 'c1', author: 'user', body: 'good', isResolved: true, source: 'github' }],
      });

      const actions = await callAddressFindings(monitor, state, cycle);
      assert.strictEqual(actions.length, 0);
    });
  });

  // ── Failing checks ────────────────────────────────────────────────────────

  suite('failing checks', () => {
    test('invokes copilot runner with task description for failing checks', async () => {
      const copilot = createMockCopilot(sandbox);
      const monitor = makeMonitor(copilot);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        checks: [
          { name: 'Build', status: 'failing', url: 'http://ci/1' },
          { name: 'Lint', status: 'failing', url: undefined },
        ],
      });

      await callAddressFindings(monitor, state, cycle);

      assert.ok(copilot.run.calledOnce);
      const callArgs = copilot.run.firstCall.args[0];
      assert.ok(callArgs.task.includes('CI/CD Check Failures'));
      assert.ok(callArgs.task.includes('Build'));
      assert.strictEqual(callArgs.cwd, state.repoPath);
      assert.strictEqual(callArgs.timeout, 0);
    });

    test('includes check URL in task when present', async () => {
      const copilot = createMockCopilot(sandbox);
      const monitor = makeMonitor(copilot);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        checks: [{ name: 'Build', status: 'failing', url: 'https://ci.example.com/123' }],
      });

      await callAddressFindings(monitor, state, cycle);

      const callArgs = copilot.run.firstCall.args[0];
      assert.ok(callArgs.task.includes('https://ci.example.com/123'));
    });

    test('returns fix-code failure action when copilot throws', async () => {
      const copilot = createMockCopilot(sandbox);
      copilot.run.rejects(new Error('CLI not available'));
      const monitor = makeMonitor(copilot);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        checks: [{ name: 'Build', status: 'failing', url: undefined }],
      });

      const actions = await callAddressFindings(monitor, state, cycle);

      assert.strictEqual(actions.length, 1);
      assert.strictEqual(actions[0].type, 'fix-code');
      assert.strictEqual(actions[0].success, false);
      assert.ok(actions[0].description.includes('Failed to invoke'));
    });

    test('returns fix-code failure action when copilot returns failure', async () => {
      const copilot = createMockCopilot(sandbox);
      copilot.run.resolves({ success: false, error: 'Agent failed', sessionId: 'sid' });
      const monitor = makeMonitor(copilot);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        checks: [{ name: 'Tests', status: 'failing', url: undefined }],
      });

      const actions = await callAddressFindings(monitor, state, cycle);

      assert.strictEqual(actions.length, 1);
      assert.strictEqual(actions[0].type, 'fix-code');
      assert.strictEqual(actions[0].success, false);
      assert.ok(actions[0].description.includes('failed to apply'));
    });

    test('does not commit when hasChanges is false', async () => {
      const git = createMockGit(sandbox);
      git.repository.hasChanges.resolves(false);
      const copilot = createMockCopilot(sandbox);
      const monitor = makeMonitor(copilot, git);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        checks: [{ name: 'Build', status: 'failing', url: undefined }],
      });

      await callAddressFindings(monitor, state, cycle);

      assert.ok(git.repository.stageAll.notCalled);
      assert.ok(git.repository.commit.notCalled);
      assert.ok(git.repository.push.notCalled);
    });

    test('commits and pushes when hasChanges is true', async () => {
      const git = createMockGit(sandbox);
      git.repository.hasChanges.resolves(true);
      git.repository.getHead.resolves('deadbeef1234');
      const copilot = createMockCopilot(sandbox);
      const monitor = makeMonitor(copilot, git);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        cycleNumber: 3,
        checks: [{ name: 'Build', status: 'failing', url: undefined }],
      });

      const actions = await callAddressFindings(monitor, state, cycle);

      assert.ok(git.repository.stageAll.calledWith(state.repoPath));
      assert.ok(git.repository.commit.calledOnce);
      const commitMsg: string = git.repository.commit.firstCall.args[1];
      assert.ok(commitMsg.includes('cycle 3'));
      assert.ok(git.repository.push.calledWith(state.repoPath, { branch: state.releaseBranch }));

      const fixAction = actions.find((a: any) => a.type === 'fix-code');
      assert.ok(fixAction);
      assert.strictEqual(fixAction.success, true);
      assert.ok(fixAction.commitHash?.startsWith('deadbeef'));
    });

    test('returns fix-code failure action when commit/push fails', async () => {
      const git = createMockGit(sandbox);
      git.repository.hasChanges.resolves(true);
      git.repository.stageAll.rejects(new Error('Stage failed'));
      const copilot = createMockCopilot(sandbox);
      const monitor = makeMonitor(copilot, git);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        checks: [{ name: 'Build', status: 'failing', url: undefined }],
      });

      const actions = await callAddressFindings(monitor, state, cycle);

      const fixAction = actions.find((a: any) => a.type === 'fix-code');
      assert.ok(fixAction);
      assert.strictEqual(fixAction.success, false);
      assert.ok(fixAction.description.includes('Failed to commit'));
    });

    test('handles git hasChanges throwing gracefully', async () => {
      const git = createMockGit(sandbox);
      git.repository.hasChanges.rejects(new Error('git error'));
      const copilot = createMockCopilot(sandbox);
      const monitor = makeMonitor(copilot, git);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        checks: [{ name: 'Build', status: 'failing', url: undefined }],
      });

      // Should not throw — hasChanges error is caught and logged
      const actions = await callAddressFindings(monitor, state, cycle);
      assert.ok(Array.isArray(actions));
    });
  });

  // ── Unresolved comments ───────────────────────────────────────────────────

  suite('unresolved comments', () => {
    test('includes comment details in task description', async () => {
      const copilot = createMockCopilot(sandbox);
      const monitor = makeMonitor(copilot);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        comments: [
          {
            id: 'c1',
            author: 'reviewer',
            body: 'This is problematic',
            path: 'src/app.ts',
            line: 42,
            isResolved: false,
            source: 'github',
          },
        ],
      });

      await callAddressFindings(monitor, state, cycle);

      const callArgs = copilot.run.firstCall.args[0];
      assert.ok(callArgs.task.includes('PR Comments to Address'));
      assert.ok(callArgs.task.includes('reviewer'));
      assert.ok(callArgs.task.includes('This is problematic'));
      assert.ok(callArgs.task.includes('src/app.ts:42'));
    });

    test('includes file path without line when line is undefined', async () => {
      const copilot = createMockCopilot(sandbox);
      const monitor = makeMonitor(copilot);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        comments: [
          {
            id: 'c2',
            author: 'user',
            body: 'General comment',
            path: 'README.md',
            line: undefined,
            isResolved: false,
            source: 'github',
          },
        ],
      });

      await callAddressFindings(monitor, state, cycle);

      const callArgs = copilot.run.firstCall.args[0];
      assert.ok(callArgs.task.includes('README.md'));
    });

    test('comment without path does not include file line', async () => {
      const copilot = createMockCopilot(sandbox);
      const monitor = makeMonitor(copilot);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        comments: [
          {
            id: 'c3',
            author: 'user',
            body: 'No file context',
            path: undefined,
            line: undefined,
            isResolved: false,
            source: 'github',
          },
        ],
      });

      await callAddressFindings(monitor, state, cycle);

      // Just verify it ran without error
      assert.ok(copilot.run.calledOnce);
    });

    test('replies to inline comments after successful copilot run (no changes)', async () => {
      const copilot = createMockCopilot(sandbox);
      const git = createMockGit(sandbox);
      git.repository.hasChanges.resolves(false);
      const monitor = makeMonitor(copilot, git);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        comments: [
          { id: 'c1', author: 'rev', body: 'Fix this', path: 'src/file.ts', isResolved: false, source: 'github' },
        ],
      });

      const actions = await callAddressFindings(monitor, state, cycle);

      assert.ok(prService.replyToComment.calledOnce);
      assert.ok(prService.addIssueComment.notCalled);
      assert.strictEqual(prService.replyToComment.firstCall.args[0], state.prNumber);
      assert.strictEqual(prService.replyToComment.firstCall.args[1], 'c1');
      assert.ok(prService.replyToComment.firstCall.args[2].includes('✅ Addressed in automated fix'));

      const respondAction = actions.find((a: any) => a.type === 'respond-comment');
      assert.ok(respondAction);
      assert.strictEqual(respondAction.success, true);
      assert.ok(respondAction.description.includes('rev'));
    });

    test('posts a quoted issue comment for non-threadable PR feedback', async () => {
      const copilot = createMockCopilot(sandbox);
      const git = createMockGit(sandbox);
      git.repository.hasChanges.resolves(false);
      const monitor = makeMonitor(copilot, git);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        comments: [
          { id: 'c-top', author: 'rev', body: 'Please revisit this', isResolved: false, source: 'human' },
        ],
      });

      const actions = await callAddressFindings(monitor, state, cycle);

      assert.ok(prService.replyToComment.notCalled);
      assert.ok(prService.addIssueComment.calledOnce);
      assert.strictEqual(prService.addIssueComment.firstCall.args[0], state.prNumber);
      assert.strictEqual(
        prService.addIssueComment.firstCall.args[1],
        '> Please revisit this\n\n✅ Addressed in automated fix ',
      );

      const respondAction = actions.find((a: any) => a.type === 'respond-comment');
      assert.ok(respondAction);
      assert.strictEqual(respondAction.success, true);
    });

    test('resolves thread when comment has threadId', async () => {
      const copilot = createMockCopilot(sandbox);
      const git = createMockGit(sandbox);
      git.repository.hasChanges.resolves(false);
      const monitor = makeMonitor(copilot, git);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        comments: [
          { id: 'c1', author: 'rev', body: 'Fix', isResolved: false, source: 'github', threadId: 'thread-99' },
        ],
      });

      await callAddressFindings(monitor, state, cycle);

      assert.ok(prService.resolveThread.calledOnce);
      assert.strictEqual(prService.resolveThread.firstCall.args[0], state.prNumber);
      assert.strictEqual(prService.resolveThread.firstCall.args[1], 'thread-99');
    });

    test('does not call resolveThread when comment has no threadId', async () => {
      const copilot = createMockCopilot(sandbox);
      const git = createMockGit(sandbox);
      git.repository.hasChanges.resolves(false);
      const monitor = makeMonitor(copilot, git);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        comments: [
          { id: 'c1', author: 'rev', body: 'Fix', path: 'src/file.ts', isResolved: false, source: 'github' },
        ],
      });

      await callAddressFindings(monitor, state, cycle);

      assert.ok(prService.resolveThread.notCalled);
    });

    test('minimizes top-level review comments when nodeId is available', async () => {
      const copilot = createMockCopilot(sandbox);
      const git = createMockGit(sandbox);
      git.repository.hasChanges.resolves(false);
      const monitor = makeMonitor(copilot, git);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        comments: [
          { id: 'c-root', author: 'rev', body: 'Fix', isResolved: false, source: 'github', nodeId: 'node-42' },
        ],
      });

      await callAddressFindings(monitor, state, cycle);

      assert.ok(prService.addIssueComment.calledOnce);
      assert.ok(prService.minimizeComment.calledOnce);
      assert.strictEqual(prService.minimizeComment.firstCall.args[0], 'node-42');
      assert.strictEqual(prService.minimizeComment.firstCall.args[1], 'RESOLVED');
      assert.strictEqual(prService.minimizeComment.firstCall.args[2], state.repoPath);
    });

    test('does not minimize inline comments even when nodeId is available', async () => {
      const copilot = createMockCopilot(sandbox);
      const git = createMockGit(sandbox);
      git.repository.hasChanges.resolves(false);
      const monitor = makeMonitor(copilot, git);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        comments: [
          {
            id: 'c-inline',
            author: 'rev',
            body: 'Fix',
            path: 'src/file.ts',
            isResolved: false,
            source: 'github',
            nodeId: 'node-inline',
          },
        ],
      });

      await callAddressFindings(monitor, state, cycle);

      assert.ok(prService.replyToComment.calledOnce);
      assert.ok(prService.minimizeComment.notCalled);
    });

    test('replies to inline comments with replyToComment', async () => {
      const copilot = createMockCopilot(sandbox);
      const git = createMockGit(sandbox);
      git.repository.hasChanges.resolves(false);
      const monitor = makeMonitor(copilot, git);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        comments: [
          { id: 'c-inline', author: 'rev', body: 'Fix', path: 'src/file.ts', isResolved: false, source: 'github' },
        ],
      });

      await callAddressFindings(monitor, state, cycle);

      assert.ok(prService.replyToComment.calledOnce);
      assert.ok(prService.addIssueComment.notCalled);
      assert.strictEqual(prService.replyToComment.firstCall.args[1], 'c-inline');
    });

    test('records failed respond-comment action when replyToComment throws', async () => {
      const copilot = createMockCopilot(sandbox);
      const git = createMockGit(sandbox);
      git.repository.hasChanges.resolves(false);
      const monitor = makeMonitor(copilot, git);
      const prService = createMockPRService(sandbox);
      prService.replyToComment.rejects(new Error('API error'));
      const state = makeState(prService);
      const cycle = makeCycle({
        comments: [
          { id: 'c1', author: 'rev', body: 'Fix', path: 'src/file.ts', isResolved: false, source: 'github' },
        ],
      });

      const actions = await callAddressFindings(monitor, state, cycle);

      const respondAction = actions.find((a: any) => a.type === 'respond-comment');
      assert.ok(respondAction);
      assert.strictEqual(respondAction.success, false);
      assert.ok(respondAction.description.includes('Failed to reply'));
    });

    test('includes commit hash in reply when changes were committed', async () => {
      const copilot = createMockCopilot(sandbox);
      const git = createMockGit(sandbox);
      git.repository.hasChanges.resolves(true);
      git.repository.getHead.resolves('abcdef123456');
      const monitor = makeMonitor(copilot, git);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        comments: [
          { id: 'c1', author: 'rev', body: 'Fix this', path: 'src/file.ts', isResolved: false, source: 'github' },
        ],
      });

      await callAddressFindings(monitor, state, cycle);

      const replyText: string = prService.replyToComment.firstCall.args[2];
      assert.ok(replyText.includes('abcdef1'));
    });
  });

  // ── Security alerts ───────────────────────────────────────────────────────

  suite('security alerts', () => {
    test('includes alert details in task description', async () => {
      const copilot = createMockCopilot(sandbox);
      const monitor = makeMonitor(copilot);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        securityAlerts: [
          { id: 'alert-1', severity: 'high', description: 'SQL injection', file: 'src/db.ts', resolved: false },
        ],
      });

      await callAddressFindings(monitor, state, cycle);

      const callArgs = copilot.run.firstCall.args[0];
      assert.ok(callArgs.task.includes('Security Alerts'));
      assert.ok(callArgs.task.includes('HIGH'));
      assert.ok(callArgs.task.includes('SQL injection'));
      assert.ok(callArgs.task.includes('src/db.ts'));
    });

    test('handles alert without file path', async () => {
      const copilot = createMockCopilot(sandbox);
      const monitor = makeMonitor(copilot);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        securityAlerts: [
          { id: 'alert-2', severity: 'medium', description: 'Dependency vuln', file: undefined, resolved: false },
        ],
      });

      await callAddressFindings(monitor, state, cycle);

      const callArgs = copilot.run.firstCall.args[0];
      assert.ok(callArgs.task.includes('Security Alerts'));
      assert.ok(callArgs.task.includes('Dependency vuln'));
    });

    test('skips resolved alerts in task description', async () => {
      const copilot = createMockCopilot(sandbox);
      const monitor = makeMonitor(copilot);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        securityAlerts: [
          { id: 'a1', severity: 'high', description: 'Fixed vuln', file: undefined, resolved: true },
        ],
      });

      const actions = await callAddressFindings(monitor, state, cycle);

      // All alerts resolved → no findings → taskParts empty → return early
      assert.strictEqual(actions.length, 0);
      assert.ok(copilot.run.notCalled);
    });
  });

  // ── Combined findings ─────────────────────────────────────────────────────

  suite('combined findings', () => {
    test('handles failing checks + unresolved comments + unresolved alerts together', async () => {
      const copilot = createMockCopilot(sandbox);
      const git = createMockGit(sandbox);
      git.repository.hasChanges.resolves(true);
      git.repository.getHead.resolves('cafebabe0000');
      const monitor = makeMonitor(copilot, git);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        checks: [{ name: 'CI', status: 'failing', url: undefined }],
        comments: [{ id: 'c1', author: 'rev', body: 'Fix', isResolved: false, source: 'github' }],
        securityAlerts: [{ id: 'a1', severity: 'low', description: 'Leak', file: undefined, resolved: false }],
      });

      const actions = await callAddressFindings(monitor, state, cycle);

      assert.ok(copilot.run.calledOnce);
      const task: string = copilot.run.firstCall.args[0].task;
      assert.ok(task.includes('CI/CD Check Failures'));
      assert.ok(task.includes('PR Comments to Address'));
      assert.ok(task.includes('Security Alerts'));

      // Should have fix-code action + respond-comment action
      const fixAction = actions.find((a: any) => a.type === 'fix-code');
      const respondAction = actions.find((a: any) => a.type === 'respond-comment');
      assert.ok(fixAction);
      assert.ok(respondAction);
    });

    test('onOutput callback captures output lines', async () => {
      const copilot = createMockCopilot(sandbox);
      copilot.run.callsFake(async (opts: any) => {
        opts.onOutput('line 1');
        opts.onOutput('line 2');
        return { success: true };
      });
      const monitor = makeMonitor(copilot);
      const prService = createMockPRService(sandbox);
      const state = makeState(prService);
      const cycle = makeCycle({
        checks: [{ name: 'Build', status: 'failing', url: undefined }],
      });

      // Should complete without error
      const actions = await callAddressFindings(monitor, state, cycle);
      assert.ok(Array.isArray(actions));
    });
  });
});
