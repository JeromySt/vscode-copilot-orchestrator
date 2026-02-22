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

  // ─── Low-Level File Operations ─────────────────────────────────────────
  // Used by FileSystemPlanStore for plan storage management.

  /** Check if a path exists synchronously. */
  existsSync(filePath: string): boolean;

  /** Read a file as UTF-8 string (async). */
  readFileAsync(filePath: string): Promise<string>;

  /** Read a file as UTF-8 string (sync). */
  readFileSync(filePath: string): string;

  /** Write a UTF-8 string to a file (async). Creates parent dirs if needed. */
  writeFileAsync(filePath: string, content: string): Promise<void>;

  /** Write a UTF-8 string to a file (sync). */
  writeFileSync(filePath: string, content: string): void;

  /** Rename/move a file or directory (async). */
  renameAsync(oldPath: string, newPath: string): Promise<void>;

  /** Rename/move a file or directory (sync). */
  renameSync(oldPath: string, newPath: string): void;

  /** Delete a file (async). */
  unlinkAsync(filePath: string): Promise<void>;

  /** Delete a file (sync). */
  unlinkSync(filePath: string): void;

  /** Remove a file or directory recursively (async). */
  rmAsync(filePath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;

  /** Remove an empty directory (async). */
  rmdirAsync(dirPath: string): Promise<void>;

  /** Create directories recursively (async). */
  mkdirAsync(dirPath: string, options?: { recursive?: boolean }): Promise<void>;

  /** Create directories recursively (sync). */
  mkdirSync(dirPath: string, options?: { recursive?: boolean }): void;

  /** Read directory entries (async). */
  readdirAsync(dirPath: string): Promise<string[]>;

  /** Get file/link stats without following symlinks (async). */
  lstatAsync(filePath: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }>;

  /** Create a symbolic link or junction (async). */
  symlinkAsync(target: string, linkPath: string, type?: 'file' | 'dir' | 'junction'): Promise<void>;

  /** Read the target of a symbolic link (async). */
  readlinkAsync(linkPath: string): Promise<string>;

  /** Check if a path is accessible (async). Throws if not. */
  accessAsync(filePath: string): Promise<void>;

  /** Copy a file (async). */
  copyFileAsync(src: string, dest: string): Promise<void>;
}
