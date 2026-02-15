/**
 * @fileoverview Git Core Module - Unified git operations.
 * 
 * This module provides a clean, focused API for all git operations.
 * Each sub-module has a single responsibility:
 * 
 * - branches: Branch management
 * - worktrees: Worktree management
 * - merge: Merge and conflict handling
 * - repository: General repository operations
 * - (executor: Low-level command execution — internal to git module)
 * 
 * @module git/core
 * 
 * @example
 * ```typescript
 * import * as git from './git/core';
 * 
 * // Branch operations
 * if (git.branches.isDefaultBranch('main', repoPath)) {
 *   git.branches.create('feature/new', 'main', repoPath);
 * }
 * 
 * // Worktree operations
 * git.worktrees.create({
 *   repoPath,
 *   worktreePath: '/path/to/worktree',
 *   branchName: 'feature/new',
 *   fromRef: 'main'
 * });
 * 
 * // Merge operations
 * const result = git.merge.merge({
 *   source: 'feature/new',
 *   target: 'main',
 *   cwd: repoPath
 * });
 * ```
 */

// Re-export all sub-modules
export * as branches from './branches';
export * as worktrees from './worktrees';
export * as merge from './merge';
export * as repository from './repository';
export * as gitignore from './gitignore';

// Re-export commonly used types
export type { GitLogger, CommandResult, ExecuteOptions } from './executor';
export type { MergeResult, MergeOptions } from './merge';
export type { CreateOptions as WorktreeCreateOptions } from './worktrees';
export type { CommitInfo, FileChange } from './repository';
