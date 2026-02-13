/**
 * @fileoverview Global Capacity Manager
 * 
 * Coordinates job capacity across multiple VS Code instances using a file-based registry.
 * Provides cross-instance visibility into running jobs and enforces global capacity limits.
 * 
 * Features:
 * - File-based registry with atomic operations
 * - Heartbeat-based instance lifecycle tracking
 * - Process liveness detection
 * - Event emission for capacity changes
 * - Graceful fallback for single-instance mode
 * 
 * @module core/globalCapacity
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { Logger } from './logger';
import { ensureDirAsync, readJSONAsync, writeJSONAsync } from './utils';

const log = Logger.for('global-capacity');

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Represents a single VS Code instance in the global registry.
 */
export interface InstanceRegistration {
  /** Unique ID for this VS Code instance */
  instanceId: string;
  /** OS process ID for liveness detection */
  processId: number;
  /** Current job count from this instance */
  runningJobs: number;
  /** Timestamp of last update (ms since epoch) */
  lastHeartbeat: number;
  /** Plan IDs being executed */
  activePlans: string[];
}

/**
 * Global capacity registry structure.
 */
export interface GlobalCapacityRegistry {
  /** Schema version for future migrations */
  version: number;
  /** Registered instances */
  instances: InstanceRegistration[];
  /** Shared limit across all instances */
  globalMaxParallel: number;
}

/**
 * Statistics about global capacity usage.
 */
export interface GlobalCapacityStats {
  /** This instance's ID */
  thisInstanceId: string;
  /** This instance's running job count */
  thisInstanceJobs: number;
  /** Total jobs across all instances */
  totalGlobalJobs: number;
  /** Global capacity limit */
  globalMaxParallel: number;
  /** Number of active instances */
  activeInstances: number;
  /** Details for each instance */
  instanceDetails: Array<{
    instanceId: string;
    runningJobs: number;
    isCurrentInstance: boolean;
  }>;
}

/**
 * Events emitted by GlobalCapacityManager.
 */
