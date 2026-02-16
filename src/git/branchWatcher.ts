/**
 * @fileoverview Branch change detection for .gitignore maintenance.
 * 
 * Monitors VS Code git repositories for branch changes and ensures
 * orchestrator .gitignore entries are present after switching branches.
 * This prevents issues when switching to branches that don't have
 * orchestrator setup or have reverted .gitignore changes.
 * 
 * @module git/branchWatcher
 */

import * as vscode from 'vscode';
import type { ILogger } from '../interfaces/ILogger';
import { ensureOrchestratorGitIgnore } from './core/gitignore';

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
        
        // Ensure .gitignore has orchestrator entries
        await this.ensureGitIgnoreOnBranchChange(workspaceRoot);
      }
    });
    
    this.disposables.push(disposable);
  }
  
  /**
   * Ensure orchestrator .gitignore entries are present after a branch change.
   */
  private async ensureGitIgnoreOnBranchChange(workspaceRoot: string): Promise<void> {
    try {
      const modified = await ensureOrchestratorGitIgnore(workspaceRoot);
      
      if (modified) {
        this.logger.info('Updated .gitignore with orchestrator entries after branch change', {
          repository: workspaceRoot
        });
        
        // Show user notification for awareness
        vscode.window.showInformationMessage(
          'Copilot Orchestrator: Updated .gitignore for the new branch',
          { modal: false }
        );
      } else {
        this.logger.debug('No .gitignore update needed - orchestrator entries already present', {
          repository: workspaceRoot
        });
      }
    } catch (error) {
      this.logger.error('Failed to update .gitignore on branch change', {
        repository: workspaceRoot,
        error: error instanceof Error ? error.message : String(error)
      });
      
      // Show error to user since this affects functionality
      vscode.window.showWarningMessage(
        `Copilot Orchestrator: Could not update .gitignore after branch change: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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