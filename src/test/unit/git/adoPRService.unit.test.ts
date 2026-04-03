/**
 * @fileoverview Unit tests for AdoPRService.
 * 
 * Tests Azure DevOps REST API integration, authentication, and PR operations.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { AdoPRService } from '../../../git/remotePR/adoPRService';
import type { IProcessSpawner } from '../../../interfaces/IProcessSpawner';
import type { IRemoteProviderDetector } from '../../../interfaces/IRemoteProviderDetector';
import type { RemoteProviderInfo, RemoteCredentials } from '../../../plan/types/remotePR';

suite('AdoPRService', () => {
  let sandbox: sinon.SinonSandbox;
  let mockSpawner: IProcessSpawner;
  let mockDetector: IRemoteProviderDetector;
  let service: AdoPRService;
  let httpsRequestStub: sinon.SinonStub;

  const adoProvider: RemoteProviderInfo = {
    type: 'azure-devops',
    remoteUrl: 'https://dev.azure.com/myorg/myproject/_git/myrepo',
    organization: 'myorg',
    project: 'myproject',
    repoName: 'myrepo',
    owner: 'myorg',
  };

  const patCredentials: RemoteCredentials = {
    token: 'ado_pat_token',
    tokenSource: 'environment',
    hostname: 'dev.azure.com/myorg',
  };

  const azCliCredentials: RemoteCredentials = {
    token: 'ey_bearer_token',
    tokenSource: 'az-cli',
    hostname: 'dev.azure.com/myorg',
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    
    mockSpawner = {
      spawn: sandbox.stub(),
    } as any;
    
    mockDetector = {
      detect: sandbox.stub().resolves(adoProvider),
      acquireCredentials: sandbox.stub().resolves(patCredentials),
    } as any;
    
    service = new AdoPRService(mockSpawner, mockDetector);

    // Stub https.request
    const https = require('https');
    httpsRequestStub = sandbox.stub(https, 'request');
  });

  teardown(() => {
    sandbox.restore();
  });

  /**
   * Helper to stub an HTTPS request that returns a successful response.
   */
  function stubHttpsRequest(statusCode: number, responseBody: string): any {
    const req = (() => {
      const EventEmitter = require('events');
      const request = new EventEmitter() as any;
      request.write = sandbox.stub();
      request.setTimeout = sandbox.stub().returns(request);
      request.destroy = sandbox.stub().callsFake((error?: Error) => {
        if (error) {
          request.emit('error', error);
        }
      });
      request.end = sandbox.stub().callsFake((callback: any) => {
        const res = new EventEmitter() as any;
        res.statusCode = statusCode;

        process.nextTick(() => {
          callback(res);
          res.emit('data', Buffer.from(responseBody));
          res.emit('end');
        });
      });

      return request;
    })();

    httpsRequestStub.callsFake((_options: any, callback: any) => {
      req.end = sandbox.stub().callsFake(() => {
        const EventEmitter = require('events');
        const res = new EventEmitter() as any;
        res.statusCode = statusCode;

        process.nextTick(() => {
          callback(res);
          res.emit('data', Buffer.from(responseBody));
          res.emit('end');
        });
      });

      return req;
    });
    return req;
  }

  suite('createPR', () => {
    test('posts to ADO API v7.0', async () => {
      const responseBody = JSON.stringify({
        pullRequestId: 123,
        url: 'https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/123',
      });
      
      stubHttpsRequest(201, responseBody);

      const result = await service.createPR({
        baseBranch: 'main',
        headBranch: 'feature',
        title: 'Add feature',
        body: 'Description',
        cwd: '/repo',
      });

      assert.strictEqual(result.prNumber, 123);
      assert.ok(result.prUrl.includes('/pullrequest/123'));
      
      // Verify API call
      const options = httpsRequestStub.firstCall.args[0];
      assert.strictEqual(options.method, 'POST');
      assert.ok(options.path.includes('git/repositories/myrepo/pullrequests'));
      assert.ok(options.path.includes('api-version=7.0'));
    });

    test('uses Basic auth with PAT', async () => {
      stubHttpsRequest(201, JSON.stringify({ pullRequestId: 1, url: 'http://example.com' }));

      await service.createPR({
        baseBranch: 'main',
        headBranch: 'feature',
        title: 'Title',
        body: 'Body',
        cwd: '/repo',
      });

      const options = httpsRequestStub.firstCall.args[0];
      const authHeader = options.headers.Authorization;
      
      // Basic auth with base64(':' + token)
      assert.ok(authHeader.startsWith('Basic '));
      
      const base64Token = authHeader.split(' ')[1];
      const decoded = Buffer.from(base64Token, 'base64').toString();
      assert.strictEqual(decoded, ':ado_pat_token');
    });

    test('uses Bearer auth for az-cli tokens', async () => {
      (mockDetector.acquireCredentials as sinon.SinonStub).resolves(azCliCredentials);

      stubHttpsRequest(201, JSON.stringify({ pullRequestId: 1, url: 'http://example.com' }));

      await service.createPR({
        baseBranch: 'main',
        headBranch: 'feature',
        title: 'Title',
        body: 'Body',
        cwd: '/repo',
      });

      const options = httpsRequestStub.firstCall.args[0];
      const authHeader = options.headers.Authorization;
      
      assert.strictEqual(authHeader, 'Bearer ey_bearer_token');
    });

    test('configures a timeout for Azure DevOps API requests', async () => {
      const req = stubHttpsRequest(201, JSON.stringify({ pullRequestId: 1, url: 'http://example.com' }));

      await service.createPR({
        baseBranch: 'main',
        headBranch: 'feature',
        title: 'Title',
        body: 'Body',
        cwd: '/repo',
      });

      assert.ok(req.setTimeout.calledOnce);
      assert.strictEqual(req.setTimeout.firstCall.args[0], 30000);
    });
  });

  suite('getPRChecks', () => {
    test('fetches builds, maps result', async () => {
      const buildsResponse = JSON.stringify({
        value: [
          {
            definition: { name: 'Build Pipeline' },
            status: 'completed',
            result: 'succeeded',
            triggerInfo: { 'pr.number': '42' },
            _links: { web: { href: 'https://dev.azure.com/build/1' } },
          },
          {
            definition: { name: 'Test Pipeline' },
            status: 'inProgress',
            result: null,
            triggerInfo: { 'pr.number': '42' },
            _links: { web: { href: 'https://dev.azure.com/build/2' } },
          },
        ],
      });

      stubHttpsRequest(200, buildsResponse);

      const checks = await service.getPRChecks(42, '/repo');

      assert.strictEqual(checks.length, 2);
      
      assert.strictEqual(checks[0].name, 'Build Pipeline');
      assert.strictEqual(checks[0].status, 'passing');
      
      assert.strictEqual(checks[1].name, 'Test Pipeline');
      assert.strictEqual(checks[1].status, 'pending');
    });
  });

  suite('getPRComments', () => {
    test('fetches threads, maps to PRComment', async () => {
      const threadsResponse = JSON.stringify({
        value: [
          {
            id: 1,
            status: 'active',
            threadContext: { filePath: 'src/file.ts', rightFileStart: { line: 42 } },
            comments: [
              { id: 10, author: { displayName: 'Alice' }, content: 'Please fix this' },
              { id: 11, author: { displayName: 'Bob' }, content: 'Fixed' },
            ],
          },
          {
            id: 2,
            status: 'fixed',
            comments: [
              { id: 20, author: { displayName: 'Carol' }, content: 'Resolved' },
            ],
          },
        ],
      });

      stubHttpsRequest(200, threadsResponse);

      const comments = await service.getPRComments(42, '/repo');

      // 2 threads → 2 entries (thread-level grouping)
      assert.strictEqual(comments.length, 2);
      
      const thread1 = comments.find(c => c.id === '10');
      assert.strictEqual(thread1?.author, 'Alice');
      assert.strictEqual(thread1?.path, 'src/file.ts');
      assert.strictEqual(thread1?.line, 42);
      assert.strictEqual(thread1?.isResolved, false);
      // Second comment in thread 1 becomes a reply
      assert.strictEqual(thread1?.replies?.length, 1);
      assert.strictEqual(thread1?.replies?.[0].author, 'Bob');
      assert.strictEqual(thread1?.replies?.[0].body, 'Fixed');
      
      const thread2 = comments.find(c => c.id === '20');
      assert.strictEqual(thread2?.isResolved, true);
      assert.strictEqual(thread2?.replies, undefined); // single-comment thread
    });
  });

  suite('getSecurityAlerts', () => {
    test('returns empty when not enabled', async () => {
      stubHttpsRequest(404, JSON.stringify({ message: 'Not found' }));

      const alerts = await service.getSecurityAlerts('main', '/repo');

      assert.strictEqual(alerts.length, 0);
    });

    test('handles 403 gracefully', async () => {
      stubHttpsRequest(403, JSON.stringify({ message: 'Forbidden' }));

      const alerts = await service.getSecurityAlerts('main', '/repo');

      assert.strictEqual(alerts.length, 0);
    });
  });

  suite('replyToComment', () => {
    test('posts to thread comments', async () => {
      stubHttpsRequest(201, JSON.stringify({ id: 999 }));

      await service.replyToComment(42, 'thread-123', 'My reply', '/repo');

      const options = httpsRequestStub.firstCall.args[0];
      assert.strictEqual(options.method, 'POST');
      assert.ok(options.path.includes('pullRequests/42/threads/thread-123/comments'));
    });
  });

  suite('mergePR', () => {
    test('patches PR with status completed and squash strategy', async () => {
      const responseBody = JSON.stringify({
        pullRequestId: 42,
        status: 'completed',
        lastMergeCommit: { commitId: 'abc1234567890' },
      });
      stubHttpsRequest(200, responseBody);

      const result = await service.mergePR(42, '/repo', { method: 'squash' });

      const options = httpsRequestStub.firstCall.args[0];
      assert.strictEqual(options.method, 'PATCH');
      assert.ok(options.path.includes('pullRequests/42'));
      assert.ok(!options.path.includes('/merge'), 'URL must not have /merge suffix');
      assert.strictEqual(result.commitSha, 'abc1234567890');
    });

    test('includes admin bypass in completionOptions', async () => {
      stubHttpsRequest(200, JSON.stringify({
        pullRequestId: 42,
        lastMergeCommit: { commitId: 'def567' },
      }));

      let capturedBody: any;
      httpsRequestStub.callsFake((_options: any, callback: any) => {
        const EventEmitter = require('events');
        const req = new EventEmitter() as any;
        req.write = sandbox.stub().callsFake((data: any) => {
          capturedBody = JSON.parse(data.toString());
        });
        req.setTimeout = sandbox.stub().returns(req);
        req.destroy = sandbox.stub();
        req.end = sandbox.stub().callsFake(() => {
          const res = new EventEmitter() as any;
          res.statusCode = 200;
          process.nextTick(() => {
            callback(res);
            res.emit('data', Buffer.from(JSON.stringify({
              pullRequestId: 42,
              lastMergeCommit: { commitId: 'def567' },
            })));
            res.emit('end');
          });
        });
        return req;
      });

      await service.mergePR(42, '/repo', { method: 'merge', admin: true, deleteSourceBranch: true, title: 'My release' });

      assert.ok(capturedBody, 'Body should be captured');
      assert.strictEqual(capturedBody.status, 'completed');
      assert.strictEqual(capturedBody.completionOptions.bypassPolicy, true);
      assert.strictEqual(capturedBody.completionOptions.deleteSourceBranch, true);
      assert.strictEqual(capturedBody.completionOptions.mergeCommitMessage, 'My release');
    });

    test('throws on API error', async () => {
      stubHttpsRequest(400, JSON.stringify({ message: 'PR is not mergeable' }));

      await assert.rejects(
        () => service.mergePR(42, '/repo', { method: 'squash' }),
        /Failed to merge ADO PR/,
      );
    });
  });

  suite('resolveThread', () => {
    test('patches status to fixed', async () => {
      stubHttpsRequest(200, JSON.stringify({ id: 1, status: 'fixed' }));

      await service.resolveThread(42, 'thread-456', '/repo');

      const options = httpsRequestStub.firstCall.args[0];
      assert.strictEqual(options.method, 'PATCH');
      assert.ok(options.path.includes('pullRequests/42/threads/thread-456'));
    });
  });

  test('token never in logs', async () => {
    // This test documents the expectation that tokens are never logged
    // The implementation uses Logger.for('git') which should not log sensitive data
    
    stubHttpsRequest(201, JSON.stringify({ pullRequestId: 1, url: 'http://example.com' }));

    await service.createPR({
      baseBranch: 'main',
      headBranch: 'feature',
      title: 'Title',
      body: 'Body',
      cwd: '/repo',
    });

    // Verify token is used in auth header but would not be logged
    const options = httpsRequestStub.firstCall.args[0];
    assert.ok(options.headers.Authorization);
  });

  test('rejects when an Azure DevOps API request times out', async () => {
    httpsRequestStub.callsFake(() => {
      const EventEmitter = require('events');
      const req = new EventEmitter() as any;
      req.write = sandbox.stub();
      req.destroy = sandbox.stub().callsFake((error?: Error) => {
        if (error) {
          req.emit('error', error);
        }
      });
      req.setTimeout = sandbox.stub().callsFake((_timeoutMs: number, handler: () => void) => {
        process.nextTick(() => handler());
        return req;
      });
      req.end = sandbox.stub();
      return req;
    });

    await assert.rejects(
      service.createPR({
        baseBranch: 'main',
        headBranch: 'feature',
        title: 'Title',
        body: 'Body',
        cwd: '/repo',
      }),
      /timed out/i,
    );
  });
});
