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
 * Debounces .gitignore writes after branch changes to prevent race conditions.
 * 
 * When a branch change occurs, this class defers .gitignore writes for 30 seconds
 * to avoid creating uncommitted changes that would block subsequent `git checkout`
 * operations by VS Code or the user. Multiple write requests during the delay
 * window are merged and deduplicated.
 */
export class GitignoreDebouncer implements IGitignoreDebouncer {
  private _lastBranchChangeTime = 0;
  private _pendingTimer: ReturnType<typeof setTimeout> | undefined;
  private _pendingEntries: string[] = [];
  private _pendingResolvers: Array<() => void> = [];

  /**
   * Creates a new GitignoreDebouncer instance.
   * 
   * @param _git - Git operations interface for writing .gitignore entries
   */
  constructor(private readonly _git: IGitOperations) {}

  /**
   * Notifies the debouncer that a branch change has occurred.
   * 
   * Starts the debounce delay window. Any .gitignore write requests
   * within the next 30 seconds will be deferred and merged.
   */
  notifyBranchChange(): void {
    this._lastBranchChangeTime = Date.now();
    log.info('Branch change detected, deferring gitignore writes', {
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
    const elapsed = Date.now() - this._lastBranchChangeTime;
    if (elapsed < BRANCH_CHANGE_DELAY_MS) {
      const remaining = BRANCH_CHANGE_DELAY_MS - elapsed;
      log.info('Deferring gitignore write', {
        remainingMs: remaining,
        entryCount: entries.length,
        repoPath
      });

      // Merge with any pending entries (deduplicate)
      this._pendingEntries = [...new Set([...this._pendingEntries, ...entries])];

      // Clear existing timer — we'll reset it to fire at the end of the full delay
      if (this._pendingTimer) {
        clearTimeout(this._pendingTimer);
      }

      return new Promise<void>((resolve) => {
        this._pendingResolvers.push(resolve);
        this._pendingTimer = setTimeout(async () => {
          const toWrite = [...this._pendingEntries];
          const resolvers = [...this._pendingResolvers];
          this._pendingEntries = [];
          this._pendingResolvers = [];
          this._pendingTimer = undefined;

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
   * Cancels any pending delayed write operation and immediately resolves
   * all waiting promises to prevent hanging callers.
   */
  dispose(): void {
    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer);
      this._pendingTimer = undefined;
    }
    // Resolve any waiting callers so they don't hang
    for (const r of this._pendingResolvers) { r(); }
    this._pendingResolvers = [];
    this._pendingEntries = [];
  }
}
