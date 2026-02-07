/**
 * @fileoverview Evidence Validator
 * 
 * Default implementation of {@link IEvidenceValidator}.
 * Checks for evidence files in `.orchestrator/evidence/` and validates
 * their schema.
 * 
 * @module plan/evidenceValidator
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IEvidenceValidator } from '../interfaces';
import type { EvidenceFile, EvidenceValidationResult } from './types';

/** Directory within the worktree where evidence files are stored. */
const EVIDENCE_DIR = '.orchestrator/evidence';

/**
 * Default evidence validator that reads evidence files from disk.
 * 
 * Evidence files allow nodes to prove they performed work even when
 * no tracked source files were modified.
 */
export class DefaultEvidenceValidator implements IEvidenceValidator {

  async hasEvidenceFile(worktreePath: string, nodeId: string): Promise<boolean> {
    const filePath = path.join(worktreePath, EVIDENCE_DIR, `${nodeId}.json`);
    return fs.existsSync(filePath);
  }

  async readEvidence(
    worktreePath: string,
    nodeId: string
  ): Promise<EvidenceFile | undefined> {
    const filePath = path.join(worktreePath, EVIDENCE_DIR, `${nodeId}.json`);
    if (!fs.existsSync(filePath)) { return undefined; }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as EvidenceFile;

      // Basic schema validation
      if (parsed.version !== 1) { return undefined; }
      if (!parsed.nodeId || !parsed.timestamp || !parsed.summary) { return undefined; }

      return parsed;
    } catch {
      return undefined;
    }
  }

  async validate(
    worktreePath: string,
    nodeId: string,
    expectsNoChanges: boolean
  ): Promise<EvidenceValidationResult> {
    // Check for evidence file
    const evidence = await this.readEvidence(worktreePath, nodeId);
    if (evidence) {
      return {
        valid: true,
        reason: `Evidence file found: ${evidence.summary}`,
        evidence,
        method: 'evidence_file',
      };
    }

    // Check expectsNoChanges flag
    if (expectsNoChanges) {
      return {
        valid: true,
        reason: 'Node declares expectsNoChanges',
        method: 'expects_no_changes',
      };
    }

    // No evidence
    return {
      valid: false,
      reason: 'No work evidence produced',
      method: 'none',
    };
  }
}
