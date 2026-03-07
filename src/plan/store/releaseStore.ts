/**
 * @fileoverview FileSystem Release Store Implementation
 * 
 * Implements IReleaseStore for filesystem-based release storage.
 * All file I/O goes through the injected IFileSystem interface for testability.
 * Storage path: `<repoRoot>/.orchestrator/release/<sanitized-branch>/`
 * 
 * @module plan/store/releaseStore
 */

import * as path from 'path';
import type { IReleaseStore } from '../../interfaces/IReleaseStore';
import type { ReleaseDefinition, PRMonitorCycle } from '../types/release';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import { Logger } from '../../core/logger';

const log = Logger.for('plan-persistence');

/**
 * Sanitize branch name for use as directory name.
 * Replaces characters unsafe for file paths with hyphens.
 */
function sanitizeBranchName(branchName: string): string {
  return branchName.replace(/[^a-zA-Z0-9._-]/g, '-');
}

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
 * FileSystem-backed implementation of IReleaseStore.
 * All storage under `.orchestrator/release/`.
 */
export class FileSystemReleaseStore implements IReleaseStore {
  private readonly orchestratorPath: string;
  
  constructor(
    private readonly repoPath: string,
    private readonly fs: IFileSystem,
  ) {
    this.orchestratorPath = path.join(repoPath, '.orchestrator');
  }

  /**
   * Get the storage directory for a release.
   * Path: `.orchestrator/release/<sanitized-branch>/`
   */
  private getReleasePath(release: ReleaseDefinition): string {
    const sanitized = sanitizeBranchName(release.releaseBranch);
    const releasePath = path.join(this.repoPath, '.orchestrator', 'release', sanitized);
    validatePath(this.orchestratorPath, releasePath);
    return releasePath;
  }

  /**
   * Find release directory by scanning for matching release ID.
   * Returns undefined if not found.
   */
  private async findReleaseDirectory(releaseId: string): Promise<string | undefined> {
    const releaseRoot = path.join(this.repoPath, '.orchestrator', 'release');
    
    try {
      const exists = await this.fs.existsAsync(releaseRoot);
      if (!exists) {
        return undefined;
      }

      const branches = await this.fs.readdirAsync(releaseRoot);
      
      for (const branch of branches) {
        // Skip dangerous or special entries defensively
        if (branch === '.' || branch === '..' || branch === '.git') {
          continue;
        }

        const branchPath = path.join(releaseRoot, branch);
        const releaseFile = path.join(branchPath, 'release.json');
        try {
          // Ensure constructed paths remain under .orchestrator
          validatePath(this.orchestratorPath, branchPath);
          validatePath(this.orchestratorPath, releaseFile);

          const content = await this.fs.readFileAsync(releaseFile);
          const release = JSON.parse(content) as ReleaseDefinition;
          if (release.id === releaseId) {
            return path.join(releaseRoot, branch);
          }
        } catch {
          // Skip invalid, unsafe, or missing files
          continue;
        }
      }
    } catch (error) {
      log.error('Failed to scan release directories', { error: (error as Error).message });
    }

    return undefined;
  }

  async saveRelease(release: ReleaseDefinition): Promise<void> {
    const releaseDir = this.getReleasePath(release);
    const releaseFile = path.join(releaseDir, 'release.json');
    const tempFile = path.join(releaseDir, '.release.json.tmp');

    try {
      await this.fs.mkdirAsync(releaseDir, { recursive: true });
      await this.fs.writeFileAsync(tempFile, JSON.stringify(release, null, 2));
      await this.fs.renameAsync(tempFile, releaseFile);
      log.debug('Saved release', { releaseId: release.id, path: releaseFile });
    } catch (error) {
      log.error('Failed to save release', { releaseId: release.id, error: (error as Error).message });
      try {
        await this.fs.unlinkAsync(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  async loadRelease(releaseId: string): Promise<ReleaseDefinition | undefined> {
    const releaseDir = await this.findReleaseDirectory(releaseId);
    if (!releaseDir) {
      return undefined;
    }

    const releaseFile = path.join(releaseDir, 'release.json');
    try {
      const content = await this.fs.readFileAsync(releaseFile);
      return JSON.parse(content) as ReleaseDefinition;
    } catch (error) {
      if ((error as any)?.code === 'ENOENT') {
        return undefined;
      }
      log.error('Failed to load release', { releaseId, error: (error as Error).message });
      throw error;
    }
  }

  async loadAllReleases(): Promise<ReleaseDefinition[]> {
    const releaseRoot = path.join(this.repoPath, '.orchestrator', 'release');
    const releases: ReleaseDefinition[] = [];

    try {
      const exists = await this.fs.existsAsync(releaseRoot);
      if (!exists) {
        return [];
      }

      const branches = await this.fs.readdirAsync(releaseRoot);

      for (const branch of branches) {
        const releaseFile = path.join(releaseRoot, branch, 'release.json');
        try {
          const content = await this.fs.readFileAsync(releaseFile);
          const release = JSON.parse(content) as ReleaseDefinition;
          releases.push(release);
        } catch {
          // Skip invalid or missing files
          log.debug('Skipping invalid release file', { path: releaseFile });
          continue;
        }
      }
    } catch (error) {
      log.error('Failed to load all releases', { error: (error as Error).message });
      throw error;
    }

    return releases;
  }

  async deleteRelease(releaseId: string): Promise<void> {
    const releaseDir = await this.findReleaseDirectory(releaseId);
    if (!releaseDir) {
      log.debug('Release not found for deletion', { releaseId });
      return;
    }

    try {
      await this.fs.rmAsync(releaseDir, { recursive: true, force: true });
      log.debug('Deleted release', { releaseId, path: releaseDir });
    } catch (error) {
      log.error('Failed to delete release', { releaseId, error: (error as Error).message });
      throw error;
    }
  }

  async saveMonitorCycles(releaseId: string, cycles: PRMonitorCycle[]): Promise<void> {
    const releaseDir = await this.findReleaseDirectory(releaseId);
    if (!releaseDir) {
      throw new Error(`Release not found: ${releaseId}`);
    }

    const cyclesFile = path.join(releaseDir, 'monitor-cycles.json');
    const tempFile = path.join(releaseDir, '.monitor-cycles.json.tmp');

    try {
      await this.fs.writeFileAsync(tempFile, JSON.stringify(cycles, null, 2));
      await this.fs.renameAsync(tempFile, cyclesFile);
      log.debug('Saved monitor cycles', { releaseId, count: cycles.length });
    } catch (error) {
      log.error('Failed to save monitor cycles', { releaseId, error: (error as Error).message });
      try {
        await this.fs.unlinkAsync(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  async loadMonitorCycles(releaseId: string): Promise<PRMonitorCycle[]> {
    const releaseDir = await this.findReleaseDirectory(releaseId);
    if (!releaseDir) {
      log.debug('Release not found when loading monitor cycles', { releaseId });
      return [];
    }

    const cyclesFile = path.join(releaseDir, 'monitor-cycles.json');
    try {
      const content = await this.fs.readFileAsync(cyclesFile);
      return JSON.parse(content) as PRMonitorCycle[];
    } catch (error) {
      if ((error as any)?.code === 'ENOENT') {
        return [];
      }
      log.error('Failed to load monitor cycles', { releaseId, error: (error as Error).message });
      throw error;
    }
  }
}
