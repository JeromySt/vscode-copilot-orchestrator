/**
 * @fileoverview Interface for environment abstraction.
 * 
 * Abstracts process.env, process.platform, and process.cwd() to enable
 * dependency injection and unit testing without relying on real environment.
 * 
 * @module interfaces/IEnvironment
 */

/**
 * Interface for accessing environment information.
 * 
 * @example
 * ```typescript
 * class CopilotCliRunner {
 *   constructor(private readonly env: IEnvironment) {}
 *   
 *   buildCleanEnv() {
 *     const clean = { ...this.env.env };
 *     delete clean.NODE_OPTIONS;
 *     return clean;
 *   }
 * }
 * ```
 */
export interface IEnvironment {
  /** Environment variables (mirrors process.env) */
  readonly env: Record<string, string | undefined>;

  /** Platform identifier (mirrors process.platform) */
  readonly platform: string;

  /** Get the current working directory */
  cwd(): string;
}

/**
 * Default environment that delegates to Node.js process globals.
 */
export class DefaultEnvironment implements IEnvironment {
  get env(): Record<string, string | undefined> {
    return process.env;
  }

  get platform(): string {
    return process.platform;
  }

  cwd(): string {
    return process.cwd();
  }
}
