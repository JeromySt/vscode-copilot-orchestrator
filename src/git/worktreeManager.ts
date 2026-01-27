/**
 * @fileoverview Git worktree management.
 * 
 * Provides functionality for creating and managing git worktrees,
 * which allow jobs to run in isolated working directories without
 * affecting the main repository state.
 * 
 * @module git/worktreeManager
 */

import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { ensureDir } from '../core/utils';
import { IGitOperations, WorktreeConfig, MergeResult } from '../interfaces/IGitOperations';

/**
 * Logger function type for worktree operations.
 */
export type WorktreeLogger = (message: string) => void;

/**
 * Execute a shell command with logging.
 * @throws Error if command exits with non-zero status
 */
function executeCommand(cmd: string, cwd: string, log: WorktreeLogger): void {
  const result = spawnSync(cmd, { 
    cwd, 
    shell: true, 
    stdio: 'pipe', 
    encoding: 'utf-8' 
  });
  
  if (result.stdout) log(result.stdout);
  if (result.stderr) log(result.stderr);
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${cmd}`);
  }
}

/**
 * Execute a shell command and return the result.
 * Does not throw on failure.
 */
function runCommand(cmd: string, cwd: string): { success: boolean; stdout: string; stderr: string } {
  const result = spawnSync(cmd, { 
    cwd, 
    shell: true, 
    stdio: 'pipe', 
    encoding: 'utf-8' 
  });
  
  return {
    success: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

/**
 * Git operations implementation using git CLI.
 * 
 * Provides worktree management, branch operations, and merge handling
 * for the job orchestration system.
 * 
 * @example
 * ```typescript
 * const git = new GitOperations(console.log);
 * const worktreePath = await git.createWorktree({
 *   repoPath: '/path/to/repo',
 *   baseBranch: 'main',
 *   targetBranch: 'feature/my-change',
 *   worktreeRoot: '.worktrees',
 *   worktreeId: 'job-abc-123'
 * });
 * ```
 */
export class GitOperations implements IGitOperations {
  /** Logger function for git operations */
  private logger: WorktreeLogger;
  
  /**
   * Create a new GitOperations instance.
   * @param logger - Function to log operation output
   */
  constructor(logger: WorktreeLogger = () => {}) {
    this.logger = logger;
  }
  
  /**
   * Create a git worktree for isolated job execution.
   * 
   * This method:
   * 1. Ensures orchestrator directories are in .gitignore
   * 2. Fetches latest changes from remote
   * 3. Creates a new worktree from the base branch
   * 4. Initializes submodules if present
   * 
   * @param config - Worktree configuration
   * @returns Absolute path to the created worktree
   */
  async createWorktree(config: WorktreeConfig): Promise<string> {
    const { repoPath, worktreeRoot, baseBranch, worktreeId } = config;
    
    // Ensure orchestrator directories are in .gitignore
    this.updateGitignore(repoPath, worktreeRoot);
    
    // Fetch latest changes
    executeCommand('git fetch --all --tags', repoPath, this.logger);
    
    // Switch to base branch
    executeCommand(`git switch ${baseBranch}`, repoPath, this.logger);
    
    // Try to pull (non-fatal if fails)
    this.tryPull(repoPath);
    
    // Create worktree directory
    const worktreeRootAbs = path.join(repoPath, worktreeRoot);
    ensureDir(worktreeRootAbs);
    const worktreePath = path.join(worktreeRootAbs, worktreeId);
    
    // Check if worktree already exists (for retry scenarios)
    if (fs.existsSync(worktreePath) && fs.existsSync(path.join(worktreePath, '.git'))) {
      this.logger(`[git] Worktree already exists, reusing: ${worktreePath}`);
      executeCommand(`git -C "${worktreePath}" fetch --all`, repoPath, this.logger);
      return worktreePath;
    }
    
    // Create new worktree with a job-specific branch
    ensureDir(worktreePath);
    const jobBranch = `copilot_jobs/${worktreeId}`;
    executeCommand(
      `git worktree add -B ${jobBranch} "${worktreePath}" "${baseBranch}"`, 
      repoPath, 
      this.logger
    );
    
    // Initialize submodules
    this.initializeSubmodules(repoPath, worktreePath, worktreeId);
    
    return worktreePath;
  }
  
  /**
   * Remove a git worktree and optionally its branch.
   */
  async removeWorktree(worktreePath: string, options?: {
    deleteBranch?: boolean;
    force?: boolean;
  }): Promise<void> {
    const forceFlag = options?.force ? '--force' : '';
    
    // Get repo root from worktree
    const result = runCommand('git rev-parse --git-common-dir', worktreePath);
    if (!result.success) {
      this.logger(`[git] Could not find git common dir for ${worktreePath}`);
      return;
    }
    
    const repoPath = path.resolve(worktreePath, result.stdout.trim(), '..');
    
    // Remove worktree
    const removeResult = runCommand(`git worktree remove ${forceFlag} "${worktreePath}"`, repoPath);
    if (removeResult.stdout) this.logger(removeResult.stdout);
    if (removeResult.stderr) this.logger(removeResult.stderr);
    
    // Prune worktrees
    runCommand('git worktree prune', repoPath);
    
    // Delete branch if requested
    if (options?.deleteBranch) {
      const branchName = path.basename(worktreePath);
      runCommand(`git branch -D copilot_jobs/${branchName}`, repoPath);
    }
  }
  
  /**
   * Merge a source branch into a target branch.
   */
  async merge(source: string, target: string, cwd: string): Promise<MergeResult> {
    // Checkout target branch
    const checkoutResult = runCommand(`git checkout ${target}`, cwd);
    if (!checkoutResult.success) {
      return {
        success: false,
        error: `Failed to checkout ${target}: ${checkoutResult.stderr}`
      };
    }
    
    // Attempt merge
    const mergeResult = runCommand(`git merge ${source} --no-edit`, cwd);
    
    if (mergeResult.success) {
      // Get the merge commit hash
      const hashResult = runCommand('git rev-parse HEAD', cwd);
      return {
        success: true,
        commitHash: hashResult.stdout.trim()
      };
    }
    
    // Check for conflicts
    const hasConflicts = mergeResult.stderr.includes('CONFLICT') || 
                         mergeResult.stdout.includes('CONFLICT');
    
    return {
      success: false,
      error: mergeResult.stderr || mergeResult.stdout,
      hasConflicts
    };
  }
  
  /**
   * Get the default branch of a repository.
   */
  async getDefaultBranch(repoPath: string): Promise<string> {
    // Try to get from remote HEAD
    const remoteHeadResult = runCommand(
      'git symbolic-ref refs/remotes/origin/HEAD', 
      repoPath
    );
    
    if (remoteHeadResult.success) {
      return remoteHeadResult.stdout.trim().replace('refs/remotes/origin/', '');
    }
    
    // Fallback: check for common default branch names
    const branchesResult = runCommand('git branch -r', repoPath);
    const branches = branchesResult.stdout;
    
    if (branches.includes('origin/main')) return 'main';
    if (branches.includes('origin/master')) return 'master';
    if (branches.includes('origin/develop')) return 'develop';
    
    return 'main'; // Final fallback
  }
  
  /**
   * Get the current branch name.
   */
  async getCurrentBranch(cwd: string): Promise<string> {
    const result = runCommand('git branch --show-current', cwd);
    return result.stdout.trim() || 'HEAD';
  }
  
  /**
   * Calculate diff statistics between two refs.
   */
  async getDiffStats(baseRef: string, headRef: string, cwd: string): Promise<{
    commits: number;
    filesAdded: number;
    filesModified: number;
    filesDeleted: number;
  }> {
    // Get merge base for accurate comparison
    const mergeBaseResult = runCommand(`git merge-base ${headRef} ${baseRef}`, cwd);
    const mergeBase = mergeBaseResult.success ? mergeBaseResult.stdout.trim() : baseRef;
    
    // Count commits
    const commitCountResult = runCommand(
      `git rev-list --count ${mergeBase}..${headRef}`, 
      cwd
    );
    const commits = parseInt(commitCountResult.stdout.trim(), 10) || 0;
    
    // Get file changes
    const diffResult = runCommand(
      `git diff --numstat ${mergeBase}..${headRef}`, 
      cwd
    );
    
    let filesAdded = 0;
    let filesModified = 0;
    let filesDeleted = 0;
    
    if (diffResult.success && diffResult.stdout) {
      const lines = diffResult.stdout.trim().split('\n').filter(l => l);
      
      for (const line of lines) {
        const [added, deleted] = line.split('\t');
        const addedNum = parseInt(added, 10) || 0;
        const deletedNum = parseInt(deleted, 10) || 0;
        
        if (addedNum > 0 && deletedNum === 0) {
          filesAdded++;
        } else if (addedNum === 0 && deletedNum > 0) {
          filesDeleted++;
        } else {
          filesModified++;
        }
      }
    }
    
    return { commits, filesAdded, filesModified, filesDeleted };
  }
  
  /**
   * Update .gitignore to exclude orchestrator directories.
   */
  private updateGitignore(repoPath: string, worktreeRoot: string): void {
    const gitignorePath = path.join(repoPath, '.gitignore');
    
    try {
      let content = '';
      if (fs.existsSync(gitignorePath)) {
        content = fs.readFileSync(gitignorePath, 'utf-8');
      }
      
      let modified = false;
      
      // Add worktreeRoot to .gitignore
      const ignorePattern = worktreeRoot.startsWith('/') ? worktreeRoot : `/${worktreeRoot}`;
      if (!content.includes(worktreeRoot)) {
        const separator = content.endsWith('\n') || content === '' ? '' : '\n';
        content += `${separator}# Copilot Orchestrator\n${ignorePattern}\n`;
        modified = true;
      }
      
      // Add .orchestrator directory
      if (!content.includes('.orchestrator')) {
        const separator = content.endsWith('\n') ? '' : '\n';
        content += `${separator}/.orchestrator\n`;
        modified = true;
      }
      
      if (modified) {
        fs.writeFileSync(gitignorePath, content, 'utf-8');
        this.logger('[git] Updated .gitignore with orchestrator directories');
      }
    } catch (e) {
      this.logger(`[git] Warning: Could not update .gitignore: ${e}`);
    }
  }
  
  /**
   * Try to pull latest changes (non-fatal on failure).
   */
  private tryPull(repoPath: string): void {
    const result = spawnSync('git', ['pull', '--ff-only'], {
      cwd: repoPath,
      shell: true,
      stdio: 'pipe',
      encoding: 'utf-8'
    });
    
    if (result.stdout) this.logger(result.stdout);
    
    if (result.status !== 0 && result.stderr) {
      if (!result.stderr.includes('no tracking information')) {
        this.logger(`[git] Warning: Pull failed - ${result.stderr}`);
      }
    }
  }
  
  /**
   * Initialize submodules in a worktree.
   */
  private initializeSubmodules(repoPath: string, worktreePath: string, worktreeId: string): void {
    executeCommand('git submodule update --init --recursive', repoPath, this.logger);
    executeCommand(`git -C "${worktreePath}" config submodule.recurse true`, repoPath, this.logger);
    
    // Handle submodules with worktrees
    const listResult = spawnSync(
      'git', 
      ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'],
      { cwd: repoPath, encoding: 'utf-8' }
    );
    
    if (!listResult.stdout) return;
    
    const lines = listResult.stdout.trim().split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^submodule\.(.*?)\.path\s+(.*)$/);
      if (!match) continue;
      
      const [, name, submodulePath] = match;
      
      // Get branch for submodule
      const branchResult = spawnSync(
        'git',
        ['config', '--file', '.gitmodules', `submodule.${name}.branch`],
        { cwd: repoPath, encoding: 'utf-8' }
      );
      const branch = branchResult.stdout?.trim() || 'main';
      
      const submoduleAbs = path.join(repoPath, submodulePath);
      const destPath = path.join(worktreePath, submodulePath);
      ensureDir(path.dirname(destPath));
      
      // Check if remote branch exists
      const checkResult = spawnSync(
        'git',
        ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
        { cwd: submoduleAbs }
      );
      
      const jobBranch = `copilot_jobs/${worktreeId}`;
      
      if (checkResult.status === 0) {
        executeCommand(
          `git worktree add -B ${jobBranch} "${destPath}" "origin/${branch}"`,
          submoduleAbs,
          this.logger
        );
      } else {
        const headResult = spawnSync(
          'git',
          ['rev-parse', 'HEAD'],
          { cwd: submoduleAbs, encoding: 'utf-8' }
        );
        const head = headResult.stdout?.trim() || 'HEAD';
        executeCommand(`git worktree add "${destPath}" ${head}`, submoduleAbs, this.logger);
      }
    }
  }
}

