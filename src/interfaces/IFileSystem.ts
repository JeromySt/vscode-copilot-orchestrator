/**
 * @fileoverview Interface for file system operations abstraction.
 * 
 * Abstracts the file system utilities from `src/core/utils.ts` to enable
 * dependency injection and unit testing without touching the real file system.
 * 
 * @module interfaces/IFileSystem
 */

/**
 * Interface for file system operations.
 * 
 * Provides both sync and async variants for common file operations.
 * Prefer async methods to avoid blocking the event loop.
 * 
 * @example
 * ```typescript
 * class PlanPersistence {
 *   constructor(private readonly fs: IFileSystem) {}
 *   
 *   async savePlan(path: string, plan: Plan): Promise<void> {
 *     await this.fs.ensureDirAsync(dirname(path));
 *     await this.fs.writeJSONAsync(path, plan);
 *   }
 * }
 * ```
 */
export interface IFileSystem {
  // ─── Sync Operations ───────────────────────────────────────────────────

  /**
   * Ensure a directory exists, creating it recursively if needed.
   * @param dirPath - Directory path to ensure
   */
  ensureDir(dirPath: string): void;

  /**
   * Read and parse a JSON file synchronously.
   * Returns the fallback value if the file doesn't exist or is invalid.
   * 
   * @param filePath - Path to JSON file
   * @param fallback - Default value on failure
   * @returns Parsed JSON or fallback
   */
  readJSON<T>(filePath: string, fallback: T): T;

  /**
   * Write an object as JSON to a file synchronously.
   * Creates parent directories as needed.
   * 
   * @param filePath - Path to write
   * @param obj - Object to serialize
   */
  writeJSON(filePath: string, obj: any): void;

  // ─── Async Operations ─────────────────────────────────────────────────

  /**
   * Ensure a directory exists, creating it recursively if needed (async).
   * @param dirPath - Directory path to ensure
   */
  ensureDirAsync(dirPath: string): Promise<void>;

  /**
   * Read and parse a JSON file asynchronously.
   * Returns the fallback value if the file doesn't exist or is invalid.
   * 
   * @param filePath - Path to JSON file
   * @param fallback - Default value on failure
   * @returns Parsed JSON or fallback
   */
  readJSONAsync<T>(filePath: string, fallback: T): Promise<T>;

  /**
   * Write an object as JSON to a file asynchronously.
   * Creates parent directories as needed.
   * 
   * @param filePath - Path to write
   * @param obj - Object to serialize
   */
  writeJSONAsync(filePath: string, obj: any): Promise<void>;

  /**
   * Check if a path exists (async).
   * 
   * @param filePath - Path to check
   * @returns true if the path exists
   */
  existsAsync(filePath: string): Promise<boolean>;
}
