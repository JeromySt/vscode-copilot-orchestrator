/**
 * @fileoverview Worktree Operations - Git worktree management (fully async).
 * 
 * Single responsibility: Create, remove, and query git worktrees.
 * All operations are async to avoid blocking the event loop.
 * 
 * IMPORTANT: Git worktree operations have a race condition when run in parallel.
 * We use a per-repository mutex to serialize worktree add/remove operations.
 * See: https://lore.kernel.org/git/... (git worktree commondir race)
 * 
 * @module git/core/worktrees
 */

import * as fs from 'fs';
import * as path from 'path';
import { execAsync, execAsyncOrThrow, execAsyncOrNull, GitLogger } from './executor';
import * as branches from './branches';

// ============================================================================
// MUTEX FOR WORKTREE OPERATIONS
// ============================================================================

/**
 * Per-repository mutex to prevent git worktree race conditions.
 * Git's `worktree add` and `worktree remove` commands can race when
 * multiple operations happen simultaneously on the same repository,
 * causing "failed to read .git/worktrees/<id>/commondir: No error" errors.
 */
const repoMutexes = new Map<string, Promise<void>>();

/**
 * Acquire a mutex for the given repository path.
 * Returns a release function that must be called when done.
 */
async function acquireRepoMutex(repoPath: string): Promise<() => void> {
  const normalizedPath = path.resolve(repoPath).toLowerCase();
  
  // Wait for any existing operation to complete
  while (repoMutexes.has(normalizedPath)) {
    await repoMutexes.get(normalizedPath);
  }
  
  // Create a new promise that will resolve when we release
  let release: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  
  repoMutexes.set(normalizedPath, promise);
  
  return () => {
    repoMutexes.delete(normalizedPath);
    release!();
  };
}

/**
 * Worktree creation options.
 */
export interface CreateOptions {
  /** Working directory of the main repository */
  repoPath: string;
  /** Path where the worktree will be created */
  worktreePath: string;
  /** Branch name for the worktree */
  branchName: string;
  /** Branch/commit to base the worktree branch on */
  fromRef: string;
  /** Logger function */
  log?: GitLogger;
}

/**
 * Timing breakdown for worktree creation.
 */
export interface CreateTiming {
  worktreeMs: number;
  submoduleMs: number;
  totalMs: number;
}

/**
 * Create a git worktree.
 * 
 * Creates or resets the branch to point at fromRef and creates a worktree
 * with that branch checked out.
 * 
 * @param options - Worktree creation options
 * @throws Error if worktree creation fails
 */
export async function create(options: CreateOptions): Promise<void> {
  await createWithTiming(options);
}

/**
 * Create a git worktree and return timing breakdown.
 * 
 * Creates or resets the branch to point at fromRef and creates a worktree
 * with that branch checked out. For submodules, creates symlinks to the
 * original submodule folders (avoiding expensive re-checkout).
 * 
 * @param options - Worktree creation options
 * @returns Timing breakdown
 * @throws Error if worktree creation fails
 */
export async function createWithTiming(options: CreateOptions): Promise<CreateTiming> {
  const { repoPath, worktreePath, branchName, fromRef, log } = options;
  
  // Acquire mutex to prevent race condition with parallel worktree operations
  const releaseMutex = await acquireRepoMutex(repoPath);
  
  try {
    const totalStart = Date.now();
    
    // Ensure parent directory exists
    const parentDir = path.dirname(worktreePath);
    try {
      await fs.promises.access(parentDir);
    } catch {
      await fs.promises.mkdir(parentDir, { recursive: true });
    }
    
    log?.(`[worktree] Creating worktree at '${worktreePath}' on branch '${branchName}' from '${fromRef}'`);
    
    // Use -B to create or reset the branch to fromRef's HEAD
    const wtAddStart = Date.now();
    await execAsyncOrThrow(['worktree', 'add', '-B', branchName, worktreePath, fromRef], repoPath);
    const worktreeMs = Date.now() - wtAddStart;
    
    log?.(`[worktree] ✓ Created worktree (${worktreeMs}ms)`);
    
    // Setup submodules via symlinks (much faster than full checkout)
    const submoduleMs = await setupSubmoduleSymlinks(repoPath, worktreePath, log);
    
    // Symlink shared directories (node_modules, etc.) for tool availability
    await setupSharedDirectorySymlinks(repoPath, worktreePath, log);
    
    const totalMs = Date.now() - totalStart;
    return { worktreeMs, submoduleMs, totalMs };
  } finally {
    releaseMutex();
  }
}

