/**
 * @fileoverview PR Lifecycle Manager implementation.
 *
 * Orchestrates the lifecycle of pull requests including adoption, monitoring,
 * promotion/demotion, and autonomous feedback handling.
 *
 * @module plan/prLifecycleManager
 */

import { EventEmitter } from 'events';
import type {
  ManagedPR,
  ManagedPRStatus,
  AdoptPROptions,
  AdoptPRResult,
  ListPRsOptions,
  AvailablePR,
  PRLifecycleResult,
} from './types/prLifecycle';
import type { IPRLifecycleManager } from '../interfaces/IPRLifecycleManager';
import type { IRemotePRServiceFactory } from '../interfaces/IRemotePRServiceFactory';
import type { IReleasePRMonitor } from '../interfaces/IReleasePRMonitor';
import type { IIsolatedRepoManager } from '../interfaces/IIsolatedRepoManager';
import type { IManagedPRStore } from '../interfaces/IManagedPRStore';
import type { IReleaseConfigManager } from '../interfaces/IReleaseConfigManager';
import { Logger } from '../core/logger';

const log = Logger.for('plan');

/**
 * Default implementation of IPRLifecycleManager.
 *
 * Manages PR lifecycle through the following states:
 * - adopted: PR has been adopted but monitoring has not started
 * - monitoring: Actively monitoring for checks, comments, alerts
 * - addressing: Autonomously addressing feedback
 * - ready: All checks passed, ready to merge
 * - blocked: Failing checks or unresolved feedback
 * - abandoned: Management stopped
 *
 * All remote operations delegate to IRemotePRService (provider-agnostic).
 * All state changes emit events for UI synchronization.
 * All mutations persist immediately to IManagedPRStore.
 */
export class DefaultPRLifecycleManager extends EventEmitter implements IPRLifecycleManager {
  private readonly managedPRs = new Map<string, ManagedPR>();
  private initialized = false;

  constructor(
    private readonly prServiceFactory: IRemotePRServiceFactory,
    private readonly prMonitor: IReleasePRMonitor,
    private readonly isolatedRepos: IIsolatedRepoManager,
    private readonly store: IManagedPRStore,
    private readonly releaseConfig: IReleaseConfigManager,
  ) {
    super();
  }

  /**
   * Initialize the manager by loading all persisted managed PRs.
   * Called lazily on first use to avoid blocking extension activation.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    log.debug('Initializing PR lifecycle manager');
    try {
      const storedPRs = await this.store.loadAll();
      for (const pr of storedPRs) {
        // Convert IManagedPRStore.ManagedPR to prLifecycle.ManagedPR
        const managedPR = this.convertStoredPRToManagedPR(pr);
        this.managedPRs.set(managedPR.id, managedPR);
      }
      log.info('Loaded managed PRs', { count: storedPRs.length });
      this.initialized = true;
    } catch (err) {
      log.error('Failed to initialize PR lifecycle manager', { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /**
   * Convert IManagedPRStore.ManagedPR to prLifecycle.ManagedPR.
   * The store interface uses a different ManagedPR shape (simpler, storage-focused).
   */
  private convertStoredPRToManagedPR(storedPR: import('../interfaces/IManagedPRStore').ManagedPR): ManagedPR {
    // Extract lifecycle metadata from storedPR.metadata
    const metadata = storedPR.metadata || {};
    
    return {
      id: metadata.id || `pr-${storedPR.prNumber}-${Date.now()}`,
      prNumber: storedPR.prNumber,
      prUrl: storedPR.prUrl || '',
      title: storedPR.title,
      baseBranch: storedPR.targetBranch,
      headBranch: storedPR.sourceBranch,
      status: (metadata.status || 'adopted') as ManagedPRStatus,
      providerType: metadata.providerType || 'github',
      repoPath: storedPR.repoPath,
      workingDirectory: metadata.workingDirectory || storedPR.repoPath,
      releaseId: storedPR.releaseId,
      priority: metadata.priority,
      adoptedAt: storedPR.createdAt,
      monitoringStartedAt: metadata.monitoringStartedAt,
      completedAt: metadata.completedAt,
      unresolvedComments: metadata.unresolvedComments,
      failingChecks: metadata.failingChecks,
      unresolvedAlerts: metadata.unresolvedAlerts,
      error: metadata.error,
    };
  }

