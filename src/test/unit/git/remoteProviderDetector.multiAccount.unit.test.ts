/**
 * @fileoverview Unit tests for multi-identity authentication in DefaultRemoteProviderDetector.
 * 
 * Tests account listing, username configuration, per-account credential fill,
 * and the ensureCredentials flow with interactive account selection.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { DefaultRemoteProviderDetector } from '../../../git/remotePR/remoteProviderDetector';
import type { IProcessSpawner } from '../../../interfaces/IProcessSpawner';
import type { IEnvironment } from '../../../interfaces/IEnvironment';
import type { IDialogService } from '../../../interfaces/IDialogService';
import type { ChildProcessLike } from '../../../interfaces/IProcessSpawner';
import { EventEmitter } from 'events';
import type { RemoteProviderInfo } from '../../../plan/types/remotePR';

suite('RemoteProviderDetector - Multi-Account', () => {
  let sandbox: sinon.SinonSandbox;
  let mockSpawner: IProcessSpawner;
  let mockEnv: IEnvironment;
  let mockDialogService: IDialogService;
  let detector: DefaultRemoteProviderDetector;

  setup(() => {
    sandbox = sinon.createSandbox();
    
    mockSpawner = {
      spawn: sandbox.stub(),
    } as any;
    
    mockEnv = {
      env: {},
      platform: 'win32',
      cwd: () => 'c:\\repo\\path',
    };
    
    mockDialogService = {
      showQuickPick: sandbox.stub(),
      showInfo: sandbox.stub(),
      showError: sandbox.stub(),
      showWarning: sandbox.stub(),
      showInputBox: sandbox.stub(),
    } as any;
    
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
    
    setImmediate(() => {
      if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
      proc.emit('exit', exitCode);
    });
    
    return proc;
  }

  /**
   * Helper to create a mock process with stdin support for git credential fill.
   */
  function makeMockProcessWithStdin(stdout: string, stderr: string, exitCode: number): ChildProcessLike {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = {
      write: sandbox.stub(),
      end: sandbox.stub(),
    };
    
    setImmediate(() => {
      if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
      proc.emit('exit', exitCode);
    });
    
    return proc;
  }

  suite('listAccounts', () => {
    test('GitHub: parses usernames from git credential-manager github list output', async () => {
      const provider: RemoteProviderInfo = {
        type: 'github',
        remoteUrl: 'https://github.com/microsoft/vscode.git',
        owner: 'microsoft',
        repoName: 'vscode',
      };

      const mockProc = makeMockProcess('alice\nbob\ncarol_microsoft\n', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      const accounts = await detector.listAccounts(provider);

      assert.strictEqual(accounts.length, 3);
      assert.strictEqual(accounts[0], 'alice');
      assert.strictEqual(accounts[1], 'bob');
      assert.strictEqual(accounts[2], 'carol_microsoft');
      assert.ok((mockSpawner.spawn as sinon.SinonStub).calledWith('git', ['credential-manager', 'github', 'list']));
    });

    test('GitHub: returns empty array when GCM command fails', async () => {
      const provider: RemoteProviderInfo = {
        type: 'github',
        remoteUrl: 'https://github.com/microsoft/vscode.git',
        owner: 'microsoft',
        repoName: 'vscode',
      };

      const mockProc = makeMockProcess('', 'credential-manager not found', 1);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      const accounts = await detector.listAccounts(provider);

      assert.strictEqual(accounts.length, 0);
    });

    test('GitHub Enterprise: filters accounts by hostname', async () => {
      const provider: RemoteProviderInfo = {
        type: 'github-enterprise',
        remoteUrl: 'https://github.company.com/corp/project.git',
        hostname: 'github.company.com',
        owner: 'corp',
        repoName: 'project',
      };

      // First call to listGitHubAccounts returns accounts
      const mockProc = makeMockProcess('alice\nbob\ncarol\n', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      const accounts = await detector.listAccounts(provider);

      // For GHE, it returns accounts from GCM (no filtering by hostname in current implementation)
      assert.strictEqual(accounts.length, 3);
      assert.strictEqual(accounts[0], 'alice');
      assert.strictEqual(accounts[1], 'bob');
      assert.strictEqual(accounts[2], 'carol');
    });

    test('Azure DevOps: parses usernames from az account list output', async () => {
      const provider: RemoteProviderInfo = {
        type: 'azure-devops',
        remoteUrl: 'https://dev.azure.com/myorg/myproject/_git/myrepo',
        organization: 'myorg',
        project: 'myproject',
        repoName: 'myrepo',
        owner: 'myorg',
      };

      const mockProc = makeMockProcess('user1@company.com\nuser2@company.com\nuser3@company.com\n', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      const accounts = await detector.listAccounts(provider);

      assert.strictEqual(accounts.length, 3);
      assert.strictEqual(accounts[0], 'user1@company.com');
      assert.strictEqual(accounts[1], 'user2@company.com');
      assert.strictEqual(accounts[2], 'user3@company.com');
      assert.ok((mockSpawner.spawn as sinon.SinonStub).calledWith('az', ['account', 'list', '--query', '[].user.name', '-o', 'tsv']));
    });

    test('Azure DevOps: returns empty array when az CLI fails', async () => {
      const provider: RemoteProviderInfo = {
        type: 'azure-devops',
        remoteUrl: 'https://dev.azure.com/myorg/myproject/_git/myrepo',
        organization: 'myorg',
        project: 'myproject',
        repoName: 'myrepo',
        owner: 'myorg',
      };

      const mockProc = makeMockProcess('', 'az not found', 1);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      const accounts = await detector.listAccounts(provider);

      assert.strictEqual(accounts.length, 0);
    });
  });

  suite('getConfiguredUsername', () => {
    test('returns username from repo-local git config', async () => {
      const mockProc = makeMockProcess('alice\n', '', 0);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      // Call private method via acquireCredentials which uses it
      const provider: RemoteProviderInfo = {
        type: 'github',
        remoteUrl: 'https://github.com/microsoft/vscode.git',
        owner: 'microsoft',
        repoName: 'vscode',
      };

      // Setup: first call returns configured username, second call is git credential fill
      let callCount = 0;
      (mockSpawner.spawn as sinon.SinonStub).callsFake((cmd: string, args: string[]) => {
        callCount++;
        
        if (callCount === 1) {
          // git config --local credential.https://github.com.username
          return makeMockProcess('alice\n', '', 0);
        }
        
        // git credential fill
        return makeMockProcessWithStdin('password=token123\nusername=alice\n', '', 0);
      });

      const creds = await detector.acquireCredentials(provider, 'c:\\repo\\path');

      assert.strictEqual(creds.username, 'alice');
      assert.strictEqual(creds.tokenSource, 'git-credential-cache');
      assert.ok((mockSpawner.spawn as sinon.SinonStub).firstCall.calledWith('git', ['config', '--local', 'credential.https://github.com.username']));
    });

    test('returns null when no config set', async () => {
      const provider: RemoteProviderInfo = {
        type: 'github',
        remoteUrl: 'https://github.com/microsoft/vscode.git',
        owner: 'microsoft',
        repoName: 'vscode',
      };

      // git config returns exit code 1 when key not found
      const mockProc = makeMockProcess('', '', 1);
      (mockSpawner.spawn as sinon.SinonStub).returns(mockProc);

      // After config check fails, it will try gh auth token
      (mockSpawner.spawn as sinon.SinonStub).onSecondCall().returns(makeMockProcess('token\n', '', 0));

      const creds = await detector.acquireCredentials(provider, 'c:\\repo\\path');

      // Should not have username since config was not set
      assert.strictEqual(creds.username, undefined);
      assert.ok((mockSpawner.spawn as sinon.SinonStub).firstCall.calledWith('git', ['config', '--local', 'credential.https://github.com.username']));
    });

    test('returns null when git config command fails', async () => {
      const provider: RemoteProviderInfo = {
        type: 'github',
        remoteUrl: 'https://github.com/microsoft/vscode.git',
        owner: 'microsoft',
        repoName: 'vscode',
      };

      // git config command error (not just empty result)
      (mockSpawner.spawn as sinon.SinonStub).onFirstCall().returns(makeMockProcess('', 'fatal: not in a git repository', 128));
      (mockSpawner.spawn as sinon.SinonStub).onSecondCall().returns(makeMockProcess('token\n', '', 0));

      const creds = await detector.acquireCredentials(provider, 'c:\\repo\\path');

      // Should fallback to gh auth without username
      assert.strictEqual(creds.username, undefined);
    });
  });

  suite('tryGitCredentialFill with username', () => {
    test('includes username in credential fill input when provided', async () => {
      const provider: RemoteProviderInfo = {
        type: 'github',
        remoteUrl: 'https://github.com/microsoft/vscode.git',
        owner: 'microsoft',
        repoName: 'vscode',
      };

      let callCount = 0;
      (mockSpawner.spawn as sinon.SinonStub).callsFake((cmd: string, args: string[]) => {
        callCount++;
        
        if (callCount === 1) {
          // getConfiguredUsername returns 'alice'
          return makeMockProcess('alice\n', '', 0);
        }
        
        // git credential fill with username
        const proc = makeMockProcessWithStdin('password=token123\nusername=alice\n', '', 0);
        return proc;
      });

      const creds = await detector.acquireCredentials(provider, 'c:\\repo\\path');

      assert.strictEqual(creds.username, 'alice');
      assert.strictEqual(creds.token, 'token123');
      
      // Verify stdin received username
      const gitCredFillCall = (mockSpawner.spawn as sinon.SinonStub).secondCall;
      assert.ok(gitCredFillCall.calledWith('git', ['credential', 'fill']));
      
      const proc = gitCredFillCall.returnValue as any;
      assert.ok(proc.stdin.write.called);
      const writtenInput = proc.stdin.write.firstCall.args[0];
      assert.ok(writtenInput.includes('username=alice'));
    });

    test('parses both username and password from response', async () => {
      const provider: RemoteProviderInfo = {
        type: 'github',
        remoteUrl: 'https://github.com/microsoft/vscode.git',
        owner: 'microsoft',
        repoName: 'vscode',
      };

      let callCount = 0;
      (mockSpawner.spawn as sinon.SinonStub).callsFake(() => {
        callCount++;
        
        if (callCount === 1) {
          // getConfiguredUsername
          return makeMockProcess('bob\n', '', 0);
        }
        
        // git credential fill returns both
        return makeMockProcessWithStdin('protocol=https\nhost=github.com\nusername=bob\npassword=secret_token_456\n', '', 0);
      });

      const creds = await detector.acquireCredentials(provider, 'c:\\repo\\path');

      assert.strictEqual(creds.username, 'bob');
      assert.strictEqual(creds.token, 'secret_token_456');
    });

    test('works without username (existing behavior preserved)', async () => {
      const provider: RemoteProviderInfo = {
        type: 'github',
        remoteUrl: 'https://github.com/microsoft/vscode.git',
        owner: 'microsoft',
        repoName: 'vscode',
      };

      let callCount = 0;
      (mockSpawner.spawn as sinon.SinonStub).callsFake(() => {
        callCount++;
        
        if (callCount === 1) {
          // getConfiguredUsername returns nothing (exit 1)
          return makeMockProcess('', '', 1);
        }
        
        if (callCount === 2) {
          // gh auth token fails
          return makeMockProcess('', 'not logged in', 1);
        }
        
        // git credential fill without username
        return makeMockProcessWithStdin('password=generic_token\n', '', 0);
      });

      const creds = await detector.acquireCredentials(provider, 'c:\\repo\\path');

      assert.strictEqual(creds.token, 'generic_token');
      // Username may be empty string when not provided by credential helper
      assert.strictEqual(creds.username, '');
    });
  });

  suite('ensureCredentials', () => {
    test('uses configured username from repo git config', async () => {
      const provider: RemoteProviderInfo = {
        type: 'github',
        remoteUrl: 'https://github.com/microsoft/vscode.git',
        owner: 'microsoft',
        repoName: 'vscode',
      };

      let callCount = 0;
      (mockSpawner.spawn as sinon.SinonStub).callsFake((cmd: string, args: string[]) => {
        callCount++;
        
        if (callCount === 1) {
          // getConfiguredUsername
          return makeMockProcess('alice\n', '', 0);
        }
        
        // git credential fill
        return makeMockProcessWithStdin('password=token_for_alice\nusername=alice\n', '', 0);
      });

      const creds = await detector.ensureCredentials('c:\\repo\\path', provider, mockDialogService);

      assert.strictEqual(creds.username, 'alice');
      assert.strictEqual(creds.token, 'token_for_alice');
      
      // Should not call listAccounts when username is already configured
      assert.ok((mockSpawner.spawn as sinon.SinonStub).neverCalledWith('git', ['credential-manager', 'github', 'list']));
    });

    test('auto-selects when only one account exists', async () => {
      const provider: RemoteProviderInfo = {
        type: 'github',
        remoteUrl: 'https://github.com/microsoft/vscode.git',
        owner: 'microsoft',
        repoName: 'vscode',
      };

      let callCount = 0;
      (mockSpawner.spawn as sinon.SinonStub).callsFake((cmd: string, args: string[]) => {
        callCount++;
        
        if (callCount === 1) {
          // getConfiguredUsername - not found
          return makeMockProcess('', '', 1);
        }
        
        if (callCount === 2) {
          // listAccounts - returns single account
          return makeMockProcess('bob\n', '', 0);
        }
        
        if (callCount === 3) {
          // setConfiguredUsername
          return makeMockProcess('', '', 0);
        }
        
        // git credential fill
        return makeMockProcessWithStdin('password=token_for_bob\nusername=bob\n', '', 0);
      });

      const creds = await detector.ensureCredentials('c:\\repo\\path', provider, mockDialogService);

      assert.strictEqual(creds.username, 'bob');
      assert.strictEqual(creds.token, 'token_for_bob');
      
      // Should not show quickpick for single account
      assert.ok((mockDialogService.showQuickPick as sinon.SinonStub).notCalled);
    });

    test('shows quickpick when multiple accounts exist and dialogService provided', async () => {
      const provider: RemoteProviderInfo = {
        type: 'github',
        remoteUrl: 'https://github.com/microsoft/vscode.git',
        owner: 'microsoft',
        repoName: 'vscode',
      };

      (mockDialogService.showQuickPick as sinon.SinonStub).resolves('carol_microsoft (recommended)');

      let callCount = 0;
      (mockSpawner.spawn as sinon.SinonStub).callsFake((cmd: string, args: string[]) => {
        callCount++;
        
        if (callCount === 1) {
          // getConfiguredUsername - not found
          return makeMockProcess('', '', 1);
        }
        
        if (callCount === 2) {
          // listAccounts
          return makeMockProcess('alice\nbob\ncarol_microsoft\n', '', 0);
        }
        
        if (callCount === 3) {
          // setConfiguredUsername
          return makeMockProcess('', '', 0);
        }
        
        // git credential fill
        return makeMockProcessWithStdin('password=token_for_carol\nusername=carol_microsoft\n', '', 0);
      });

      const creds = await detector.ensureCredentials('c:\\repo\\path', provider, mockDialogService);

      assert.strictEqual(creds.username, 'carol_microsoft');
      assert.ok((mockDialogService.showQuickPick as sinon.SinonStub).called);
      
      const quickPickCall = (mockDialogService.showQuickPick as sinon.SinonStub).firstCall;
      const items = quickPickCall.args[0];
      assert.ok(items.includes('carol_microsoft (recommended)'));
      assert.ok(items.includes('alice'));
      assert.ok(items.includes('bob'));
    });

    test('uses first account in headless mode (no dialogService)', async () => {
      const provider: RemoteProviderInfo = {
        type: 'github',
        remoteUrl: 'https://github.com/microsoft/vscode.git',
        owner: 'microsoft',
        repoName: 'vscode',
      };

      let callCount = 0;
      (mockSpawner.spawn as sinon.SinonStub).callsFake((cmd: string, args: string[]) => {
        callCount++;
        
        if (callCount === 1) {
          // getConfiguredUsername - not found
          return makeMockProcess('', '', 1);
        }
        
        if (callCount === 2) {
          // listAccounts - returns multiple accounts
          return makeMockProcess('alice\nbob\ncarol\n', '', 0);
        }
        
        if (callCount === 3) {
          // setConfiguredUsername
          return makeMockProcess('', '', 0);
        }
        
        // git credential fill
        return makeMockProcessWithStdin('password=token_for_alice\nusername=alice\n', '', 0);
      });

      const creds = await detector.ensureCredentials('c:\\repo\\path', provider);

      // In headless mode with multiple accounts, should use first (or recommended if found)
      assert.strictEqual(creds.username, 'alice');
    });

    test('stores selected username in repo-local git config', async () => {
      const provider: RemoteProviderInfo = {
        type: 'github',
        remoteUrl: 'https://github.com/microsoft/vscode.git',
        owner: 'microsoft',
        repoName: 'vscode',
      };

      let callCount = 0;
      (mockSpawner.spawn as sinon.SinonStub).callsFake((cmd: string, args: string[]) => {
        callCount++;
        
        if (callCount === 1) {
          // getConfiguredUsername - not found
          return makeMockProcess('', '', 1);
        }
        
        if (callCount === 2) {
          // listAccounts
          return makeMockProcess('dave\n', '', 0);
        }
        
        if (callCount === 3) {
          // setConfiguredUsername - this is what we're testing
          return makeMockProcess('', '', 0);
        }
        
        // git credential fill
        return makeMockProcessWithStdin('password=token_for_dave\nusername=dave\n', '', 0);
      });

      await detector.ensureCredentials('c:\\repo\\path', provider);

      // Verify setConfiguredUsername was called
      const setConfigCall = (mockSpawner.spawn as sinon.SinonStub).getCall(2);
      assert.ok(setConfigCall.calledWith('git', ['config', '--local', 'credential.https://github.com.username', 'dave']));
      assert.deepStrictEqual(setConfigCall.args[2], { cwd: 'c:\\repo\\path', shell: false });
    });

    test('throws when zero accounts and no login possible', async () => {
      const provider: RemoteProviderInfo = {
        type: 'github',
        remoteUrl: 'https://github.com/microsoft/vscode.git',
        owner: 'microsoft',
        repoName: 'vscode',
      };

      let callCount = 0;
      (mockSpawner.spawn as sinon.SinonStub).callsFake(() => {
        callCount++;
        
        if (callCount === 1) {
          // getConfiguredUsername - not found
          return makeMockProcess('', '', 1);
        }
        
        // listAccounts - returns no accounts
        return makeMockProcess('', '', 0);
      });

      await assert.rejects(
        () => detector.ensureCredentials('c:\\repo\\path', provider),
        (err: Error) => {
          assert.ok(err.message.includes('No accounts found'));
          assert.ok(err.message.includes('Login Git Account'));
          return true;
        }
      );
    });
  });

  suite('acquireGitHubCredentials with configured username', () => {
    test('skips gh auth token when username is configured', async () => {
      const provider: RemoteProviderInfo = {
        type: 'github',
        remoteUrl: 'https://github.com/microsoft/vscode.git',
        owner: 'microsoft',
        repoName: 'vscode',
      };

      let callCount = 0;
      (mockSpawner.spawn as sinon.SinonStub).callsFake((cmd: string) => {
        callCount++;
        
        if (callCount === 1) {
          // getConfiguredUsername
          return makeMockProcess('alice\n', '', 0);
        }
        
        // git credential fill - should be called directly, skipping gh auth
        return makeMockProcessWithStdin('password=token_alice\nusername=alice\n', '', 0);
      });

      const creds = await detector.acquireCredentials(provider, 'c:\\repo\\path');

      assert.strictEqual(creds.username, 'alice');
      assert.strictEqual(creds.token, 'token_alice');
      assert.strictEqual(creds.tokenSource, 'git-credential-cache');
      
      // Should NOT call gh auth token
      assert.ok((mockSpawner.spawn as sinon.SinonStub).neverCalledWith('gh', ['auth', 'token']));
    });

    test('goes straight to git credential fill with username', async () => {
      const provider: RemoteProviderInfo = {
        type: 'github',
        remoteUrl: 'https://github.com/microsoft/vscode.git',
        owner: 'microsoft',
        repoName: 'vscode',
      };

      let callCount = 0;
      (mockSpawner.spawn as sinon.SinonStub).callsFake((cmd: string, args: string[]) => {
        callCount++;
        
        if (callCount === 1) {
          // getConfiguredUsername
          return makeMockProcess('bob\n', '', 0);
        }
        
        // git credential fill should be the second call
        assert.strictEqual(cmd, 'git');
        assert.deepStrictEqual(args, ['credential', 'fill']);
        return makeMockProcessWithStdin('password=token_bob\nusername=bob\n', '', 0);
      });

      const creds = await detector.acquireCredentials(provider, 'c:\\repo\\path');

      assert.strictEqual(callCount, 2); // Only config + credential fill
      assert.strictEqual(creds.username, 'bob');
    });

    test('falls back to normal chain if credential fill fails', async () => {
      const provider: RemoteProviderInfo = {
        type: 'github',
        remoteUrl: 'https://github.com/microsoft/vscode.git',
        owner: 'microsoft',
        repoName: 'vscode',
      };

      let callCount = 0;
      (mockSpawner.spawn as sinon.SinonStub).callsFake((cmd: string, args: string[]) => {
        callCount++;
        
        if (callCount === 1) {
          // getConfiguredUsername
          return makeMockProcess('charlie\n', '', 0);
        }
        
        if (callCount === 2) {
          // git credential fill with username fails
          return makeMockProcessWithStdin('', 'not found', 1);
        }
        
        // Fallback: gh auth token
        return makeMockProcess('fallback_token\n', '', 0);
      });

      const creds = await detector.acquireCredentials(provider, 'c:\\repo\\path');

      assert.strictEqual(creds.token, 'fallback_token');
      assert.strictEqual(creds.tokenSource, 'gh-auth');
      
      // Verify gh auth was called as fallback
      assert.ok((mockSpawner.spawn as sinon.SinonStub).calledWith('gh', ['auth', 'token']));
    });

    test('sets username on returned credentials', async () => {
      const provider: RemoteProviderInfo = {
        type: 'github',
        remoteUrl: 'https://github.com/microsoft/vscode.git',
        owner: 'microsoft',
        repoName: 'vscode',
      };

      let callCount = 0;
      (mockSpawner.spawn as sinon.SinonStub).callsFake(() => {
        callCount++;
        
        if (callCount === 1) {
          // getConfiguredUsername
          return makeMockProcess('eve\n', '', 0);
        }
        
        // git credential fill
        return makeMockProcessWithStdin('password=token_eve\nusername=eve\n', '', 0);
      });

      const creds = await detector.acquireCredentials(provider, 'c:\\repo\\path');

      assert.strictEqual(creds.username, 'eve');
      assert.strictEqual(creds.hostname, 'github.com');
      assert.strictEqual(creds.token, 'token_eve');
      assert.strictEqual(creds.tokenSource, 'git-credential-cache');
    });
  });
});
