/**
 * @fileoverview Unit tests for RemotePRServiceFactory.
 * 
 * Tests factory pattern for creating provider-specific PR service instances with caching.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { RemotePRServiceFactory } from '../../../git/remotePR/remotePRServiceFactory';
import { GitHubPRService } from '../../../git/remotePR/githubPRService';
import { AdoPRService } from '../../../git/remotePR/adoPRService';
import type { IProcessSpawner } from '../../../interfaces/IProcessSpawner';
import type { IRemoteProviderDetector } from '../../../interfaces/IRemoteProviderDetector';
import type { RemoteProviderInfo } from '../../../plan/types/remotePR';

suite('RemotePRServiceFactory', () => {
  let sandbox: sinon.SinonSandbox;
  let mockSpawner: IProcessSpawner;
  let mockDetector: IRemoteProviderDetector;
  let factory: RemotePRServiceFactory;

  const githubProvider: RemoteProviderInfo = {
    type: 'github',
    remoteUrl: 'https://github.com/owner/repo.git',
    owner: 'owner',
    repoName: 'repo',
  };

  const gheProvider: RemoteProviderInfo = {
    type: 'github-enterprise',
    remoteUrl: 'https://mygithub.company.com/corp/app.git',
    hostname: 'mygithub.company.com',
    owner: 'corp',
    repoName: 'app',
  };

  const adoProvider: RemoteProviderInfo = {
    type: 'azure-devops',
    remoteUrl: 'https://dev.azure.com/org/project/_git/repo',
    organization: 'org',
    project: 'project',
    repoName: 'repo',
    owner: 'org',
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    
    mockSpawner = {
      spawn: sandbox.stub(),
    } as any;
    
    mockDetector = {
      detect: sandbox.stub(),
      acquireCredentials: sandbox.stub(),
    } as any;
    
    factory = new RemotePRServiceFactory(mockSpawner, mockDetector, GitHubPRService, AdoPRService);
  });

  teardown(() => {
    sandbox.restore();
  });

  test('returns GitHubPRService for github', async () => {
    (mockDetector.detect as sinon.SinonStub).resolves(githubProvider);

    const service = await factory.getServiceForRepo('/repo/path');

    assert.ok(service);
    assert.strictEqual(service.constructor.name, 'GitHubPRService');
  });

  test('returns GitHubPRService for github-enterprise', async () => {
    (mockDetector.detect as sinon.SinonStub).resolves(gheProvider);

    const service = await factory.getServiceForRepo('/ghe/repo');

    assert.ok(service);
    assert.strictEqual(service.constructor.name, 'GitHubPRService');
  });

  test('returns AdoPRService for azure-devops', async () => {
    (mockDetector.detect as sinon.SinonStub).resolves(adoProvider);

    const service = await factory.getServiceForRepo('/ado/repo');

    assert.ok(service);
    assert.strictEqual(service.constructor.name, 'AdoPRService');
  });

  test('caches per repoPath', async () => {
    (mockDetector.detect as sinon.SinonStub).resolves(githubProvider);

    const service1 = await factory.getServiceForRepo('/repo/path');
    const service2 = await factory.getServiceForRepo('/repo/path');

    // Should be the same instance
    assert.strictEqual(service1, service2);
    
    // Detector should only be called once
    assert.strictEqual((mockDetector.detect as sinon.SinonStub).callCount, 1);
  });

  test('returns cached on second call', async () => {
    (mockDetector.detect as sinon.SinonStub).resolves(adoProvider);

    const first = await factory.getServiceForRepo('/ado/repo');
    const second = await factory.getServiceForRepo('/ado/repo');

    assert.strictEqual(first, second);
    assert.strictEqual((mockDetector.detect as sinon.SinonStub).callCount, 1);
  });

  test('different repos get different services', async () => {
    (mockDetector.detect as sinon.SinonStub)
      .onFirstCall().resolves(githubProvider)
      .onSecondCall().resolves(adoProvider);

    const githubService = await factory.getServiceForRepo('/github/repo');
    const adoService = await factory.getServiceForRepo('/ado/repo');

    assert.notStrictEqual(githubService, adoService);
    assert.strictEqual(githubService.constructor.name, 'GitHubPRService');
    assert.strictEqual(adoService.constructor.name, 'AdoPRService');
  });

  test('uses injected constructors instead of hardcoded classes', async () => {
    let githubCtorCalled = false;
    let adoCtorCalled = false;
    const mockGitHubInstance = { type: 'mock-github' } as any;
    const mockAdoInstance = { type: 'mock-ado' } as any;
    
    const mockGithubCtor = function() { githubCtorCalled = true; return mockGitHubInstance; } as any;
    const mockAdoCtor = function() { adoCtorCalled = true; return mockAdoInstance; } as any;
    
    const customFactory = new RemotePRServiceFactory(mockSpawner, mockDetector, mockGithubCtor, mockAdoCtor);
    
    (mockDetector.detect as sinon.SinonStub).resolves(githubProvider);
    const service = await customFactory.getServiceForRepo('/custom/repo');
    
    assert.ok(githubCtorCalled);
    assert.ok(!adoCtorCalled);
    assert.strictEqual(service, mockGitHubInstance);
  });
});
