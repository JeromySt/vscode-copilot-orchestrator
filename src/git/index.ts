/**
 * @fileoverview Git operations module exports.
 * @module git
 */

// Export the original worktree implementation (used by jobRunner)
export { createWorktrees, WorktreePlan } from './gitWorktrees';

// Export the new modular Git operations (for new code)
export { GitOperations, WorktreeLogger } from './worktreeManager';

// Export simple git operations
export { listConflicts, stageAll, commit, checkoutSide } from './gitApi';
