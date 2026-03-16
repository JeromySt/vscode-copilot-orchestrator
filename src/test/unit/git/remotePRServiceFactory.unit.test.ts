/**
 * @fileoverview Unit tests for RemotePRServiceFactory.
 * 
 * Tests factory pattern for creating provider-specific PR service instances with caching.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { RemotePRServiceFactory } from '../../../git/remotePR/remotePRServiceFactory';
import type { IProcessSpawner } from '../../../interfaces/IProcessSpawner';
import type { IRemoteProviderDetector } from '../../../interfaces/IRemoteProviderDetector';
import type { RemoteProviderInfo } from '../../../plan/types/remotePR';

suite('RemotePRServiceFactory', () => {
  let sandbox: sinon.SinonSandbox;
  let mockSpawner: IProcessSpawner;
  let mockDetector: IRemoteProviderDetector;
  let factory: RemotePRServiceFactory;
  let githubCreator: sinon.SinonStub;
  let adoCreator: sinon.SinonStub;

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

    githubCreator = sandbox.stub().callsFake(() => ({ kind: 'github-service' } as any));
    adoCreator = sandbox.stub().callsFake(() => ({ kind: 'ado-service' } as any));

    factory = new RemotePRServiceFactory(mockSpawner, mockDetector, githubCreator, adoCreator);
  });

  teardown(() => {
    sandbox.restore();
  });

  test('returns GitHubPRService for github', async () => {
    (mockDetector.detect as sinon.SinonStub).resolves(githubProvider);

    const service = await factory.getServiceForRepo('/repo/path');

    assert.ok(service);
    assert.strictEqual(service, githubCreator.firstCall.returnValue);
    assert.ok(githubCreator.calledOnceWithExactly(mockSpawner, mockDetector));
    assert.ok(adoCreator.notCalled);
  });

  test('returns GitHubPRService for github-enterprise', async () => {
    (mockDetector.detect as sinon.SinonStub).resolves(gheProvider);

    const service = await factory.getServiceForRepo('/ghe/repo');

    assert.ok(service);
    assert.strictEqual(service, githubCreator.firstCall.returnValue);
    assert.ok(githubCreator.calledOnceWithExactly(mockSpawner, mockDetector));
    assert.ok(adoCreator.notCalled);
  });

  test('returns AdoPRService for azure-devops', async () => {
    (mockDetector.detect as sinon.SinonStub).resolves(adoProvider);

    const service = await factory.getServiceForRepo('/ado/repo');

    assert.ok(service);
    assert.strictEqual(service, adoCreator.firstCall.returnValue);
    assert.ok(adoCreator.calledOnceWithExactly(mockSpawner, mockDetector));
    assert.ok(githubCreator.notCalled);
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
    assert.strictEqual(githubService, githubCreator.firstCall.returnValue);
    assert.strictEqual(adoService, adoCreator.firstCall.returnValue);
  });

  test('uses injected service creators instead of hardcoded classes', async () => {
    let githubCreatorCalled = false;
    let adoCreatorCalled = false;
    const mockGitHubInstance = { type: 'mock-github' } as any;
    const mockAdoInstance = { type: 'mock-ado' } as any;

    const mockGithubCreator = (() => {
      githubCreatorCalled = true;
      return mockGitHubInstance;
    }) as any;
    const mockAdoCreator = (() => {
      adoCreatorCalled = true;
      return mockAdoInstance;
    }) as any;

    const customFactory = new RemotePRServiceFactory(
      mockSpawner,
      mockDetector,
      mockGithubCreator,
      mockAdoCreator,
    );
    
    (mockDetector.detect as sinon.SinonStub).resolves(githubProvider);
    const service = await customFactory.getServiceForRepo('/custom/repo');
    
    assert.ok(githubCreatorCalled);
    assert.ok(!adoCreatorCalled);
    assert.strictEqual(service, mockGitHubInstance);
  });

  test('throws for unsupported provider type', async () => {
    const unknownProvider = { type: 'bitbucket', remoteUrl: 'https://bitbucket.org/x/y' } as any;
    (mockDetector.detect as sinon.SinonStub).resolves(unknownProvider);

    await assert.rejects(
      () => factory.getServiceForRepo('/unknown/repo'),
      /Unsupported remote provider type: bitbucket/,
    );
  });
});
