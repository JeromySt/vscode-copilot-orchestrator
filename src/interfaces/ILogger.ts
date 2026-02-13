/**
 * @fileoverview Interface for logging abstraction.
 * 
 * Mirrors the public API of `ComponentLogger` to allow dependency injection
 * of logging in components that need testability without coupling to the
 * concrete Logger/ComponentLogger implementation.
 * 
 * @module interfaces/ILogger
 */

/**
 * Interface for a component-scoped logger.
 * 
 * Provides standard log-level methods for structured logging.
 * Implementations may write to VS Code OutputChannel, console, or test stubs.
 * 
 * @example
 * ```typescript
 * class MyService {
 *   constructor(private readonly log: ILogger) {}
 *   
 *   doWork(): void {
 *     this.log.info('Starting work');
 *     this.log.debug('Details', { step: 1 });
 *   }
 * }
 * ```
 */
export interface ILogger {
  /**
   * Log at debug level.
   * Only emitted if debug logging is enabled for the component.
   * 
   * @param message - Log message
   * @param data - Optional structured data or Error
   */
  debug(message: string, data?: any): void;

  /**
   * Log at info level.
   * 
   * @param message - Log message
   * @param data - Optional structured data or Error
   */
  info(message: string, data?: any): void;

  /**
   * Log at warn level.
   * 
   * @param message - Log message
   * @param data - Optional structured data or Error
   */
  warn(message: string, data?: any): void;

  /**
   * Log at error level.
   * 
   * @param message - Log message
   * @param data - Optional structured data or Error
   */
  error(message: string, data?: any): void;

  /**
   * Check if debug logging is enabled.
   * Useful to skip expensive data formatting when debug is off.
   * 
   * @returns true if debug logging is enabled
   */
  isDebugEnabled(): boolean;

  /**
   * Set the log level for this logger.
   * 
   * @param level - The log level to set
   */
  setLevel(level: 'debug' | 'info' | 'warn' | 'error'): void;

  /**
   * Get the current log level.
   * 
   * @returns The current log level as a string
   */
  getLevel(): string;
}
