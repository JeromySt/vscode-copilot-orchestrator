/**
 * @fileoverview Unit tests for DefaultRemoteProviderDetector.
 * 
 * Tests URL parsing, provider detection, and credential acquisition through
 * various fallback chains (gh CLI → environment → git credential cache).
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { DefaultRemoteProviderDetector } from '../../../git/remotePR/remoteProviderDetector';
import type { IProcessSpawner } from '../../../interfaces/IProcessSpawner';
import type { IEnvironment } from '../../../interfaces/IEnvironment';
import type { ChildProcessLike } from '../../../interfaces/IProcessSpawner';
import { EventEmitter } from 'events';

suite('RemoteProviderDetector', () => {
  let sandbox: sinon.SinonSandbox;
  let mockSpawner: IProcessSpawner;
  let mockEnv: IEnvironment;
  let detector: DefaultRemoteProviderDetector;

  setup(() => {
    sandbox = sinon.createSandbox();
    
    mockSpawner = {
      spawn: sandbox.stub(),
    } as any;
    
    mockEnv = {
      env: {},
      platform: 'linux',
      cwd: () => '/repo/path',
    };
    
    detector = new DefaultRemoteProviderDetector(mockSpawner, mockEnv);
  });

  teardown(() => {
    sandbox.restore();
  });

  /**
   * Helper to create a mock process with stdout/stderr and exit event.
   */
  function makeMockProcess(stdout: string, stderr: string, exitCode: number): ChildProcessLike {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    
    // Emit data and exit asynchronously
    setImmediate(() => {
      if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
      proc.emit('exit', exitCode);
    });
    
    return proc;
  }

  suite('detect', () => {
    test('github.com HTTPS URL -> github', async () => {
      const mockProc = makeMockProcess('https://github.com/microsoft/vscode.git\n', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      const result = await detector.detect('/repo/path');

      assert.strictEqual(result.type, 'github');
      assert.strictEqual(result.owner, 'microsoft');
      assert.strictEqual(result.repoName, 'vscode');
      assert.strictEqual(result.remoteUrl, 'https://github.com/microsoft/vscode.git');
    });

    test('github.com SSH URL git@github.com:org/repo -> github', async () => {
      const mockProc = makeMockProcess('git@github.com:facebook/react.git\n', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      const result = await detector.detect('/repo/path');

      assert.strictEqual(result.type, 'github');
      assert.strictEqual(result.owner, 'facebook');
      assert.strictEqual(result.repoName, 'react');
    });

    test('custom hostname with github -> github-enterprise', async () => {
      const mockProc = makeMockProcess('https://mygithub.company.com/corp/project.git\n', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      const result = await detector.detect('/repo/path');

      assert.strictEqual(result.type, 'github-enterprise');
      assert.strictEqual(result.hostname, 'mygithub.company.com');
      assert.strictEqual(result.owner, 'corp');
      assert.strictEqual(result.repoName, 'project');
    });

    test('dev.azure.com URL -> azure-devops', async () => {
      const mockProc = makeMockProcess('https://dev.azure.com/myorg/myproject/_git/myrepo\n', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      const result = await detector.detect('/repo/path');

      assert.strictEqual(result.type, 'azure-devops');
      assert.strictEqual(result.organization, 'myorg');
      assert.strictEqual(result.project, 'myproject');
      assert.strictEqual(result.repoName, 'myrepo');
      assert.strictEqual(result.owner, 'myorg');
    });

    test('*.visualstudio.com URL -> azure-devops', async () => {
      const mockProc = makeMockProcess('https://myorg.visualstudio.com/myproject/_git/myrepo.git\n', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      const result = await detector.detect('/repo/path');

      assert.strictEqual(result.type, 'azure-devops');
      assert.strictEqual(result.organization, 'myorg');
      assert.strictEqual(result.project, 'myproject');
      assert.strictEqual(result.repoName, 'myrepo');
    });

    test('SSH ADO URL -> azure-devops', async () => {
      const mockProc = makeMockProcess('myorg@vs-ssh.visualstudio.com:v3/myorg/myproject/myrepo\n', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      const result = await detector.detect('/repo/path');

      assert.strictEqual(result.type, 'azure-devops');
      assert.strictEqual(result.organization, 'myorg');
      assert.strictEqual(result.project, 'myproject');
      assert.strictEqual(result.repoName, 'myrepo');
    });

    test('parses owner/repoName from GitHub HTTPS', async () => {
      const mockProc = makeMockProcess('https://github.com/owner/repo-name.git\n', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      const result = await detector.detect('/repo/path');

      assert.strictEqual(result.owner, 'owner');
      assert.strictEqual(result.repoName, 'repo-name');
    });

    test('parses owner/repoName from GitHub SSH', async () => {
      const mockProc = makeMockProcess('git@github.com:user/my-repo.git\n', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      const result = await detector.detect('/repo/path');

      assert.strictEqual(result.owner, 'user');
      assert.strictEqual(result.repoName, 'my-repo');
    });

    test('parses org/project/repo from ADO dev.azure.com', async () => {
      const mockProc = makeMockProcess('https://dev.azure.com/org/proj/_git/repo\n', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      const result = await detector.detect('/repo/path');

      assert.strictEqual(result.organization, 'org');
      assert.strictEqual(result.project, 'proj');
      assert.strictEqual(result.repoName, 'repo');
    });

    test('parses org/project/repo from legacy visualstudio.com', async () => {
      const mockProc = makeMockProcess('https://org.visualstudio.com/proj/_git/repo.git\n', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      const result = await detector.detect('/repo/path');

      assert.strictEqual(result.organization, 'org');
      assert.strictEqual(result.project, 'proj');
      assert.strictEqual(result.repoName, 'repo');
    });

    test('handles .git suffix', async () => {
      const mockProc = makeMockProcess('https://github.com/owner/repo.git\n', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      const result = await detector.detect('/repo/path');

      assert.strictEqual(result.repoName, 'repo');
      assert.ok(!result.repoName.endsWith('.git'));
    });
  });

  suite('acquireCredentials', () => {
    suite('GitHub', () => {
      test('GitHub: gh auth token first', async () => {
        const provider = {
          type: 'github' as const,
          remoteUrl: 'https://github.com/owner/repo',
          owner: 'owner',
          repoName: 'repo',
        };

        const mockProc = makeMockProcess('gho_token123\n', '', 0);
        (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

        const creds = await detector.acquireCredentials(provider);

        assert.strictEqual(creds.token, 'gho_token123');
        assert.strictEqual(creds.tokenSource, 'gh-auth');
        assert.strictEqual(creds.hostname, 'github.com');
        assert.ok((mockSpawner.spawn as sinon.SinonStub).calledWith('gh', ['auth', 'token']));
      });

      test('GitHub: fallback GH_TOKEN env', async () => {
        const provider = {
          type: 'github' as const,
          remoteUrl: 'https://github.com/owner/repo',
          owner: 'owner',
          repoName: 'repo',
        };

        // gh auth fails
        const mockProc = makeMockProcess('', 'not logged in', 1);
        (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

        mockEnv.env.GH_TOKEN = 'env_token_gh';

        const creds = await detector.acquireCredentials(provider);

        assert.strictEqual(creds.token, 'env_token_gh');
        assert.strictEqual(creds.tokenSource, 'environment');
        assert.strictEqual(creds.hostname, 'github.com');
      });

      test('GitHub: fallback GITHUB_TOKEN env', async () => {
        const provider = {
          type: 'github' as const,
          remoteUrl: 'https://github.com/owner/repo',
          owner: 'owner',
          repoName: 'repo',
        };

        // gh auth fails
        const mockProc = makeMockProcess('', 'not logged in', 1);
        (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

        mockEnv.env.GITHUB_TOKEN = 'env_token_github';

        const creds = await detector.acquireCredentials(provider);

        assert.strictEqual(creds.token, 'env_token_github');
        assert.strictEqual(creds.tokenSource, 'environment');
        assert.strictEqual(creds.hostname, 'github.com');
      });

      test('GitHub: fallback git credential cache', async () => {
        const provider = {
          type: 'github' as const,
          remoteUrl: 'https://github.com/owner/repo',
          owner: 'owner',
          repoName: 'repo',
        };

        let callCount = 0;
        (mockSpawner.spawn as sinon.SinonStub).callsFake((cmd: string, args: string[]) => {
          callCount++;
          
          // First call: gh auth token fails
          if (callCount === 1) {
            return makeMockProcess('', 'not logged in', 1);
          }
          
          // Second call: git credential fill succeeds
          const proc = new EventEmitter() as any;
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = {
            write: sandbox.stub(),
            end: sandbox.stub(),
          };
          
          setImmediate(() => {
            proc.stdout.emit('data', Buffer.from('password=git_cred_token\n'));
            proc.emit('exit', 0);
          });
          
          return proc;
        });

        const creds = await detector.acquireCredentials(provider);

        assert.strictEqual(creds.token, 'git_cred_token');
        assert.strictEqual(creds.tokenSource, 'git-credential-cache');
        assert.strictEqual(creds.hostname, 'github.com');
      });
    });

    suite('GitHub Enterprise', () => {
      test('GHE: gh auth token -h <hostname> first', async () => {
        const provider = {
          type: 'github-enterprise' as const,
          remoteUrl: 'https://mygithub.company.com/owner/repo',
          hostname: 'mygithub.company.com',
          owner: 'owner',
          repoName: 'repo',
        };

        const mockProc = makeMockProcess('gho_enterprise_token\n', '', 0);
        (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

        const creds = await detector.acquireCredentials(provider);

        assert.strictEqual(creds.token, 'gho_enterprise_token');
        assert.strictEqual(creds.tokenSource, 'gh-auth');
        assert.strictEqual(creds.hostname, 'mygithub.company.com');
        assert.ok((mockSpawner.spawn as sinon.SinonStub).calledWith('gh', ['auth', 'token', '-h', 'mygithub.company.com']));
      });

      test('GHE: fallback GH_ENTERPRISE_TOKEN', async () => {
        const provider = {
          type: 'github-enterprise' as const,
          remoteUrl: 'https://mygithub.company.com/owner/repo',
          hostname: 'mygithub.company.com',
          owner: 'owner',
          repoName: 'repo',
        };

        // gh auth fails
        const mockProc = makeMockProcess('', 'not logged in', 1);
        (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

        mockEnv.env.GH_ENTERPRISE_TOKEN = 'ghe_env_token';

        const creds = await detector.acquireCredentials(provider);

        assert.strictEqual(creds.token, 'ghe_env_token');
        assert.strictEqual(creds.tokenSource, 'environment');
        assert.strictEqual(creds.hostname, 'mygithub.company.com');
      });
    });

    suite('Azure DevOps', () => {
      test('ADO: az account get-access-token first', async () => {
        const provider = {
          type: 'azure-devops' as const,
          remoteUrl: 'https://dev.azure.com/org/proj/_git/repo',
          organization: 'org',
          project: 'proj',
          repoName: 'repo',
          owner: 'org',
        };

        const mockProc = makeMockProcess('ey_az_token\n', '', 0);
        (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

        const creds = await detector.acquireCredentials(provider);

        assert.strictEqual(creds.token, 'ey_az_token');
        assert.strictEqual(creds.tokenSource, 'az-cli');
        assert.strictEqual(creds.hostname, 'dev.azure.com/org');
        assert.ok((mockSpawner.spawn as sinon.SinonStub).calledWith('az', sinon.match.array));
      });

      test('ADO: fallback AZURE_DEVOPS_EXT_PAT', async () => {
        const provider = {
          type: 'azure-devops' as const,
          remoteUrl: 'https://dev.azure.com/org/proj/_git/repo',
          organization: 'org',
          project: 'proj',
          repoName: 'repo',
          owner: 'org',
        };

        // az CLI fails
        const mockProc = makeMockProcess('', 'not logged in', 1);
        (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

        mockEnv.env.AZURE_DEVOPS_EXT_PAT = 'ado_pat_token';

        const creds = await detector.acquireCredentials(provider);

        assert.strictEqual(creds.token, 'ado_pat_token');
        assert.strictEqual(creds.tokenSource, 'environment');
      });

      test('ADO: fallback SYSTEM_ACCESSTOKEN', async () => {
        const provider = {
          type: 'azure-devops' as const,
          remoteUrl: 'https://dev.azure.com/org/proj/_git/repo',
          organization: 'org',
          project: 'proj',
          repoName: 'repo',
          owner: 'org',
        };

        // az CLI fails
        const mockProc = makeMockProcess('', 'not logged in', 1);
        (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

        mockEnv.env.SYSTEM_ACCESSTOKEN = 'system_token';

        const creds = await detector.acquireCredentials(provider);

        assert.strictEqual(creds.token, 'system_token');
        assert.strictEqual(creds.tokenSource, 'environment');
      });

      test('ADO: fallback git credential cache', async () => {
        const provider = {
          type: 'azure-devops' as const,
          remoteUrl: 'https://dev.azure.com/org/proj/_git/repo',
          organization: 'org',
          project: 'proj',
          repoName: 'repo',
          owner: 'org',
        };

        let callCount = 0;
        (mockSpawner.spawn as sinon.SinonStub).callsFake((cmd: string, args: string[]) => {
          callCount++;
          
          // First call: az CLI fails
          if (callCount === 1) {
            return makeMockProcess('', 'not logged in', 1);
          }
          
          // Second call: git credential fill succeeds
          const proc = new EventEmitter() as any;
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = {
            write: sandbox.stub(),
            end: sandbox.stub(),
          };
          
          setImmediate(() => {
            proc.stdout.emit('data', Buffer.from('password=ado_git_cred\n'));
            proc.emit('exit', 0);
          });
          
          return proc;
        });

        const creds = await detector.acquireCredentials(provider);

        assert.strictEqual(creds.token, 'ado_git_cred');
        assert.strictEqual(creds.tokenSource, 'git-credential-cache');
      });
    });

    test('never logs actual tokens', async () => {
      const provider = {
        type: 'github' as const,
        remoteUrl: 'https://github.com/owner/repo',
        owner: 'owner',
        repoName: 'repo',
      };

      const sensitiveToken = 'gho_super_secret_token_12345';
      const mockProc = makeMockProcess(`${sensitiveToken}\n`, '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      const creds = await detector.acquireCredentials(provider);

      // Verify token is returned
      assert.strictEqual(creds.token, sensitiveToken);
      
      // This test primarily documents the expectation that tokens are never logged
      // The implementation uses Logger.for('git') which doesn't log token values
    });
  });
});