/**
 * Remove a git worktree (throws on error).
 * 
 * @param worktreePath - Path to the worktree to remove
 * @param repoPath - Path to the main repository
 * @param log - Optional logger
 */
export async function remove(worktreePath: string, repoPath: string, log?: GitLogger): Promise<void> {
  // Acquire mutex to prevent race condition with parallel worktree operations
  const releaseMutex = await acquireRepoMutex(repoPath);
  
  try {
    log?.(`[worktree] Removing worktree at '${worktreePath}'`);
    await execAsyncOrThrow(['worktree', 'remove', worktreePath, '--force'], repoPath);
    await execAsync(['worktree', 'prune'], { cwd: repoPath });
    log?.(`[worktree] ✓ Removed worktree`);
    
    // Git worktree remove sometimes leaves empty directories behind
    try {
      await fs.promises.access(worktreePath);
      await fs.promises.rm(worktreePath, { recursive: true, force: true });
      log?.(`[worktree] ✓ Removed leftover directory`);
    } catch {
      // Ignore - directory doesn't exist or cleanup failed
    }
  } finally {
    releaseMutex();
  }
}

/**
 * Remove a git worktree (returns success/failure, doesn't throw).
 * 
 * @param repoPath - Path to the main repository
 * @param worktreePath - Path to the worktree to remove
 * @param options - Options including force flag and logger
 */
export async function removeSafe(
  repoPath: string,
  worktreePath: string,
  options: { force?: boolean; log?: GitLogger } = {}
): Promise<boolean> {
  const { force = true, log } = options;
  
  // Acquire mutex to prevent race condition with parallel worktree operations
  const releaseMutex = await acquireRepoMutex(repoPath);
  
  try {
    log?.(`[worktree] Removing worktree at '${worktreePath}'`);
    const args = ['worktree', 'remove', worktreePath];
    if (force) {args.push('--force');}
    const result = await execAsync(args, { cwd: repoPath });
    
    if (!result.success) {
      log?.(`[worktree] ⚠ git worktree remove failed: ${result.stderr}`);
    }
    
    // Always prune to clean up stale worktree references
    await execAsync(['worktree', 'prune'], { cwd: repoPath });
    
    if (result.success) {
      log?.(`[worktree] ✓ Removed worktree`);
    }
    
    // Git worktree remove sometimes leaves empty directories behind
    // Clean up any remaining directory
    try {
      await fs.promises.access(worktreePath);
      await fs.promises.rm(worktreePath, { recursive: true, force: true });
      log?.(`[worktree] ✓ Removed leftover directory`);
    } catch {
      // Ignore - directory doesn't exist or cleanup failed
    }
    
    return result.success;
  } finally {
    releaseMutex();
  }
}

/**
 * Create a worktree in detached HEAD mode at a specific commit/branch.
 * 
 * This is useful when you don't need a branch - commits can be merged by SHA.
 * Benefits: No branch to manage/cleanup, no "branch already checked out" errors.
 * 
 * @param repoPath - Path to the main repository
 * @param worktreePath - Path where the worktree will be created
 * @param commitish - Branch name or commit to checkout (detached)
 * @param log - Optional logger
 * @throws Error if worktree creation fails
 */
export async function createDetached(
  repoPath: string,
  worktreePath: string,
  commitish: string,
  log?: GitLogger
): Promise<void> {
  await createDetachedWithTiming(repoPath, worktreePath, commitish, log);
}

/**
 * Create a worktree in detached HEAD mode and return timing info.
 * 
 * This is the preferred method for job worktrees:
 * - No branch created (detached HEAD)
 * - Returns the base commit SHA for tracking
 * - Submodules set up via symlinks
 * 
 * @param repoPath - Path to the main repository
 * @param worktreePath - Path where the worktree will be created
 * @param commitish - Branch name or commit to start from (detached)
 * @param log - Optional logger
 * @returns Timing breakdown and base commit SHA
 */
