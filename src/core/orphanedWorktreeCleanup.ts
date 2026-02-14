/**
 * @fileoverview Orphaned Worktree Cleanup
 * 
 * Detects and cleans up orphaned `.worktrees/` directories that are not
 * associated with any active plan.
 * 
 * @module core/orphanedWorktreeCleanup
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IGitOperations } from '../interfaces/IGitOperations';
import type { PlanInstance } from '../plan/types/plan';

export interface OrphanedWorktreeCleanupOptions {
  /** Paths to repository roots to scan */
  repoPaths: string[];
  /** Map of planId -> PlanInstance for active plans */
  activePlans: Map<string, PlanInstance>;
  /** Git operations interface */
  git: IGitOperations;
  /** Logger for progress reporting */
  logger?: (msg: string) => void;
}

export interface CleanupResult {
  scannedRepos: number;
  orphanedFound: number;
  orphanedCleaned: number;
  errors: string[];
}

/**
 * Scan repositories for orphaned worktree directories and clean them up.
 * 
 * **What constitutes an "orphaned" worktree:**
 * 1. A directory exists in `.worktrees/` folder
 * 2. It is NOT registered with git (`git worktree list` doesn't include it)
 * 3. It is NOT referenced by any active plan's `nodeStates.worktreePath`
 * 
 * **When cleanup runs:**
 * - Triggered asynchronously after extension activation (typically 2-second delay)
 * - Scans all repository paths (from active plans and workspace folders)
 * - Runs in the background and doesn't block extension initialization
 * 
 * **Error handling:**
 * - Continues scanning even if individual worktrees fail to clean
 * - Captures errors and returns them in `CleanupResult.errors`
 * - Safe operation: never removes directories tracked by active plans or git-registered worktrees
 * 
 * **Configuration:**
 * - Can be disabled via `copilotOrchestrator.cleanupOrphanedWorktrees` setting (default: true)
 * 
 * @param options - Scan and cleanup options
 * @returns CleanupResult with counts and any errors encountered
 */
export async function cleanupOrphanedWorktrees(
  options: OrphanedWorktreeCleanupOptions
): Promise<CleanupResult> {
  const { repoPaths, activePlans, git, logger } = options;
  const log = logger || (() => {});
  
  const result: CleanupResult = {
    scannedRepos: 0,
    orphanedFound: 0,
    orphanedCleaned: 0,
    errors: []
  };
  
  // Collect all worktree paths tracked by active plans
  const trackedWorktrees = new Set<string>();
  for (const [, plan] of activePlans) {
    for (const [, state] of plan.nodeStates) {
      if (state.worktreePath && !state.worktreeCleanedUp) {
        trackedWorktrees.add(path.normalize(state.worktreePath).toLowerCase());
      }
    }
  }
  
  log(`Tracked worktrees from active plans: ${trackedWorktrees.size}`);
  
  // Scan each repository
  for (const repoPath of repoPaths) {
    const worktreesDir = path.join(repoPath, '.worktrees');
    
    if (!fs.existsSync(worktreesDir)) {
      continue;
    }
    
    result.scannedRepos++;
    log(`Scanning for orphaned worktrees in: ${worktreesDir}`);
    
    try {
      // Get git-registered worktrees
      const gitWorktrees = await getGitWorktreePaths(repoPath, git);
      const gitWorktreeSet = new Set(gitWorktrees.map(p => path.normalize(p).toLowerCase()));
      
      // Scan .worktrees directory
      const entries = await fs.promises.readdir(worktreesDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        
        const worktreePath = path.join(worktreesDir, entry.name);
        const normalizedPath = path.normalize(worktreePath).toLowerCase();
        
        // Check if orphaned:
        // 1. Not registered with git
        // 2. Not tracked by any active plan
        const isGitRegistered = gitWorktreeSet.has(normalizedPath);
        const isTrackedByPlan = trackedWorktrees.has(normalizedPath);
        
        if (!isGitRegistered && !isTrackedByPlan) {
          result.orphanedFound++;
          log(`Found orphaned worktree: ${worktreePath}`);
          
          try {
            // Try git worktree remove first (in case it's partially registered)
            await git.worktrees.removeSafe(repoPath, worktreePath, { force: true });
            
            // If directory still exists, remove it directly
            if (fs.existsSync(worktreePath)) {
              await fs.promises.rm(worktreePath, { recursive: true, force: true });
            }
            
            result.orphanedCleaned++;
            log(`Cleaned orphaned worktree: ${worktreePath}`);
          } catch (err: any) {
            result.errors.push(`Failed to clean ${worktreePath}: ${err.message}`);
          }
        }
      }
      
      // Check if .worktrees directory is now empty and remove it
      const remainingEntries = await fs.promises.readdir(worktreesDir);
      if (remainingEntries.length === 0) {
        await fs.promises.rmdir(worktreesDir);
        log(`Removed empty .worktrees directory: ${worktreesDir}`);
      }
      
    } catch (err: any) {
      result.errors.push(`Error scanning ${repoPath}: ${err.message}`);
    }
  }
  
  return result;
}

/**
 * Get paths of all git-registered worktrees for a repository.
 */
async function getGitWorktreePaths(repoPath: string, git: IGitOperations): Promise<string[]> {
  try {
    const list = await git.worktrees.list(repoPath);
    return list.map(wt => wt.path);
  } catch {
    return [];
  }
}
