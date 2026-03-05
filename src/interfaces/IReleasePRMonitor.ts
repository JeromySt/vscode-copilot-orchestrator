/**
 * @fileoverview IReleasePRMonitor Interface
 *
 * Monitors pull requests for releases, tracking CI checks, reviews, comments,
 * and security alerts. Provides feedback to the release manager for autonomous
 * issue resolution.
 *
 * @module interfaces/IReleasePRMonitor
 */

import type { PRMonitorCycle } from '../plan/types/release';

/**
 * Release PR Monitor interface.
 * 
 * Continuously monitors a release PR for:
 * - CI/CD check status (build, test, lint, etc.)
 * - Review comments and feedback (human, Copilot, CodeQL, bots)
 * - Security alerts (CodeQL, Dependabot, etc.)
 * 
 * Operates on isolated repository clones under
 * `.orchestrator/release/<sanitized-branch>/`.
 */
export interface IReleasePRMonitor {
  /**
   * Starts monitoring a release PR.
   * 
   * Periodically polls the PR for new checks, comments, and alerts,
   * emitting monitoring cycle events with the latest status.
   * 
   * @param releaseId - The release ID
   * @param prNumber - The PR number to monitor
   * @param repoPath - Path to the isolated repository clone (under .orchestrator/release/)
   * @param releaseBranch - The release branch name
   */
  startMonitoring(
    releaseId: string,
    prNumber: number,
    repoPath: string,
    releaseBranch: string
  ): Promise<void>;

  /**
   * Stops monitoring a release PR.
   * 
   * @param releaseId - The release ID
   */
  stopMonitoring(releaseId: string): void;

  /**
   * Checks if a release PR is currently being monitored.
   * 
   * @param releaseId - The release ID
   * @returns True if monitoring is active
   */
  isMonitoring(releaseId: string): boolean;

  /**
   * Gets all monitoring cycles for a release.
   * 
   * @param releaseId - The release ID
   * @returns Array of monitoring cycles in chronological order
   */
  getMonitorCycles(releaseId: string): PRMonitorCycle[];
}