  /**
   * Convert prLifecycle.ManagedPR to IManagedPRStore.ManagedPR for persistence.
   */
  private convertManagedPRToStoredPR(managedPR: ManagedPR): import('../interfaces/IManagedPRStore').ManagedPR {
    return {
      prNumber: managedPR.prNumber,
      title: managedPR.title,
      body: '', // Not tracked in lifecycle manager
      sourceBranch: managedPR.headBranch,
      targetBranch: managedPR.baseBranch,
      repoPath: managedPR.repoPath,
      prUrl: managedPR.prUrl,
      isOpen: managedPR.status !== 'abandoned',
      createdAt: managedPR.adoptedAt,
      updatedAt: Date.now(),
      releaseId: managedPR.releaseId,
      metadata: {
        id: managedPR.id,
        status: managedPR.status,
        providerType: managedPR.providerType,
        workingDirectory: managedPR.workingDirectory,
        priority: managedPR.priority,
        monitoringStartedAt: managedPR.monitoringStartedAt,
        completedAt: managedPR.completedAt,
        unresolvedComments: managedPR.unresolvedComments,
        failingChecks: managedPR.failingChecks,
        unresolvedAlerts: managedPR.unresolvedAlerts,
        error: managedPR.error,
      },
    };
  }

  /**
   * Persist a managed PR to storage.
   */
  private async persistPR(managedPR: ManagedPR): Promise<void> {
    try {
      const storedPR = this.convertManagedPRToStoredPR(managedPR);
      await this.store.save(storedPR);
      log.debug('Persisted managed PR', { id: managedPR.id, prNumber: managedPR.prNumber });
    } catch (err) {
      log.error('Failed to persist managed PR', { 
        id: managedPR.id, 
        prNumber: managedPR.prNumber, 
        error: err instanceof Error ? err.message : String(err) 
      });
      throw err;
    }
  }

  // ── PR Discovery ───────────────────────────────────────────────────

  async listAvailablePRs(options: ListPRsOptions): Promise<AvailablePR[]> {
    await this.ensureInitialized();

    log.debug('Listing available PRs', { repoPath: options.repoPath, baseBranch: options.baseBranch });

    try {
      const prService = await this.prServiceFactory.getServiceForRepo(options.repoPath);
      const prList = await prService.listPRs(options.repoPath, {
        state: options.state || 'open',
        limit: options.limit || 30,
      });

      // Convert to AvailablePR format and check if already managed
      const availablePRs: AvailablePR[] = prList
        .filter(pr => !options.baseBranch || pr.baseBranch === options.baseBranch)
        .map(pr => ({
          prNumber: pr.prNumber,
          title: pr.title,
          baseBranch: pr.baseBranch,
          headBranch: pr.headBranch,
          author: pr.author,
          state: pr.state,
          url: pr.url,
          isManaged: this.getManagedPRByNumber(pr.prNumber, options.repoPath) !== undefined,
        }));

      log.info('Listed available PRs', { count: availablePRs.length, managed: availablePRs.filter(p => p.isManaged).length });
      return availablePRs;
    } catch (err) {
      log.error('Failed to list available PRs', { 
        repoPath: options.repoPath, 
        error: err instanceof Error ? err.message : String(err) 
      });
      throw err;
    }
  }

  // ── PR Adoption ────────────────────────────────────────────────────