/**
 * Legacy function for backward compatibility.
 * @deprecated Use GitOperations class instead
 */
export type WorktreePlan = {
  jobId: string;
  repoPath: string;
  worktreeRoot: string;
  baseBranch: string;
  targetBranch: string;
};

/**
 * Legacy function for backward compatibility.
 * @deprecated Use GitOperations.createWorktree() instead
 */
export function createWorktrees(plan: WorktreePlan, log: (s: string) => void): string {
  const git = new GitOperations(log);
  
  // This is synchronous wrapper for async method - use directly for new code
  const config: WorktreeConfig = {
    repoPath: plan.repoPath,
    baseBranch: plan.baseBranch,
    targetBranch: plan.targetBranch,
    worktreeRoot: plan.worktreeRoot,
    worktreeId: plan.jobId
  };
  
  // Inline the synchronous implementation for backward compatibility
  const { repoPath, worktreeRoot, baseBranch, worktreeId } = config;
  
  // Update gitignore
  const gitignorePath = path.join(repoPath, '.gitignore');
  try {
    let content = '';
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, 'utf-8');
    }
    
    let modified = false;
    const ignorePattern = worktreeRoot.startsWith('/') ? worktreeRoot : `/${worktreeRoot}`;
    if (!content.includes(worktreeRoot)) {
      content += (content.endsWith('\n') || content === '' ? '' : '\n') + 
                 `# Copilot Orchestrator\n${ignorePattern}\n`;
      modified = true;
    }
    if (!content.includes('.orchestrator')) {
      content += (content.endsWith('\n') ? '' : '\n') + `/.orchestrator\n`;
      modified = true;
    }
    if (modified) {
      fs.writeFileSync(gitignorePath, content, 'utf-8');
      log('[orchestrator] Updated .gitignore with orchestrator directories');
    }
  } catch (e) {
    log(`[orchestrator] Warning: Could not update .gitignore: ${e}`);
  }
  
  executeCommand('git fetch --all --tags', repoPath, log);
  executeCommand(`git switch ${baseBranch}`, repoPath, log);
  
  // Try pull
  const pullResult = spawnSync('git', ['pull', '--ff-only'], { 
    cwd: repoPath, shell: true, stdio: 'pipe', encoding: 'utf-8' 
  });
  if (pullResult.stdout) log(pullResult.stdout);
  if (pullResult.stderr && pullResult.status === 0) log(pullResult.stderr);
  if (pullResult.status !== 0 && pullResult.stderr && !pullResult.stderr.includes('no tracking information')) {
    log(`[orchestrator] Warning: Pull failed - ${pullResult.stderr}`);
  }
  
  const worktreeRootAbs = path.join(repoPath, worktreeRoot);
  ensureDir(worktreeRootAbs);
  const worktreePath = path.join(worktreeRootAbs, worktreeId);
  
  if (fs.existsSync(worktreePath) && fs.existsSync(path.join(worktreePath, '.git'))) {
    log(`[orchestrator] Worktree already exists, reusing: ${worktreePath}`);
    executeCommand(`git -C "${worktreePath}" fetch --all`, repoPath, log);
    return worktreePath;
  }
  
  ensureDir(worktreePath);
  const jobBranch = `copilot_jobs/${worktreeId}`;
  executeCommand(`git worktree add -B ${jobBranch} "${worktreePath}" "${baseBranch}"`, repoPath, log);
  
  // Submodules
  executeCommand('git submodule update --init --recursive', repoPath, log);
  executeCommand(`git -C "${worktreePath}" config submodule.recurse true`, repoPath, log);
  
  const list = spawnSync('git', ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], 
    { cwd: repoPath, encoding: 'utf-8' });
  const lines = list.stdout ? list.stdout.trim().split(/\r?\n/) : [];
  
  for (const line of lines) {
    const m = line.match(/^submodule\.(.*?)\.path\s+(.*)$/);
    if (!m) continue;
    const name = m[1];
    const smPath = m[2];
    const branchQ = spawnSync('git', ['config', '--file', '.gitmodules', `submodule.${name}.branch`], 
      { cwd: repoPath, encoding: 'utf-8' });
    const branch = (branchQ.stdout || '').trim() || 'main';
    const abs = path.join(repoPath, smPath);
    const dest = path.join(worktreePath, smPath);
    ensureDir(path.dirname(dest));
    const check = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: abs });
    if (check.status === 0) {
      executeCommand(`git worktree add -B ${jobBranch} "${dest}" "origin/${branch}"`, abs, log);
    } else {
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: abs, encoding: 'utf-8' }).stdout.trim();
      executeCommand(`git worktree add "${dest}" ${head}`, abs, log);
    }
  }
  
  return worktreePath;
}
