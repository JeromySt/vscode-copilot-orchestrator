/**
 * @fileoverview Interface for job execution and management.
 * 
 * This is the primary interface for job orchestration, used by:
 * - HTTP API handlers
 * - MCP server tools
 * - VS Code commands
 * - UI components
 * 
 * @module interfaces/IJobRunner
 */

import { Job, JobSpec, WebhookConfig } from '../types';

/**
 * Core interface for job execution and lifecycle management.
 * 
 * The JobRunner is responsible for:
 * - Queue management and worker allocation
 * - Job execution orchestration
 * - State persistence and recovery
 * - Process monitoring and cleanup
 * 
 * @example
 * ```typescript
 * // In a command handler
 * const job = runner.getJob(jobId);
 * if (job?.status === 'failed') {
 *   runner.retry(jobId);
 * }
 * ```
 */
export interface IJobRunner {
  /**
   * Get all jobs (both active and completed).
   * @returns Array of all jobs in the system
   */
  list(): Job[];
  
  /**
   * Get a specific job by ID.
   * @param id - Job identifier
   * @returns The job if found, undefined otherwise
   */
  getJob(id: string): Job | undefined;
  
  /**
   * Queue a new job for execution.
   * The job will be executed when a worker becomes available.
   * @param spec - Job specification
   * @param webhook - Optional webhook configuration for notifications
   */
  enqueue(spec: JobSpec, webhook?: WebhookConfig): void;
  
  /**
   * Retry a failed or canceled job.
   * Creates a new execution attempt with updated work context.
   * @param jobId - Job to retry
   * @param updatedWorkContext - Optional new context for the retry
   */
  retry(jobId: string, updatedWorkContext?: string): void;
  
  /**
   * Continue a job with additional work instructions.
   * Used for iterative development on a job.
   * @param jobId - Job to continue
   * @param work - New work instructions
   */
  continueWork(jobId: string, work: string): void;
  
  /**
   * Cancel a running or queued job.
   * Running jobs will have their processes terminated.
   * @param id - Job to cancel
   */
  cancel(id: string): void;
  
  /**
   * Delete a job and its associated resources.
   * Running jobs will be canceled first.
   * @param id - Job to delete
   * @returns true if deletion succeeded, false otherwise
   */
  delete(id: string): boolean;
  
  /**
   * Maximum number of concurrent job workers.
   * Defaults to CPU count minus one.
   */
  readonly maxWorkers: number;
}
