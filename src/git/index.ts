/**
 * @fileoverview Git Operations Module - Unified git functionality.
 * 
 * This module provides a clean, modular API for git operations.
 * 
 * ## Architecture
 * 
 * ### Core Operations (git/core/)
 * - `branches` - Branch management (create, delete, query)
 * - `worktrees` - Worktree management (create, remove, query)
 * - `merge` - Merge operations and conflict handling
 * - `repository` - General repository operations (fetch, pull, push, commit)
 * - (executor - Low-level git command execution — internal to git module)
 * 
 * ### Orchestrator Operations (git/orchestrator)
 * - Job worktree management
 * - Branch resolution for orchestrator workflows
 * - Gitignore management
 * 
 * ## Usage
 * 
 * ```typescript
 * import * as git from './git';
 * 
 * // Core API
 * git.branches.create('feature/new', 'main', repoPath);
 * git.worktrees.create({ repoPath, worktreePath, branchName, fromRef });
 * const result = git.merge.merge({ source, target, cwd });
 * 
 * // Orchestrator API
 * const worktreePath = git.orchestrator.createJobWorktree(options);
 * const resolved = git.orchestrator.resolveTargetBranchRoot(baseBranch, repoPath);
 * ```
 * 
 * @module git
 */

// =============================================================================
// Core API
// =============================================================================

export * as branches from './core/branches';
export * as worktrees from './core/worktrees';
export * as merge from './core/merge';
export * as repository from './core/repository';
export * as gitignore from './core/gitignore';

// =============================================================================
// Orchestrator API
// =============================================================================

export * as orchestrator from './orchestrator';

// =============================================================================
// Types
// =============================================================================

export type { GitLogger, CommandResult, ExecuteOptions } from './core/executor';
export type { MergeResult, MergeOptions, MergeTreeResult, MergeTreeOptions } from './core/merge';
export type { CommitInfo, FileChange } from './core/repository';
export type { CreateOptions as WorktreeCreateOptions, CreateTiming } from './core/worktrees';
export type { JobWorktreeOptions } from './orchestrator';

// =============================================================================
// Implementations
// =============================================================================

export { DefaultGitOperations } from './DefaultGitOperations';

