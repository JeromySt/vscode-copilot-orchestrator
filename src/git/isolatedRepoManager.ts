/**
 * @fileoverview Default implementation of IIsolatedRepoManager.
 * 
 * Manages isolated git clones for release workflows under
 * `.orchestrator/release/<sanitized-branch-name>/`.
 * 
 * @module git/isolatedRepoManager
 */

import * as path from 'path';
import type { IIsolatedRepoManager, IsolatedRepoInfo } from '../interfaces/IIsolatedRepoManager';
import type { IGitOperations } from '../interfaces/IGitOperations';
import type { IFileSystem } from '../interfaces/IFileSystem';
import { Logger } from '../core/logger';
import { execAsync } from './core/executor';

const log = Logger.for('git');

/**
 * Sanitize a branch name for use in a directory path.
 * Replaces characters that are invalid in file paths with hyphens.
 * 
 * @param branch - Branch name to sanitize
 * @returns Sanitized branch name safe for directory names
 */
function sanitizeBranchForDir(branch: string): string {
  // Replace /\:*?"<>| with hyphens
  return branch.replace(/[\/\\:*?"<>|]/g, '-');
}

/**
 * Default implementation of IIsolatedRepoManager.
 */
export class DefaultIsolatedRepoManager implements IIsolatedRepoManager {
  /** Registry of active isolated repositories */
  private readonly _registry = new Map<string, IsolatedRepoInfo>();

  constructor(
    private readonly _git: IGitOperations,
    private readonly _fs: IFileSystem,
  ) {}

  /**
   * Get the clone path for a given repo and branch.
   * Returns path under `.orchestrator/release/<sanitized-branch>/`.
   */
  private _getClonePath(repoPath: string, branch: string): string {
    const sanitized = sanitizeBranchForDir(branch);
    return path.join(repoPath, '.orchestrator', 'release', sanitized);
  }

  /**
   * Validate that a clone path is within the allowed .orchestrator directory.
   * Prevents path traversal attacks.
   */
  private _validateClonePath(repoPath: string, clonePath: string): void {
    const orchestratorDir = path.resolve(repoPath, '.orchestrator');
    const cloneResolved = path.resolve(clonePath);

    if (!cloneResolved.startsWith(orchestratorDir + path.sep)) {
      throw new Error(
        `Security: Clone path must be under .orchestrator/ directory. ` +
        `Attempted: ${clonePath}, Expected under: ${orchestratorDir}`
      );
    }
  }

  /**
   * Get the remote URL for a repository.
   */
  private async _getRemoteUrl(repoPath: string): Promise<string> {
    const result = await execAsync(['config', '--get', 'remote.origin.url'], {
      cwd: repoPath,
      throwOnError: false,
    });
    
    if (!result.success || !result.stdout.trim()) {
      throw new Error(`Failed to get remote URL for ${repoPath}`);
    }
    
    return result.stdout.trim();
  }

  /**
   * Try to clone using --shared (fastest, hardlinks objects).
   * Returns true on success, false on failure.
   */
  private async _tryCloneShared(repoPath: string, clonePath: string): Promise<boolean> {
    log.debug('Attempting clone with --shared', { repoPath, clonePath });
    
    const result = await execAsync(
      ['clone', '--shared', '--no-checkout', repoPath, clonePath],
      {
        cwd: path.dirname(clonePath),
        throwOnError: false,
      }
    );
    
    return result.success;
  }

  /**
   * Try to clone using --reference (alternates, more compatible than --shared).
   * Returns true on success, false on failure.
   */
  private async _tryCloneReference(repoPath: string, clonePath: string): Promise<boolean> {
    log.debug('Attempting clone with --reference', { repoPath, clonePath });
    
    const result = await execAsync(
      ['clone', '--reference', repoPath, repoPath, clonePath],
      {
        cwd: path.dirname(clonePath),
        throwOnError: false,
      }
    );
    
    return result.success;
  }

  /**
   * Try to create using git worktree add as a fallback.
   * Returns true on success, false on failure.
   */
  private async _tryWorktreeAdd(repoPath: string, clonePath: string, branch: string): Promise<boolean> {
    log.debug('Attempting worktree add as fallback', { repoPath, clonePath, branch });
    
    try {
      await this._git.worktrees.createDetachedWithTiming(repoPath, clonePath, branch);
      return true;
    } catch (err: any) {
      log.debug('Worktree add failed', { error: err.message });
      return false;
    }
  }

  async createIsolatedRepo(releaseId: string, repoPath: string, branch: string): Promise<IsolatedRepoInfo> {
    log.info('Creating isolated repo', { releaseId, repoPath, branch });

    // Check if already exists
    if (this._registry.has(releaseId)) {
      const existing = this._registry.get(releaseId)!;
      log.warn('Isolated repo already exists', { releaseId, clonePath: existing.clonePath });
      return existing;
    }

    const clonePath = this._getClonePath(repoPath, branch);
    this._validateClonePath(repoPath, clonePath);

    // Ensure .orchestrator/release/ exists
    const releaseDir = path.dirname(clonePath);
    await this._fs.ensureDirAsync(releaseDir);

    // Ensure .orchestrator/ is in .gitignore
    try {
      await this._git.gitignore.ensureGitignoreEntries(repoPath, ['.orchestrator/']);
    } catch (err: any) {
      log.warn('Failed to update .gitignore', { error: err.message });
    }

    // Try clone strategies in order
    let cloneSucceeded = false;
    
    // Strategy 1: --shared (fastest)
    cloneSucceeded = await this._tryCloneShared(repoPath, clonePath);
    
    // Strategy 2: --reference (fallback)
    if (!cloneSucceeded) {
      cloneSucceeded = await this._tryCloneReference(repoPath, clonePath);
    }
    
    // Strategy 3: git worktree add (last resort)
    if (!cloneSucceeded) {
      cloneSucceeded = await this._tryWorktreeAdd(repoPath, clonePath, branch);
    }
    
    if (!cloneSucceeded) {
      throw new Error(
        `Failed to create isolated repo at ${clonePath}. ` +
        `All clone strategies failed (--shared, --reference, worktree add).`
      );
    }

    log.info('Clone created successfully', { clonePath });

    // Checkout the branch
    try {
      const checkoutResult = await execAsync(['checkout', branch], {
        cwd: clonePath,
        throwOnError: false,
      });
      
      if (!checkoutResult.success) {
        // Try to create the branch if it doesn't exist
        const createResult = await execAsync(['checkout', '-b', branch], {
          cwd: clonePath,
          throwOnError: false,
        });
        
        if (!createResult.success) {
          throw new Error(`Failed to checkout branch ${branch}: ${checkoutResult.stderr}`);
        }
      }
    } catch (err: any) {
      // Cleanup on failure
      await this._fs.rmAsync(clonePath, { recursive: true, force: true });
      throw new Error(`Failed to checkout branch ${branch}: ${err.message}`);
    }

    // Set remote URL to actual origin (not local path)
    try {
      const remoteUrl = await this._getRemoteUrl(repoPath);
      await execAsync(['remote', 'set-url', 'origin', remoteUrl], {
        cwd: clonePath,
        throwOnError: false,
      });
    } catch (err: any) {
      log.warn('Failed to set remote URL', { error: err.message });
    }

    // Register the isolated repo
    const info: IsolatedRepoInfo = {
      releaseId,
      clonePath,
      isReady: true,
      currentBranch: branch,
    };
    
    this._registry.set(releaseId, info);
    log.info('Isolated repo registered', info);
    
    return info;
  }

  async getRepoPath(releaseId: string): Promise<string | null> {
    const info = this._registry.get(releaseId);
    return info ? info.clonePath : null;
  }

  async getRepoInfo(releaseId: string): Promise<IsolatedRepoInfo | null> {
    return this._registry.get(releaseId) ?? null;
  }

  async removeIsolatedRepo(releaseId: string): Promise<boolean> {
    const info = this._registry.get(releaseId);
    if (!info) {
      log.debug('Isolated repo not found for removal', { releaseId });
      return false;
    }

    log.info('Removing isolated repo', { releaseId, clonePath: info.clonePath });

    // Remove from registry first
    this._registry.delete(releaseId);

    // Try to remove directory
    try {
      if (await this._fs.existsAsync(info.clonePath)) {
        await this._fs.rmAsync(info.clonePath, { recursive: true, force: true });
        log.info('Isolated repo directory removed', { clonePath: info.clonePath });
      }
    } catch (err: any) {
      log.error('Failed to remove isolated repo directory', {
        releaseId,
        clonePath: info.clonePath,
        error: err.message,
      });
    }

    return true;
  }

  async cleanupAll(): Promise<number> {
    log.info('Cleaning up all isolated repositories', { count: this._registry.size });
    
    let cleanedCount = 0;
    
    // Cleanup registered repos
    const releaseIds = Array.from(this._registry.keys());
    for (const releaseId of releaseIds) {
      const removed = await this.removeIsolatedRepo(releaseId);
      if (removed) {
        cleanedCount++;
      }
    }

    // Scan for orphaned clones in .orchestrator/release/
    // This handles cases where the extension crashed or was force-stopped
    try {
      // Get unique repo paths from all registered clones (before cleanup)
      const scannedPaths = new Set<string>();
      
      for (const info of this._registry.values()) {
        // Extract repo path from clone path (remove .orchestrator/release/... suffix)
        const parts = info.clonePath.split(path.sep);
        const orchestratorIdx = parts.lastIndexOf('.orchestrator');
        if (orchestratorIdx > 0) {
          const repoPath = parts.slice(0, orchestratorIdx).join(path.sep);
          scannedPaths.add(repoPath);
        }
      }

      // Scan each unique repo for orphaned release clones
      for (const repoPath of scannedPaths) {
        const releaseDir = path.join(repoPath, '.orchestrator', 'release');
        if (await this._fs.existsAsync(releaseDir)) {
          const entries = await this._fs.readdirAsync(releaseDir);
          
          for (const entry of entries) {
            const entryPath = path.join(releaseDir, entry);
            const stat = await this._fs.lstatAsync(entryPath);
            
            if (stat.isDirectory()) {
              // Check if this directory is still in the registry
              const isTracked = Array.from(this._registry.values()).some(
                info => path.normalize(info.clonePath).toLowerCase() === 
                        path.normalize(entryPath).toLowerCase()
              );
              
              if (!isTracked) {
                log.info('Found orphaned isolated repo, removing', { path: entryPath });
                try {
                  await this._fs.rmAsync(entryPath, { recursive: true, force: true });
                  cleanedCount++;
                } catch (err: any) {
                  log.error('Failed to remove orphaned isolated repo', {
                    path: entryPath,
                    error: err.message,
                  });
                }
              }
            }
          }
          
          // Remove release directory if empty
          const remainingEntries = await this._fs.readdirAsync(releaseDir);
          if (remainingEntries.length === 0) {
            await this._fs.rmdirAsync(releaseDir);
            log.info('Removed empty release directory', { path: releaseDir });
          }
        }
      }
    } catch (err: any) {
      log.error('Error scanning for orphaned isolated repos', { error: err.message });
    }

    log.info('Cleanup complete', { cleanedCount });
    return cleanedCount;
  }

  async listActive(): Promise<string[]> {
    return Array.from(this._registry.keys());
  }
}
