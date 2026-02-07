/**
 * @fileoverview Interface for work evidence validation.
 * 
 * Abstracts evidence file detection and validation to enable
 * dependency injection and unit testing.
 * 
 * @module interfaces/IEvidenceValidator
 */

import type { EvidenceFile, EvidenceValidationResult } from '../plan/types';

/**
 * Validates that a work node produced evidence of work.
 * Extracted as an interface for dependency injection and testing.
 */
export interface IEvidenceValidator {
  /**
   * Check whether an evidence file exists for the given node.
   * 
   * @param worktreePath - Root of the worktree
   * @param nodeId - Node identifier
   * @returns true if .orchestrator/evidence/<nodeId>.json exists and is valid
   */
  hasEvidenceFile(worktreePath: string, nodeId: string): Promise<boolean>;

  /**
   * Read and parse the evidence file for a node.
   * Returns undefined if the file doesn't exist or is invalid.
   */
  readEvidence(worktreePath: string, nodeId: string): Promise<EvidenceFile | undefined>;

  /**
   * Perform the full evidence validation check.
   * Called during the commit phase after determining there are no 
   * uncommitted changes and no commits since baseCommit.
   * 
   * @returns ValidationResult indicating pass/fail and reason
   */
  validate(
    worktreePath: string,
    nodeId: string,
    expectsNoChanges: boolean
  ): Promise<EvidenceValidationResult>;
}
