
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { ensureDir, readJSON, writeJSON, cpuCountMinusOne } from './utils';
import { createWorktrees } from '../git/gitWorktrees';
import { isCopilotCliAvailable } from '../agent/cliCheckCore';

export type CommitDetail = { hash: string; shortHash: string; message: string; author: string; date: string; filesAdded: string[]; filesModified: string[]; filesDeleted: string[] };
export type WorkSummary = { commits: number; filesAdded: number; filesModified: number; filesDeleted: number; description: string; commitDetails?: CommitDetail[] };
export type JobMetrics = { testsRun?: number; testsPassed?: number; testsFailed?: number; coveragePercent?: number; buildErrors?: number; buildWarnings?: number };
export type WebhookConfig = { url: string; events?: ('stage_complete' | 'job_complete' | 'job_failed')[]; headers?: Record<string, string> };
export type ExecutionAttempt = { attemptId: string; startedAt: number; endedAt?: number; logFile: string; copilotSessionId?: string; workInstruction: string; stepStatuses: { prechecks?: 'success'|'failed'|'skipped'; work?: 'success'|'failed'|'skipped'; postchecks?: 'success'|'failed'|'skipped'; mergeback?: 'success'|'failed'|'skipped'; cleanup?: 'success'|'failed'|'skipped' }; status: 'queued'|'running'|'succeeded'|'failed'|'canceled'; workSummary?: WorkSummary; metrics?: JobMetrics };
export type JobSpec = { id: string; name: string; task: string; inputs: { repoPath: string; baseBranch: string; targetBranch: string; worktreeRoot: string; instructions?: string }; policy: { useJust: boolean; steps: { prechecks: string; work: string; postchecks: string } }; webhook?: WebhookConfig };
export type Job = JobSpec & { status: 'queued'|'running'|'succeeded'|'failed'|'canceled'; logFile?: string; startedAt?: number; endedAt?: number; copilotSessionId?: string; processIds?: number[]; currentStep?: string; stepStatuses?: { prechecks?: 'success'|'failed'|'skipped'; work?: 'success'|'failed'|'skipped'; postchecks?: 'success'|'failed'|'skipped'; mergeback?: 'success'|'failed'|'skipped'; cleanup?: 'success'|'failed'|'skipped' }; workHistory?: string[]; attempts?: ExecutionAttempt[]; currentAttemptId?: string; workSummary?: WorkSummary; metrics?: JobMetrics };

export class JobRunner {
  private ctx: vscode.ExtensionContext; 
  private jobs = new Map<string, Job>(); 
  private queue: string[] = []; 
  private working = 0; 
  private storeFile: string; 
  public maxWorkers = 1;
  private runningProcesses = new Map<string, Set<any>>(); // Track processes per job
  constructor(ctx: vscode.ExtensionContext) {
    this.ctx = ctx; 
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ctx.globalStorageUri.fsPath; 
    this.storeFile = path.join(ws,'.orchestrator','jobs','state.json'); 
    ensureDir(path.dirname(this.storeFile));
    const cfg = readJSON<any>(path.join(ws,'.orchestrator','config.json'), {maxWorkers:0}); 
    this.maxWorkers = cfg.maxWorkers && cfg.maxWorkers>0 ? cfg.maxWorkers : cpuCountMinusOne();
    
    // Load existing jobs and migrate old format
    const saved = readJSON<{jobs: any[] }>(this.storeFile,{jobs:[]});
    const logDir = path.join(this.ctx.globalStorageUri.fsPath, 'logs');
    ensureDir(logDir);
    
    for (const j of saved.jobs) {
      // Migrate old jobs that have log array to log file
      if ((j as any).log && !j.logFile) {
        j.logFile = path.join(logDir, `${j.id}.log`);
        // Write old logs to file if they exist
        if (Array.isArray((j as any).log) && (j as any).log.length > 0) {
          try {
            fs.writeFileSync(j.logFile, (j as any).log.join('\n') + '\n', 'utf-8');
          } catch (e) {
            console.error(`Failed to migrate logs for job ${j.id}:`, e);
          }
        }
        delete (j as any).log; // Remove old log array
      }
      // Ensure log file exists
      if (!j.logFile) {
        j.logFile = path.join(logDir, `${j.id}.log`);
      }
      this.jobs.set(j.id, j as Job);
    }
    
    // Persist migrated state
    if (saved.jobs.length > 0) {
      this.persist();
    }
    
    // Clean up orphaned processes from crashed/reloaded jobs
    this.cleanupOrphanedProcesses();
    
    // Reconcile any remaining inconsistent states
    this.reconcileStates();
  }
  
