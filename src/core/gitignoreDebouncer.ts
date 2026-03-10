/**
 * @fileoverview Debounces .gitignore writes after branch changes.
 * Prevents the race condition where .gitignore is written immediately after a
 * branch change, creating uncommitted changes that block subsequent git checkout
 * operations by VS Code or the user.
 *
 * @module core/gitignoreDebouncer
 */

import { Logger } from './logger';
import type { IGitignoreDebouncer } from '../interfaces/IGitignoreDebouncer';
import type { IGitOperations } from '../interfaces/IGitOperations';

const log = Logger.for('gitignore-debouncer');

/** Duration to wait after a branch change before allowing .gitignore writes. */
export const BRANCH_CHANGE_DELAY_MS = 30_000;

/**
 * Per-repository pending state.
 */
interface PendingRepoState {
  entries: string[];
  timer: ReturnType<typeof setTimeout> | undefined;
  resolvers: Array<() => void>;
}

/**
 * Debounces .gitignore writes after branch changes to prevent race conditions.
 * 
 * When a branch change occurs, this class defers .gitignore writes for 30 seconds
 * to avoid creating uncommitted changes that would block subsequent `git checkout`
 * operations by VS Code or the user. Multiple write requests during the delay
 * window are merged and deduplicated.
 * 
 * Pending state is keyed by repoPath so concurrent writes to different repositories
 * cannot interfere with each other.
 */
export class GitignoreDebouncer implements IGitignoreDebouncer {
  private readonly _lastBranchChangeByRepo = new Map<string, number>();
  private readonly _pendingByRepo = new Map<string, PendingRepoState>();

  /**
   * Creates a new GitignoreDebouncer instance.
   * 
   * @param _git - Git operations interface for writing .gitignore entries
   */
  constructor(private readonly _git: IGitOperations) {}

  /**
   * Notifies the debouncer that a branch change has occurred in the given repo.
   * 
   * Starts the debounce delay window for that specific repository. Any .gitignore
   * write requests for that repo within the next 30 seconds will be deferred.
   */
  notifyBranchChange(repoPath: string): void {
    this._lastBranchChangeByRepo.set(repoPath, Date.now());
    log.info('Branch change detected, deferring gitignore writes', {
      repoPath,
      delayMs: BRANCH_CHANGE_DELAY_MS
    });
  }

  /**
   * Ensures .gitignore entries exist, deferring writes during the branch-change delay.
   * 
   * If called within 30 seconds of `notifyBranchChange()`, the write is deferred
   * and merged with other pending entries. Otherwise, writes immediately.
   * 
   * @param repoPath - Absolute path to the git repository root
   * @param entries - Lines to ensure exist in .gitignore
   * @returns Promise that resolves when entries are written (immediately or after delay)
   */
  async ensureEntries(repoPath: string, entries: string[]): Promise<void> {
    const lastBranchChange = this._lastBranchChangeByRepo.get(repoPath) ?? 0;
    const elapsed = Date.now() - lastBranchChange;
    if (elapsed < BRANCH_CHANGE_DELAY_MS) {
      const remaining = BRANCH_CHANGE_DELAY_MS - elapsed;
      log.info('Deferring gitignore write', {
        remainingMs: remaining,
        entryCount: entries.length,
        repoPath
      });

      // Get or create per-repo pending state
      let pending = this._pendingByRepo.get(repoPath);
      if (!pending) {
        pending = { entries: [], timer: undefined, resolvers: [] };
        this._pendingByRepo.set(repoPath, pending);
      }

      // Merge with any pending entries for this repo (deduplicate)
      pending.entries = [...new Set([...pending.entries, ...entries])];

      // Clear existing timer for this repo — reset it to fire at the end of the full delay
      if (pending.timer) {
        clearTimeout(pending.timer);
      }

      return new Promise<void>((resolve) => {
        pending!.resolvers.push(resolve);
        pending!.timer = setTimeout(async () => {
          const toWrite = [...pending!.entries];
          const resolvers = [...pending!.resolvers];
          this._pendingByRepo.delete(repoPath);

          try {
            await this._git.gitignore.ensureGitignoreEntries(repoPath, toWrite);
            log.info('Deferred gitignore entries written', {
              count: toWrite.length,
              entries: toWrite
            });
          } catch (err: any) {
            log.error('Failed to write deferred gitignore entries', {
              error: err.message,
              repoPath
            });
          }

          // Resolve all waiting callers
          for (const r of resolvers) { r(); }
        }, remaining);
      });
    }

    // No recent branch change — write immediately
    try {
      await this._git.gitignore.ensureGitignoreEntries(repoPath, entries);
    } catch (err: any) {
      log.error('Failed to write gitignore entries', {
        error: err.message,
        repoPath
      });
    }
  }

  /**
   * Cleans up pending timers and resolves waiting callers.
   * 
   * Cancels any pending delayed write operations and immediately resolves
   * all waiting promises to prevent hanging callers.
   */
  dispose(): void {
    for (const [, pending] of this._pendingByRepo) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      for (const r of pending.resolvers) { r(); }
    }
    this._pendingByRepo.clear();
    this._lastBranchChangeByRepo.clear();
  }
}
