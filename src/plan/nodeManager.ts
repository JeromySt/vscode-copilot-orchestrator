/**
 * @fileoverview Node Manager
 *
 * Handles node-level operations: retry, force-fail, update node specs,
 * query node state, logs, process stats, and failure context.
 *
 * @module plan/nodeManager
 */

import type { ILogger } from '../interfaces/ILogger';
import type {
  PlanInstance,
  JobNode,
  NodeExecutionState,
  ExecutionPhase,
  AttemptRecord,
  WorkSpec,
  LogEntry,
} from './types';
import { PlanStateMachine } from './stateMachine';
import { PlanEventEmitter } from './planEvents';
import { PlanPersistence } from './persistence';
import type { IProcessMonitor } from '../interfaces/IProcessMonitor';
import { formatLogEntries } from './helpers';
import type { IGitOperations } from '../interfaces/IGitOperations';
import type { JobExecutor, RetryNodeOptions } from './runner';

/**
 * Shared state reference for node operations.
 */
export interface NodeManagerState {
  plans: Map<string, PlanInstance>;
  stateMachines: Map<string, PlanStateMachine>;
  persistence: PlanPersistence;
  executor?: JobExecutor;
  events: PlanEventEmitter;
  processMonitor: IProcessMonitor;
}

/**
 * Manages node-level operations: retry, force-fail, queries, logs.
 */
export class NodeManager {
  private readonly state: NodeManagerState;
  private readonly log: ILogger;
  private readonly git: IGitOperations;

  constructor(state: NodeManagerState, log: ILogger, git: IGitOperations) {
    this.state = state;
    this.log = log;
    this.git = git;
  }

  // ── Queries ────────────────────────────────────────────────────────

  getNodeLogs(planId: string, nodeId: string, phase?: 'all' | ExecutionPhase, attemptNumber?: number): string {
    if (!this.state.executor) {return 'No executor available.';}

    let logs: LogEntry[] = [];
    if (phase && phase !== 'all' && this.state.executor.getLogsForPhase) {
      logs = this.state.executor.getLogsForPhase(planId, nodeId, phase);
    } else if (this.state.executor.getLogs) {
      logs = this.state.executor.getLogs(planId, nodeId);
    }

    if (logs.length > 0) {return formatLogEntries(logs);}

    if ('readLogsFromFile' in this.state.executor && typeof (this.state.executor as any).readLogsFromFile === 'function') {
      const fileContent = (this.state.executor as any).readLogsFromFile(planId, nodeId, attemptNumber);
      if (fileContent && !fileContent.startsWith('No log file')) {
        if (phase && phase !== 'all') {
          const phaseMarker = `[${phase.toUpperCase()}]`;
          const lines = fileContent.split('\n').filter((line: string) => line.includes(phaseMarker));
          return lines.length > 0 ? lines.join('\n') : `No logs for ${phase} phase.`;
        }
        return fileContent;
      }
    }

    return 'No logs available.';
  }

  getNodeLogFilePath(planId: string, nodeId: string, attemptNumber?: number): string | undefined {
    if (!this.state.executor?.getLogFilePath) {return undefined;}
    return this.state.executor.getLogFilePath(planId, nodeId, attemptNumber);
  }

  getNodeLogsFromOffset(planId: string, nodeId: string, memoryOffset: number, fileByteOffset: number, attemptNumber?: number): string {
    if (!this.state.executor) {return 'No executor available.';}

    if (this.state.executor.getLogs) {
      const allLogs = this.state.executor.getLogs(planId, nodeId);
      if (allLogs.length > 0) {
        const sliced = allLogs.slice(memoryOffset);
        return sliced.length > 0 ? formatLogEntries(sliced) : 'No logs available.';
      }
    }

    if ('readLogsFromFileOffset' in this.state.executor && typeof (this.state.executor as any).readLogsFromFileOffset === 'function') {
      const fileContent = (this.state.executor as any).readLogsFromFileOffset(planId, nodeId, fileByteOffset, attemptNumber) as string;
      if (fileContent && !fileContent.startsWith('No log file')) {return fileContent;}
    }

    return 'No logs available.';
  }

  getNodeAttempt(planId: string, nodeId: string, attemptNumber: number): AttemptRecord | null {
    const plan = this.state.plans.get(planId);
    if (!plan) {return null;}
    const state = plan.nodeStates.get(nodeId);
    if (!state || !state.attemptHistory) {return null;}
    return state.attemptHistory.find(a => a.attemptNumber === attemptNumber) || null;
  }