  async adoptPR(options: AdoptPROptions): Promise<AdoptPRResult> {
    await this.ensureInitialized();

    log.info('Adopting PR', { prNumber: options.prNumber, repoPath: options.repoPath });

    try {
      // Check if already managed
      const existing = this.getManagedPRByNumber(options.prNumber, options.repoPath);
      if (existing) {
        log.warn('PR already adopted', { id: existing.id, prNumber: options.prNumber });
        return {
          success: false,
          error: `PR #${options.prNumber} is already managed (ID: ${existing.id})`,
        };
      }

      // Get PR details from remote
      const prService = await this.prServiceFactory.getServiceForRepo(options.repoPath);
      const provider = await prService.detectProvider(options.repoPath);
      const prDetails = await prService.getPRDetails(options.prNumber, options.repoPath);

      // Generate unique ID
      const id = `pr-${options.prNumber}-${Date.now()}`;

      // Determine working directory
      let workingDirectory = options.workingDirectory || options.repoPath;

      // Create managed PR record
      const managedPR: ManagedPR = {
        id,
        prNumber: options.prNumber,
        prUrl: prDetails.url,
        title: prDetails.title,
        baseBranch: prDetails.baseBranch,
        headBranch: prDetails.headBranch,
        status: 'adopted',
        providerType: provider.type,
        repoPath: options.repoPath,
        workingDirectory,
        releaseId: options.releaseId,
        priority: options.priority ?? 0,
        adoptedAt: Date.now(),
      };

      // Store in memory and persist
      this.managedPRs.set(id, managedPR);
      await this.persistPR(managedPR);

      // Emit event
      this.emit('prAdopted', managedPR);

      log.info('PR adopted successfully', { id, prNumber: options.prNumber });
      return {
        success: true,
        managedPR,
      };
    } catch (err) {
      log.error('Failed to adopt PR', { 
        prNumber: options.prNumber, 
        error: err instanceof Error ? err.message : String(err) 
      });
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to adopt PR',
      };
    }
  }

  // ── PR Queries ─────────────────────────────────────────────────────

  getManagedPR(id: string): ManagedPR | undefined {
    return this.managedPRs.get(id);
  }

  getManagedPRByNumber(prNumber: number, repoPath: string): ManagedPR | undefined {
    for (const pr of this.managedPRs.values()) {
      if (pr.prNumber === prNumber && pr.repoPath === repoPath) {
        return pr;
      }
    }
    return undefined;
  }

  getAllManagedPRs(): ManagedPR[] {
    return Array.from(this.managedPRs.values());
  }

  getManagedPRsByStatus(status: ManagedPRStatus): ManagedPR[] {
    return Array.from(this.managedPRs.values()).filter(pr => pr.status === status);
  }

  // ── PR Monitoring ──────────────────────────────────────────────────

  async startMonitoring(id: string): Promise<void> {
    await this.ensureInitialized();

    const pr = this.managedPRs.get(id);
    if (!pr) {
      throw new Error(`Managed PR not found: ${id}`);
    }

    if (pr.status !== 'adopted') {
      throw new Error(`Cannot start monitoring PR in '${pr.status}' status (must be 'adopted')`);
    }

    log.info('Starting PR monitoring', { id, prNumber: pr.prNumber });

    try {
      // Ensure isolated clone exists if working directory is different from repo path
      if (pr.workingDirectory !== pr.repoPath) {
        const repoInfo = await this.isolatedRepos.getRepoInfo(id);
        if (!repoInfo) {
          log.debug('Creating isolated repo for PR monitoring', { id, branch: pr.headBranch });
          await this.isolatedRepos.createIsolatedRepo(id, pr.repoPath, pr.headBranch);
        }
      }

      // Delegate to IReleasePRMonitor
      await this.prMonitor.startMonitoring(id, pr.prNumber, pr.workingDirectory, pr.headBranch);

      // Update status
      pr.status = 'monitoring';
      pr.monitoringStartedAt = Date.now();
      await this.persistPR(pr);

      // Emit event
      this.emit('prMonitoringStarted', pr);

      log.info('PR monitoring started', { id, prNumber: pr.prNumber });
    } catch (err) {
      log.error('Failed to start PR monitoring', { 
        id, 
        prNumber: pr.prNumber, 
        error: err instanceof Error ? err.message : String(err) 
      });
      throw err;
    }
  }

  async stopMonitoring(id: string): Promise<void> {
    await this.ensureInitialized();

    const pr = this.managedPRs.get(id);
    if (!pr) {
      throw new Error(`Managed PR not found: ${id}`);
    }

    if (pr.status !== 'monitoring' && pr.status !== 'addressing') {
      throw new Error(`Cannot stop monitoring PR in '${pr.status}' status (must be 'monitoring' or 'addressing')`);
    }

    log.info('Stopping PR monitoring', { id, prNumber: pr.prNumber });

    try {
      // Delegate to IReleasePRMonitor
      this.prMonitor.stopMonitoring(id);

      // Update status back to adopted
      pr.status = 'adopted';
      await this.persistPR(pr);

      // Emit event
      this.emit('prMonitoringStopped', pr);

      log.info('PR monitoring stopped', { id, prNumber: pr.prNumber });
    } catch (err) {
      log.error('Failed to stop PR monitoring', { 
        id, 
        prNumber: pr.prNumber, 
        error: err instanceof Error ? err.message : String(err) 
      });
      throw err;
    }
  }

  // ── PR Lifecycle Management ────────────────────────────────────────

  async abandonPR(id: string): Promise<PRLifecycleResult> {
    await this.ensureInitialized();

    const pr = this.managedPRs.get(id);
    if (!pr) {
      return {
        success: false,
        error: `Managed PR not found: ${id}`,
      };
    }

    log.info('Abandoning PR', { id, prNumber: pr.prNumber });

    try {
      // Stop monitoring if active
      if (pr.status === 'monitoring' || pr.status === 'addressing') {
        this.prMonitor.stopMonitoring(id);
      }

      // Call remote PR service to close the PR
      const prService = await this.prServiceFactory.getServiceForRepo(pr.repoPath);
      await prService.abandonPR(pr.prNumber, pr.workingDirectory, 'Abandoned by orchestrator');

      // Update status
      pr.status = 'abandoned';
      pr.completedAt = Date.now();
      await this.persistPR(pr);

      // Cleanup isolated clone if exists
      if (pr.workingDirectory !== pr.repoPath) {
        await this.isolatedRepos.removeIsolatedRepo(id);
      }

      // Emit event
      this.emit('prAbandoned', pr);

      log.info('PR abandoned successfully', { id, prNumber: pr.prNumber });
      return {
        success: true,
        message: `PR #${pr.prNumber} abandoned`,
      };
    } catch (err) {
      log.error('Failed to abandon PR', { 
        id, 
        prNumber: pr.prNumber, 
        error: err instanceof Error ? err.message : String(err) 
      });
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to abandon PR',
      };
    }
  }

  async promotePR(id: string): Promise<PRLifecycleResult> {
    await this.ensureInitialized();

    const pr = this.managedPRs.get(id);
    if (!pr) {
      return {
        success: false,
        error: `Managed PR not found: ${id}`,
      };
    }

    log.info('Promoting PR', { id, prNumber: pr.prNumber });

    try {
      // Call remote PR service to promote (mark as ready for review if draft)
      const prService = await this.prServiceFactory.getServiceForRepo(pr.repoPath);
      await prService.promotePR(pr.prNumber, pr.workingDirectory);

      // Increase priority
      pr.priority = (pr.priority ?? 0) + 1;
      await this.persistPR(pr);

      // Emit event
      this.emit('prPromoted', pr);

      log.info('PR promoted successfully', { id, prNumber: pr.prNumber, newPriority: pr.priority });
      return {
        success: true,
        message: `PR #${pr.prNumber} promoted to priority ${pr.priority}`,
      };
    } catch (err) {
      log.error('Failed to promote PR', { 
        id, 
        prNumber: pr.prNumber, 
        error: err instanceof Error ? err.message : String(err) 
      });
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to promote PR',
      };
    }
  }

  async demotePR(id: string): Promise<PRLifecycleResult> {
    await this.ensureInitialized();

    const pr = this.managedPRs.get(id);
    if (!pr) {
      return {
        success: false,
        error: `Managed PR not found: ${id}`,
      };
    }

    log.info('Demoting PR', { id, prNumber: pr.prNumber });

    try {
      // Call remote PR service to demote (mark as draft)
      const prService = await this.prServiceFactory.getServiceForRepo(pr.repoPath);
      await prService.demotePR(pr.prNumber, pr.workingDirectory);

      // Decrease priority
      pr.priority = Math.max(0, (pr.priority ?? 0) - 1);
      await this.persistPR(pr);

      // Emit event
      this.emit('prDemoted', pr);

      log.info('PR demoted successfully', { id, prNumber: pr.prNumber, newPriority: pr.priority });
      return {
        success: true,
        message: `PR #${pr.prNumber} demoted to priority ${pr.priority}`,
      };
    } catch (err) {
      log.error('Failed to demote PR', { 
        id, 
        prNumber: pr.prNumber, 
        error: err instanceof Error ? err.message : String(err) 
      });
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to demote PR',
      };
    }
  }

  async removePR(id: string): Promise<PRLifecycleResult> {
    await this.ensureInitialized();

    const pr = this.managedPRs.get(id);
    if (!pr) {
      return {
        success: false,
        error: `Managed PR not found: ${id}`,
      };
    }

    log.info('Removing PR from management', { id, prNumber: pr.prNumber });

    try {
      // Stop monitoring if active
      if (pr.status === 'monitoring' || pr.status === 'addressing') {
        this.prMonitor.stopMonitoring(id);
      }

      // Cleanup isolated clone if exists
      if (pr.workingDirectory !== pr.repoPath) {
        await this.isolatedRepos.removeIsolatedRepo(id);
      }

      // Delete from store
      await this.store.delete(pr.prNumber);

      // Remove from memory
      this.managedPRs.delete(id);

      // Emit event (with ID only since PR is gone)
      this.emit('prRemoved', id);

      log.info('PR removed from management', { id, prNumber: pr.prNumber });
      return {
        success: true,
        message: `PR #${pr.prNumber} removed from management`,
      };
    } catch (err) {
      log.error('Failed to remove PR', { 
        id, 
        prNumber: pr.prNumber, 
        error: err instanceof Error ? err.message : String(err) 
      });
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to remove PR',
      };
    }
  }
}
