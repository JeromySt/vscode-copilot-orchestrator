/**
 * @fileoverview Plan Configuration Manager
 *
 * Wraps configuration access behind {@link IConfigProvider} so that
 * plan-related code never imports vscode directly.
 *
 * @module plan/configManager
 */

import type { IConfigProvider } from '../interfaces/IConfigProvider';

/**
 * Provides plan-related configuration with type-safe accessors.
 *
 * Falls back to sensible defaults when no config provider is available
 * (e.g. running outside the VS Code extension host).
 */
export class PlanConfigManager {
  private readonly provider?: IConfigProvider;

  constructor(provider?: IConfigProvider) {
    this.provider = provider;
  }

  /**
   * Generic typed configuration getter.
   */
  getConfig<T>(section: string, key: string, defaultValue: T): T {
    if (!this.provider) {
      return defaultValue;
    }
    return this.provider.getConfig(section, key, defaultValue);
  }

  /**
   * Whether to push target branch to origin after a successful RI merge.
   */
  get pushOnSuccess(): boolean {
    return this.getConfig<boolean>('copilotOrchestrator.merge', 'pushOnSuccess', false);
  }

  /**
   * Conflict resolution preference ('theirs' | 'ours').
   */
  get mergePrefer(): string {
    return this.getConfig<string>('copilotOrchestrator.merge', 'prefer', 'theirs');
  }
}