export interface GlobalCapacityEvents {
  capacityChanged: (stats: GlobalCapacityStats) => void;
  instanceJoined: (instanceId: string) => void;
  instanceLeft: (instanceId: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const REGISTRY_VERSION = 1;
const DEFAULT_MAX_PARALLEL = 16;
const HEARTBEAT_INTERVAL_MS = 5000; // 5 seconds
const STALE_THRESHOLD_MS = 30000;   // 30 seconds
const WRITE_ERROR_LOG_INTERVAL_MS = 60000; // Log at most once per minute

// ─────────────────────────────────────────────────────────────────────────────
// GlobalCapacityManager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages global job capacity across multiple VS Code instances.
 * 
 * Uses a file-based registry with atomic operations to coordinate capacity.
 * Instances register themselves and update their running job counts via heartbeat.
 * Stale instances (no heartbeat) are automatically cleaned up.
 * 
 * @example
 * ```typescript
 * const manager = new GlobalCapacityManager(globalStoragePath);
 * await manager.initialize();
 * 
 * await manager.updateRunningJobs(3, ['plan-1', 'plan-2']);
 * const stats = await manager.getStats();
 * console.log(`Total jobs: ${stats.totalGlobalJobs}`);
 * 
 * await manager.shutdown();
 * ```
 */
export class GlobalCapacityManager extends EventEmitter {
  private instanceId: string;
  private processId: number;
  private registryPath: string;
  private heartbeatInterval?: NodeJS.Timeout;
  private currentRunningJobs: number = 0;
  private currentActivePlans: string[] = [];
  private isInitialized: boolean = false;
  private writeErrorCount: number = 0;
  private lastWriteErrorLog: number = 0;

  /**
   * Creates a new GlobalCapacityManager.
   * 
   * @param globalStoragePath - Path to extension's global storage directory
   */
  constructor(private globalStoragePath: string) {
    super();
    this.processId = process.pid;
    this.instanceId = this.generateInstanceId();
    this.registryPath = path.join(globalStoragePath, 'capacity-registry.json');
  }

  /**
   * Initialize and register this instance.
   * 
   * Registers this VS Code instance in the global registry, starts the heartbeat
   * process, and cleans up any stale instances from previous crashes.
   * 
   * Safe to call multiple times — only the first call performs initialization.
   * 
   * On error (e.g., registry file locked), logs the error but does not throw,
   * allowing graceful fallback to single-instance mode.
   * 
   * @throws Never - all errors are caught and logged
   * 
   * @example
   * ```typescript
   * const manager = new GlobalCapacityManager(globalStoragePath);
   * await manager.initialize();
   * // Now ready to use
   * ```
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      log.warn('GlobalCapacityManager already initialized');
      return;
    }

    try {
      await ensureDirAsync(this.globalStoragePath);
      
      // Register this instance
      await this.registerInstance();
      
      // Start heartbeat
      this.startHeartbeat();
      
      this.isInitialized = true;
      log.info(`GlobalCapacityManager initialized (instance: ${this.instanceId})`);
    } catch (error) {
      log.error('Failed to initialize GlobalCapacityManager', error);
      // Fallback to single-instance mode - don't throw
    }
  }

  /**
   * Update this instance's running job count.
   * 
   * Notifies the global registry of this instance's current job count and active plans.
   * Should be called whenever job count changes. Emits `capacityChanged` event on success.
   * 
   * On error, logs the error but does not throw, allowing graceful degradation.
   * 
   * @param count - Current number of running jobs in this instance
   * @param activePlans - IDs of plans currently executing in this instance
   * @throws Never - errors are caught and logged
   * 
   * @example
   * ```typescript
   * await manager.updateRunningJobs(3, ['plan-id-1', 'plan-id-2']);
   * ```
   */
  async updateRunningJobs(count: number, activePlans: string[]): Promise<void> {
    if (!this.isInitialized) {
      log.warn('GlobalCapacityManager not initialized, skipping update');
      return;
    }

    this.currentRunningJobs = count;
    this.currentActivePlans = activePlans;
    
    try {
      await this.updateRegistry();
      const stats = await this.getStats();
      this.emit('capacityChanged', stats);
    } catch (error) {
      log.error('Failed to update running jobs', error);
    }
  }

  /**
   * Get global capacity statistics.
   * 
   * Retrieves current capacity usage across all instances, including this instance's
   * job count, total global jobs, and per-instance breakdown.
   * 
   * On error, returns fallback stats for single-instance mode to ensure graceful degradation.
   * 
   * @returns Statistics about global capacity usage
   * @throws Never - errors are caught and fallback stats are returned
   * 
   * @example
   * ```typescript
   * const stats = await manager.getStats();
   * console.log(`Global: ${stats.totalGlobalJobs}/${stats.globalMaxParallel}`);
   * console.log(`This instance: ${stats.thisInstanceJobs}`);
   * console.log(`Active instances: ${stats.activeInstances}`);
   * ```
   */
  async getStats(): Promise<GlobalCapacityStats> {
    try {
      const registry = await this.readRegistry();
      const totalJobs = registry.instances.reduce((sum, inst) => sum + inst.runningJobs, 0);
      
      return {
        thisInstanceId: this.instanceId,
        thisInstanceJobs: this.currentRunningJobs,
        totalGlobalJobs: totalJobs,
        globalMaxParallel: registry.globalMaxParallel,
        activeInstances: registry.instances.length,
        instanceDetails: registry.instances.map(inst => ({
          instanceId: inst.instanceId,
          runningJobs: inst.runningJobs,
          isCurrentInstance: inst.instanceId === this.instanceId,
        })),
      };
    } catch (error) {
      log.error('Failed to get stats', error);
      // Fallback stats for single instance
      return {
        thisInstanceId: this.instanceId,
        thisInstanceJobs: this.currentRunningJobs,
        totalGlobalJobs: this.currentRunningJobs,
        globalMaxParallel: DEFAULT_MAX_PARALLEL,
        activeInstances: 1,
        instanceDetails: [{
          instanceId: this.instanceId,
          runningJobs: this.currentRunningJobs,
          isCurrentInstance: true,
        }],
      };
    }
  }

  /**
   * Check if we can start more jobs globally.
   * 
   * Returns the number of additional jobs that can be started across all instances
   * before hitting the global capacity limit. Returns 0 if at capacity.
   * 
   * On error, falls back to per-instance capacity calculation (DEFAULT_MAX_PARALLEL - currentRunningJobs).
   * 
   * @returns Number of jobs that can be started (≥ 0)
   * @throws Never - errors are caught and fallback calculation is returned
   * 
   * @example
   * ```typescript
   * const available = await manager.getAvailableCapacity();
   * if (available > 0) {
   *   // Schedule more jobs
   * }
   * ```
   */
  async getAvailableCapacity(): Promise<number> {
    try {
      const registry = await this.readRegistry();
      const totalJobs = registry.instances.reduce((sum, inst) => sum + inst.runningJobs, 0);
      return Math.max(0, registry.globalMaxParallel - totalJobs);
    } catch (error) {
      log.error('Failed to get available capacity', error);
      // Fallback: allow up to default limit
      return Math.max(0, DEFAULT_MAX_PARALLEL - this.currentRunningJobs);
    }
  }

  /**
   * Get total jobs running across all instances.
   * 
   * Sums the job counts from all registered instances. Useful for monitoring
   * and capacity planning across the entire system.
   * 
   * On error, returns this instance's job count (fallback to local visibility).
   * 
   * @returns Total number of jobs running across all instances
   * @throws Never - errors are caught and local count is returned
   * 
   * @example
   * ```typescript
   * const total = await manager.getTotalGlobalRunning();
   * console.log(`${total} jobs running globally`);
   * ```
   */
  async getTotalGlobalRunning(): Promise<number> {
    try {
      const registry = await this.readRegistry();
      return registry.instances.reduce((sum, inst) => sum + inst.runningJobs, 0);
    } catch (error) {
      log.error('Failed to get total global running', error);
      return this.currentRunningJobs;
    }
  }

  /**
   * Set the global max parallel limit.
   * 
   * Updates the registry with a new global capacity limit. All instances will respect
   * this limit for scheduling decisions. Emits `capacityChanged` event on success.
   * 
   * Has no effect if not initialized. Errors are logged but do not throw.
   * 
   * @param max - New global maximum parallel jobs (must be positive)
   * @throws Never - errors are caught and logged
   * 
   * @example
   * ```typescript
   * await manager.setGlobalMaxParallel(32);
   * ```
   */
  async setGlobalMaxParallel(max: number): Promise<void> {
    if (!this.isInitialized) {
      log.warn('GlobalCapacityManager not initialized');
      return;
    }

    try {
      const registry = await this.readRegistry();
      registry.globalMaxParallel = max;
      await this.writeRegistry(registry);
      log.info(`Global max parallel set to ${max}`);
      
      const stats = await this.getStats();
      this.emit('capacityChanged', stats);
    } catch (error) {
      log.error('Failed to set global max parallel', error);
    }
  }

  /**
   * Unregister this instance on shutdown.
   * 
   * Stops the heartbeat interval and removes this instance from the registry.
   * Should be called during extension deactivation to cleanly release global capacity.
   * 
   * Safe to call even if not initialized — performs no-op in that case.
   * Errors during unregistration are logged but do not throw.
   * 
   * @throws Never - all errors are caught and logged
   * 
   * @example
   * ```typescript
   * // On extension deactivation:
   * await manager.shutdown();
   * ```
   */
  async shutdown(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    try {
      await this.unregisterInstance();
      log.info(`GlobalCapacityManager shutdown (instance: ${this.instanceId})`);
    } catch (error) {
      log.error('Failed to shutdown GlobalCapacityManager', error);
    }

    this.isInitialized = false;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Generate a stable instance ID.
   * Uses workspace path and process ID for uniqueness.
   */
  private generateInstanceId(): string {
    let vscode: typeof import('vscode') | undefined;
    try {
      vscode = require('vscode');
    } catch {
      vscode = undefined;
    }

    const workspace = vscode?.workspace.workspaceFolders?.[0]?.uri.fsPath || 'unknown';
    const seed = `${workspace}-${this.processId}-${Date.now()}`;
    
    return crypto.createHash('md5')
      .update(seed)
      .digest('hex')
      .slice(0, 12);
  }

  /**
   * Read the registry file.
   * Returns default registry if file doesn't exist or is corrupted.
   */
  private async readRegistry(): Promise<GlobalCapacityRegistry> {
    const defaultRegistry: GlobalCapacityRegistry = {
      version: REGISTRY_VERSION,
      instances: [],
      globalMaxParallel: DEFAULT_MAX_PARALLEL,
    };

    try {
      const registry = await readJSONAsync<GlobalCapacityRegistry>(this.registryPath, defaultRegistry);
      
      // Validate schema
      if (registry.version !== REGISTRY_VERSION) {
        log.warn(`Registry version mismatch (expected ${REGISTRY_VERSION}, got ${registry.version}), resetting`);
        return defaultRegistry;
      }
      
      return registry;
    } catch (error) {
      log.error('Failed to read registry, using default', error);
      return defaultRegistry;
    }
  }

  /**
   * Write the registry file atomically.
   * Uses temp file + rename for atomicity with retry logic for EPERM/EBUSY errors.
   */
  private async writeRegistry(registry: GlobalCapacityRegistry): Promise<void> {
    const tempPath = `${this.registryPath}.tmp.${this.instanceId}`;
    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 100;
    let originalError: any;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Write to temp file
        await writeJSONAsync(tempPath, registry);
        
        // Atomic rename
        await fs.promises.rename(tempPath, this.registryPath);
        return; // Success!
        
      } catch (error: any) {
        originalError = error;
        
        // Clean up temp file
        try { 
          await fs.promises.unlink(tempPath); 
        } catch { 
          // Ignore cleanup errors
        }
        
        // Check if EPERM/EBUSY - retry those
        if ((error.code === 'EPERM' || error.code === 'EBUSY') && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1); // 100, 200, 400ms
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // If not retryable error or max retries reached, try fallback
        break;
      }
    }
    
    // After all retries fail for rename, try direct write as last resort
    try {
      await writeJSONAsync(this.registryPath, registry);
      log.debug('Used direct write fallback for registry');
      return;
    } catch {
      throw originalError;
    }
  }

  /**
   * Register this instance in the registry.
   */
  private async registerInstance(): Promise<void> {
    const registry = await this.readRegistry();
    
    // Clean up stale instances first
    await this.cleanupStaleInstances(registry);
    
    // Check if already registered
    const existingIndex = registry.instances.findIndex(inst => inst.instanceId === this.instanceId);
    
    const registration: InstanceRegistration = {
      instanceId: this.instanceId,
      processId: this.processId,
      runningJobs: this.currentRunningJobs,
      lastHeartbeat: Date.now(),
      activePlans: this.currentActivePlans,
    };
    
    if (existingIndex >= 0) {
      registry.instances[existingIndex] = registration;
    } else {
      registry.instances.push(registration);
      this.emit('instanceJoined', this.instanceId);
    }
    
    await this.writeRegistry(registry);
  }

  /**
   * Unregister this instance from the registry.
   */
  private async unregisterInstance(): Promise<void> {
    try {
      const registry = await this.readRegistry();
      const originalLength = registry.instances.length;
      
      registry.instances = registry.instances.filter(inst => inst.instanceId !== this.instanceId);
      
      if (registry.instances.length < originalLength) {
        await this.writeRegistry(registry);
        this.emit('instanceLeft', this.instanceId);
      }
    } catch (error) {
      log.error('Failed to unregister instance', error);
    }
  }

  /**
   * Update registry with current state (heartbeat).
   */
  private async updateRegistry(): Promise<void> {
    try {
      const registry = await this.readRegistry();
      
      // Clean up stale instances
      await this.cleanupStaleInstances(registry);
      
      // Update this instance
      const index = registry.instances.findIndex(inst => inst.instanceId === this.instanceId);
      
      if (index >= 0) {
        registry.instances[index].runningJobs = this.currentRunningJobs;
        registry.instances[index].activePlans = this.currentActivePlans;
        registry.instances[index].lastHeartbeat = Date.now();
      } else {
        // Re-register if missing
        registry.instances.push({
          instanceId: this.instanceId,
          processId: this.processId,
          runningJobs: this.currentRunningJobs,
          lastHeartbeat: Date.now(),
          activePlans: this.currentActivePlans,
        });
      }
      
      await this.writeRegistry(registry);
    } catch (error) {
      this.writeErrorCount++;
      const now = Date.now();
      if (now - this.lastWriteErrorLog > WRITE_ERROR_LOG_INTERVAL_MS) {
        log.warn(`Failed to update registry (${this.writeErrorCount} failures since last log)`, error);
        this.lastWriteErrorLog = now;
        this.writeErrorCount = 0;
      }
      // Still proceed - single instance mode as fallback
    }
  }

  /**
   * Clean up stale instances from the registry.
   * An instance is stale if:
   * - Its heartbeat is older than STALE_THRESHOLD_MS
   * - Its process is no longer running
   */
  private async cleanupStaleInstances(registry: GlobalCapacityRegistry): Promise<void> {
    const now = Date.now();
    const originalLength = registry.instances.length;
    
    registry.instances = registry.instances.filter(inst => {
      // Skip current instance
      if (inst.instanceId === this.instanceId) {
        return true;
      }
      
      // Check heartbeat age
      if (now - inst.lastHeartbeat > STALE_THRESHOLD_MS) {
        log.debug(`Removing stale instance ${inst.instanceId} (heartbeat age: ${now - inst.lastHeartbeat}ms)`);
        this.emit('instanceLeft', inst.instanceId);
        return false;
      }
      
      // Check if process is still running
      if (!this.isProcessAlive(inst.processId)) {
        log.debug(`Removing dead instance ${inst.instanceId} (process ${inst.processId} not running)`);
        this.emit('instanceLeft', inst.instanceId);
        return false;
      }
      
      return true;
    });
    
    if (registry.instances.length < originalLength) {
      log.info(`Cleaned up ${originalLength - registry.instances.length} stale instance(s)`);
    }
  }

  /**
   * Check if a process is still running.
   * 
   * @param pid - Process ID to check
   * @returns true if process is alive, false otherwise
   */
  private isProcessAlive(pid: number): boolean {
    try {
      // Signal 0 doesn't actually send a signal, just checks if process exists
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      // ESRCH means process doesn't exist
      if (error.code === 'ESRCH') {
        return false;
      }
      // EPERM means process exists but we don't have permission (still alive)
      if (error.code === 'EPERM') {
        return true;
      }
      // Other errors: assume alive to be safe
      return true;
    }
  }

  /**
   * Start the heartbeat interval.
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    this.heartbeatInterval = setInterval(async () => {
      try {
        await this.updateRegistry();
      } catch (error) {
        log.error('Heartbeat update failed', error);
      }
    }, HEARTBEAT_INTERVAL_MS);
    
    // Don't keep process alive if this is the only thing running
    this.heartbeatInterval.unref();
  }
}
