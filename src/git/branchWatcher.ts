/**
 * @fileoverview Branch change detection.
 * 
 * Monitors VS Code git repositories for branch changes.
 * 
 * @module git/branchWatcher
 */

import * as vscode from 'vscode';
import type { ILogger } from '../interfaces/ILogger';

/**
 * Git extension types from VS Code built-in git extension
 */
interface GitExtension {
  getAPI(version: number): GitAPI;
}

interface GitAPI {
  repositories: Repository[];
  onDidOpenRepository(listener: (repo: Repository) => void): vscode.Disposable;
}

interface Repository {
  state: RepositoryState;
  onDidChangeState(listener: (state: RepositoryState) => void): vscode.Disposable;
  rootUri: vscode.Uri;
}

interface RepositoryState {
  HEAD?: {
    name?: string;  // Branch name
    commit?: string;
  };
}

/**
 * Watches for branch changes in VS Code git repositories and ensures
 * orchestrator .gitignore entries are maintained.
 */
export class BranchChangeWatcher implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private repositoryBranches = new Map<string, string | undefined>();
  
  constructor(private readonly logger: ILogger) {}
  
  /**
   * Initialize the branch change watcher.
   * Connects to VS Code's git extension and starts monitoring repositories.
   */
  public async initialize(): Promise<void> {
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExtension) {
      this.logger.warn('Git extension not found - branch change detection disabled');
      return;
    }
    
    // Ensure git extension is activated
    await gitExtension.activate();
    const git = gitExtension.exports.getAPI(1);
    
    this.logger.debug('Initializing branch change watcher', { repositories: git.repositories.length });
    
    // Watch existing repositories
    for (const repo of git.repositories) {
      this.watchRepository(repo);
    }
    
    // Watch for new repositories being opened
    this.disposables.push(
      git.onDidOpenRepository(repo => this.watchRepository(repo))
    );
  }
  
  /**
   * Start watching a specific git repository for branch changes.
   */
  private watchRepository(repo: Repository): void {
    const workspaceRoot = repo.rootUri.fsPath;
    const repoKey = repo.rootUri.toString();
    
    // Store initial branch state
    const initialBranch = repo.state.HEAD?.name;
    this.repositoryBranches.set(repoKey, initialBranch);
    
    this.logger.debug('Watching repository for branch changes', { 
      path: workspaceRoot, 
      initialBranch 
    });
    
    // Watch for state changes (includes branch changes, commits, etc.)
    // Guard: some VS Code Git API versions may not expose onDidChangeState
    if (typeof repo.onDidChangeState !== 'function') {
      this.logger.warn('Repository does not support onDidChangeState — skipping watch', { path: workspaceRoot });
      return;
    }
    const disposable = repo.onDidChangeState(async (state) => {
      const currentBranch = state.HEAD?.name;
      const lastBranch = this.repositoryBranches.get(repoKey);
      
      // Check if branch actually changed (not just a commit)
      if (currentBranch !== lastBranch) {
        this.logger.info('Branch change detected', {
          repository: workspaceRoot,
          from: lastBranch || '(unknown)',
          to: currentBranch || '(unknown)'
        });
        
        // Update our tracked branch
        this.repositoryBranches.set(repoKey, currentBranch);
        
        // Note: We intentionally do NOT re-write .gitignore on branch change.
        // The new branch may not have orchestrator entries, but that's fine —
        // planInitialization.ts ensures them on activation, and any plan
        // execution will add them if needed. Eagerly writing .gitignore here
        // creates uncommitted changes that block git checkout operations.
      }
    });
    
    this.disposables.push(disposable);
  }
  
  /**
   * Dispose of all watchers and clean up resources.
   */
  public dispose(): void {
    this.logger.debug('Disposing branch change watcher', { 
      watchedRepositories: this.repositoryBranches.size,
      disposables: this.disposables.length 
    });
    
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    
    this.disposables = [];
    this.repositoryBranches.clear();
  }
}