  getNodeAttempts(planId: string, nodeId: string): AttemptRecord[] {
    const plan = this.state.plans.get(planId);
    if (!plan) {return [];}
    const state = plan.nodeStates.get(nodeId);
    return state?.attemptHistory || [];
  }

  async getProcessStats(planId: string, nodeId: string): Promise<{
    pid: number | null;
    running: boolean;
    tree: any[];
    duration: number | null;
  }> {
    if (!this.state.executor) {
      return { pid: null, running: false, tree: [], duration: null };
    }
    if ('getProcessStats' in this.state.executor && typeof (this.state.executor as any).getProcessStats === 'function') {
      return (this.state.executor as any).getProcessStats(planId, nodeId);
    }
    return { pid: null, running: false, tree: [], duration: null };
  }

  /**
   * Get process stats for all running nodes in a Plan.
   * Uses a single OS process snapshot for efficiency.
   */
  async getAllProcessStats(planId: string): Promise<{ flat: any[]; hierarchy: any[] }> {
    const plan = this.state.plans.get(planId);
    if (!plan || !this.state.executor) {return { flat: [], hierarchy: [] };}

    const nodeKeys: Array<{ planId: string; nodeId: string; nodeName: string; planName?: string }> = [];
    const rootJobs: any[] = [];
    const rootHierarchy: any[] = [];

    for (const [nodeId, state] of plan.nodeStates) {
      const node = plan.nodes.get(nodeId);
      if (!node || node.type !== 'job') {continue;}
      if (state.status !== 'running' && state.status !== 'scheduled') {continue;}
      const name = node.name || nodeId.slice(0, 8);
      nodeKeys.push({ planId: plan.id, nodeId, nodeName: name });
      rootJobs.push({ nodeId, nodeName: name, status: state.status, pid: null, running: false, tree: [], duration: null });
    }

    // Batch fetch process stats
    const processStats = new Map<string, any>();
    if (nodeKeys.length > 0 && 'getAllProcessStats' in this.state.executor) {
      try {
        const stats = await (this.state.executor as any).getAllProcessStats(nodeKeys);
        for (const stat of stats) {processStats.set(`${stat.planId}:${stat.nodeId}`, stat);}
      } catch { /* fallback: individual fetches */ }
    }

    // Fill stats
    const fillJob = (job: any, pId: string) => {
      const s = processStats.get(`${pId}:${job.nodeId}`);
      if (s) { job.pid = s.pid; job.running = s.running; job.tree = s.tree; job.duration = s.duration; }
    };
    for (const job of rootJobs) {fillJob(job, plan.id);}

    const fillHierarchy = (h: any) => {
      for (const job of h.jobs) {fillJob(job, h.planId);}
      for (const child of h.children) {fillHierarchy(child);}
    };
    for (const h of rootHierarchy) {fillHierarchy(h);}

    // Build flat list
    const flat: any[] = [];
    const collectFlat = (jobs: any[], pId: string, pName?: string) => {
      for (const job of jobs) {
        if (job.running || job.pid) {
          flat.push({ nodeId: job.nodeId, nodeName: job.nodeName, planId: pId, planName: pName, pid: job.pid, running: job.running, tree: job.tree, duration: job.duration });
        }
      }
    };
    collectFlat(rootJobs, plan.id, undefined);

    const collectHierarchyFlat = (h: any, parentPath?: string) => {
      const pp = parentPath ? `${parentPath} → ${h.planName}` : h.planName;
      collectFlat(h.jobs, h.planId, pp);
      for (const child of h.children) {collectHierarchyFlat(child, pp);}
    };
    for (const h of rootHierarchy) {collectHierarchyFlat(h);}

    return { flat, hierarchy: rootHierarchy, rootJobs } as any;
  }

  getNodeFailureContext(planId: string, nodeId: string): {
    logs: string;
    phase: string;
    errorMessage: string;
    sessionId?: string;
    lastAttempt?: NodeExecutionState['lastAttempt'];
    worktreePath?: string;
  } | { error: string } {
    const plan = this.state.plans.get(planId);
    if (!plan) {return { error: `Plan not found: ${planId}` };}
    const node = plan.nodes.get(nodeId);
    if (!node) {return { error: `Node not found: ${nodeId}` };}
    const nodeState = plan.nodeStates.get(nodeId);
    if (!nodeState) {return { error: `Node state not found: ${nodeId}` };}

    const logsText = this.getNodeLogs(planId, nodeId);
    return {
      logs: logsText,
      phase: nodeState.lastAttempt?.phase || 'unknown',
      errorMessage: nodeState.error || 'Unknown error',
      sessionId: nodeState.copilotSessionId,
      lastAttempt: nodeState.lastAttempt,
      worktreePath: nodeState.worktreePath,
    };
  }

