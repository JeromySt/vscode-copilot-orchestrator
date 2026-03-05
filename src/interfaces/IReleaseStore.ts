/**
 * @fileoverview Storage backend interface for release persistence.
 * 
 * Defines low-level storage operations for release metadata and monitoring cycles.
 * All storage is under repoRoot/.orchestrator/release/sanitized-branch/.
 * 
 * @module interfaces/IReleaseStore
 */

import type { ReleaseDefinition, PRMonitorCycle } from '../plan/types/release';

/**
 * Storage backend interface for release persistence.
 * Handles the physical storage and retrieval of release data.
 */
export interface IReleaseStore {
  /**
   * Save release metadata to storage.
   * Path: .orchestrator/release/sanitized-branch/release.json
   * 
   * @param release - Release definition to save
   */
  saveRelease(release: ReleaseDefinition): Promise<void>;

  /**
   * Load release metadata from storage by release ID.
   * Searches all release.json files to find matching release.
   * 
   * @param releaseId - Unique release identifier
   * @returns Release definition or undefined if not found
   */
  loadRelease(releaseId: string): Promise<ReleaseDefinition | undefined>;

  /**
   * Load all persisted releases.
   * Scans all release.json files under .orchestrator/release/.
   * 
   * @returns Array of all release definitions
   */
  loadAllReleases(): Promise<ReleaseDefinition[]>;

  /**
   * Delete release and all associated data.
   * Removes entire .orchestrator/release/sanitized-branch/ directory.
   * 
   * @param releaseId - Unique release identifier
   */
  deleteRelease(releaseId: string): Promise<void>;

  /**
   * Save PR monitoring cycles for a release.
   * Path: .orchestrator/release/sanitized-branch/monitor-cycles.json
   * 
   * @param releaseId - Unique release identifier
   * @param cycles - Array of monitoring cycles
   */
  saveMonitorCycles(releaseId: string, cycles: PRMonitorCycle[]): Promise<void>;

  /**
   * Load PR monitoring cycles for a release.
   * Path: .orchestrator/release/sanitized-branch/monitor-cycles.json
   * 
   * @param releaseId - Unique release identifier
   * @returns Array of monitoring cycles, or empty array if not found
   */
  loadMonitorCycles(releaseId: string): Promise<PRMonitorCycle[]>;
}
