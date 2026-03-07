/**
 * @fileoverview FileSystem Managed PR Store Implementation
 * 
 * Implements IManagedPRStore for filesystem-based managed PR storage.
 * All file I/O goes through the injected IFileSystem interface for testability.
 * Storage path: `<repoRoot>/.orchestrator/managed-prs/<pr-number>/`
 * 
 * @module plan/store/managedPRStore
 */

import * as path from 'path';
import type { IManagedPRStore, ManagedPR } from '../../interfaces/IManagedPRStore';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import { Logger } from '../../core/logger';

const log = Logger.for('plan-persistence');

/**
 * Validate that a path is within the allowed .orchestrator directory.
 * Guards against path traversal attacks.
 */
function validatePath(basePath: string, targetPath: string): void {
  const resolved = path.resolve(targetPath);
  const baseResolved = path.resolve(basePath);
  
  if (!resolved.startsWith(baseResolved + path.sep)) {
    throw new Error(`Path traversal blocked: ${targetPath}`);
  }
}

/**
 * FileSystem-backed implementation of IManagedPRStore.
 * All storage under `.orchestrator/managed-prs/`.
 */
export class FileSystemManagedPRStore implements IManagedPRStore {
  private readonly orchestratorPath: string;
  
  constructor(
    private readonly repoPath: string,
    private readonly fs: IFileSystem,
  ) {
    this.orchestratorPath = path.join(repoPath, '.orchestrator');
  }

  /**
   * Get the storage directory for a managed PR.
   * Path: `.orchestrator/managed-prs/<pr-number>/`
   */
  private getManagedPRPath(prNumber: number): string {
    const prPath = path.join(this.repoPath, '.orchestrator', 'managed-prs', String(prNumber));
    validatePath(this.orchestratorPath, prPath);
    return prPath;
  }

  async save(managedPR: ManagedPR): Promise<void> {
    const prDir = this.getManagedPRPath(managedPR.prNumber);
    const prFile = path.join(prDir, 'managed-pr.json');
    const tempFile = path.join(prDir, '.managed-pr.json.tmp');

    try {
      await this.fs.mkdirAsync(prDir, { recursive: true });
      await this.fs.writeFileAsync(tempFile, JSON.stringify(managedPR, null, 2));
      await this.fs.renameAsync(tempFile, prFile);
      log.debug('Saved managed PR', { prNumber: managedPR.prNumber, path: prFile });
    } catch (error) {
      log.error('Failed to save managed PR', { prNumber: managedPR.prNumber, error: (error as Error).message });
      try {
        await this.fs.unlinkAsync(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  async load(prNumber: number): Promise<ManagedPR | undefined> {
    const prDir = this.getManagedPRPath(prNumber);
    const prFile = path.join(prDir, 'managed-pr.json');

    try {
      const content = await this.fs.readFileAsync(prFile);
      return JSON.parse(content) as ManagedPR;
    } catch (error) {
      if ((error as any)?.code === 'ENOENT') {
        return undefined;
      }
      log.error('Failed to load managed PR', { prNumber, error: (error as Error).message });
      throw error;
    }
  }

  async loadByPRNumber(prNumber: number): Promise<ManagedPR | undefined> {
    return this.load(prNumber);
  }

  async loadAll(): Promise<ManagedPR[]> {
    const managedPRsRoot = path.join(this.repoPath, '.orchestrator', 'managed-prs');
    const managedPRs: ManagedPR[] = [];

    try {
      const exists = await this.fs.existsAsync(managedPRsRoot);
      if (!exists) {
        return [];
      }

      const prDirs = await this.fs.readdirAsync(managedPRsRoot);

      for (const prDir of prDirs) {
        // Allowlist: PR directories must be numeric (PR numbers)
        if (!/^\d+$/.test(prDir)) {
          log.debug('Skipping non-numeric managed PR directory', { prDir });
          continue;
        }

        const prFile = path.join(managedPRsRoot, prDir, 'managed-pr.json');
        try {
          // Ensure the managed PR file path stays under the managed-prs root
          validatePath(managedPRsRoot, prFile);

          const content = await this.fs.readFileAsync(prFile);
          const managedPR = JSON.parse(content) as ManagedPR;
          managedPRs.push(managedPR);
        } catch {
          // Skip invalid, missing, or unsafe files
          log.debug('Skipping invalid managed PR file', { path: prFile });
          continue;
        }
      }
    } catch (error) {
      log.error('Failed to load all managed PRs', { error: (error as Error).message });
      throw error;
    }

    return managedPRs;
  }

  async delete(prNumber: number): Promise<void> {
    const prDir = this.getManagedPRPath(prNumber);

    try {
      const exists = await this.fs.existsAsync(prDir);
      if (!exists) {
        log.debug('Managed PR not found for deletion', { prNumber });
        return;
      }

      await this.fs.rmAsync(prDir, { recursive: true, force: true });
      log.debug('Deleted managed PR', { prNumber, path: prDir });
    } catch (error) {
      log.error('Failed to delete managed PR', { prNumber, error: (error as Error).message });
      throw error;
    }
  }
}