  // ── Force Fail ─────────────────────────────────────────────────────

  async forceFailNode(planId: string, nodeId: string): Promise<void> {
    const plan = this.state.plans.get(planId);
    if (!plan) {throw new Error(`Plan ${planId} not found`);}
    const node = plan.nodes.get(nodeId);
    if (!node) {throw new Error(`Node ${nodeId} not found in plan ${planId}`);}
    const nodeState = plan.nodeStates.get(nodeId);
    if (!nodeState) {throw new Error(`Node state ${nodeId} not found in plan ${planId}`);}

    this.log.info(`Force failing node ${nodeId} (current status: ${nodeState.status}, attempts: ${nodeState.attempts}, pid: ${nodeState.pid})`);

    if (this.state.executor && 'cancel' in this.state.executor) {
      try {
        (this.state.executor as any).cancel(planId, nodeId);
        this.log.info(`Cancelled executor for node ${nodeId}`);
      } catch (e) {
        this.log.debug(`Could not cancel executor: ${e}`);
      }
    }

    if (nodeState.pid) {
      try {
        await this.state.processMonitor.terminate(nodeState.pid, true);
        this.log.info(`Killed process tree ${nodeState.pid} for node ${nodeId}`);
      } catch (e) {
        this.log.debug(`Could not kill process ${nodeState.pid}: ${e}`);
      }
    }

    const previousStatus = nodeState.status;
    nodeState.status = 'failed';
    nodeState.error = 'Manually failed by user (Force Fail)';
    nodeState.forceFailed = true;
    nodeState.pid = undefined;
    if (previousStatus === 'running') {nodeState.attempts = (nodeState.attempts || 0) + 1;}
    nodeState.endedAt = Date.now();
    nodeState.version = (nodeState.version || 0) + 1;
    plan.stateVersion = (plan.stateVersion || 0) + 1;

    this.state.persistence.save(plan);

    this.state.events.emitNodeTransitionFull({
      planId,
      nodeId,
      previousStatus,
      newStatus: 'failed',
      reason: 'force-failed',
    });

    this.log.info(`Node ${nodeId} force failed successfully. New status: ${nodeState.status}`);
  }

  // ── Retry ──────────────────────────────────────────────────────────

