/**
 * @fileoverview Unit tests for AdoPRService extensions (listPRs, getPRDetails, abandonPR, promotePR, demotePR, addIssueComment).
 *
 * Covers:
 * - listPRs: List PRs via ADO REST API with filters
 * - getPRDetails: Get PR details via ADO REST API
 * - abandonPR: Close PR via ADO REST API with optional comment
 * - promotePR: Mark PR as ready via ADO REST API
 * - demotePR: Mark PR as draft via ADO REST API
 * - addIssueComment: Post a general PR comment via ADO threads API
 * - All operations use PAT/Bearer token authentication
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { AdoPRService } from '../../../../git/remotePR/adoPRService';
import type { 
  RemoteProviderInfo, 
  RemoteCredentials,
  PRListOptions 
} from '../../../../plan/types/remotePR';

suite('AdoPRService Extensions', () => {
  let sandbox: sinon.SinonSandbox;
  let mockSpawner: any;
  let mockDetector: any;
  let service: AdoPRService;
  let httpsRequestStub: sinon.SinonStub;

  const mockProvider: RemoteProviderInfo = {
    type: 'azure-devops',
    owner: 'test-org',
    repoName: 'test-repo',
    remoteUrl: 'https://dev.azure.com/test-org/test-project/_git/test-repo',
    hostname: 'dev.azure.com',
    organization: 'test-org',
    project: 'test-project',
  };

  const mockPATCredentials: RemoteCredentials = {
    token: 'ado_pat_123',
    tokenSource: 'environment',
  };

  const mockBearerCredentials: RemoteCredentials = {
    token: 'bearer_token_123',
    tokenSource: 'az-cli',
  };

  setup(() => {
    sandbox = sinon.createSandbox();

    mockSpawner = {
      spawn: sandbox.stub(),
    };

    mockDetector = {
      detect: sandbox.stub().resolves(mockProvider),
      acquireCredentials: sandbox.stub().resolves(mockPATCredentials),
    };

    service = new AdoPRService(mockSpawner, mockDetector);

    // Stub https.request using require pattern
    const https = require('https');
    httpsRequestStub = sandbox.stub(https, 'request');
  });

  teardown(() => {
    sandbox.restore();
  });

  // ── Helper to mock HTTPS success ──────────────────────────────────────

  function mockHttpsSuccess(responseBody: any, statusCode: number = 200): void {
    const mockRes: any = {
      statusCode,
      on: (event: string, handler: any) => {
        if (event === 'data') {
          handler(JSON.stringify(responseBody));
        } else if (event === 'end') {
          handler();
        }
      },
    };

    const mockReq: any = {
      on: (event: string, handler: any) => {},
      write: sandbox.stub(),
      end: sandbox.stub().callsFake(() => {
        // Immediately trigger response
        const callback = httpsRequestStub.firstCall.args[1];
        callback(mockRes);
      }),
    };

    httpsRequestStub.returns(mockReq);
  }

  function mockHttpsError(statusCode: number, errorMessage: string = 'Error'): void {
    const mockRes: any = {
      statusCode,
      on: (event: string, handler: any) => {
        if (event === 'data') {
          handler(JSON.stringify({ message: errorMessage }));
        } else if (event === 'end') {
          handler();
        }
      },
    };

    const mockReq: any = {
      on: (event: string, handler: any) => {},
      write: sandbox.stub(),
      end: sandbox.stub().callsFake(() => {
        const callback = httpsRequestStub.firstCall.args[1];
        callback(mockRes);
      }),
    };

    httpsRequestStub.returns(mockReq);
  }

  // ── listPRs ────────────────────────────────────────────────────────────

  suite('listPRs', () => {
    test('should list PRs with default filters', async () => {
      const adoResponse = {
        value: [
          {
            pullRequestId: 42,
            title: 'Test PR 1',
            sourceRefName: 'refs/heads/feature/test-1',
            targetRefName: 'refs/heads/main',
            status: 'active',
            isDraft: false,
            createdBy: { displayName: 'User One', uniqueName: 'user1@company.com' },
          },
          {
            pullRequestId: 43,
            title: 'Test PR 2',
            sourceRefName: 'refs/heads/feature/test-2',
            targetRefName: 'refs/heads/main',
            status: 'active',
            isDraft: true,
            createdBy: { displayName: 'User Two' },
          },
        ],
      };

      mockHttpsSuccess(adoResponse);

      const result = await service.listPRs('/repo');

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].prNumber, 42);
      assert.strictEqual(result[0].title, 'Test PR 1');
      assert.strictEqual(result[0].headBranch, 'feature/test-1');
      assert.strictEqual(result[0].baseBranch, 'main');
      assert.strictEqual(result[0].state, 'open');
      assert.strictEqual(result[0].isDraft, false);
      assert.strictEqual(result[0].author, 'User One');
      assert.strictEqual(result[1].isDraft, true);
      assert.strictEqual(result[1].author, 'User Two');

      // Verify URL
      const requestOptions = httpsRequestStub.firstCall.args[0];
      assert.ok(requestOptions.path.includes('pullrequests'));
      assert.ok(requestOptions.path.includes('api-version=7.0'));

      // Verify PAT auth header (Basic auth with base64 encoded ':' + token)
      const expectedAuth = 'Basic ' + Buffer.from(':ado_pat_123').toString('base64');
      assert.strictEqual(requestOptions.headers['Authorization'], expectedAuth);
    });

    test('should use Bearer token for az-cli credentials', async () => {
      mockDetector.acquireCredentials.resolves(mockBearerCredentials);
      const newService = new AdoPRService(mockSpawner, mockDetector);

      mockHttpsSuccess({ value: [] });

      await newService.listPRs('/repo');

      const requestOptions = httpsRequestStub.firstCall.args[0];
      assert.strictEqual(requestOptions.headers['Authorization'], 'Bearer bearer_token_123');
    });

    test('should filter by state=open', async () => {
      mockHttpsSuccess({ value: [] });

      const options: PRListOptions = {
        state: 'open',
      };

      await service.listPRs('/repo', options);

      const requestOptions = httpsRequestStub.firstCall.args[0];
      assert.ok(requestOptions.path.includes('searchCriteria.status=active'));
    });

    test('should filter by state=closed', async () => {
      mockHttpsSuccess({ value: [] });

      const options: PRListOptions = {
        state: 'closed',
      };

      await service.listPRs('/repo', options);

      const requestOptions = httpsRequestStub.firstCall.args[0];
      assert.ok(requestOptions.path.includes('searchCriteria.status=completed'));
    });

    test('should filter by state=all', async () => {
      mockHttpsSuccess({ value: [] });

      const options: PRListOptions = {
        state: 'all',
      };

      await service.listPRs('/repo', options);

      const requestOptions = httpsRequestStub.firstCall.args[0];
      assert.ok(requestOptions.path.includes('searchCriteria.status=all'));
    });

    test('should filter by author', async () => {
      mockHttpsSuccess({ value: [] });

      const options: PRListOptions = {
        author: 'specific-user',
      };

      await service.listPRs('/repo', options);

      const requestOptions = httpsRequestStub.firstCall.args[0];
      assert.ok(requestOptions.path.includes('searchCriteria.creatorId=specific-user'));
    });

    test('should limit results', async () => {
      mockHttpsSuccess({ value: [] });

      const options: PRListOptions = {
        limit: 50,
      };

      await service.listPRs('/repo', options);

      const requestOptions = httpsRequestStub.firstCall.args[0];
      // $top is URL-encoded as %24top
      assert.ok(requestOptions.path.includes('%24top=50') || requestOptions.path.includes('$top=50'));
    });

    test('should handle completed PRs as merged', async () => {
      const adoResponse = {
        value: [
          {
            pullRequestId: 44,
            title: 'Merged PR',
            sourceRefName: 'refs/heads/feature/merged',
            targetRefName: 'refs/heads/main',
            status: 'completed',
            isDraft: false,
            createdBy: { displayName: 'User Three' },
          },
        ],
      };

      mockHttpsSuccess(adoResponse);

      const result = await service.listPRs('/repo');

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].state, 'merged');
    });

    test('should handle abandoned PRs as closed', async () => {
      const adoResponse = {
        value: [
          {
            pullRequestId: 45,
            title: 'Abandoned PR',
            sourceRefName: 'refs/heads/feature/abandoned',
            targetRefName: 'refs/heads/main',
            status: 'abandoned',
            isDraft: false,
            createdBy: { displayName: 'User Four' },
          },
        ],
      };

      mockHttpsSuccess(adoResponse);

      const result = await service.listPRs('/repo');

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].state, 'closed');
    });

    test('should handle missing author gracefully', async () => {
      const adoResponse = {
        value: [
          {
            pullRequestId: 46,
            title: 'No Author PR',
            sourceRefName: 'refs/heads/feature/no-author',
            targetRefName: 'refs/heads/main',
            status: 'active',
            isDraft: false,
            createdBy: null,
          },
        ],
      };

      mockHttpsSuccess(adoResponse);

      const result = await service.listPRs('/repo');

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].author, 'unknown');
    });

    test('should throw on API error', async () => {
      mockHttpsError(404, 'Repository not found');

      await assert.rejects(
        async () => service.listPRs('/repo'),
        /Repository not found/
      );
    });
  });

  // ── getPRDetails ───────────────────────────────────────────────────────

  suite('getPRDetails', () => {
    test('should get PR details', async () => {
      const adoResponse = {
        pullRequestId: 42,
        title: 'Test PR',
        sourceRefName: 'refs/heads/feature/test',
        targetRefName: 'refs/heads/main',
        isDraft: false,
        status: 'active',
        createdBy: { displayName: 'Test User', uniqueName: 'testuser@company.com' },
        description: 'PR description here',
      };

      mockHttpsSuccess(adoResponse);

      const result = await service.getPRDetails(42, '/repo');

      assert.strictEqual(result.prNumber, 42);
      assert.strictEqual(result.title, 'Test PR');
      assert.strictEqual(result.headBranch, 'feature/test');
      assert.strictEqual(result.baseBranch, 'main');
      assert.strictEqual(result.isDraft, false);
      assert.strictEqual(result.state, 'open');
      assert.strictEqual(result.author, 'Test User');
      assert.strictEqual(result.body, 'PR description here');
      assert.ok(result.url.includes('pullrequest/42'));

      // Verify URL
      const requestOptions = httpsRequestStub.firstCall.args[0];
      assert.ok(requestOptions.path.includes('pullRequests/42'));
      assert.ok(requestOptions.path.includes('api-version=7.0'));
    });

    test('should handle draft PR', async () => {
      const adoResponse = {
        pullRequestId: 42,
        title: 'Draft PR',
        sourceRefName: 'refs/heads/feature/draft',
        targetRefName: 'refs/heads/main',
        isDraft: true,
        status: 'active',
        createdBy: { displayName: 'Test User' },
        description: '',
      };

      mockHttpsSuccess(adoResponse);

      const result = await service.getPRDetails(42, '/repo');

      assert.strictEqual(result.isDraft, true);
    });

    test('should throw on API error', async () => {
      mockHttpsError(404, 'PR not found');

      await assert.rejects(
        async () => service.getPRDetails(999, '/repo'),
        /PR not found/
      );
    });
  });

  // ── abandonPR ──────────────────────────────────────────────────────────

  suite('abandonPR', () => {
    test('should abandon PR without comment', async () => {
      // Only one PATCH request to set status to abandoned
      mockHttpsSuccess({});

      await service.abandonPR(42, '/repo');

      // Verify PATCH request
      const requestOptions = httpsRequestStub.firstCall.args[0];
      assert.strictEqual(requestOptions.method, 'PATCH');
      assert.ok(requestOptions.path.includes('pullRequests/42'));

      // Verify body
      const mockReq = httpsRequestStub.firstCall.returnValue;
      assert.ok(mockReq.write.calledOnce);
      const bodyStr = mockReq.write.firstCall.args[0];
      const body = JSON.parse(bodyStr);
      assert.strictEqual(body.status, 'abandoned');
    });

    test('should abandon PR with comment', async () => {
      // Two requests: POST comment thread, then PATCH to abandon
      let requestCount = 0;
      httpsRequestStub.callsFake((options: any, callback: any) => {
        requestCount++;
        
        const mockRes: any = {
          statusCode: 200,
          on: (event: string, handler: any) => {
            if (event === 'data') {
              handler(JSON.stringify({}));
            } else if (event === 'end') {
              handler();
            }
          },
        };

        const mockReq: any = {
          on: (event: string, handler: any) => {},
          write: sandbox.stub(),
          end: sandbox.stub().callsFake(() => {
            callback(mockRes);
          }),
        };

        return mockReq;
      });

      await service.abandonPR(42, '/repo', 'Closing due to inactivity');

      assert.strictEqual(requestCount, 2);

      // Verify first request (POST comment thread)
      const firstOptions = httpsRequestStub.firstCall.args[0];
      assert.strictEqual(firstOptions.method, 'POST');
      assert.ok(firstOptions.path.includes('threads'));

      // Verify second request (PATCH abandon)
      const secondOptions = httpsRequestStub.secondCall.args[0];
      assert.strictEqual(secondOptions.method, 'PATCH');
      assert.ok(secondOptions.path.includes('pullRequests/42'));
    });

    test('should continue abandoning even if comment fails', async () => {
      let requestCount = 0;
      httpsRequestStub.callsFake((options: any, callback: any) => {
        requestCount++;
        
        if (requestCount === 1) {
          // First request (comment) fails
          const mockRes: any = {
            statusCode: 403,
            on: (event: string, handler: any) => {
              if (event === 'data') {
                handler(JSON.stringify({ message: 'Permission denied' }));
              } else if (event === 'end') {
                handler();
              }
            },
          };

          const mockReq: any = {
            on: (event: string, handler: any) => {},
            write: sandbox.stub(),
            end: sandbox.stub().callsFake(() => {
              callback(mockRes);
            }),
          };
          return mockReq;
        } else {
          // Second request (abandon) succeeds
          const mockRes: any = {
            statusCode: 200,
            on: (event: string, handler: any) => {
              if (event === 'data') {
                handler(JSON.stringify({}));
              } else if (event === 'end') {
                handler();
              }
            },
          };

          const mockReq: any = {
            on: (event: string, handler: any) => {},
            write: sandbox.stub(),
            end: sandbox.stub().callsFake(() => {
              callback(mockRes);
            }),
          };
          return mockReq;
        }
      });

      // Should not throw even though comment failed
      await service.abandonPR(42, '/repo', 'Comment that fails');

      assert.strictEqual(requestCount, 2);
    });

    test('should throw on API error', async () => {
      mockHttpsError(403, 'Permission denied');

      await assert.rejects(
        async () => service.abandonPR(42, '/repo'),
        /Permission denied/
      );
    });
  });

  // ── promotePR ──────────────────────────────────────────────────────────

  suite('promotePR', () => {
    test('should promote draft PR to ready', async () => {
      mockHttpsSuccess({});

      await service.promotePR(42, '/repo');

      // Verify PATCH request
      const requestOptions = httpsRequestStub.firstCall.args[0];
      assert.strictEqual(requestOptions.method, 'PATCH');
      assert.ok(requestOptions.path.includes('pullRequests/42'));

      // Verify body
      const mockReq = httpsRequestStub.firstCall.returnValue;
      assert.ok(mockReq.write.calledOnce);
      const bodyStr = mockReq.write.firstCall.args[0];
      const body = JSON.parse(bodyStr);
      assert.strictEqual(body.isDraft, false);
    });

    test('should throw on API error', async () => {
      mockHttpsError(400, 'PR is not a draft');

      await assert.rejects(
        async () => service.promotePR(42, '/repo'),
        /PR is not a draft/
      );
    });
  });

  // ── demotePR ───────────────────────────────────────────────────────────

  suite('demotePR', () => {
    test('should demote PR to draft', async () => {
      mockHttpsSuccess({});

      await service.demotePR(42, '/repo');

      // Verify PATCH request
      const requestOptions = httpsRequestStub.firstCall.args[0];
      assert.strictEqual(requestOptions.method, 'PATCH');
      assert.ok(requestOptions.path.includes('pullRequests/42'));

      // Verify body
      const mockReq = httpsRequestStub.firstCall.returnValue;
      assert.ok(mockReq.write.calledOnce);
      const bodyStr = mockReq.write.firstCall.args[0];
      const body = JSON.parse(bodyStr);
      assert.strictEqual(body.isDraft, true);
    });

    test('should throw on API error', async () => {
      mockHttpsError(400, 'PR cannot be converted to draft');

      await assert.rejects(
        async () => service.demotePR(42, '/repo'),
        /PR cannot be converted to draft/
      );
    });
  });

  // ── Provider detection ─────────────────────────────────────────────────

  suite('provider detection', () => {
    test('should detect provider before API calls', async () => {
      mockHttpsSuccess({ value: [] });

      await service.listPRs('/repo');

      assert.ok(mockDetector.detect.calledOnce);
      assert.ok(mockDetector.detect.calledWith('/repo'));
    });

    test('should acquire credentials before API calls', async () => {
      mockHttpsSuccess({ value: [] });

      await service.listPRs('/repo');

      assert.ok(mockDetector.acquireCredentials.calledOnce);
      assert.ok(mockDetector.acquireCredentials.calledWith(mockProvider));
    });

    test('should throw if organization is missing', async () => {
      const invalidProvider = { ...mockProvider, organization: undefined };
      mockDetector.detect.resolves(invalidProvider);
      const newService = new AdoPRService(mockSpawner, mockDetector);

      // Will throw when trying to construct the API URL
      await assert.rejects(
        async () => newService.listPRs('/repo')
      );
    });

    test('should throw if project is missing', async () => {
      const invalidProvider = { ...mockProvider, project: undefined };
      mockDetector.detect.resolves(invalidProvider);
      const newService = new AdoPRService(mockSpawner, mockDetector);

      // Will throw when trying to construct the API URL
      await assert.rejects(
        async () => newService.listPRs('/repo')
      );
    });
  });

  // ── addIssueComment ────────────────────────────────────────────────────

  suite('addIssueComment', () => {
    test('should post a general comment to a PR thread', async () => {
      mockHttpsSuccess({ id: 1, comments: [{ id: 1, content: 'Test comment' }] });

      await service.addIssueComment(42, 'Test comment body', '/repo');

      const requestOptions = httpsRequestStub.firstCall.args[0];
      assert.strictEqual(requestOptions.method, 'POST');
      assert.ok(requestOptions.path.includes('pullRequests/42/threads'));

      const mockReq = httpsRequestStub.firstCall.returnValue;
      assert.ok(mockReq.write.calledOnce);
      const body = JSON.parse(mockReq.write.firstCall.args[0]);
      assert.deepStrictEqual(body.comments, [{ content: 'Test comment body', commentType: 1 }]);
      assert.strictEqual(body.status, 1);
    });

    test('should include correct repo name in URL', async () => {
      mockHttpsSuccess({});

      await service.addIssueComment(99, 'Hello world', '/repo');

      const requestOptions = httpsRequestStub.firstCall.args[0];
      assert.ok(requestOptions.path.includes('test-repo'));
      assert.ok(requestOptions.path.includes('pullRequests/99/threads'));
    });

    test('should throw when API request fails', async () => {
      mockHttpsError(403, 'Forbidden');

      await assert.rejects(
        async () => service.addIssueComment(42, 'Test comment', '/repo'),
        /Failed to add general comment to ADO PR/
      );
    });
  });
});
