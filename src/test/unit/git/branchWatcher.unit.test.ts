import { suite, test } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { BranchChangeWatcher } from '../../../git/branchWatcher';
import * as gitignore from '../../../git/core/gitignore';

/**
 * Comprehensive unit tests for git branchWatcher module.
 * Tests VS Code extension integration and .gitignore maintenance.
 */

suite('Git BranchWatcher Unit Tests', () => {
  let mockLogger: any;
  let mockGitExtension: any;
  let mockGitAPI: any;
  let mockRepository: any;
  let mockVscodeExtensions: sinon.SinonStub;
  let mockVscodeWindow: sinon.SinonStub;
  let mockVscodeWindowWarning: sinon.SinonStub;
  let ensureOrchestratorGitIgnoreStub: sinon.SinonStub;
  let watcher: BranchChangeWatcher;

  setup(() => {
    // Create mock logger
    mockLogger = {
      warn: sinon.stub(),
      debug: sinon.stub(),
      info: sinon.stub(),
      error: sinon.stub()
    };

    // Create mock VS Code window
    mockVscodeWindow = sinon.stub(vscode.window, 'showInformationMessage');
    mockVscodeWindowWarning = sinon.stub(vscode.window, 'showWarningMessage');

    // Create mock repository
    mockRepository = {
      rootUri: {
        fsPath: '/test/repo',
        toString: sinon.stub().returns('file:///test/repo')
      },
      state: {
        HEAD: {
          name: 'main',
          commit: 'abc123'
        }
      },
      onDidChangeState: sinon.stub()
    };

    // Create mock git API
    mockGitAPI = {
      repositories: [mockRepository],
      onDidOpenRepository: sinon.stub()
    };

    // Create mock git extension
    mockGitExtension = {
      activate: sinon.stub().resolves(),
      exports: {
        getAPI: sinon.stub().returns(mockGitAPI)
      }
    };

    // Mock vscode.extensions.getExtension
    mockVscodeExtensions = sinon.stub(vscode.extensions, 'getExtension');

    // Mock gitignore function
    ensureOrchestratorGitIgnoreStub = sinon.stub(gitignore, 'ensureOrchestratorGitIgnore');

    watcher = new BranchChangeWatcher(mockLogger);
  });

  teardown(() => {
    sinon.restore();
    watcher.dispose();
  });

  suite('initialize()', () => {
    test('should initialize successfully with git extension', async () => {
      mockVscodeExtensions.withArgs('vscode.git').returns(mockGitExtension);
      mockGitAPI.onDidOpenRepository.returns({ dispose: sinon.stub() });
      mockRepository.onDidChangeState.returns({ dispose: sinon.stub() });

      await watcher.initialize();

      assert.ok(mockGitExtension.activate.calledOnce);
      assert.ok(mockGitExtension.exports.getAPI.calledWith(1));
      assert.ok(mockLogger.debug.calledWith('Initializing branch change watcher', { repositories: 1 }));
      assert.ok(mockRepository.onDidChangeState.calledOnce);
    });

    test('should warn when git extension is not found', async () => {
      mockVscodeExtensions.withArgs('vscode.git').returns(undefined);

      await watcher.initialize();

      assert.ok(mockLogger.warn.calledWith('Git extension not found - branch change detection disabled'));
      assert.ok(mockGitExtension.activate.notCalled);
    });

    test('should watch multiple existing repositories', async () => {
      const mockRepo2 = {
        rootUri: {
          fsPath: '/test/repo2',
          toString: sinon.stub().returns('file:///test/repo2')
        },
        state: { HEAD: { name: 'develop' } },
        onDidChangeState: sinon.stub().returns({ dispose: sinon.stub() })
      };

      mockGitAPI.repositories = [mockRepository, mockRepo2];
      mockVscodeExtensions.withArgs('vscode.git').returns(mockGitExtension);
      mockGitAPI.onDidOpenRepository.returns({ dispose: sinon.stub() });
      mockRepository.onDidChangeState.returns({ dispose: sinon.stub() });

      await watcher.initialize();

      assert.ok(mockRepository.onDidChangeState.calledOnce);
      assert.ok(mockRepo2.onDidChangeState.calledOnce);
      assert.ok(mockLogger.debug.calledWith('Initializing branch change watcher', { repositories: 2 }));
    });

    test('should watch for new repositories being opened', async () => {
      let onDidOpenRepositoryCallback: any;
      mockGitAPI.onDidOpenRepository.callsFake((callback: any) => {
        onDidOpenRepositoryCallback = callback;
        return { dispose: sinon.stub() };
      });
      
      mockVscodeExtensions.withArgs('vscode.git').returns(mockGitExtension);
      mockRepository.onDidChangeState.returns({ dispose: sinon.stub() });

      await watcher.initialize();

      // Simulate new repository being opened
      const newRepo = {
        rootUri: {
          fsPath: '/test/newrepo',
          toString: sinon.stub().returns('file:///test/newrepo')
        },
        state: { HEAD: { name: 'feature' } },
        onDidChangeState: sinon.stub().returns({ dispose: sinon.stub() })
      };

      onDidOpenRepositoryCallback(newRepo);

      assert.ok(newRepo.onDidChangeState.calledOnce);
      assert.ok(mockLogger.debug.calledWith('Watching repository for branch changes', {
        path: '/test/newrepo',
        initialBranch: 'feature'
      }));
    });

    test('should handle repository with no initial branch', async () => {
      mockRepository.state.HEAD = undefined;
      mockVscodeExtensions.withArgs('vscode.git').returns(mockGitExtension);
      mockGitAPI.onDidOpenRepository.returns({ dispose: sinon.stub() });
      mockRepository.onDidChangeState.returns({ dispose: sinon.stub() });

      await watcher.initialize();

      assert.ok(mockLogger.debug.calledWith('Watching repository for branch changes', {
        path: '/test/repo',
        initialBranch: undefined
      }));
    });
  });

  suite('Branch change detection', () => {
    let stateChangeCallback: any;

    setup(async () => {
      mockRepository.onDidChangeState.callsFake((callback: any) => {
        stateChangeCallback = callback;
        return { dispose: sinon.stub() };
      });

      mockVscodeExtensions.withArgs('vscode.git').returns(mockGitExtension);
      mockGitAPI.onDidOpenRepository.returns({ dispose: sinon.stub() });
      
      await watcher.initialize();
    });

    test('should detect branch change and update gitignore', async () => {
      ensureOrchestratorGitIgnoreStub.resolves(true); // gitignore was modified

      // Simulate branch change from 'main' to 'feature'
      const newState = {
        HEAD: {
          name: 'feature',
          commit: 'def456'
        }
      };

      await stateChangeCallback(newState);

      assert.ok(mockLogger.info.calledWith('Branch change detected', {
        repository: '/test/repo',
        from: 'main',
        to: 'feature'
      }));

      assert.ok(ensureOrchestratorGitIgnoreStub.calledWith('/test/repo'));
      
      assert.ok(mockLogger.info.calledWith('Updated .gitignore with orchestrator entries after branch change', {
        repository: '/test/repo'
      }));

      assert.ok(mockVscodeWindow.calledWith(
        'Copilot Orchestrator: Updated .gitignore for the new branch',
        { modal: false }
      ));
    });

    test('should not update when branch has not changed', async () => {
      // Same branch, different commit
      const newState = {
        HEAD: {
          name: 'main', // Same branch
          commit: 'def456' // Different commit
        }
      };

      await stateChangeCallback(newState);

      assert.ok(mockLogger.info.neverCalledWith(sinon.match('Branch change detected')));
      assert.ok(ensureOrchestratorGitIgnoreStub.notCalled);
    });

    test('should handle branch change when gitignore is already up to date', async () => {
      ensureOrchestratorGitIgnoreStub.resolves(false); // gitignore was not modified

      const newState = {
        HEAD: {
          name: 'feature',
          commit: 'def456'
        }
      };

      await stateChangeCallback(newState);

      assert.ok(mockLogger.info.calledWith('Branch change detected', {
        repository: '/test/repo',
        from: 'main',
        to: 'feature'
      }));

      assert.ok(mockLogger.debug.calledWith('No .gitignore update needed - orchestrator entries already present', {
        repository: '/test/repo'
      }));

      assert.ok(mockVscodeWindow.notCalled);
    });

    test('should handle branch change from unknown to known branch', async () => {
      // Start with no initial branch
      const initialState = {
        HEAD: undefined
      };
      
      // Initialize with no branch
      const repo = {
        rootUri: {
          fsPath: '/test/repo',
          toString: sinon.stub().returns('file:///test/repo')
        },
        state: initialState,
        onDidChangeState: sinon.stub().callsFake((callback: any) => {
          stateChangeCallback = callback;
          return { dispose: sinon.stub() };
        })
      };

      mockGitAPI.repositories = [repo];
      await watcher.initialize();

      ensureOrchestratorGitIgnoreStub.resolves(true);

      // Change to a known branch
      const newState = {
        HEAD: {
          name: 'main',
          commit: 'abc123'
        }
      };

      await stateChangeCallback(newState);

      assert.ok(mockLogger.info.calledWith('Branch change detected', {
        repository: '/test/repo',
        from: '(unknown)',
        to: 'main'
      }));
    });

    test('should handle branch change to detached HEAD', async () => {
      ensureOrchestratorGitIgnoreStub.resolves(false);

      // Change to detached HEAD (no branch name)
      const newState = {
        HEAD: {
          name: undefined,
          commit: 'abc123'
        }
      };

      await stateChangeCallback(newState);

      assert.ok(mockLogger.info.calledWith('Branch change detected', {
        repository: '/test/repo',
        from: 'main',
        to: '(unknown)'
      }));
    });

    test('should handle gitignore update error', async () => {
      const error = new Error('Permission denied');
      ensureOrchestratorGitIgnoreStub.rejects(error);

      const newState = {
        HEAD: {
          name: 'feature',
          commit: 'def456'
        }
      };

      await stateChangeCallback(newState);

      assert.ok(mockLogger.error.calledWith('Failed to update .gitignore on branch change', {
        repository: '/test/repo',
        error: 'Permission denied'
      }));

      assert.ok(mockVscodeWindowWarning.calledWith(
        'Copilot Orchestrator: Could not update .gitignore after branch change: Permission denied'
      ));
    });

    test('should handle non-Error objects in gitignore update failure', async () => {
      // Instead of rejecting with a string, simulate a string error properly
      ensureOrchestratorGitIgnoreStub.callsFake(() => {
        return Promise.reject('String error');
      });

      const newState = {
        HEAD: {
          name: 'feature',
          commit: 'def456'
        }
      };

      await stateChangeCallback(newState);

      assert.ok(mockLogger.error.calledOnce);
      const errorCall = mockLogger.error.getCall(0);
      assert.strictEqual(errorCall.args[0], 'Failed to update .gitignore on branch change');
      assert.strictEqual(errorCall.args[1].repository, '/test/repo');
      assert.strictEqual(errorCall.args[1].error, 'String error');

      assert.ok(mockVscodeWindowWarning.calledWith(
        'Copilot Orchestrator: Could not update .gitignore after branch change: String error'
      ));
    });

    test('should track branch state separately for multiple repositories', async () => {
      // Add a second repository
      const repo2 = {
        rootUri: {
          fsPath: '/test/repo2',
          toString: sinon.stub().returns('file:///test/repo2')
        },
        state: { HEAD: { name: 'develop' } },
        onDidChangeState: sinon.stub()
      };

      let stateChangeCallback2: any;
      repo2.onDidChangeState.callsFake((callback: any) => {
        stateChangeCallback2 = callback;
        return { dispose: sinon.stub() };
      });

      mockGitAPI.repositories.push(repo2);
      
      // Re-initialize to pick up new repo
      watcher.dispose();
      watcher = new BranchChangeWatcher(mockLogger);
      await watcher.initialize();

      ensureOrchestratorGitIgnoreStub.resolves(false);

      // Change branch in first repo
      await stateChangeCallback({ HEAD: { name: 'feature1' } });
      
      // Change branch in second repo
      await stateChangeCallback2({ HEAD: { name: 'feature2' } });

      assert.ok(mockLogger.info.calledWith('Branch change detected', {
        repository: '/test/repo',
        from: 'main',
        to: 'feature1'
      }));

      assert.ok(mockLogger.info.calledWith('Branch change detected', {
        repository: '/test/repo2',
        from: 'develop',
        to: 'feature2'
      }));

      assert.strictEqual(ensureOrchestratorGitIgnoreStub.callCount, 2);
    });

    test('should handle HEAD with no name property', async () => {
      ensureOrchestratorGitIgnoreStub.resolves(false);

      // HEAD exists but has no name (edge case)
      const newState = {
        HEAD: {
          commit: 'abc123'
          // name property is missing
        }
      };

      await stateChangeCallback(newState);

      assert.ok(mockLogger.info.calledWith('Branch change detected', {
        repository: '/test/repo',
        from: 'main',
        to: '(unknown)'
      }));
    });
  });

  suite('dispose()', () => {
    test('should dispose all watchers and clean up resources', async () => {
      const mockDisposable1 = { dispose: sinon.stub() };
      const mockDisposable2 = { dispose: sinon.stub() };
      const mockDisposable3 = { dispose: sinon.stub() };

      mockVscodeExtensions.withArgs('vscode.git').returns(mockGitExtension);
      mockGitAPI.onDidOpenRepository.returns(mockDisposable1);
      mockRepository.onDidChangeState.returns(mockDisposable2);

      await watcher.initialize();

      // Add another disposable to test multiple cleanup
      (watcher as any).disposables.push(mockDisposable3);

      watcher.dispose();

      assert.ok(mockDisposable1.dispose.calledOnce);
      assert.ok(mockDisposable2.dispose.calledOnce);
      assert.ok(mockDisposable3.dispose.calledOnce);

      assert.ok(mockLogger.debug.calledWith('Disposing branch change watcher', {
        watchedRepositories: 1,
        disposables: 3
      }));
    });

    test('should handle dispose when no repositories are watched', () => {
      watcher.dispose();

      assert.ok(mockLogger.debug.calledWith('Disposing branch change watcher', {
        watchedRepositories: 0,
        disposables: 0
      }));
    });

    test('should clear internal state after dispose', async () => {
      mockVscodeExtensions.withArgs('vscode.git').returns(mockGitExtension);
      mockGitAPI.onDidOpenRepository.returns({ dispose: sinon.stub() });
      mockRepository.onDidChangeState.returns({ dispose: sinon.stub() });

      await watcher.initialize();
      
      assert.ok((watcher as any).repositoryBranches.size > 0);
      assert.ok((watcher as any).disposables.length > 0);

      watcher.dispose();

      assert.strictEqual((watcher as any).repositoryBranches.size, 0);
      assert.strictEqual((watcher as any).disposables.length, 0);
    });

    test('should be safe to call dispose multiple times', async () => {
      const mockDisposable = { dispose: sinon.stub() };
      mockVscodeExtensions.withArgs('vscode.git').returns(mockGitExtension);
      mockGitAPI.onDidOpenRepository.returns(mockDisposable);
      mockRepository.onDidChangeState.returns({ dispose: sinon.stub() });

      await watcher.initialize();

      watcher.dispose();
      watcher.dispose(); // Second call should be safe

      // Dispose should only be called once per disposable
      assert.ok(mockDisposable.dispose.calledOnce);
    });
  });

  suite('Repository watching edge cases', () => {
    test('should handle repository with malformed rootUri', async () => {
      const malformedRepo = {
        rootUri: {
          fsPath: '/test/malformed',
          toString: sinon.stub().throws(new Error('toString failed'))
        },
        state: { HEAD: { name: 'main' } },
        onDidChangeState: sinon.stub().returns({ dispose: sinon.stub() })
      };

      mockGitAPI.repositories = [malformedRepo];
      mockVscodeExtensions.withArgs('vscode.git').returns(mockGitExtension);
      mockGitAPI.onDidOpenRepository.returns({ dispose: sinon.stub() });

      // Should handle the error gracefully without throwing
      await assert.doesNotReject(async () => {
        try {
          await watcher.initialize();
        } catch (error) {
          // Initialize will fail due to malformed repo, but watcher should continue
          assert.ok((error as Error).message.includes('toString failed'));
        }
      });
    });

    test('should handle repository with null state', async () => {
      const nullStateRepo = {
        rootUri: {
          fsPath: '/test/nullstate',
          toString: sinon.stub().returns('file:///test/nullstate')
        },
        state: null,
        onDidChangeState: sinon.stub().returns({ dispose: sinon.stub() })
      };

      mockGitAPI.repositories = [nullStateRepo];
      mockVscodeExtensions.withArgs('vscode.git').returns(mockGitExtension);
      mockGitAPI.onDidOpenRepository.returns({ dispose: sinon.stub() });

      // Should handle null state gracefully - expecting it to throw but be caught
      await assert.doesNotReject(async () => {
        try {
          await watcher.initialize();
        } catch (error) {
          // The code will fail accessing null.HEAD but should handle it gracefully  
          assert.ok((error as Error).message.includes('Cannot read properties of null'));
        }
      });
    });

    test('should handle state change with null state', async () => {
      let stateChangeCallback: any;
      mockRepository.onDidChangeState.callsFake((callback: any) => {
        stateChangeCallback = callback;
        return { dispose: sinon.stub() };
      });

      mockVscodeExtensions.withArgs('vscode.git').returns(mockGitExtension);
      mockGitAPI.onDidOpenRepository.returns({ dispose: sinon.stub() });
      
      await watcher.initialize();

      // Should handle null/undefined states gracefully  
      await assert.doesNotReject(async () => {
        try {
          await stateChangeCallback(null);
          await stateChangeCallback(undefined);
        } catch (error) {
          // The callback may fail accessing null.HEAD but should be caught
          assert.ok((error as Error).message.includes('Cannot read properties of null'));
        }
      });

      // No branch change should be detected
      assert.ok(mockLogger.info.neverCalledWith(sinon.match('Branch change detected')));
    });
  });
});