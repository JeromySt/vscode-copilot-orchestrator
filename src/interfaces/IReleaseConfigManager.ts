/**
 * @fileoverview Interface for Release Configuration Manager
 * 
 * Provides abstraction for release management configuration access
 * to enable dependency injection and unit testing without coupling
 * to concrete implementations.
 * 
 * @module interfaces/IReleaseConfigManager
 */

import type { ReleaseConfig } from '../plan/releaseConfigManager';

/**
 * Interface for accessing release management configuration.
 * 
 * Provides type-safe access to all release-related settings.
 * Implementations should read from VS Code configuration and
 * return complete {@link ReleaseConfig} objects.
 * 
 * @example
 * ```typescript
 * class ReleasePRMonitor {
 *   constructor(private readonly releaseConfig: IReleaseConfigManager) {}
 *   
 *   async startMonitoring(): Promise<void> {
 *     const config = this.releaseConfig.getConfig();
 *     const pollInterval = config.pollIntervalMs;
 *     // Use config values...
 *   }
 * }
 * ```
 */
export interface IReleaseConfigManager {
  /**
   * Get all release management configuration settings.
   * 
   * This should be called at each operation (not cached) so that
   * live configuration changes take effect immediately.
   * 
   * @returns Complete release configuration with all settings resolved
   */
  getConfig(): ReleaseConfig;
}
