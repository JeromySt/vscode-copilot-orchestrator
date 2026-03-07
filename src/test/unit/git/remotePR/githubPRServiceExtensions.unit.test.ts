/**
 * @fileoverview Unit tests for GitHubPRService extensions (listPRs, getPRDetails, abandonPR, promotePR, demotePR).
 *
 * Covers:
 * - listPRs: List PRs via gh CLI with filters, parse JSON output
 * - getPRDetails: Get PR details via gh CLI, parse response
 * - abandonPR: Close PR via gh CLI, optional comment
 * - promotePR: Mark draft PR ready via gh CLI
 * - demotePR: Convert PR to draft via GraphQL mutation
 * - All operations use GH_TOKEN env var authentication
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { GitHubPRService } from '../../../../git/remotePR/githubPRService';
import type { 
  RemoteProviderInfo, 
  RemoteCredentials,
  PRListOptions 
} from '../../../../plan/types/remotePR';

suite('GitHubPRService Extensions', () => {
  let sandbox: sinon.SinonSandbox;
  let mockSpawner: any;
  let mockDetector: any;
  let service: GitHubPRService;

  const mockProvider: RemoteProviderInfo = {
    type: 'github',
    owner: 'test-owner',
    repoName: 'test-repo',
    remoteUrl: 'https://github.com/test-owner/test-repo.git',
    hostname: 'github.com',
  };

  const mockCredentials: RemoteCredentials = {
    token: 'gh_token_123',
    tokenSource: 'environment',
  };

  setup(() => {
    sandbox = sinon.createSandbox();

    mockSpawner = {
      spawn: sandbox.stub(),
    };

    mockDetector = {
      detect: sandbox.stub().resolves(mockProvider),
      acquireCredentials: sandbox.stub().resolves(mockCredentials),
    };

    service = new GitHubPRService(mockSpawner, mockDetector);
  });

  teardown(() => {
    sandbox.restore();
  });

  // ── Helper to mock spawn success ──────────────────────────────────────

  function mockSpawnSuccess(output: string): void {
    const mockProcess: any = {
      stdout: {
        on: (event: string, handler: any) => {
          if (event === 'data') {
            handler(Buffer.from(output));
          }
        },
      },
      stderr: {
        on: (event: string, handler: any) => {},
      },
      on: (event: string, handler: any) => {
        if (event === 'close') {
          handler(0);
        }
      },
    };

    mockSpawner.spawn.returns(mockProcess);
  }

  function mockSpawnError(stderr: string, code: number = 1): void {
    const mockProcess: any = {
      stdout: {
        on: (event: string, handler: any) => {},
      },
      stderr: {
        on: (event: string, handler: any) => {
          if (event === 'data') {
            handler(Buffer.from(stderr));
          }
        },
      },
      on: (event: string, handler: any) => {
        if (event === 'close') {
          handler(code);
        }
      },
    };

    mockSpawner.spawn.returns(mockProcess);
  }

  // ── listPRs ────────────────────────────────────────────────────────────

  suite('listPRs', () => {
    test('should list PRs with default filters', async () => {
      const ghOutput = JSON.stringify([
        {
          number: 42,
          title: 'Test PR 1',
          headRefName: 'feature/test-1',
          baseRefName: 'main',
          state: 'OPEN',
          isDraft: false,
          author: { login: 'user1' },
          url: 'https://github.com/test-owner/test-repo/pull/42',
        },
        {
          number: 43,
          title: 'Test PR 2',
          headRefName: 'feature/test-2',
          baseRefName: 'main',
          state: 'OPEN',
          isDraft: true,
          author: { login: 'user2' },
          url: 'https://github.com/test-owner/test-repo/pull/43',
        },
      ]);

      mockSpawnSuccess(ghOutput);

      const result = await service.listPRs('/repo');

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].prNumber, 42);
      assert.strictEqual(result[0].title, 'Test PR 1');
      assert.strictEqual(result[0].headBranch, 'feature/test-1');
      assert.strictEqual(result[0].baseBranch, 'main');
      assert.strictEqual(result[0].state, 'open');
      assert.strictEqual(result[0].isDraft, false);
      assert.strictEqual(result[0].author, 'user1');
      assert.strictEqual(result[1].isDraft, true);

      // Verify spawn called with correct args
      const spawnArgs = mockSpawner.spawn.firstCall.args;
      assert.strictEqual(spawnArgs[0], 'gh');
      assert.ok(spawnArgs[1].includes('pr'));
      assert.ok(spawnArgs[1].includes('list'));
      assert.ok(spawnArgs[1].includes('--author'));
      assert.ok(spawnArgs[1].includes('@me'));

      // Verify GH_TOKEN in env
      const spawnEnv = spawnArgs[2]?.env;
      assert.strictEqual(spawnEnv?.GH_TOKEN, 'gh_token_123');
    });

    test('should filter by author', async () => {
      mockSpawnSuccess(JSON.stringify([]));

      const options: PRListOptions = {
        author: 'specific-user',
      };

      await service.listPRs('/repo', options);

      const spawnArgs = mockSpawner.spawn.firstCall.args;
      assert.ok(spawnArgs[1].includes('--author'));
      assert.ok(spawnArgs[1].includes('specific-user'));
    });

    test('should filter by assignee', async () => {
      mockSpawnSuccess(JSON.stringify([]));

      const options: PRListOptions = {
        assignee: 'assigned-user',
      };

      await service.listPRs('/repo', options);

      const spawnArgs = mockSpawner.spawn.firstCall.args;
      assert.ok(spawnArgs[1].includes('--assignee'));
      assert.ok(spawnArgs[1].includes('assigned-user'));
    });

    test('should filter by state', async () => {
      mockSpawnSuccess(JSON.stringify([]));

      const options: PRListOptions = {
        state: 'closed',
      };

      await service.listPRs('/repo', options);

      const spawnArgs = mockSpawner.spawn.firstCall.args;
      assert.ok(spawnArgs[1].includes('--state'));
      assert.ok(spawnArgs[1].includes('closed'));
    });

    test('should limit results', async () => {
      mockSpawnSuccess(JSON.stringify([]));

      const options: PRListOptions = {
        limit: 50,
      };

      await service.listPRs('/repo', options);

      const spawnArgs = mockSpawner.spawn.firstCall.args;
      assert.ok(spawnArgs[1].includes('--limit'));
      assert.ok(spawnArgs[1].includes('50'));
    });

    test('should handle closed PRs', async () => {
      const ghOutput = JSON.stringify([
        {
          number: 44,
          title: 'Closed PR',
          headRefName: 'feature/closed',
          baseRefName: 'main',
          state: 'CLOSED',
          isDraft: false,
          author: { login: 'user3' },
          url: 'https://github.com/test-owner/test-repo/pull/44',
        },
      ]);

      mockSpawnSuccess(ghOutput);

      const result = await service.listPRs('/repo');

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].state, 'closed');
    });

    test('should handle merged PRs', async () => {
      const ghOutput = JSON.stringify([
        {
          number: 45,
          title: 'Merged PR',
          headRefName: 'feature/merged',
          baseRefName: 'main',
          state: 'MERGED',
          isDraft: false,
          author: { login: 'user4' },
          url: 'https://github.com/test-owner/test-repo/pull/45',
        },
      ]);

      mockSpawnSuccess(ghOutput);

      const result = await service.listPRs('/repo');

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].state, 'merged');
    });

    test('should handle missing author gracefully', async () => {
      const ghOutput = JSON.stringify([
        {
          number: 46,
          title: 'No Author PR',
          headRefName: 'feature/no-author',
          baseRefName: 'main',
          state: 'OPEN',
          isDraft: false,
          author: null,
          url: 'https://github.com/test-owner/test-repo/pull/46',
        },
      ]);

      mockSpawnSuccess(ghOutput);

      const result = await service.listPRs('/repo');

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].author, 'unknown');
    });

    test('should throw on gh CLI error', async () => {
      mockSpawnError('gh: not authenticated', 1);

      await assert.rejects(
        async () => service.listPRs('/repo'),
        /gh: not authenticated/
      );
    });

    test('should throw on invalid JSON response', async () => {
      mockSpawnSuccess('not valid json');

      await assert.rejects(
        async () => service.listPRs('/repo'),
        /Failed to parse gh pr list output/
      );
    });
  });

  // ── getPRDetails ───────────────────────────────────────────────────────

  suite('getPRDetails', () => {
    test('should get PR details', async () => {
      const ghOutput = JSON.stringify({
        number: 42,
        title: 'Test PR',
        headRefName: 'feature/test',
        baseRefName: 'main',
        isDraft: false,
        state: 'OPEN',
        author: { login: 'test-user' },
        url: 'https://github.com/test-owner/test-repo/pull/42',
        body: 'PR description here',
      });

      mockSpawnSuccess(ghOutput);

      const result = await service.getPRDetails(42, '/repo');

      assert.strictEqual(result.prNumber, 42);
      assert.strictEqual(result.title, 'Test PR');
      assert.strictEqual(result.headBranch, 'feature/test');
      assert.strictEqual(result.baseBranch, 'main');
      assert.strictEqual(result.isDraft, false);
      assert.strictEqual(result.state, 'open');
      assert.strictEqual(result.author, 'test-user');
      assert.strictEqual(result.url, 'https://github.com/test-owner/test-repo/pull/42');
      assert.strictEqual(result.body, 'PR description here');

      // Verify spawn called with correct args
      const spawnArgs = mockSpawner.spawn.firstCall.args;
      assert.strictEqual(spawnArgs[0], 'gh');
      assert.ok(spawnArgs[1].includes('pr'));
      assert.ok(spawnArgs[1].includes('view'));
      assert.ok(spawnArgs[1].includes('42'));
      assert.ok(spawnArgs[1].includes('--json'));

      // Verify GH_TOKEN in env
      const spawnEnv = spawnArgs[2]?.env;
      assert.strictEqual(spawnEnv?.GH_TOKEN, 'gh_token_123');
    });

    test('should handle draft PR', async () => {
      const ghOutput = JSON.stringify({
        number: 42,
        title: 'Draft PR',
        headRefName: 'feature/draft',
        baseRefName: 'main',
        isDraft: true,
        state: 'OPEN',
        author: { login: 'test-user' },
        url: 'https://github.com/test-owner/test-repo/pull/42',
        body: '',
      });

      mockSpawnSuccess(ghOutput);

      const result = await service.getPRDetails(42, '/repo');

      assert.strictEqual(result.isDraft, true);
    });

    test('should throw on gh CLI error', async () => {
      mockSpawnError('PR not found', 1);

      await assert.rejects(
        async () => service.getPRDetails(999, '/repo'),
        /PR not found/
      );
    });

    test('should throw on invalid JSON response', async () => {
      mockSpawnSuccess('invalid json');

      await assert.rejects(
        async () => service.getPRDetails(42, '/repo'),
        /Failed to parse gh pr view output/
      );
    });
  });

  // ── abandonPR ──────────────────────────────────────────────────────────

  suite('abandonPR', () => {
    test('should abandon PR without comment', async () => {
      mockSpawnSuccess('');

      await service.abandonPR(42, '/repo');

      const spawnArgs = mockSpawner.spawn.firstCall.args;
      assert.strictEqual(spawnArgs[0], 'gh');
      assert.ok(spawnArgs[1].includes('pr'));
      assert.ok(spawnArgs[1].includes('close'));
      assert.ok(spawnArgs[1].includes('42'));
      assert.ok(!spawnArgs[1].includes('--comment'));

      // Verify GH_TOKEN in env
      const spawnEnv = spawnArgs[2]?.env;
      assert.strictEqual(spawnEnv?.GH_TOKEN, 'gh_token_123');
    });

    test('should abandon PR with comment', async () => {
      mockSpawnSuccess('');

      await service.abandonPR(42, '/repo', 'Closing due to inactivity');

      const spawnArgs = mockSpawner.spawn.firstCall.args;
      assert.ok(spawnArgs[1].includes('--comment'));
      assert.ok(spawnArgs[1].includes('Closing due to inactivity'));
    });

    test('should throw on gh CLI error', async () => {
      mockSpawnError('Permission denied', 1);

      await assert.rejects(
        async () => service.abandonPR(42, '/repo'),
        /Permission denied/
      );
    });
  });

  // ── promotePR ──────────────────────────────────────────────────────────

  suite('promotePR', () => {
    test('should promote draft PR to ready', async () => {
      mockSpawnSuccess('');

      await service.promotePR(42, '/repo');

      const spawnArgs = mockSpawner.spawn.firstCall.args;
      assert.strictEqual(spawnArgs[0], 'gh');
      assert.ok(spawnArgs[1].includes('pr'));
      assert.ok(spawnArgs[1].includes('ready'));
      assert.ok(spawnArgs[1].includes('42'));

      // Verify GH_TOKEN in env
      const spawnEnv = spawnArgs[2]?.env;
      assert.strictEqual(spawnEnv?.GH_TOKEN, 'gh_token_123');
    });

    test('should throw on gh CLI error', async () => {
      mockSpawnError('PR is not a draft', 1);

      await assert.rejects(
        async () => service.promotePR(42, '/repo'),
        /PR is not a draft/
      );
    });
  });

  // ── demotePR ───────────────────────────────────────────────────────────

  suite('demotePR', () => {
    test('should demote PR to draft via GraphQL', async () => {
      // First call to get PR node ID
      const nodeIdOutput = JSON.stringify({ id: 'PR_kwDOABCD' });
      
      // Second call for GraphQL mutation
      let callCount = 0;
      mockSpawner.spawn.callsFake(() => {
        callCount++;
        if (callCount === 1) {
          // First call: pr view --json id
          const mockProcess: any = {
            stdout: {
              on: (event: string, handler: any) => {
                if (event === 'data') {
                  handler(Buffer.from(nodeIdOutput));
                }
              },
            },
            stderr: { on: (event: string, handler: any) => {} },
            on: (event: string, handler: any) => {
              if (event === 'close') {
                handler(0);
              }
            },
          };
          return mockProcess;
        } else {
          // Second call: api graphql mutation
          const mockProcess: any = {
            stdout: {
              on: (event: string, handler: any) => {
                if (event === 'data') {
                  handler(Buffer.from('{}'));
                }
              },
            },
            stderr: { on: (event: string, handler: any) => {} },
            on: (event: string, handler: any) => {
              if (event === 'close') {
                handler(0);
              }
            },
          };
          return mockProcess;
        }
      });

      await service.demotePR(42, '/repo');

      assert.strictEqual(callCount, 2);

      // Verify first call to get node ID
      const firstCall = mockSpawner.spawn.firstCall.args;
      assert.ok(firstCall[1].includes('pr'));
      assert.ok(firstCall[1].includes('view'));
      assert.ok(firstCall[1].includes('42'));
      assert.ok(firstCall[1].includes('--json'));
      assert.ok(firstCall[1].includes('id'));

      // Verify second call for GraphQL mutation
      const secondCall = mockSpawner.spawn.secondCall.args;
      assert.ok(secondCall[1].includes('api'));
      assert.ok(secondCall[1].includes('graphql'));
      assert.ok(secondCall[1].includes('-f'));
      
      // The query is passed as a value starting with "query=" 
      // Find it in the args array
      const queryArg = secondCall[1].find((arg: string) => typeof arg === 'string' && arg.startsWith('query='));
      assert.ok(queryArg, 'Should have query= argument');
      assert.ok(queryArg.includes('convertPullRequestToDraft'));
      assert.ok(queryArg.includes('PR_kwDOABCD'));

      // Verify both calls have GH_TOKEN
      assert.strictEqual(firstCall[2]?.env?.GH_TOKEN, 'gh_token_123');
      assert.strictEqual(secondCall[2]?.env?.GH_TOKEN, 'gh_token_123');
    });

    test('should throw if node ID cannot be retrieved', async () => {
      mockSpawnError('PR not found', 1);

      await assert.rejects(
        async () => service.demotePR(42, '/repo'),
        /PR not found|Failed to get PR node ID/
      );
    });

    test('should throw if GraphQL mutation fails', async () => {
      let callCount = 0;
      mockSpawner.spawn.callsFake(() => {
        callCount++;
        if (callCount === 1) {
          // First call succeeds
          const mockProcess: any = {
            stdout: {
              on: (event: string, handler: any) => {
                if (event === 'data') {
                  handler(Buffer.from(JSON.stringify({ id: 'PR_kwDOABCD' })));
                }
              },
            },
            stderr: { on: (event: string, handler: any) => {} },
            on: (event: string, handler: any) => {
              if (event === 'close') {
                handler(0);
              }
            },
          };
          return mockProcess;
        } else {
          // Second call fails
          const mockProcess: any = {
            stdout: { on: (event: string, handler: any) => {} },
            stderr: {
              on: (event: string, handler: any) => {
                if (event === 'data') {
                  handler(Buffer.from('GraphQL error'));
                }
              },
            },
            on: (event: string, handler: any) => {
              if (event === 'close') {
                handler(1);
              }
            },
          };
          return mockProcess;
        }
      });

      await assert.rejects(
        async () => service.demotePR(42, '/repo'),
        /GraphQL error/
      );
    });

    test('should throw if node ID response is invalid JSON', async () => {
      mockSpawnSuccess('not valid json');

      await assert.rejects(
        async () => service.demotePR(42, '/repo'),
        /Failed to get PR node ID/
      );
    });
  });

  // ── Provider detection and credentials ────────────────────────────────

  suite('authentication', () => {
    test('should use cached provider info on subsequent calls', async () => {
      mockSpawnSuccess(JSON.stringify([]));

      await service.listPRs('/repo');
      await service.listPRs('/repo');

      // Detector should be called only once
      assert.strictEqual(mockDetector.detect.callCount, 1);
    });

    test('should acquire credentials for each provider', async () => {
      mockSpawnSuccess(JSON.stringify([]));

      await service.listPRs('/repo');

      assert.ok(mockDetector.acquireCredentials.calledOnce);
      assert.ok(mockDetector.acquireCredentials.calledWith(mockProvider));
    });
  });
});
