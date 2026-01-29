/**
 * @fileoverview Job Logging - Centralized logging for job execution.
 * 
 * Single responsibility: Write and read job execution logs.
 * 
 * @module core/job/logging
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger, ComponentLogger } from '../logger';
import { Job, ExecutionAttempt } from './types';

const log: ComponentLogger = Logger.for('jobs');

/**
 * Write a message to a job's log file.
 */
export function writeJobLog(job: Job, message: string): void {
  if (!job.logFile) return;
  
  try {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}`;
    fs.appendFileSync(job.logFile, logLine + '\n', 'utf-8');
  } catch (e: any) {
    log.error(`Failed to write to job log file`, { jobId: job.id, error: e.message });
  }
}

/**
 * Read a job's log file content.
 */
export function readJobLog(job: Job): string {
  if (!job.logFile) return '';
  
  try {
    if (fs.existsSync(job.logFile)) {
      return fs.readFileSync(job.logFile, 'utf-8');
    }
  } catch (e: any) {
    log.error(`Failed to read job log file`, { jobId: job.id, error: e.message });
  }
  
  return '';
}

/**
 * Initialize a new log file for a job attempt.
 */
export function initializeAttemptLog(
  job: Job,
  attempt: ExecutionAttempt,
  logDir: string
): string {
  const logFile = path.join(logDir, `${job.id}-attempt-${attempt.attemptId.substring(0, 8)}.log`);
  
  try {
    const header = [
      `=== Job ${job.name} (${job.id}) Attempt ${job.attempts?.length || 1} started at ${new Date(attempt.startedAt).toISOString()} ===`,
      `Attempt ID: ${attempt.attemptId}`,
      `Name: ${job.name}`,
      `Task: ${job.task}`,
      `Repository: ${job.inputs.repoPath}`,
      `Base Branch: ${job.inputs.baseBranch}`,
      `Target Branch: ${job.inputs.targetBranch}`,
    ];
    
    if (job.workHistory && job.workHistory.length > 1) {
      header.push(`Work History (${job.workHistory.length} iterations):`);
      job.workHistory.forEach((w, i) => {
        header.push(`  [${i === 0 ? 'CURRENT' : i}] ${w.substring(0, 100)}${w.length > 100 ? '...' : ''}`);
      });
    }
    
    header.push('');
    
    fs.writeFileSync(logFile, header.join('\n') + '\n', 'utf-8');
    log.debug(`Initialized log file for job attempt`, { jobId: job.id, attemptId: attempt.attemptId });
  } catch (e: any) {
    log.error(`Failed to initialize log file`, { jobId: job.id, error: e.message });
  }
  
  return logFile;
}

/**
 * Append a section header to the log.
 */
export function logSectionStart(job: Job, sectionName: string): void {
  writeJobLog(job, '');
  writeJobLog(job, `========== ${sectionName.toUpperCase()} SECTION START ==========`);
  writeJobLog(job, `[orchestrator] Starting ${sectionName.toLowerCase()}...`);
}

/**
 * Append a section footer to the log.
 */
export function logSectionEnd(job: Job, sectionName: string): void {
  writeJobLog(job, `========== ${sectionName.toUpperCase()} SECTION END ==========`);
  writeJobLog(job, '');
}

/**
 * Log an orchestrator message.
 */
export function logOrchestrator(job: Job, message: string): void {
  writeJobLog(job, `[orchestrator] ${message}`);
}

/**
 * Log a preflight message.
 */
export function logPreflight(job: Job, message: string): void {
  writeJobLog(job, `[preflight] ${message}`);
}

/**
 * Log an error message.
 */
export function logError(job: Job, message: string): void {
  writeJobLog(job, `[error] ${message}`);
}

/**
 * Log a step output message.
 */
export function logStepOutput(job: Job, stepName: string, output: string): void {
  writeJobLog(job, `[${stepName}] ${output.trimEnd()}`);
}
