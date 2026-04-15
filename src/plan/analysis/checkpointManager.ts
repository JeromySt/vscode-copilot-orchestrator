/**
 * @fileoverview Checkpoint file manager implementation.
 *
 * Handles sentinel and manifest file I/O for the context pressure system.
 * All filesystem access goes through the injected {@link IFileSystem}.
 *
 * - Sentinel: `<worktreePath>/.orchestrator/CHECKPOINT_REQUIRED`
 * - Manifest: `<worktreePath>/.orchestrator/checkpoint-manifest.json`
 *
 * @see docs/CONTEXT_PRESSURE_DESIGN.md §5.1–§5.2, §6.2–§6.3, §13.1
 * @module plan/analysis/checkpointManager
 */

import * as path from 'path';
import { Logger } from '../../core/logger';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import type {
  ICheckpointManager,
  ContextPressureState,
  CheckpointManifest,
} from '../../interfaces/ICheckpointManager';

const log = Logger.for('jobs');

const ORCHESTRATOR_DIR = '.orchestrator';
const SENTINEL_FILENAME = 'CHECKPOINT_REQUIRED';
const MANIFEST_FILENAME = 'checkpoint-manifest.json';

/**
 * Default implementation of {@link ICheckpointManager}.
 *
 * Uses {@link IFileSystem} for all file operations so that tests can inject
 * a mock filesystem without touching disk.
 */
export class DefaultCheckpointManager implements ICheckpointManager {
  constructor(private readonly fileSystem: IFileSystem) {}

  async writeSentinel(worktreePath: string, state: ContextPressureState): Promise<void> {
    const sentinelPath = path.join(worktreePath, ORCHESTRATOR_DIR, SENTINEL_FILENAME);
    const payload = {
      reason: 'context_pressure',
      currentTokens: state.currentInputTokens,
      maxTokens: state.maxPromptTokens,
      pressure: state.pressure,
      timestamp: new Date().toISOString(),
      instructions: 'Finish current tool call, commit work, write manifest, exit.',
    };

    await this.fileSystem.ensureDirAsync(path.join(worktreePath, ORCHESTRATOR_DIR));
    await this.fileSystem.writeFileAsync(sentinelPath, JSON.stringify(payload, null, 2));
    log.info('Checkpoint sentinel written', { worktreePath, pressure: state.pressure });
  }

  async manifestExists(worktreePath: string): Promise<boolean> {
    const manifestPath = path.join(worktreePath, ORCHESTRATOR_DIR, MANIFEST_FILENAME);
    return this.fileSystem.existsAsync(manifestPath);
  }

  async readManifest(worktreePath: string): Promise<CheckpointManifest | undefined> {
    const manifestPath = path.join(worktreePath, ORCHESTRATOR_DIR, MANIFEST_FILENAME);

    const exists = await this.fileSystem.existsAsync(manifestPath);
    if (!exists) {
      return undefined;
    }

    let manifest: CheckpointManifest;
    try {
      const raw = await this.fileSystem.readFileAsync(manifestPath);
      manifest = JSON.parse(raw) as CheckpointManifest;
    } catch (err) {
      log.error('Failed to parse checkpoint manifest', {
        worktreePath,
        error: (err as Error).message,
      });
      return undefined;
    }

    // Edge case: no remaining items → nothing to split
    if (!manifest.remaining || manifest.remaining.length === 0) {
      log.info('Checkpoint manifest has no remaining items, skipping split', { worktreePath });
      return undefined;
    }

    // Edge case: empty manifest (no completed work AND remaining matches original task)
    // → the agent checkpointed without making progress; skip split, let auto-heal retry
    if ((!manifest.completed || manifest.completed.length === 0) && !manifest.inProgress) {
      log.info('Checkpoint manifest has no completed work, skipping split for auto-heal retry', { worktreePath });
      return undefined;
    }

    return manifest;
  }

  async cleanupManifest(worktreePath: string): Promise<void> {
    const manifestPath = path.join(worktreePath, ORCHESTRATOR_DIR, MANIFEST_FILENAME);
    try {
      await this.fileSystem.unlinkAsync(manifestPath);
    } catch {
      // File may not exist — safe to ignore
    }
  }

  async cleanupSentinel(worktreePath: string): Promise<void> {
    const sentinelPath = path.join(worktreePath, ORCHESTRATOR_DIR, SENTINEL_FILENAME);
    try {
      await this.fileSystem.unlinkAsync(sentinelPath);
    } catch {
      // File may not exist — safe to ignore
    }
  }
}
