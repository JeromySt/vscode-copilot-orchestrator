/**
 * @fileoverview Release Configuration Manager
 *
 * Provides typed access to release management configuration settings.
 * Wraps {@link IConfigProvider} to isolate release management code from
 * VS Code API dependencies.
 *
 * @module plan/releaseConfigManager
 */

import type { IConfigProvider } from '../interfaces/IConfigProvider';

/**
 * Release management configuration settings.
 * All time values are converted to milliseconds for internal use.
 */
export interface ReleaseConfig {
  /** Poll interval in milliseconds (derived from pollIntervalSeconds * 1000) */
  pollIntervalMs: number;
  /** Maximum monitoring duration in milliseconds (derived from maxMonitoringMinutes * 60000) */
  maxMonitoringMs: number;
  /** Reset the monitoring timer when a fix is pushed to the PR branch */
  resetTimerOnPush: boolean;
  /** Create pull requests as drafts initially */
  createPRAsDraft: boolean;
  /** Automatically address review comments using Copilot CLI */
  autoAddressComments: boolean;
  /** Automatically fix failing CI checks using Copilot CLI */
  autoFixCI: boolean;
  /** Automatically resolve security/CodeQL alerts using Copilot CLI */
  autoResolveSecurityAlerts: boolean;
  /** Git merge strategy when merging plan branches into the release branch */
  mergeStrategy: 'merge' | 'squash' | 'rebase';
  /** Git clone strategy for isolated release repos */
  isolatedCloneStrategy: 'shared' | 'reference' | 'full';
  /** Automatically clean up isolated clones on completion */
  cleanupOnComplete: boolean;
}

/**
 * Manages release-related configuration with type-safe accessors.
 * 
 * Resolves all settings from `copilotOrchestrator.releaseManagement.*`
 * with sensible defaults. Falls back to defaults when no config provider
 * is available (e.g., running outside the VS Code extension host).
 * 
 * @example
 * ```typescript
 * const manager = new ReleaseConfigManager(configProvider);
 * const config = manager.getConfig();
 * 
 * if (config.autoAddressComments) {
 *   await addressReviewComments();
 * }
 * ```
 */
export class ReleaseConfigManager {
  private readonly provider?: IConfigProvider;

  constructor(provider?: IConfigProvider) {
    this.provider = provider;
  }

  /**
   * Get all release management configuration settings.
   * 
   * This method should be called at each operation (not cached) so that
   * live config changes take effect immediately.
   * 
   * @returns Complete release configuration with all settings resolved
   */
  getConfig(): ReleaseConfig {
    const pollIntervalSeconds = this.getConfigValue(
      'pollIntervalSeconds',
      120
    );
    const maxMonitoringMinutes = this.getConfigValue(
      'maxMonitoringMinutes',
      40
    );

    return {
      pollIntervalMs: pollIntervalSeconds * 1000,
      maxMonitoringMs: maxMonitoringMinutes * 60000,
      resetTimerOnPush: this.getConfigValue('resetTimerOnPush', true),
      createPRAsDraft: this.getConfigValue('createPRAsDraft', false),
      autoAddressComments: this.getConfigValue('autoAddressComments', true),
      autoFixCI: this.getConfigValue('autoFixCI', true),
      autoResolveSecurityAlerts: this.getConfigValue('autoResolveSecurityAlerts', true),
      mergeStrategy: this.getConfigValue<'merge' | 'squash' | 'rebase'>('mergeStrategy', 'merge'),
      isolatedCloneStrategy: this.getConfigValue<'shared' | 'reference' | 'full'>('isolatedCloneStrategy', 'shared'),
      cleanupOnComplete: this.getConfigValue('cleanupOnComplete', true),
    };
  }

  /**
   * Generic typed configuration getter for release management settings.
   * 
   * @template T - Type of the configuration value
   * @param key - Configuration key within the releaseManagement section
   * @param defaultValue - Default value if configuration is not set
   * @returns Configuration value or default
   */
  private getConfigValue<T>(key: string, defaultValue: T): T {
    if (!this.provider) {
      return defaultValue;
    }
    return this.provider.getConfig<T>(
      'copilotOrchestrator.releaseManagement',
      key,
      defaultValue
    );
  }
}