  async retryNode(planId: string, nodeId: string, options?: RetryNodeOptions, startPump?: () => void): Promise<{ success: boolean; error?: string }> {
    const plan = this.state.plans.get(planId);
    if (!plan) {return { success: false, error: `Plan not found: ${planId}` };}
    const node = plan.nodes.get(nodeId);
    if (!node) {return { success: false, error: `Node not found: ${nodeId}` };}
    const nodeState = plan.nodeStates.get(nodeId);
    if (!nodeState) {return { success: false, error: `Node state not found: ${nodeId}` };}
    if (nodeState.status !== 'failed') {return { success: false, error: `Node is not in failed state: ${nodeState.status}` };}
    const sm = this.state.stateMachines.get(planId);
    if (!sm) {return { success: false, error: `State machine not found for Plan: ${planId}` };}

    this.log.info(`Retrying failed node: ${node.name}`, {
      planId,
      nodeId,
      hasNewWork: !!options?.newWork,
      clearWorktree: options?.clearWorktree ?? false,
    });

    // Handle new work spec
    if (options?.newWork && node.type === 'job') {
      const jobNode = node as JobNode;
      const newWork = options.newWork;
      if (typeof newWork === 'string') {
        jobNode.work = newWork;
        if (!newWork.startsWith('@agent')) {nodeState.copilotSessionId = undefined;}
      } else if (newWork.type === 'agent') {
        if (newWork.instructions) {jobNode.work = newWork;}
        if (newWork.resumeSession === false) {nodeState.copilotSessionId = undefined;}
      } else {
        jobNode.work = newWork;
        nodeState.copilotSessionId = undefined;
      }
    }

    // Handle new prechecks/postchecks
    if (node.type === 'job') {
      const jobNode = node as JobNode;
      if (options?.newPrechecks !== undefined) {
        jobNode.prechecks = options.newPrechecks === null ? undefined : options.newPrechecks;
        this.log.info(`Updated prechecks for retry: ${node.name}`);
      }
      if (options?.newPostchecks !== undefined) {
        jobNode.postchecks = options.newPostchecks === null ? undefined : options.newPostchecks;
        this.log.info(`Updated postchecks for retry: ${node.name}`);
      }
    }

    // Auto-generate failure-fixing instructions for agent jobs
    if (!options?.newWork && node.type === 'job') {
      const jobNode = node as JobNode;
      const isAgentWork = typeof jobNode.work === 'string'
        ? jobNode.work.startsWith('@agent')
        : (jobNode.work && 'type' in jobNode.work && jobNode.work.type === 'agent');

      if (isAgentWork && nodeState.copilotSessionId) {
        const failureContext = this.getNodeFailureContext(planId, nodeId);
        if (!('error' in failureContext)) {
          const truncatedLogs = failureContext.logs.length > 2000
            ? '...' + failureContext.logs.slice(-2000)
            : failureContext.logs;

          const retryInstructions = `@agent The previous attempt at this task failed. Please analyze the error and fix it, then continue the original work.\n\n## Previous Error\nPhase: ${failureContext.phase}\nError: ${failureContext.errorMessage}\n\n## Recent Logs\n\`\`\`\n${truncatedLogs}\n\`\`\`\n\n## Instructions\n1. Analyze what went wrong in the previous attempt\n2. Fix the root cause of the failure\n3. Complete the original task: ${jobNode.task || node.name}\n\nResume working in the existing worktree and session context.`;
          jobNode.work = retryInstructions;
          this.log.info(`Auto-generated retry instructions for agent job: ${node.name}`);
        }
      }
    }

    // Reset node state for retry
    nodeState.status = 'pending';
    nodeState.error = undefined;
    nodeState.endedAt = undefined;
    nodeState.startedAt = undefined;

    const hasNewWork = !!options?.newWork;
    const hasNewPrechecks = options?.newPrechecks !== undefined;
    const hasNewPostchecks = options?.newPostchecks !== undefined;
    const failedPhase = nodeState.lastAttempt?.phase;
    const shouldResetPhases = hasNewWork || hasNewPrechecks || options?.clearWorktree;

    if (shouldResetPhases) {
      nodeState.stepStatuses = undefined;
      nodeState.resumeFromPhase = undefined;
    } else if (hasNewPostchecks && failedPhase === 'postchecks') {
      nodeState.resumeFromPhase = 'postchecks' as any;
    } else if (failedPhase) {
      nodeState.resumeFromPhase = failedPhase as any;
    }

    // Handle worktree reset
    if (options?.clearWorktree && nodeState.worktreePath) {
      const upstreamWithCommits: string[] = [];
      for (const depId of node.dependencies) {
        const depState = plan.nodeStates.get(depId);
        if (depState?.completedCommit) {
          const depNode = plan.nodes.get(depId);
          upstreamWithCommits.push(depNode?.name || depId);
        }
      }

      if (upstreamWithCommits.length > 0) {
        return {
          success: false,
          error: `Cannot clear worktree: would lose merged commits from upstream dependencies (${upstreamWithCommits.join(', ')}). Retry without clearWorktree to preserve upstream work, or manually merge upstream commits after reset.`,
        };
      }

      try {
        await this.git.repository.fetch(plan.repoPath, { all: true });
      } catch (e: any) {
        this.log.warn(`Git fetch failed before worktree clear: ${e.message}`);
      }

      try {
        if (nodeState.baseCommit && nodeState.worktreePath) {
          await this.git.repository.resetHard(nodeState.worktreePath, nodeState.baseCommit);
          await this.git.repository.clean(nodeState.worktreePath);
        }
      } catch (e: any) {
        this.log.warn(`Failed to reset worktree: ${e.message}`);
      }
    }

    if (plan.endedAt) {plan.endedAt = undefined;}

    const readyNodes = sm.getReadyNodes();
    if (!readyNodes.includes(nodeId)) {
      sm.resetNodeToPending(nodeId);
    }

    this.state.persistence.save(plan);
    startPump?.();
    this.state.events.emit('nodeRetry', planId, nodeId);

    return { success: true };
  }
}
