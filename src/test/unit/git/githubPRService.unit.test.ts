/**
 * @fileoverview Unit tests for GitHubPRService.
 * 
 * Tests gh CLI integration, credential handling, and PR operations for GitHub/GitHub Enterprise.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { GitHubPRService } from '../../../git/remotePR/githubPRService';
import type { IProcessSpawner } from '../../../interfaces/IProcessSpawner';
import type { IRemoteProviderDetector } from '../../../interfaces/IRemoteProviderDetector';
import type { RemoteProviderInfo, RemoteCredentials } from '../../../plan/types/remotePR';
import { EventEmitter } from 'events';

suite('GitHubPRService', () => {
  let sandbox: sinon.SinonSandbox;
  let mockSpawner: IProcessSpawner;
  let mockDetector: IRemoteProviderDetector;
  let service: GitHubPRService;

  const githubProvider: RemoteProviderInfo = {
    type: 'github',
    remoteUrl: 'https://github.com/microsoft/vscode.git',
    owner: 'microsoft',
    repoName: 'vscode',
  };

  const gheProvider: RemoteProviderInfo = {
    type: 'github-enterprise',
    remoteUrl: 'https://mygithub.company.com/corp/app.git',
    hostname: 'mygithub.company.com',
    owner: 'corp',
    repoName: 'app',
  };

  const credentials: RemoteCredentials = {
    token: 'gho_test_token',
    tokenSource: 'gh-auth',
    hostname: 'github.com',
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    
    mockSpawner = {
      spawn: sandbox.stub(),
    } as any;
    
    mockDetector = {
      detect: sandbox.stub().resolves(githubProvider),
      acquireCredentials: sandbox.stub().resolves(credentials),
    } as any;
    
    service = new GitHubPRService(mockSpawner, mockDetector);
  });

  teardown(() => {
    sandbox.restore();
  });

  /**
   * Helper to create a mock process with stdout/stderr and exit event.
   */
  function makeMockProcess(stdout: string, stderr: string, exitCode: number): any {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    
    setImmediate(() => {
      if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
      proc.emit('close', exitCode);
    });
    
    return proc;
  }

  suite('createPR', () => {
    test('calls gh pr create with correct args', async () => {
      const mockProc = makeMockProcess('{"number":42,"url":"https://github.com/microsoft/vscode/pull/42"}', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      const result = await service.createPR({
        baseBranch: 'main',
        headBranch: 'feature-branch',
        title: 'Add feature',
        body: 'This adds a feature',
        cwd: '/repo/path',
      });

      assert.strictEqual(result.prNumber, 42);
      assert.strictEqual(result.prUrl, 'https://github.com/microsoft/vscode/pull/42');
      
      const spawnCall = (mockSpawner.spawn as sinon.SinonStub).getCall(0);
      assert.strictEqual(spawnCall.args[0], 'gh');
      assert.deepStrictEqual(spawnCall.args[1], [
        'pr', 'create',
        '--base', 'main',
        '--head', 'feature-branch',
        '--title', 'Add feature',
        '--body', 'This adds a feature',
        '--json', 'number,url',
      ]);
    });

    test('sets GH_TOKEN env var not CLI arg', async () => {
      const mockProc = makeMockProcess('{"number":1,"url":"https://github.com/microsoft/vscode/pull/1"}', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      await service.createPR({
        baseBranch: 'main',
        headBranch: 'fix',
        title: 'Fix',
        body: 'Body',
        cwd: '/repo',
      });

      const spawnCall = (mockSpawner.spawn as sinon.SinonStub).getCall(0);
      const env = spawnCall.args[2].env;
      
      // Token must be in env
      assert.strictEqual(env.GH_TOKEN, 'gho_test_token');
      
      // Token must NOT be in args
      const args = spawnCall.args[1];
      assert.ok(!args.includes('gho_test_token'));
      assert.ok(!args.some((arg: string) => arg.includes('token')));
    });

    test('sets GH_HOST for GHE', async () => {
      (mockDetector.detect as sinon.SinonStub).resolves(gheProvider);
      (mockDetector.acquireCredentials as sinon.SinonStub).resolves({
        token: 'gho_enterprise_token',
        tokenSource: 'gh-auth',
        hostname: 'mygithub.company.com',
      });

      const mockProc = makeMockProcess('{"number":1,"url":"https://github.company.com/corp/app/pull/1"}', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      await service.createPR({
        baseBranch: 'main',
        headBranch: 'feature',
        title: 'Feature',
        body: 'Body',
        cwd: '/repo',
      });

      const spawnCall = (mockSpawner.spawn as sinon.SinonStub).getCall(0);
      const env = spawnCall.args[2].env;
      
      assert.strictEqual(env.GH_HOST, 'mygithub.company.com');
      assert.strictEqual(env.GH_TOKEN, 'gho_enterprise_token');
    });
  });

  suite('getPRChecks', () => {
    test('parses gh output, maps states', async () => {
      // The new implementation makes 3 API calls:
      // 1. GET repos/{owner}/{repo}/pulls/{prNumber}  → { head: { sha } }
      // 2. GET repos/{owner}/{repo}/commits/{sha}/check-runs → { check_runs: [...] }
      // 3. GET repos/{owner}/{repo}/commits/{sha}/statuses  → [] (optional)
      let callCount = 0;
      (mockSpawner.spawn as sinon.SinonStub).callsFake(() => {
        callCount++;
        if (callCount === 1) {
          // PR detail — return head SHA
          return makeMockProcess(JSON.stringify({ head: { sha: 'deadbeef' } }), '', 0);
        }
        if (callCount === 2) {
          // Check-runs
          return makeMockProcess(JSON.stringify({
            check_runs: [
              { name: 'CI / build', conclusion: 'success', html_url: 'https://github.com/actions/1' },
              { name: 'CodeQL', conclusion: 'failure', html_url: 'https://github.com/actions/2' },
              { name: 'Lint', status: 'in_progress', conclusion: null, html_url: 'https://github.com/actions/3' },
            ],
          }), '', 0);
        }
        // Statuses (3rd call) — return empty array
        return makeMockProcess(JSON.stringify([]), '', 0);
      });

      const checks = await service.getPRChecks(42, '/repo');

      assert.strictEqual(checks.length, 3);

      assert.strictEqual(checks[0].name, 'CI / build');
      assert.strictEqual(checks[0].status, 'passing');

      assert.strictEqual(checks[1].name, 'CodeQL');
      assert.strictEqual(checks[1].status, 'failing');

      assert.strictEqual(checks[2].name, 'Lint');
      assert.strictEqual(checks[2].status, 'pending');
    });
  });

  suite('getPRComments', () => {
    test('returns one entry per thread with replies', async () => {
      let callCount = 0;
      (mockSpawner.spawn as sinon.SinonStub).callsFake((cmd: string, args: string[]) => {
        callCount++;
        
        // First call: review comments via GraphQL — thread with 2 comments
        if (callCount === 1) {
          return makeMockProcess(JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [{
                      id: 'PRRT_abc123',
                      isResolved: false,
                      comments: {
                        nodes: [
                          { databaseId: 1, author: { login: 'alice' }, body: 'Review comment', path: 'src/file.ts', line: 42 },
                          { databaseId: 4, author: { login: 'bob' }, body: 'I agree with Alice', path: 'src/file.ts', line: 42 },
                        ],
                      },
                    }],
                  },
                },
              },
            },
          }), '', 0);
        }
        
        // Second call: reviews
        if (callCount === 2) {
          return makeMockProcess(JSON.stringify([
            { id: 2, user: { login: 'bob' }, body: 'Approved', state: 'APPROVED' },
          ]), '', 0);
        }
        
        // Third call: issue comments
        return makeMockProcess(JSON.stringify([
          { id: 3, user: { login: 'carol' }, body: 'General comment' },
        ]), '', 0);
      });

      const comments = await service.getPRComments(42, '/repo');

      // Thread with 2 comments → 1 root entry + reviews + issue = 3 entries
      assert.strictEqual(comments.length, 3);
      const threadComment = comments.find(c => c.id === '1');
      assert.ok(threadComment);
      assert.strictEqual(threadComment!.author, 'alice');
      assert.strictEqual(threadComment!.replies?.length, 1);
      assert.strictEqual(threadComment!.replies![0].author, 'bob');
      assert.strictEqual(threadComment!.replies![0].body, 'I agree with Alice');
    });

    test('returns isResolved and GraphQL threadId from review threads', async () => {
      let callCount = 0;
      (mockSpawner.spawn as sinon.SinonStub).callsFake(() => {
        callCount++;

        if (callCount === 1) {
          return makeMockProcess(JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        id: 'PRRT_resolved',
                        isResolved: true,
                        comments: { nodes: [{ databaseId: 10, url: 'https://github.com/o/r/pull/42#discussion_r10', author: { login: 'alice' }, body: 'Fixed', path: 'a.ts', line: 1 }] },
                      },
                      {
                        id: 'PRRT_open',
                        isResolved: false,
                        comments: { nodes: [{ databaseId: 20, author: { login: 'bob' }, body: 'Bug', path: 'b.ts', line: 5 }] },
                      },
                    ],
                  },
                },
              },
            },
          }), '', 0);
        }

        // reviews and issue comments empty
        return makeMockProcess(JSON.stringify([]), '', 0);
      });

      const comments = await service.getPRComments(42, '/repo');

      const resolved = comments.find(c => c.id === '10');
      const open = comments.find(c => c.id === '20');

      assert.strictEqual(resolved?.isResolved, true);
      assert.strictEqual(resolved?.threadId, 'PRRT_resolved');
      assert.strictEqual(resolved?.url, 'https://github.com/o/r/pull/42#discussion_r10');
      assert.strictEqual(open?.isResolved, false);
      assert.strictEqual(open?.threadId, 'PRRT_open');
      assert.strictEqual(open?.url, undefined);
    });

    test('categorizes bot/copilot/codeql', async () => {
      let callCount = 0;
      (mockSpawner.spawn as sinon.SinonStub).callsFake(() => {
        callCount++;
        
        if (callCount === 1) {
          return makeMockProcess(JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [{
                      id: 'PRRT_bot',
                      isResolved: false,
                      comments: {
                        nodes: [
                          { databaseId: 1, author: { login: 'github-actions[bot]' }, body: 'Bot comment', path: 'file.ts', line: 1 },
                        ],
                      },
                    }],
                  },
                },
              },
            },
          }), '', 0);
        }
        
        if (callCount === 2) {
          return makeMockProcess(JSON.stringify([
            { id: 2, user: { login: 'copilot' }, body: 'Copilot suggestion' },
          ]), '', 0);
        }
        
        return makeMockProcess(JSON.stringify([
          { id: 3, user: { login: 'codeql' }, body: 'Security issue' },
        ]), '', 0);
      });

      const comments = await service.getPRComments(42, '/repo');

      const botComment = comments.find(c => c.id === '1');
      const copilotComment = comments.find(c => c.id === '2');
      const codeqlComment = comments.find(c => c.id === '3');
      
      assert.strictEqual(botComment?.source, 'bot');
      assert.strictEqual(copilotComment?.source, 'copilot');
      assert.strictEqual(codeqlComment?.source, 'codeql');
    });
  });

  suite('getSecurityAlerts', () => {
    test('returns empty on 404', async () => {
      const mockProc = makeMockProcess('', 'HTTP 404: Not Found', 1);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      const alerts = await service.getSecurityAlerts('main', '/repo');

      assert.strictEqual(alerts.length, 0);
    });
  });

  suite('replyToComment', () => {
    test('posts via gh api', async () => {
      const mockProc = makeMockProcess('{"id":999}', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      await service.replyToComment(42, '123', 'My reply', '/repo');

      const spawnCall = (mockSpawner.spawn as sinon.SinonStub).getCall(0);
      assert.strictEqual(spawnCall.args[0], 'gh');
      assert.ok(spawnCall.args[1].includes('api'));
      assert.ok(spawnCall.args[1].some((arg: string) => arg.includes('body=My reply')));
      assert.ok(spawnCall.args[1].some((arg: string) => arg.includes('in_reply_to=123')));
    });
  });

  suite('resolveThread', () => {
    test('uses graphql mutation', async () => {
      const mockProc = makeMockProcess('{"data":{"resolveReviewThread":{"thread":{"id":"123"}}}}', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      await service.resolveThread(42, 'PRRT_abc123', '/repo');

      const spawnCall = (mockSpawner.spawn as sinon.SinonStub).getCall(0);
      assert.strictEqual(spawnCall.args[0], 'gh');
      assert.ok(spawnCall.args[1].includes('api'));
      assert.ok(spawnCall.args[1].includes('graphql'));
      assert.ok(spawnCall.args[1].some((arg: string) => arg.includes('resolveReviewThread')));
    });

    test('rejects invalid threadId to prevent injection', async () => {
      await assert.rejects(
        () => service.resolveThread(42, 'bad"}) { x }', '/repo'),
        /Invalid threadId format/,
      );
    });
  });
});