  private cleanupOrphanedProcesses() {
    // Find jobs that were running when we crashed/reloaded
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && job.processIds && job.processIds.length > 0) {
        this.writeLog(job, '[orchestrator] Extension reloaded - attempting to reconnect to running processes');
        
        const stillRunning: number[] = [];
        
        job.processIds.forEach(pid => {
          if (this.isProcessRunning(pid)) {
            stillRunning.push(pid);
            this.writeLog(job, `[orchestrator] Process PID ${pid} still running - monitoring`);
            
            // Create monitor for this process
            this.monitorProcessByPid(job, pid);
          } else {
            this.writeLog(job, `[orchestrator] Process PID ${pid} not found (already exited)`);
          }
        });
        
        if (stillRunning.length === 0) {
          // All processes exited while we were reloading
          this.writeLog(job, '[orchestrator] All processes completed during reload - marking job as orphaned/failed');
          job.status = 'failed';
          job.endedAt = Date.now();
          job.processIds = [];
          
          // Also update the current attempt status
          if (job.currentAttemptId && job.attempts) {
            const currentAttempt = job.attempts.find(a => a.attemptId === job.currentAttemptId);
            if (currentAttempt && currentAttempt.status === 'running') {
              currentAttempt.status = 'failed';
              currentAttempt.endedAt = Date.now();
              this.writeLog(job, `[orchestrator] Marked attempt ${currentAttempt.attemptId} as failed (orphaned)`);
            }
          }
        } else {
          // Some processes still running - keep monitoring
          job.processIds = stillRunning;
          this.writeLog(job, `[orchestrator] Monitoring ${stillRunning.length} running process(es)`);
        }
      }
    }
    
    this.persist();
  }
  
  private isProcessRunning(pid: number): boolean {
    try {
      // Sending signal 0 checks if process exists without killing it
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return false;
    }
  }
  
  private monitorProcessByPid(job: Job, pid: number) {
    let lastActivityTime = Date.now();
    const HUNG_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
    let lastWarningTime = 0;
    
    // Poll process status every 2 seconds
    const checkInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceActivity = now - lastActivityTime;
      
      // Check if process is still running
      if (!this.isProcessRunning(pid)) {
        this.writeLog(job, `[orchestrator] Process PID ${pid} exited`);
        
        // Remove this PID from job
        if (job.processIds) {
          job.processIds = job.processIds.filter(p => p !== pid);
          
          // If no more processes running, check job completion
          if (job.processIds.length === 0 && job.status === 'running') {
            this.writeLog(job, '[orchestrator] All monitored processes completed');
            // Note: We can't determine success/failure without exit codes
            // Mark as succeeded if we got this far (processes ran to completion)
            job.status = 'succeeded';
            job.endedAt = Date.now();
            this.working = Math.max(0, this.working - 1);
            this.persist();
            this.pump();
          } else {
            this.persist();
          }
        }
        
        clearInterval(checkInterval);
        return;
      }
      
      // Check for hung process (no activity for HUNG_THRESHOLD_MS)
      if (timeSinceActivity > HUNG_THRESHOLD_MS) {
        const minutesHung = Math.floor(timeSinceActivity / 60000);
        
        // Log warning every 5 minutes
        if (now - lastWarningTime > 5 * 60 * 1000) {
          this.writeLog(job, `[orchestrator] ⚠️  WARNING: Process PID ${pid} appears to be hung (no activity for ${minutesHung} minutes)`);
          lastWarningTime = now;
        }
      }
      
      // TODO: Check if process has had recent log output to update lastActivityTime
      // For now, we assume the process is active if it's still running
      // This could be enhanced by monitoring log file changes or stdout/stderr
    }, 2000);
    
    // Clean up interval if job is canceled
    const originalCancel = this.cancel.bind(this);
    this.cancel = (id: string) => {
      if (id === job.id) {
        clearInterval(checkInterval);
      }
      originalCancel(id);
    };
  }
  
  // Reconcile any inconsistent job/attempt states
  reconcileStates() {
    let changed = false;
    for (const job of this.jobs.values()) {
      // If job is not running/queued but has attempts showing as running, fix them
      if (job.status !== 'running' && job.status !== 'queued' && job.attempts) {
        for (const attempt of job.attempts) {
          if (attempt.status === 'running') {
            attempt.status = job.status === 'succeeded' ? 'succeeded' : 'failed';
            attempt.endedAt = attempt.endedAt || job.endedAt || Date.now();
            this.writeLog(job, `[orchestrator] Reconciled attempt ${attempt.attemptId} status to ${attempt.status}`);
            changed = true;
          }
        }
      }
    }
    if (changed) {
      this.persist();
    }
  }
  
  list(): Job[] { return Array.from(this.jobs.values()); }
  enqueue(spec: JobSpec, webhookConfig?: WebhookConfig) { 
    // Generate GUID for job ID if not provided
    if (!spec.id || spec.id === '') {
      spec.id = randomUUID();
    }
    
    const logDir = path.join(this.ctx.globalStorageUri.fsPath, 'logs');
    ensureDir(logDir);
    const logFile = path.join(logDir, `${spec.id}.log`);
    const job: Job = { 
      ...spec, 
      status:'queued', 
      logFile, 
      stepStatuses: {},
      workHistory: [spec.policy.steps.work],
      attempts: [],
      webhook: webhookConfig
    }; 
    this.jobs.set(job.id, job); 
    this.queue.push(job.id); 
    this.persist(); 
    this.pump(); 
  }
  
  retry(jobId: string, updatedWorkContext?: string) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    
    // If external caller provided updated work context, use it
    // Otherwise, create AI-guided analysis prompt pointing to previous logs
    if (updatedWorkContext) {
      // External override - use provided context
      this.continueWork(jobId, updatedWorkContext);
      return;
    }
    
    // Default AI-guided retry: point agent to previous execution logs for analysis
    const failedStep = job.currentStep || 'unknown';
    const logPath = job.logFile || 'unknown';
    const lastAttempt = job.attempts && job.attempts.length > 0 
      ? job.attempts[job.attempts.length - 1] 
      : null;
    const attemptLog = lastAttempt?.logFile || logPath;
    
    const aiAnalysisPrompt = `The previous execution attempt failed at the ${failedStep} step. 

Analyze the execution logs to identify the root cause of the failure and fix the issues:
- Log file: ${attemptLog}
- Failed step: ${failedStep}
- Previous work instruction: ${job.policy.steps.work}

Your task:
1. Review the log file to understand what went wrong
2. Identify the specific errors or failures
3. Implement fixes to resolve those issues
4. Complete the original work requirements

Focus on addressing the failure root cause while maintaining all original requirements.`;
    
    this.continueWork(jobId, aiAnalysisPrompt);
  }
  
  continueWork(jobId: string, newWorkInstructions: string) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    
    // Can only continue jobs that have finished (successfully or failed)
    if (job.status === 'running' || job.status === 'queued') {
      return false;
    }
    
    // Add new work instruction to history (prepend so latest is first)
    const workPrefix = newWorkInstructions.startsWith('@') ? '' : '@agent ';
    const newWork = workPrefix + newWorkInstructions;
    
    if (!job.workHistory) {
      job.workHistory = [job.policy.steps.work];
    }
    job.workHistory.unshift(newWork);
    
    // Update the current work step to the latest instruction
    job.policy.steps.work = newWork;
    
    // Reset for continuation - mark work and postchecks for re-execution
    job.status = 'queued';
    job.endedAt = undefined;
    job.processIds = [];
    
    // Keep prechecks success if it exists, but reset work and postchecks
    // This allows us to skip prechecks on retry if they already passed
    if (job.stepStatuses) {
      delete job.stepStatuses.work;
      delete job.stepStatuses.postchecks;
      // Keep prechecks status - don't delete it
    }
    
    this.writeLog(job, '');
    this.writeLog(job, `========== CONTINUE WORK STARTED AT ${new Date().toISOString()} ==========`);
    this.writeLog(job, `[orchestrator] Work iteration ${job.workHistory.length}: ${newWorkInstructions}`);
    this.writeLog(job, `[orchestrator] Work history: ${job.workHistory.length} iteration(s)`);
    
    this.queue.push(job.id);
    this.persist();
    this.pump();
    return true;
  }
  
  private writeLog(job: Job, message: string) {
    if (!job.logFile) return;
    try {
      const timestamp = new Date().toISOString();
      const logLine = `[${timestamp}] ${message}`;
      fs.appendFileSync(job.logFile, logLine + '\n', 'utf-8');
    } catch (e) {
      console.error(`Failed to write to log file ${job.logFile}:`, e);
    }
  }

  private syncStepStatusesToAttempt(job: Job) {
    // Sync job.stepStatuses to current attempt.stepStatuses
    if (job.attempts && job.currentAttemptId && job.stepStatuses) {
      const currentAttempt = job.attempts.find(a => a.attemptId === job.currentAttemptId);
      if (currentAttempt) {
        currentAttempt.stepStatuses = { ...job.stepStatuses };
      }
    }
  }

  private isLocalUrl(urlString: string): boolean {
    try {
      const url = new URL(urlString);
      const hostname = url.hostname.toLowerCase();
      
      // Allow localhost variants
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
        return true;
      }
      
      // Allow loopback range 127.x.x.x
      if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
        return true;
      }
      
      // Block everything else (including 0.0.0.0 which could bind externally)
      return false;
    } catch {
      return false;
    }
  }

  private async notifyWebhook(job: Job, event: 'stage_complete' | 'job_complete' | 'job_failed', stage?: string) {
    if (!job.webhook?.url) return;
    
    // Security: Only allow local webhook destinations
    if (!this.isLocalUrl(job.webhook.url)) {
      this.writeLog(job, `[webhook] BLOCKED: Non-local URL not allowed (${job.webhook.url})`);
      return;
    }
    
    // Check if this event type is subscribed (default: all events)
    const subscribedEvents = job.webhook.events || ['stage_complete', 'job_complete', 'job_failed'];
    if (!subscribedEvents.includes(event)) return;
    
    const payload = {
      event,
      timestamp: Date.now(),
      job: {
        id: job.id,
        name: job.name,
        status: job.status,
        currentStep: job.currentStep,
        stepStatuses: job.stepStatuses,
        stage: stage || null,
        progress: this.calculateProgress(job),
        workSummary: job.workSummary || null,
        metrics: job.metrics || null,
        duration: job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : null
      }
    };
    
    try {
      const http = require('http');
      const https = require('https');
      const url = new URL(job.webhook.url);
      const client = url.protocol === 'https:' ? https : http;
      
      const options = {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'copilot-orchestrator/0.4.0',
          'X-Webhook-Event': event,
          'X-Job-Id': job.id,
          ...(job.webhook.headers || {})
        }
      };
      
      const req = client.request(options, (res: any) => {
        this.writeLog(job, `[webhook] ${event} notification sent to ${job.webhook!.url} - HTTP ${res.statusCode}`);
      });
      
      req.on('error', (e: Error) => {
        this.writeLog(job, `[webhook] Failed to send ${event} notification: ${e.message}`);
      });
      
      req.write(JSON.stringify(payload));
      req.end();
    } catch (e) {
      this.writeLog(job, `[webhook] Error sending notification: ${e}`);
    }
  }

  private calculateProgress(job: Job): number {
    const phaseWeights: Record<string, number> = {
      'prechecks': 10, 'work': 70, 'postchecks': 85, 'mergeback': 95, 'cleanup': 100
    };
    if (job.status === 'succeeded') return 100;
    if (job.status === 'failed' || job.status === 'canceled') return -1;
    if (job.status === 'queued') return 0;
    const currentStep = job.currentStep;
    if (!currentStep) return 5;
    const stepStatuses = job.stepStatuses || {};
    const phases = ['prechecks', 'work', 'postchecks', 'mergeback', 'cleanup'];
    let progress = 0;
    for (const phase of phases) {
      if (stepStatuses[phase as keyof typeof stepStatuses] === 'success' || stepStatuses[phase as keyof typeof stepStatuses] === 'skipped') {
        progress = phaseWeights[phase];
      } else if (phase === currentStep) {
        const prevPhase = phases[phases.indexOf(phase) - 1];
        const prevProgress = prevPhase ? phaseWeights[prevPhase] : 0;
        progress = prevProgress + (phaseWeights[phase] - prevProgress) / 2;
        break;
      }
    }
    return Math.round(progress);
  }

  private async calculateWorkSummary(job: Job): Promise<WorkSummary> {
    const { execSync } = require('child_process');
    // Build full worktree path: repoPath/worktreeRoot/jobId
    const worktreePath = path.join(job.inputs.repoPath, job.inputs.worktreeRoot, job.id);
    const baseBranch = job.inputs.baseBranch;
    
    let commits = 0;
    let filesAdded = 0;
    let filesModified = 0;
    let filesDeleted = 0;
    const commitDetails: CommitDetail[] = [];
    
    try {
      // Find the merge-base (where the worktree branch forked from baseBranch)
      // Use local branch only - worktrees don't have remotes
      const mergeBase = execSync(`git merge-base HEAD ${baseBranch}`, { cwd: worktreePath, encoding: 'utf-8' }).trim();
      
      // Get detailed commit information
      // Format: hash|shortHash|author|date|message
      const commitLogOutput = execSync(
        `git log ${mergeBase}..HEAD --pretty=format:"%H|%h|%an|%ai|%s" --reverse`,
        { cwd: worktreePath, encoding: 'utf-8' }
      ).trim();
      
      if (commitLogOutput) {
        const commitLines = commitLogOutput.split('\n').filter((l: string) => l.trim());
        commits = commitLines.length;
        
        for (const commitLine of commitLines) {
          const [hash, shortHash, author, date, ...messageParts] = commitLine.split('|');
          const message = messageParts.join('|'); // In case message contains |
          
          // Get files changed in this specific commit
          const filesOutput = execSync(
            `git diff-tree --no-commit-id --name-status -r ${hash}`,
            { cwd: worktreePath, encoding: 'utf-8' }
          ).trim();
          
          const commitFilesAdded: string[] = [];
          const commitFilesModified: string[] = [];
          const commitFilesDeleted: string[] = [];
          
          if (filesOutput) {
            const fileLines = filesOutput.split('\n').filter((l: string) => l.trim());
            for (const fileLine of fileLines) {
              const [status, ...filePathParts] = fileLine.split('\t');
              const filePath = filePathParts.join('\t');
              if (status === 'A') commitFilesAdded.push(filePath);
              else if (status === 'M') commitFilesModified.push(filePath);
              else if (status === 'D') commitFilesDeleted.push(filePath);
              else if (status.startsWith('R')) commitFilesModified.push(filePath);
              else if (status.startsWith('C')) commitFilesAdded.push(filePath);
            }
          }
          
          commitDetails.push({
            hash,
            shortHash,
            author,
            date,
            message,
            filesAdded: commitFilesAdded,
            filesModified: commitFilesModified,
            filesDeleted: commitFilesDeleted
          });
        }
      }
      
      // Get total file changes since the fork point (for summary)
      const diffOutput = execSync(`git diff --name-status ${mergeBase} HEAD`, { cwd: worktreePath, encoding: 'utf-8' }).trim();
      
      if (diffOutput) {
        const lines = diffOutput.split('\n').filter((l: string) => l.trim());
        for (const line of lines) {
          const status = line.charAt(0);
          if (status === 'A') filesAdded++;
          else if (status === 'M') filesModified++;
          else if (status === 'D') filesDeleted++;
          else if (status === 'R') filesModified++;
          else if (status === 'C') filesAdded++;
        }
      }
      
      this.writeLog(job, `[orchestrator] Work summary: ${commits} commits, forked from ${baseBranch} at ${mergeBase.substring(0, 8)}`);
    } catch (e) {
      this.writeLog(job, `[orchestrator] Warning: Could not calculate work summary: ${e}`);
    }
    
    // Build description string
    const parts: string[] = [];
    if (commits > 0) parts.push(`${commits} commit${commits !== 1 ? 's' : ''}`);
    if (filesAdded > 0) parts.push(`${filesAdded} file${filesAdded !== 1 ? 's' : ''} added`);
    if (filesModified > 0) parts.push(`${filesModified} file${filesModified !== 1 ? 's' : ''} modified`);
    if (filesDeleted > 0) parts.push(`${filesDeleted} file${filesDeleted !== 1 ? 's' : ''} deleted`);
    
    const description = parts.length > 0 ? parts.join(', ') : 'No changes detected';
    
    return { commits, filesAdded, filesModified, filesDeleted, description, commitDetails };
  }

  private extractMetricsFromLog(job: Job): JobMetrics {
    const metrics: JobMetrics = {};
    
    if (!job.logFile) return metrics;
    
    try {
      const logContent = fs.readFileSync(job.logFile, 'utf-8');
      
      // Extract test counts - common patterns
      // NUnit: "Passed: 45, Failed: 2, Skipped: 1"
      // Jest: "Tests: 45 passed, 2 failed"
      // dotnet test: "Total tests: 47, Passed: 45, Failed: 2"
      const testPatterns = [
        /Total tests?:\s*(\d+).*?Passed:\s*(\d+).*?Failed:\s*(\d+)/i,
        /Tests?:\s*(\d+)\s*passed.*?(\d+)\s*failed/i,
        /Passed:\s*(\d+).*?Failed:\s*(\d+)/i,
        /(\d+)\s*tests?\s*passed.*?(\d+)\s*failed/i,
        /(\d+)\s*passing.*?(\d+)\s*failing/i
      ];
      
      for (const pattern of testPatterns) {
        const match = logContent.match(pattern);
        if (match) {
          if (match.length === 4) {
            // Pattern with total, passed, failed
            metrics.testsRun = parseInt(match[1], 10);
            metrics.testsPassed = parseInt(match[2], 10);
            metrics.testsFailed = parseInt(match[3], 10);
          } else if (match.length === 3) {
            // Pattern with passed, failed
            metrics.testsPassed = parseInt(match[1], 10);
            metrics.testsFailed = parseInt(match[2], 10);
            metrics.testsRun = (metrics.testsPassed || 0) + (metrics.testsFailed || 0);
          }
          break;
        }
      }
      
      // Extract coverage percentage
      // Common patterns: "Coverage: 85.5%", "Line coverage: 85.5%", "85.5% coverage"
      const coveragePatterns = [
        /(?:coverage|line coverage|branch coverage):\s*([\d.]+)%/i,
        /([\d.]+)%\s*(?:coverage|covered)/i,
        /coverage\s+is\s+([\d.]+)%/i
      ];
      
      for (const pattern of coveragePatterns) {
        const match = logContent.match(pattern);
        if (match) {
          metrics.coveragePercent = parseFloat(match[1]);
          break;
        }
      }
      
      // Extract build errors/warnings
      // Common patterns: "3 error(s)", "5 warning(s)", "Build: 3 errors, 5 warnings"
      const errorMatch = logContent.match(/(\d+)\s*error(?:s|\(s\))?/i);
      const warningMatch = logContent.match(/(\d+)\s*warning(?:s|\(s\))?/i);
      
      if (errorMatch) metrics.buildErrors = parseInt(errorMatch[1], 10);
      if (warningMatch) metrics.buildWarnings = parseInt(warningMatch[1], 10);
      
    } catch (e) {
      // Log read failed, return empty metrics
    }
    
    return metrics;
  }

  cancel(id: string) { 
    const j = this.jobs.get(id); 
    if (!j) return; 
    
    if (j.status === 'running') {
      j.status = 'canceled'; 
      this.writeLog(j, '[orchestrator] Job cancellation requested');
      
      // Kill all running processes for this job (in-memory references)
      const processes = this.runningProcesses.get(id);
      if (processes) {
        processes.forEach(proc => {
          try {
            proc.kill('SIGKILL'); // Use SIGKILL for immediate termination
            this.writeLog(j, `[orchestrator] Terminated process PID ${proc.pid}`);
          } catch (e) {
            console.error(`Failed to kill process for job ${id}:`, e);
          }
        });
        this.runningProcesses.delete(id);
      }
      
      // Also kill by PID (in case we reloaded and lost in-memory references)
      // This is critical for hung processes
      if (j.processIds && j.processIds.length > 0) {
        const { spawn, execSync } = require('child_process');
        j.processIds.forEach(pid => {
          try {
            // Use platform-specific kill command - force kill for hung processes
            if (process.platform === 'win32') {
              // On Windows, kill process tree to ensure all child processes are terminated
              execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
              this.writeLog(j, `[orchestrator] Force-killed process tree for PID ${pid}`);
            } else {
              // On Unix, send SIGKILL for immediate termination
              process.kill(pid, 'SIGKILL');
              this.writeLog(j, `[orchestrator] Force-killed process PID ${pid}`);
            }
          } catch (e) {
            // Process may have already exited, that's fine
            this.writeLog(j, `[orchestrator] Process PID ${pid} already exited or not found`);
          }
        });
        j.processIds = [];
      }
    }
    
    this.persist(); 
  }
  
  delete(id: string) {
    const j = this.jobs.get(id);
    if (!j) return false;
    
    // If job is running, cancel it first
    if (j.status === 'running' || j.status === 'queued') {
      this.cancel(id);
    }
    
    // Remove from queue if queued
    const queueIndex = this.queue.indexOf(id);
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1);
    }
    
    // Delete the worktree and associated branch
    try {
      const path = require('path');
      const fs = require('fs');
      const worktreePath = path.join(j.inputs.repoPath, j.inputs.worktreeRoot, j.id);
      const branchName = `copilot_jobs/${j.id}`;
      
      if (fs.existsSync(worktreePath)) {
        const { spawnSync } = require('child_process');
        
        // Remove worktree using git
        const removeResult = spawnSync('git', ['worktree', 'remove', worktreePath, '--force'], {
          cwd: j.inputs.repoPath,
          encoding: 'utf-8',
          shell: true
        });
        
        if (removeResult.status !== 0) {
          console.error(`Failed to remove worktree via git: ${removeResult.stderr}`);
          // Try to delete directory directly as fallback
          try {
            fs.rmSync(worktreePath, { recursive: true, force: true });
          } catch (e) {
            console.error(`Failed to delete worktree directory: ${e}`);
          }
        }
      }
      
      // Always attempt to delete the associated branch (even if worktree doesn't exist)
      // This handles cases where the worktree was manually deleted but branch remains
      const { spawnSync } = require('child_process');
      const deleteBranchResult = spawnSync('git', ['branch', '-D', branchName], {
        cwd: j.inputs.repoPath,
        encoding: 'utf-8',
        shell: true
      });
      
      if (deleteBranchResult.status !== 0 && !deleteBranchResult.stderr?.includes('not found')) {
        console.error(`Failed to delete branch ${branchName}: ${deleteBranchResult.stderr}`);
      }
      
      // Also prune worktree metadata to clean up any stale references
      spawnSync('git', ['worktree', 'prune'], {
        cwd: j.inputs.repoPath,
        encoding: 'utf-8',
        shell: true
      });
      
      // Delete the log file if it exists
      if (j.logFile && fs.existsSync(j.logFile)) {
        try {
          fs.unlinkSync(j.logFile);
        } catch (e) {
          console.error(`Failed to delete log file: ${e}`);
        }
      }
    } catch (e) {
      console.error(`Error deleting worktree for job ${id}:`, e);
    }
    
    // Delete the job
    this.jobs.delete(id);
    this.persist();
    return true;
  }
  private persist(){ writeJSON(this.storeFile, { jobs: this.list() }); }
  private pump(){ while (this.working < this.maxWorkers && this.queue.length){ const id = this.queue.shift()!; const job = this.jobs.get(id)!; this.run(job).catch(err=>{ this.writeLog(job, '[error] ' + String(err)); job.status = job.status==='canceled'?'canceled':'failed'; job.endedAt = Date.now(); this.persist(); }); this.working++; } }
  private async run(job: Job){
    job.status='running'; job.startedAt=Date.now(); 
    
    // Create new execution attempt
    const attemptId = randomUUID();
    const logDir = path.join(this.ctx.globalStorageUri.fsPath, 'logs');
    const attemptLogFile = path.join(logDir, `${job.id}-attempt-${attemptId.substring(0, 8)}.log`);
    
    if (!job.attempts) job.attempts = [];
    if (!job.workHistory) job.workHistory = [job.policy.steps.work];
    
    const attempt: ExecutionAttempt = {
      attemptId,
      startedAt: Date.now(),
      logFile: attemptLogFile,
      workInstruction: job.workHistory[0] || job.policy.steps.work,
      stepStatuses: {},
      status: 'running'
    };
    
    job.attempts.push(attempt);
    job.currentAttemptId = attemptId;
    job.logFile = attemptLogFile; // Use attempt-specific log file
    
    // Initialize log file
    if (job.logFile) {
      try {
        fs.writeFileSync(job.logFile, `=== Job ${job.name} (${job.id}) Attempt ${job.attempts.length} started at ${new Date(job.startedAt).toISOString()} ===\n`, 'utf-8');
        this.writeLog(job, `Attempt ID: ${attemptId}`);
        this.writeLog(job, `Name: ${job.name}`);
        this.writeLog(job, `Task: ${job.task}`);
        this.writeLog(job, `Repository: ${job.inputs.repoPath}`);
        this.writeLog(job, `Base Branch: ${job.inputs.baseBranch}`);
        this.writeLog(job, `Target Branch: ${job.inputs.targetBranch}`);
        if (job.workHistory.length > 1) {
          this.writeLog(job, `Work History (${job.workHistory.length} iterations):`);
          job.workHistory.forEach((w, i) => {
            this.writeLog(job, `  [${i === 0 ? 'CURRENT' : i}] ${w.substring(0, 100)}${w.length > 100 ? '...' : ''}`);
          });
        }
        this.writeLog(job, '');
      } catch (e) {
        console.error('Failed to initialize log file:', e);
      }
    }
    
    this.persist();

    // ---- Pre-flight: enforce Copilot CLI if configured ----
    const enforce = vscode.workspace.getConfiguration('copilotOrchestrator.copilotCli').get<boolean>('enforceInJobs', true);
    if (enforce && !isCopilotCliAvailable()) {
      const msg = 'Pre-flight: GitHub Copilot CLI not detected. Job blocked to keep runs consistent. Use "Copilot Orchestrator: Check Copilot CLI" to install.';
      this.writeLog(job, '[preflight] '+msg);
      vscode.window.showWarningMessage(msg, 'Check Copilot CLI').then(choice=>{ if (choice==='Check Copilot CLI') vscode.commands.executeCommand('orchestrator.copilotCli.check'); });
      job.status='failed'; job.endedAt=Date.now(); this.persist(); this.working--; this.pump(); return;
    }

    const repoPath = job.inputs.repoPath; 
    const jobRoot = createWorktrees({ 
      jobId: job.id, 
      repoPath, 
      worktreeRoot: job.inputs.worktreeRoot, 
      baseBranch: job.inputs.baseBranch, 
      targetBranch: job.inputs.targetBranch 
    }, s=> this.writeLog(job, s));

    const execStep = async (label: string, cmd: string) => {
      // Check if this step already succeeded (for retry scenarios)
      const stepKey = label.toLowerCase() as 'prechecks'|'work'|'postchecks';
      if (job.stepStatuses?.[stepKey] === 'success') {
        this.writeLog(job, `[${label}] Skipping - already completed successfully`);
        return;
      }
      
      job.currentStep = label;
      this.persist();
      
      // Check if this is an AI agent delegation command
      if (cmd.startsWith('@agent') || cmd.startsWith('@copilot')) {
        const result = await this.delegateToAgent(job, label, cmd, jobRoot);
        if (!job.stepStatuses) job.stepStatuses = {};
        job.stepStatuses[stepKey] = 'success';
        this.syncStepStatusesToAttempt(job);
        this.persist();
        this.notifyWebhook(job, 'stage_complete', label);
        return result;
      }
      
      // Regular shell command execution
      return new Promise<void>((resolve,reject)=>{ 
        const p = spawn(cmd,{cwd:jobRoot,shell:true});
        
        // Track this process
        if (!this.runningProcesses.has(job.id)) {
          this.runningProcesses.set(job.id, new Set());
        }
        this.runningProcesses.get(job.id)!.add(p);
        
        // Track PID for persistence
        if (p.pid) {
          if (!job.processIds) {
            job.processIds = [];
          }
          job.processIds.push(p.pid);
          this.persist(); // Persist immediately so PID is saved
        }
        
        p.stdout.on('data',d=> {
          this.writeLog(job, `[${label}] ${d.toString().trimEnd()}`);
        }); 
        p.stderr.on('data',d=> {
          this.writeLog(job, `[${label}] ${d.toString().trimEnd()}`);
        }); 
        p.on('exit', code=> {
          // Remove from tracking
          this.runningProcesses.get(job.id)?.delete(p);
          
          // Remove PID from job
          if (p.pid && job.processIds) {
            job.processIds = job.processIds.filter(pid => pid !== p.pid);
            this.persist();
          }
          
          // Update step status
          if (!job.stepStatuses) job.stepStatuses = {};
          if (code === 0) {
            job.stepStatuses[stepKey] = 'success';
            this.syncStepStatusesToAttempt(job);
            this.persist();
            this.notifyWebhook(job, 'stage_complete', label);
            resolve();
          } else {
            job.stepStatuses[stepKey] = 'failed';
            this.syncStepStatusesToAttempt(job);
            this.writeLog(job, `[${label}] Process exited with code ${code}`);
            this.persist();
            reject(new Error(`${label} failed (${code})`));
          }
        });
      });
    };

    const steps = job.policy.steps; 
    try { 
      // Prechecks - skip if already succeeded
      if (job.stepStatuses?.prechecks === 'success') {
        this.writeLog(job, '[orchestrator] Skipping prechecks - already succeeded in previous attempt');
        if (attempt) {
          attempt.stepStatuses.prechecks = 'skipped';
        }
        this.syncStepStatusesToAttempt(job);
      } else {
        this.writeLog(job, '');
        this.writeLog(job, '========== PRECHECKS SECTION START ==========');
        this.writeLog(job, '[orchestrator] Starting prechecks...');
        await execStep('prechecks', steps.prechecks); 
        this.writeLog(job, '========== PRECHECKS SECTION END ==========');
        this.writeLog(job, '');
      }
      
      // Work step
      this.writeLog(job, '========== WORK SECTION START ==========');
      this.writeLog(job, '[orchestrator] Starting work...');
      await execStep('work', steps.work); 
      this.writeLog(job, '========== WORK SECTION END ==========');
      this.writeLog(job, '');
      
      // Calculate work summary after work step
      if (job.stepStatuses?.work === 'success') {
        const summary = await this.calculateWorkSummary(job);
        job.workSummary = summary;
        // Also store in current attempt
        if (job.attempts && job.currentAttemptId) {
          const currentAttempt = job.attempts.find(a => a.attemptId === job.currentAttemptId);
          if (currentAttempt) currentAttempt.workSummary = summary;
        }
        this.writeLog(job, `[orchestrator] Work summary: ${summary.description}`);
        this.persist();
      }
      
      // Only run postchecks if work succeeded
      if (job.stepStatuses?.work === 'success') {
        this.writeLog(job, '========== POSTCHECKS SECTION START ==========');
        this.writeLog(job, '[orchestrator] Work completed, starting postchecks...');
        await execStep('postchecks', steps.postchecks); 
        this.writeLog(job, '========== POSTCHECKS SECTION END ==========');
        this.writeLog(job, '');
        
        // Extract metrics from logs after postchecks
        const metrics = this.extractMetricsFromLog(job);
        if (Object.keys(metrics).length > 0) {
          job.metrics = metrics;
          if (job.attempts && job.currentAttemptId) {
            const currentAttempt = job.attempts.find(a => a.attemptId === job.currentAttemptId);
            if (currentAttempt) currentAttempt.metrics = metrics;
          }
          this.writeLog(job, `[orchestrator] Extracted metrics: tests=${metrics.testsRun || 0}, passed=${metrics.testsPassed || 0}, failed=${metrics.testsFailed || 0}, coverage=${metrics.coveragePercent || 'N/A'}%`);
        }
      } else {
        this.writeLog(job, '[orchestrator] Skipping postchecks - work step did not complete successfully');
        if (!job.stepStatuses) job.stepStatuses = {};
        job.stepStatuses.postchecks = 'skipped';
        this.syncStepStatusesToAttempt(job);
      }
      
      this.writeLog(job, '[orchestrator] All steps completed successfully');
      job.status='succeeded'; 
      job.currentStep = undefined;
      
      // Update current attempt status
      if (job.attempts && job.currentAttemptId) {
        const currentAttempt = job.attempts.find(a => a.attemptId === job.currentAttemptId);
        if (currentAttempt) {
          currentAttempt.status = 'succeeded';
          currentAttempt.endedAt = Date.now();
        }
      }
      
      this.persist();
      
      // Attempt mergeback - if it fails, mark job as failed
      job.currentStep = 'mergeback';
      this.persist();
      try {
        await this.mergeBack(job, repoPath, jobRoot);
      } catch (e) {
        this.writeLog(job, '[mergeback] FAILED: '+String(e));
        job.status = 'failed';
        if (job.attempts && job.currentAttemptId) {
          const currentAttempt = job.attempts.find(a => a.attemptId === job.currentAttemptId);
          if (currentAttempt) {
            currentAttempt.status = 'failed';
          }
        }
        this.persist();
        throw e; // Re-throw to skip cleanup
      }
      
      // Auto-cleanup worktree and branch after successful mergeback
      job.currentStep = 'cleanup';
      this.persist();
      this.writeLog(job, '\n========== CLEANUP SECTION START ==========');
      try {
        this.writeLog(job, '[cleanup] Cleaning up worktree and branch...');
        const { execSync } = require('child_process');
        
        // Remove worktree
        execSync(`git worktree remove "${jobRoot}" --force`, { cwd: repoPath });
        this.writeLog(job, '[cleanup] ✓ Removed worktree');
        
        // Delete the job branch
        const jobBranch = `copilot_jobs/${job.id}`;
        execSync(`git branch -D ${jobBranch}`, { cwd: repoPath });
        this.writeLog(job, '[cleanup] ✓ Deleted branch: ' + jobBranch);
        
        // Prune worktrees
        execSync('git worktree prune', { cwd: repoPath });
        this.writeLog(job, '[cleanup] ✓ Cleanup completed');
        if (!job.stepStatuses) job.stepStatuses = {};
        job.stepStatuses.cleanup = 'success';
        this.syncStepStatusesToAttempt(job);
        this.notifyWebhook(job, 'stage_complete', 'cleanup');
        this.writeLog(job, '========== CLEANUP SECTION END ==========\n');
      } catch (cleanupError) {
        this.writeLog(job, '[cleanup] Warning: ' + String(cleanupError));
        if (!job.stepStatuses) job.stepStatuses = {};
        job.stepStatuses.cleanup = 'failed';
        this.syncStepStatusesToAttempt(job);
        this.writeLog(job, '========== CLEANUP SECTION END ==========\n');
      }
      
      // Job completed successfully - send webhook
      this.notifyWebhook(job, 'job_complete');
    }
    catch(e){ 
      job.status = (job as Job).status === 'canceled' ? 'canceled' : 'failed'; 
      this.writeLog(job, '[error] ' + String(e));
      
      // Update current attempt status on failure
      if (job.attempts && job.currentAttemptId) {
        const currentAttempt = job.attempts.find(a => a.attemptId === job.currentAttemptId);
        if (currentAttempt) {
          currentAttempt.status = job.status;
          currentAttempt.endedAt = Date.now();
        }
      }
      
      // Job failed - send webhook
      this.notifyWebhook(job, 'job_failed');
    }
    finally{ 
      job.endedAt=Date.now(); 
      job.processIds = []; // Clear PIDs when job completes
      this.working--; 
      this.runningProcesses.delete(job.id); // Clean up process tracking
      this.persist(); 
      this.pump(); 
    }
  }
  
  private async delegateToAgent(job: Job, label: string, cmd: string, jobRoot: string): Promise<void> {
    // Extract the task description after @agent or @copilot prefix
    const taskDescription = cmd.replace(/^@(agent|copilot)\s*/, '').trim();
    
    this.writeLog(job, `[${label}] AI Agent Delegation: ${taskDescription}`);
    this.writeLog(job, `[${label}] Worktree: ${jobRoot}`);
    
    // Create a .copilot-task file in the worktree with instructions
    const fs = require('fs');
    const path = require('path');
    const taskFile = path.join(jobRoot, '.copilot-task.md');
    
    const taskContent = `# AI Agent Task

## Job ID
${job.id}

## Task Description
${taskDescription}

## Instructions
${job.inputs.instructions || 'No additional instructions provided.'}

## Context
- Working directory: ${jobRoot}
- Base branch: ${job.inputs.baseBranch}
- Target branch: ${job.inputs.targetBranch}

## Next Steps
This task requires AI agent intervention. The agent should:
1. Read and understand this task description
2. Make the necessary code changes in this worktree
3. Commit the changes with a descriptive message
4. The orchestrator will handle merging back to the main branch

## Status
⏳ Waiting for AI agent to complete this task...

## Copilot Session
${job.copilotSessionId ? `Session ID: ${job.copilotSessionId}\n\nThis job has an active Copilot session. Context will be maintained across multiple delegations.` : 'No active session yet. A session will be created on first Copilot interaction.'}
`;
    
    fs.writeFileSync(taskFile, taskContent, 'utf-8');
    this.writeLog(job, `[${label}] Created task file: ${taskFile}`);
    this.writeLog(job, `[${label}] ⚠️  This step requires manual AI agent intervention`);
    this.writeLog(job, `[${label}] Open the worktree and use GitHub Copilot to complete the task`);
    this.writeLog(job, `[${label}] Or use the Copilot Orchestrator MCP tools to delegate automatically`);
    
    // For now, we'll create a placeholder commit so the job can proceed
    // In the future, this could wait for actual agent completion
    const { spawnSync } = require('child_process');
    
    // Check if Copilot CLI is available for automated delegation
    const copilotAvailable = isCopilotCliAvailable();
    
    if (copilotAvailable) {
      this.writeLog(job, `[${label}] Attempting automated delegation via GitHub Copilot...`);
      
      // Create job-specific directories for Copilot logs and session tracking
      const pathM = require('path');
      const fsM = require('fs');
      const copilotJobDir = pathM.join(jobRoot, '.copilot-orchestrator');
      const copilotLogDir = pathM.join(copilotJobDir, 'logs');
      const sessionSharePath = pathM.join(copilotJobDir, `session-${label}.md`);
      
      try {
        fsM.mkdirSync(copilotLogDir, { recursive: true });
      } catch (e) {
        this.writeLog(job, `[${label}] Warning: Could not create Copilot log directory: ${e}`);
      }
      
      // Build Copilot CLI command with session resumption
      // Using non-interactive mode with -p (prompt) and headless execution flags
      let copilotCmd = `copilot -p ${JSON.stringify(taskDescription)} --allow-all-paths --allow-all-urls --allow-all-tools --log-dir ${JSON.stringify(copilotLogDir)} --log-level debug --share ${JSON.stringify(sessionSharePath)}`;
      
      // Resume existing session if we have one
      if (job.copilotSessionId) {
        this.writeLog(job, `[${label}] Resuming Copilot session: ${job.copilotSessionId}`);
        copilotCmd += ` --resume ${job.copilotSessionId}`;
      } else {
        this.writeLog(job, `[${label}] Starting new Copilot session...`);
      }
      
      // Use Copilot CLI to implement the task with streaming output
      await new Promise<void>((resolve, reject) => {
        const { spawn } = require('child_process');
        const proc = spawn(copilotCmd, [], {
          cwd: jobRoot,
          shell: true
        });
        
        // Track this process
        if (!this.runningProcesses.has(job.id)) {
          this.runningProcesses.set(job.id, new Set());
        }
        this.runningProcesses.get(job.id)!.add(proc);
        
        // Track PID for persistence
        if (proc.pid) {
          if (!job.processIds) {
            job.processIds = [];
          }
          job.processIds.push(proc.pid);
          this.writeLog(job, `[${label}] Copilot PID: ${proc.pid}`);
          this.persist(); // Persist immediately so PID is saved
        }
        
        // Stream stdout in real-time
        proc.stdout.on('data', (data: Buffer) => {
          const lines = data.toString().split('\n');
          lines.forEach(line => {
            if (line.trim()) {
              this.writeLog(job, `[${label}] ${line.trim()}`);
              
              // Try to extract session ID from output as soon as it appears
              if (!job.copilotSessionId) {
                const sessionMatch = line.match(/Session ID[:\s]+([a-f0-9-]{36})/i) ||
                                     line.match(/session[:\s]+([a-f0-9-]{36})/i) ||
                                     line.match(/Starting session[:\s]+([a-f0-9-]{36})/i);
                if (sessionMatch) {
                  job.copilotSessionId = sessionMatch[1];
                  this.writeLog(job, `[${label}] ✓ Captured Copilot session ID: ${job.copilotSessionId}`);
                  this.persist();
                }
              }
            }
          });
        });
        
        // Stream stderr in real-time
        proc.stderr.on('data', (data: Buffer) => {
          const lines = data.toString().split('\n');
          lines.forEach(line => {
            if (line.trim()) {
              this.writeLog(job, `[${label}] ${line.trim()}`);
              
              // Also check stderr for session ID
              if (!job.copilotSessionId) {
                const sessionMatch = line.match(/Session ID[:\s]+([a-f0-9-]{36})/i) ||
                                     line.match(/session[:\s]+([a-f0-9-]{36})/i) ||
                                     line.match(/Starting session[:\s]+([a-f0-9-]{36})/i);
                if (sessionMatch) {
                  job.copilotSessionId = sessionMatch[1];
                  this.writeLog(job, `[${label}] ✓ Captured Copilot session ID: ${job.copilotSessionId}`);
                  this.persist();
                }
              }
            }
          });
        });
        
        proc.on('exit', (code: number | null) => {
          // Remove from tracking
          this.runningProcesses.get(job.id)?.delete(proc);
          
          // Remove PID from job
          if (proc.pid && job.processIds) {
            job.processIds = job.processIds.filter(pid => pid !== proc.pid);
            this.persist();
          }
          
          // Try to extract session ID before resolving/rejecting
          if (!job.copilotSessionId) {
            try {
              // First, try to parse session ID from the share file
              if (fsM.existsSync(sessionSharePath)) {
                const shareContent = fsM.readFileSync(sessionSharePath, 'utf-8');
                this.writeLog(job, `[${label}] Parsing session file: ${sessionSharePath}`);
                
                // Try multiple patterns to extract session ID
                const firstLines = shareContent.substring(0, 500); // First 500 chars
                const sessionMatch = 
                  // Pattern 1: "Session ID: `<uuid>`" (markdown format with backticks)
                  shareContent.match(/Session(?:\s+ID)?[:\s*]+`?([a-f0-9-]{36})`?/i) ||
                  // Pattern 2: Look for UUID in first few lines
                  firstLines.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i) ||
                  // Pattern 3: vscode-chat-session URL format
                  shareContent.match(/vscode-chat-session:\/\/[^\/]+\/([a-f0-9-]+)/i) ||
                  // Pattern 4: Any UUID-like pattern in the content
                  shareContent.match(/\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/i);
                
                if (sessionMatch) {
                  job.copilotSessionId = sessionMatch[1];
                  this.writeLog(job, `[${label}] ✓ Extracted Copilot session ID from share file: ${job.copilotSessionId}`);
                  this.persist();
                } else {
                  this.writeLog(job, `[${label}] Warning: Share file exists but no session ID pattern found. First 200 chars: ${shareContent.substring(0, 200)}`);
                }
              }
              
              // Fallback: extract from log filename in job-specific log directory
              if (!job.copilotSessionId && fsM.existsSync(copilotLogDir)) {
                const files = fsM.readdirSync(copilotLogDir)
                  .filter((f: string) => f.startsWith('copilot-') && f.endsWith('.log'))
                  .map((f: string) => ({
                    name: f,
                    time: fsM.statSync(pathM.join(copilotLogDir, f)).mtime.getTime()
                  }))
                  .sort((a: any, b: any) => b.time - a.time);
                
                if (files.length > 0) {
                  // Extract session ID from filename: copilot-YYYY-MM-DD-<sessionId>.log
                  const match = files[0].name.match(/copilot-\\d{4}-\\d{2}-\\d{2}-([a-f0-9-]+)\\.log/i);
                  if (match) {
                    job.copilotSessionId = match[1];
                    this.writeLog(job, `[${label}] ✓ Extracted Copilot session ID from log filename: ${job.copilotSessionId}`);
                    this.persist();
                  }
                }
              }
              
              if (!job.copilotSessionId) {
                this.writeLog(job, `[${label}] Note: Could not extract session ID. Future delegations will start new sessions.`);
              }
            } catch (e) {
              this.writeLog(job, `[${label}] Could not extract session ID (non-fatal): ${e}`);
            }
          }
          
          if (code !== 0) {
            this.writeLog(job, `[${label}] Copilot exited with code ${code}`);
            reject(new Error(`Copilot failed with exit code ${code}`));
          } else {
            this.writeLog(job, `[${label}] Copilot completed successfully`);
            resolve();
          }
        });
        
        proc.on('error', (err: Error) => {
          this.writeLog(job, `[${label}] Copilot delegation failed: ${err}`);
          reject(new Error(`Copilot CLI error: ${err}`));
        });
      });
    }
    
    // Create a marker commit indicating agent delegation
    spawnSync('git', ['add', '.copilot-task.md'], { cwd: jobRoot });
    const commitResult = spawnSync('git', [
      'commit', 
      '-m', 
      `orchestrator(${job.id}): AI agent task created\n\n${taskDescription}`,
      '--allow-empty'
    ], { 
      cwd: jobRoot,
      encoding: 'utf-8'
    });
    
    if (commitResult.status === 0) {
      this.writeLog(job, `[${label}] Created marker commit for agent delegation`);
    }
    
    // This step succeeds - the actual work is delegated
    // The agent can work in the worktree and the orchestrator will merge it back
    this.writeLog(job, `[${label}] ✓ Delegation step completed`);
  }
  
  private async mergeBack(job: Job, repoPath: string, jobRoot: string){
    this.writeLog(job, '\n========== MERGEBACK SECTION START ==========');
    const cp = require('child_process'); const pathM = require('path'); const fsM = require('fs');
    
    // Load merge configuration from VS Code settings
    const mergeCfg = vscode.workspace.getConfiguration('copilotOrchestrator.merge');
    const mergeMode = mergeCfg.get<'merge' | 'rebase' | 'squash'>('mode', 'squash');
    const prefer = mergeCfg.get<'ours' | 'theirs'>('prefer', 'theirs');
    const pushOnSuccess = mergeCfg.get<boolean>('pushOnSuccess', false);
    
    this.writeLog(job, `[mergeback] Using merge mode: ${mergeMode}, prefer: ${prefer}, pushOnSuccess: ${pushOnSuccess}`);
    
    // Track output for error detection
    let copilotOutput = '';
    
    const run = (cmd: string, cwd: string)=> new Promise<void>((resolve,reject)=>{ 
      const p = cp.spawn(cmd,{cwd,shell:true}); 
      p.stdout.on('data',(d:any)=> {
        const line = d.toString().trimEnd();
        this.writeLog(job, '[mergeback] '+line);
        copilotOutput += line + '\n';
      }); 
      p.stderr.on('data',(d:any)=> {
        const line = d.toString().trimEnd();
        this.writeLog(job, '[mergeback] '+line);
        copilotOutput += line + '\n';
      }); 
      p.on('exit',(code:number)=> code===0? resolve(): reject(new Error(cmd+` -> exit ${code}`))); 
    });
    
    // Merge the job's working branch (copilot_jobs/{id}) INTO the target branch
    const targetBranch = job.inputs.targetBranch;
    const feat = `copilot_jobs/${job.id}`.replace(/[^a-zA-Z0-9\-_.\/]/g,'-');
    await run('git add -A', jobRoot).catch(()=>{}); await run(`git commit -m "orchestrator(${job.id}): finalize" || echo no-commit`, jobRoot);
    await run('git fetch --all --tags', repoPath); 
    
    // Check if targetBranch exists locally, if not check remote, if not fall back to baseBranch
    const { spawnSync } = require('child_process');
    const localCheck = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${targetBranch}`], { cwd: repoPath });
    const remoteCheck = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${targetBranch}`], { cwd: repoPath });
    
    let mergeTarget = targetBranch;
    if (localCheck.status !== 0 && remoteCheck.status !== 0) {
      // Target branch doesn't exist locally or remotely - fall back to baseBranch
      this.writeLog(job, `[mergeback] Target branch '${targetBranch}' does not exist, using base branch '${job.inputs.baseBranch}' instead`);
      mergeTarget = job.inputs.baseBranch;
    }
    
    await run(`git switch ${mergeTarget}`, repoPath); 
    
    // Try to pull, but don't fail if branch has no upstream
    await run(`git pull --ff-only || echo "No upstream tracking branch, continuing with current state"`, repoPath).catch(()=>{});
    
    // Build merge instruction based on configured mode
    let mergeInstruction: string;
    switch (mergeMode) {
      case 'squash':
        mergeInstruction = `@agent squash merge branch ${feat} into current branch ${mergeTarget}. ` +
          `Combine all commits into a single commit. ` +
          `Handle any conflicts (prefer ${prefer}) and commit with message 'orchestrator(${job.id}): squash merge from ${feat}'`;
        break;
      case 'rebase':
        mergeInstruction = `@agent rebase branch ${feat} onto current branch ${mergeTarget}. ` +
          `Handle any conflicts (prefer ${prefer}) and complete the rebase. ` +
          `Final commit message should include 'orchestrator(${job.id}): rebased from ${feat}'`;
        break;
      case 'merge':
      default:
        mergeInstruction = `@agent merge branch ${feat} into current branch ${mergeTarget}. ` +
          `Handle any conflicts (prefer ${prefer}) and commit with message 'orchestrator(${job.id}): merge from ${feat}'`;
        break;
    }
    
    this.writeLog(job, `[mergeback] Using Copilot to ${mergeMode} ${feat} into ${mergeTarget}...`);
    
    // Reset copilot output tracking for this command
    copilotOutput = '';
    
    try {
      // Let Copilot handle the entire merge operation including any conflicts
      await run(
        `copilot.exe -p "${mergeInstruction}" --allow-all-paths --allow-all-tools`,
        repoPath
      );
      
      // Check for error patterns in copilot output even if exit code was 0
      const errorPatterns = [
        /permission denied/i,
        /could not request permission/i,
        /failed to merge/i,
        /merge conflict(?!s)/i,
        /fatal:/i,
        /(?<!no )CONFLICT(?!s)/i,
        /cannot complete/i,
        /unable to merge/i,
        /\bI cannot\b/i
      ];
      
      const successPatterns = [
        /merge completed successfully/i,
        /merged.*successfully/i,
        /squash.*completed/i,
        /rebase.*completed/i,
        /fast-forward/i,
        /no conflicts/i
      ];
      
      const hasSuccess = successPatterns.some(pattern => pattern.test(copilotOutput));
      const foundError = !hasSuccess && errorPatterns.some(pattern => pattern.test(copilotOutput));
      if (foundError) {
        throw new Error('Copilot merge reported errors in output (see logs above)');
      }
      
      this.writeLog(job, `[mergeback] ✓ ${mergeMode.charAt(0).toUpperCase() + mergeMode.slice(1)} completed successfully via Copilot`);
      if (!job.stepStatuses) job.stepStatuses = {};
      job.stepStatuses.mergeback = 'success';
      this.syncStepStatusesToAttempt(job);
      this.notifyWebhook(job, 'stage_complete', 'mergeback');
      this.persist();
      
      // Push to remote if configured
      if (pushOnSuccess) {
        this.writeLog(job, `[mergeback] Pushing ${mergeTarget} to origin...`);
        try {
          await run(`git push origin ${mergeTarget}`, repoPath);
          this.writeLog(job, '[mergeback] ✓ Pushed to remote successfully');
        } catch (pushError) {
          this.writeLog(job, '[mergeback] ⚠ Push failed: ' + String(pushError));
          this.writeLog(job, '[mergeback] Changes are committed locally but not pushed');
        }
      } else {
        this.writeLog(job, '[mergeback] ✓ Merge completed locally. Push manually when ready (pushOnSuccess is disabled).');
      }
      
      this.writeLog(job, '========== MERGEBACK SECTION END ==========\n');
    } catch(e) {
      this.writeLog(job, '[mergeback] Copilot merge failed: ' + String(e));
      if (!job.stepStatuses) job.stepStatuses = {};
      job.stepStatuses.mergeback = 'failed';
      this.syncStepStatusesToAttempt(job);
      
      // Save patch as fallback
      const patchDir = pathM.join(repoPath,'.orchestrator','jobs',job.id);
      try { fsM.mkdirSync(patchDir,{recursive:true}); } catch{}
      await run(`git diff ${mergeTarget}...${feat} > "${patchDir}/patch.diff"`, repoPath).catch(()=>{});
      this.writeLog(job, '[mergeback] Saved patch to .orchestrator/jobs/'+job.id+'/patch.diff');
      this.writeLog(job, '========== MERGEBACK SECTION END ==========\n');
      throw e;
    }
  }
}
