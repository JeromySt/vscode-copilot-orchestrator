/**
 * @fileoverview Interface for VS Code configuration access abstraction.
 * 
 * Abstracts VS Code's workspace configuration API to enable dependency injection
 * and unit testing without coupling to the VS Code API directly.
 * 
 * @module interfaces/IConfigProvider
 */

/**
 * Interface for accessing VS Code workspace configuration.
 * 
 * Provides a type-safe way to read configuration values with fallback defaults.
 * Replaces direct calls to `vscode.workspace.getConfiguration()`.
 * 
 * @example
 * ```typescript
 * class MyService {
 *   constructor(private readonly config: IConfigProvider) {}
 *   
 *   getTimeout(): number {
 *     return this.config.getConfig('myExtension', 'timeout', 5000);
 *   }
 *   
 *   isFeatureEnabled(): boolean {
 *     return this.config.getConfig('myExtension', 'enableFeature', false);
 *   }
 * }
 * ```
 */
export interface IConfigProvider {
  /**
   * Get a configuration value with a fallback default.
   * 
   * @template T - Type of the configuration value
   * @param section - Configuration section (extension name)
   * @param key - Configuration key within the section
   * @param defaultValue - Default value if configuration is not set
   * @returns Configuration value or default
   */
  getConfig<T>(section: string, key: string, defaultValue: T): T;
}