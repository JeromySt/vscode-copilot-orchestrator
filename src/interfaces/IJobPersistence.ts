/**
 * @fileoverview Interface for job persistence operations.
 * 
 * Abstracts the storage mechanism for job state, enabling:
 * - Unit testing with mock storage
 * - Future migration to different storage backends
 * - Separation of concerns from job execution logic
 * 
 * @module interfaces/IJobPersistence
 */

import { Job } from '../types';

/**
 * Interface for persisting and retrieving job state.
 * 
 * Implementations should handle:
 * - Atomic writes to prevent corruption
 * - Migration from old formats
 * - Efficient log appending
 * 
 * @example
 * ```typescript
 * class FileJobPersistence implements IJobPersistence {
 *   load(): Job[] { return readJSON(this.stateFile); }
 *   save(jobs: Job[]): void { writeJSON(this.stateFile, { jobs }); }
 * }
 * ```
 */
export interface IJobPersistence {
  /**
   * Load all persisted jobs.
   * Should handle migration from old formats gracefully.
   * @returns Array of all stored jobs
   */
  load(): Job[];
  
  /**
   * Persist the current job state.
   * Should be atomic to prevent corruption on crash.
   * @param jobs - All jobs to persist
   */
  save(jobs: Job[]): void;
  
  /**
   * Append a log message to a job's log file.
   * @param jobId - The job to log to
   * @param message - The log message (will be timestamped)
   */
  appendLog(jobId: string, message: string): void;
  
  /**
   * Read a job's log file.
   * @param jobId - The job to read logs for
   * @param section - Optional section filter (PRECHECKS, WORK, etc.)
   * @returns Log content as string
   */
  readLog(jobId: string, section?: string): string;
  
  /**
   * Get the log file path for a job.
   * @param jobId - The job ID
   * @returns Absolute path to the log file
   */
  getLogPath(jobId: string): string;
}