export async function createDetachedWithTiming(
  repoPath: string,
  worktreePath: string,
  commitish: string,
  log?: GitLogger,
  additionalSymlinkDirs?: string[]
): Promise<CreateTiming & { baseCommit: string }> {
  // Acquire mutex to prevent race condition with parallel worktree operations
  const releaseMutex = await acquireRepoMutex(repoPath);
  
  try {
    const totalStart = Date.now();
    
    // Ensure parent directory exists
    const parentDir = path.dirname(worktreePath);
    try {
      await fs.promises.access(parentDir);
    } catch {
      await fs.promises.mkdir(parentDir, { recursive: true });
    }
    
    // Resolve the commitish to a SHA first (for tracking)
    const resolveResult = await execAsync(['rev-parse', commitish], { cwd: repoPath });
    const baseCommit = resolveResult.success ? resolveResult.stdout.trim() : commitish;
    
    log?.(`[worktree] Creating detached worktree at '${worktreePath}' from '${commitish}' (${baseCommit.slice(0, 8)})`);
    
    // Use --detach to create worktree in detached HEAD mode
    const wtAddStart = Date.now();
    await execAsyncOrThrow(['worktree', 'add', '--detach', worktreePath, commitish], repoPath);
    const worktreeMs = Date.now() - wtAddStart;
    
    log?.(`[worktree] ✓ Created detached worktree (${worktreeMs}ms)`);
    
    // Setup submodules via symlinks
    const submoduleMs = await setupSubmoduleSymlinks(repoPath, worktreePath, log);
    
    // Symlink shared directories (node_modules, etc.) for tool availability
    await setupSharedDirectorySymlinks(repoPath, worktreePath, log, additionalSymlinkDirs);
    
    const totalMs = Date.now() - totalStart;
    return { worktreeMs, submoduleMs, totalMs, baseCommit };
  } finally {
    releaseMutex();
  }
}

/**
 * Create or reuse a detached worktree.
 * 
 * If the worktree already exists and is valid, reuses it.
 * Otherwise creates a new detached worktree.
 * 
 * @param repoPath - Path to the main repository
 * @param worktreePath - Path where the worktree will be created
 * @param commitish - Branch name or commit to start from (detached)
 * @param log - Optional logger
 * @returns Timing breakdown, base commit SHA, and whether it was reused
 */
export async function createOrReuseDetached(
  repoPath: string,
  worktreePath: string,
  commitish: string,
  log?: GitLogger,
  additionalSymlinkDirs?: string[]
): Promise<CreateTiming & { baseCommit: string; reused: boolean }> {
  // Check if worktree already exists and is valid
  if (await isValid(worktreePath)) {
    log?.(`[worktree] Reusing existing worktree at '${worktreePath}'`);
    
    // Get the current HEAD as the base commit
    const headCommit = await getHeadCommit(worktreePath);
    const baseCommit = headCommit || commitish;
    
    return {
      worktreeMs: 0,
      submoduleMs: 0,
      totalMs: 0,
      baseCommit,
      reused: true,
    };
  }
  
  // Create new worktree
  const result = await createDetachedWithTiming(repoPath, worktreePath, commitish, log, additionalSymlinkDirs);
  return { ...result, reused: false };
}

/**
 * Get the current HEAD commit SHA from a worktree.
 */
export async function getHeadCommit(worktreePath: string): Promise<string | null> {
  const result = await execAsync(['rev-parse', 'HEAD'], { cwd: worktreePath });
  return result.success ? result.stdout.trim() : null;
}

/**
 * Check if a path is a valid git worktree.
 */
