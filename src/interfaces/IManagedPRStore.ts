/**
 * @fileoverview Storage backend interface for managed PR persistence.
 * 
 * Defines low-level storage operations for managed PR metadata.
 * All storage is under repoRoot/.orchestrator/managed-prs/<pr-number>/.
 * 
 * @module interfaces/IManagedPRStore
 */

import type { ManagedPR as LifecycleManagedPR } from '../plan/types/prLifecycle';

/**
 * Managed PR definition.
 * 
 * Represents a pull request that is being managed by the orchestrator,
 * including its metadata and current state.
 * 
 * This type is an alias of the canonical ManagedPR used by the PR lifecycle
 * manager in src/plan/types/prLifecycle.ts to ensure consistency across
 * persistence and lifecycle layers.
 */
export type ManagedPR = LifecycleManagedPR;

/**
 * Storage backend interface for managed PR persistence.
 * Handles the physical storage and retrieval of managed PR data.
 */
export interface IManagedPRStore {
  /**
   * Save managed PR metadata to storage.
   * Path: .orchestrator/managed-prs/<pr-number>/managed-pr.json
   * 
   * @param managedPR - Managed PR definition to save
   */
  save(managedPR: ManagedPR): Promise<void>;

  /**
   * Load managed PR metadata from storage by PR number.
   * 
   * @param prNumber - PR number
   * @returns Managed PR definition or undefined if not found
   */
  load(prNumber: number): Promise<ManagedPR | undefined>;

  /**
   * Load managed PR metadata by PR number (alias for load).
   * 
   * @param prNumber - PR number
   * @returns Managed PR definition or undefined if not found
   */
  loadByPRNumber(prNumber: number): Promise<ManagedPR | undefined>;

  /**
   * Load all managed PRs.
   * Scans all managed-pr.json files under .orchestrator/managed-prs/.
   * 
   * @returns Array of all managed PR definitions
   */
  loadAll(): Promise<ManagedPR[]>;

  /**
   * Delete managed PR and all associated data.
   * Removes entire .orchestrator/managed-prs/<pr-number>/ directory.
   * 
   * @param prNumber - PR number
   */
  delete(prNumber: number): Promise<void>;
}