export async function isValid(worktreePath: string): Promise<boolean> {
  const gitPath = path.join(worktreePath, '.git');
  try {
    await fs.promises.access(worktreePath);
    await fs.promises.access(gitPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the branch name of a worktree.
 */
export async function getBranch(worktreePath: string): Promise<string | null> {
  return branches.currentOrNull(worktreePath);
}

/**
 * List all worktrees for a repository.
 */
export async function list(repoPath: string): Promise<Array<{ path: string; branch: string | null }>> {
  const result = await execAsyncOrNull(['worktree', 'list', '--porcelain'], repoPath);
  if (!result) {return [];}
  
  const worktrees: Array<{ path: string; branch: string | null }> = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  
  for (const line of result.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (currentPath) {
        worktrees.push({ path: currentPath, branch: currentBranch });
      }
      currentPath = line.substring(9);
      currentBranch = null;
    } else if (line.startsWith('branch ')) {
      currentBranch = line.substring(7).replace('refs/heads/', '');
    }
  }
  
  if (currentPath) {
    worktrees.push({ path: currentPath, branch: currentBranch });
  }
  
  return worktrees;
}

/**
 * Prune stale worktree references.
 */
export async function prune(repoPath: string): Promise<void> {
  await execAsync(['worktree', 'prune'], { cwd: repoPath });
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Setup submodules in a worktree using symlinks.
 * 
 * Instead of running expensive `git submodule update --init --recursive`,
 * we create symlinks from the worktree's submodule paths to the original
 * submodule folders in the main repo. This is MUCH faster and works because:
 * - The main repo's submodules are already initialized
 * - Submodule content doesn't typically change between branches
 * - If it does, the user can manually init submodules
 * 
 * Returns time taken in ms (0 if no submodules).
 */
async function setupSubmoduleSymlinks(repoPath: string, worktreePath: string, log?: GitLogger): Promise<number> {
  const gitmodulesPath = path.join(worktreePath, '.gitmodules');
  
  log?.(`[worktree] Checking for submodules at: ${gitmodulesPath}`);
  
  // Check if .gitmodules exists in worktree
  try {
    await fs.promises.access(gitmodulesPath);
    const stats = await fs.promises.stat(gitmodulesPath);
    if (stats.size === 0) {
      log?.(`[worktree] .gitmodules exists but is empty - no submodules`);
      return 0;
    }
    log?.(`[worktree] .gitmodules found (${stats.size} bytes)`);
  } catch (err: any) {
    log?.(`[worktree] No submodules detected: ${err.code || err.message}`);
    return 0;
  }
  
  const submodStart = Date.now();
  
  // Parse .gitmodules to get submodule paths
  const listResult = await execAsync(
    ['config', '--file', gitmodulesPath, '--get-regexp', '^submodule\\..*\\.path$'],
    { cwd: worktreePath }
  );
  
  if (!listResult.success || !listResult.stdout.trim()) {
    log?.(`[worktree] Could not parse .gitmodules`);
    return 0;
  }
  
  const lines = listResult.stdout.trim().split(/\r?\n/).filter(Boolean);
  let symlinksCreated = 0;
  const failedSubmodules: string[] = [];
  
  for (const line of lines) {
    const match = line.match(/^submodule\.(.*?)\.path\s+(.*)$/);
    if (!match) {continue;}
    
    const submoduleName = match[1];
    const submodulePath = match[2];
    
    const sourceInRepo = path.join(repoPath, submodulePath);
    const destInWorktree = path.join(worktreePath, submodulePath);
    
    try {
      // Check if submodule exists in main repo
      const sourceStats = await fs.promises.stat(sourceInRepo);
      if (!sourceStats.isDirectory()) {
        log?.(`[worktree] ⚠ Submodule '${submoduleName}' at '${sourceInRepo}' is not a directory`);
        failedSubmodules.push(submodulePath);
        continue;
      }
      
      // Ensure parent directory exists in worktree
      await fs.promises.mkdir(path.dirname(destInWorktree), { recursive: true });
      
      // Remove any existing file/directory at destination
      try {
        const destStats = await fs.promises.lstat(destInWorktree);
        if (destStats.isSymbolicLink() || destStats.isFile()) {
          await fs.promises.unlink(destInWorktree);
        } else if (destStats.isDirectory()) {
          await fs.promises.rm(destInWorktree, { recursive: true, force: true });
        }
      } catch {
        // Destination doesn't exist, that's fine
      }
      
      // Create symlink (use junction on Windows for directory symlinks without admin rights)
      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
      await fs.promises.symlink(sourceInRepo, destInWorktree, symlinkType);
      
      symlinksCreated++;
      log?.(`[worktree] ✓ Symlinked submodule '${submoduleName}': ${destInWorktree} -> ${sourceInRepo}`);
      
    } catch (err: any) {
      failedSubmodules.push(submodulePath);
      log?.(`[worktree] ⚠ Failed to symlink submodule '${submoduleName}': ${err.message}`);
    }
  }
  
  // If any symlinks failed, fall back to git submodule init for those
  if (failedSubmodules.length > 0) {
    log?.(`[worktree] Falling back to git submodule init for ${failedSubmodules.length} submodule(s)...`);
    
    for (const submodulePath of failedSubmodules) {
      try {
        const initResult = await execAsync(
          ['submodule', 'update', '--init', '--', submodulePath],
          { cwd: worktreePath }
        );
        
        if (initResult.success) {
          log?.(`[worktree] ✓ Initialized submodule '${submodulePath}' via git`);
        } else {
          log?.(`[worktree] ⚠ Failed to init submodule '${submodulePath}': ${initResult.stderr}`);
        }
      } catch (err: any) {
        log?.(`[worktree] ⚠ Exception initializing submodule '${submodulePath}': ${err.message}`);
      }
    }
  }
  
  const submodTime = Date.now() - submodStart;
  
  if (symlinksCreated > 0) {
    log?.(`[worktree] ✓ Created ${symlinksCreated} submodule symlink(s) in ${submodTime}ms`);
  }
  
  // Configure submodule.recurse for git operations
  await execAsync(['config', 'submodule.recurse', 'true'], { cwd: worktreePath });
  
  return submodTime;
}

// =============================================================================
// SHARED DIRECTORY SYMLINKS
// =============================================================================

/**
 * Directories to symlink from the main repo into worktrees.
 *
 * These are read-only, .gitignored directories that agents need for tooling
 * (e.g. node_modules for eslint/tsc, .venv for Python). Adding a symlink is
 * much faster than a full install and ensures the worktree has identical
 * tool versions to the main repo.
 *
 * Requirements for a directory to be safe to symlink:
 * - It MUST be in .gitignore (won't be committed)
 * - It MUST be read-only from the agent's perspective (no npm install)
 * - Internal paths must resolve relative to themselves (node_modules does)
 */
const SHARED_DIRECTORIES = [
  'node_modules',
];

/**
 * Symlink shared directories from the main repo into a worktree.
 *
 * For each directory in {@link SHARED_DIRECTORIES}, if it exists in the main
 * repo and doesn't already exist in the worktree, creates a symlink
 * (junction on Windows) so tools like eslint, tsc, etc. work without
 * a separate `npm install`.
 */
async function setupSharedDirectorySymlinks(
  repoPath: string,
  worktreePath: string,
  log?: GitLogger,
  additionalDirs?: string[]
): Promise<void> {
  const dirs = [...SHARED_DIRECTORIES, ...(additionalDirs || [])];

  // Deduplicate and validate to prevent path traversal
  const seen = new Set<string>();
  const validatedDirs: string[] = [];
  const repoPathNorm = path.resolve(repoPath);

  for (const rawDirName of dirs) {
    const dirName = rawDirName.trim();
    if (!dirName || seen.has(dirName)) {continue;}
    seen.add(dirName);

    // Built-in shared directories are trusted
    if (SHARED_DIRECTORIES.includes(dirName)) {
      validatedDirs.push(dirName);
      continue;
    }

    // Block dangerous directory names
    if (dirName === '.' || dirName === '..' || dirName === '.git' ||
        dirName.startsWith(`.git${path.sep}`)) {
      log?.(`[worktree] Skipping directory '${dirName}': rejected dangerous name`);
      continue;
    }

    const resolved = path.resolve(repoPath, dirName);
    if (!resolved.startsWith(repoPathNorm + path.sep)) {
      log?.(`[worktree] Skipping directory '${dirName}': resolves outside repo (path traversal blocked)`);
      continue;
    }

    validatedDirs.push(dirName);
  }

  for (const dirName of validatedDirs) {
    const sourceDir = path.join(repoPath, dirName);
    const destDir = path.join(worktreePath, dirName);

    try {
      // Check source exists in main repo
      const srcStats = await fs.promises.stat(sourceDir);
      if (!srcStats.isDirectory()) {continue;}

      // Skip if destination already exists (reused worktree)
      try {
        await fs.promises.lstat(destDir);
        log?.(`[worktree] Shared directory '${dirName}' already exists in worktree, skipping`);
        continue;
      } catch {
        // Doesn't exist — good, we'll create the symlink
      }

      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
      await fs.promises.symlink(sourceDir, destDir, symlinkType);
      log?.(`[worktree] ✓ Symlinked shared directory '${dirName}': ${destDir} -> ${sourceDir}`);
    } catch (err: any) {
      log?.(`[worktree] ⚠ Failed to symlink shared directory '${dirName}': ${err.message}`);
    }
  }
}
