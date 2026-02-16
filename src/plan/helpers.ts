/**
 * @fileoverview Plan Helper Functions
 * 
 * Pure utility functions extracted from runner.ts and stateMachine.ts.
 * These functions have no side effects and operate solely on their inputs.
 * 
 * @module plan/helpers
 */

import {
  NodeStatus,
  NodeExecutionState,
  PlanStatus,
  LogEntry,
  JobWorkSummary,
  WorkSummary,
  PlanInstance,
} from './types';

// ============================================================================
// LOG FORMATTING
// ============================================================================

/**
 * Format a single {@link LogEntry} into a human-readable string.
 *
 * - `stdout` entries are returned as raw message text (no prefix).
 * - All other types get a `[time] [TYPE]` prefix.
 *
 * @param entry - The log entry to format.
 * @returns Formatted log line.
 */
export function formatLogEntry(entry: LogEntry): string {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  const prefix = entry.type === 'stderr' ? '[ERR]' :
                 entry.type === 'error'  ? '[ERROR]' :
                 entry.type === 'info'   ? '[INFO]' : '';

  if (entry.type === 'stdout') {
    return entry.message;
  }
  return `[${time}] ${prefix} ${entry.message}`;
}

/**
 * Format an array of log entries into a single newline-separated string.
 *
 * @param entries - Log entries to format.
 * @returns Concatenated formatted output.
 */
export function formatLogEntries(entries: LogEntry[]): string {
  return entries.map(formatLogEntry).join('\n');
}

// ============================================================================
// STATUS AGGREGATION
// ============================================================================

/**
 * Count how many nodes are in each {@link NodeStatus}.
 *
 * @param nodeStates - Iterable of node execution states.
 * @returns Record keyed by status with integer counts.
 */
export function computeStatusCounts(
  nodeStates: Iterable<NodeExecutionState>
): Record<NodeStatus, number> {
  const counts: Record<NodeStatus, number> = {
    pending: 0,
    ready: 0,
    scheduled: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    blocked: 0,
    canceled: 0,
  };

  for (const state of nodeStates) {
    counts[state.status]++;
  }

  return counts;
}

/**
 * Compute a 0–1 progress ratio from status counts.
 * Terminal states (succeeded, failed, blocked, canceled) count as "completed".
 *
 * @param counts - Status counts as returned by {@link computeStatusCounts}.
 * @param total  - Total number of nodes in the plan.
 * @returns Progress ratio between 0 and 1; returns 0 when `total ≤ 0`.
 */
export function computeProgress(
  counts: Record<NodeStatus, number>,
  total: number
): number {
  if (total <= 0) {return 0;}
  const completed = counts.succeeded + counts.failed + counts.blocked + counts.canceled;
  return completed / total;
}

/**
 * Derive the overall PlanStatus from node execution states.
 * 
 * @param nodeStates - Iterable of every node's execution state
 * @param hasStarted - Whether the plan has been started (plan.startedAt is set)
 * @param isPaused - Whether the plan is paused by user
 */
export function computePlanStatus(
  nodeStates: Iterable<NodeExecutionState>,
  hasStarted: boolean,
  isPaused: boolean = false
): PlanStatus {
  // Convert to array so we can iterate multiple times
  const states = Array.from(nodeStates);
  
  // If paused, return paused status (overrides running/pending)
  // Note: isPaused can be set before or after the plan starts
  if (isPaused) {
    // Check if there are still non-terminal nodes (paused only makes sense if there's work to do)
    let hasNonTerminal = false;
    for (const state of states) {
      if (!['succeeded', 'failed', 'canceled', 'blocked'].includes(state.status)) {
        hasNonTerminal = true;
        break;
      }
    }
    if (hasNonTerminal) {
      return 'paused';
    }
    // All nodes are terminal - fall through to compute final status
  }
  
  let hasRunning = false;
  let hasPending = false;
  let hasReady = false;
  let hasScheduled = false;
  let hasFailed = false;
  let hasSucceeded = false;
  let hasCanceled = false;
  let activeNonTerminal = 0;

  for (const state of states) {
    switch (state.status) {
      case 'running':
        hasRunning = true;
        break;
      case 'pending':
        hasPending = true;
        activeNonTerminal++;
        break;
      case 'ready':
        hasReady = true;
        activeNonTerminal++;
        break;
      case 'scheduled':
        hasScheduled = true;
        break;
      case 'failed':
        hasFailed = true;
        break;
      case 'succeeded':
        hasSucceeded = true;
        break;
      case 'canceled':
        hasCanceled = true;
        break;
      case 'blocked':
        // Blocked nodes don't affect status directly
        break;
    }
  }

  // If anything is still in progress
  if (hasRunning || hasScheduled) {
    return 'running';
  }

  // If there are ready or pending nodes (and no running), we're still going
  if (hasReady || hasPending) {
    if (activeNonTerminal > 0) {
      if (hasStarted) {
        return 'running';
      }
      return 'pending';
    }
  }

  // All nodes are terminal - determine final status
  if (hasCanceled) {
    return 'canceled';
  }

  if (hasFailed && hasSucceeded) {
    return 'partial';
  }

  if (hasFailed) {
    return 'failed';
  }

  if (hasSucceeded) {
    return 'succeeded';
  }

  // Edge case: all blocked (no successes or failures directly)
  return 'failed';
}

// ============================================================================
// DURATION / TIMESTAMP HELPERS
// ============================================================================

/**
 * Compute the effective endedAt timestamp from node states.
 * Returns the maximum `endedAt` across all nodes, which is the true
 * completion time even if child plans took longer than originally recorded.
 *
 * @param nodeStates - Iterable of node execution states.
 * @returns The latest endedAt timestamp in ms, or `undefined` if no nodes have ended.
 */
export function computeEffectiveEndedAt(
  nodeStates: Iterable<NodeExecutionState>
): number | undefined {
  let maxEndedAt: number | undefined;

  for (const state of nodeStates) {
    if (state.endedAt) {
      if (!maxEndedAt || state.endedAt > maxEndedAt) {
        maxEndedAt = state.endedAt;
      }
    }
  }

  return maxEndedAt;
}

// ============================================================================
// WORK SUMMARY
// ============================================================================

/**
 * Create a new empty {@link WorkSummary} with all counters at zero.
 *
 * @returns A fresh work summary object.
 */
export function createEmptyWorkSummary(): WorkSummary {
  return {
    totalCommits: 0,
    totalFilesAdded: 0,
    totalFilesModified: 0,
    totalFilesDeleted: 0,
    jobSummaries: [],
  };
}

/**
 * Append a job's work summary to an aggregated {@link WorkSummary}, mutating it in place.
 * If `summary` is `undefined`, a new one is created and returned.
 *
 * @param summary    - Existing aggregated summary, or `undefined` to create a new one.
 * @param jobSummary - The individual job summary to add.
 * @returns The mutated (or newly created) aggregated summary.
 */
export function appendWorkSummary(
  summary: WorkSummary | undefined,
  jobSummary: JobWorkSummary
): WorkSummary {
  const ws = summary ?? createEmptyWorkSummary();

  ws.totalCommits += jobSummary.commits;
  ws.totalFilesAdded += jobSummary.filesAdded;
  ws.totalFilesModified += jobSummary.filesModified;
  ws.totalFilesDeleted += jobSummary.filesDeleted;
  ws.jobSummaries.push(jobSummary);

  return ws;
}

/**
 * Merge a child plan's work summary into a parent plan's work summary.
 * This aggregates all job summaries and totals from the child into the parent.
 *
 * @param parent - The parent plan's work summary (can be undefined).
 * @param child  - The child plan's work summary to merge.
 * @returns The merged work summary.
 */
export function mergeWorkSummary(
  parent: WorkSummary | undefined,
  child: WorkSummary | undefined
): WorkSummary {
  const ws = parent ?? createEmptyWorkSummary();
  
  if (!child) {return ws;}
  
  ws.totalCommits += child.totalCommits;
  ws.totalFilesAdded += child.totalFilesAdded;
  ws.totalFilesModified += child.totalFilesModified;
  ws.totalFilesDeleted += child.totalFilesDeleted;
  ws.jobSummaries.push(...child.jobSummaries);
  
  return ws;
}

/**
 * Compute a work summary containing only work from leaf nodes that have
 * successfully merged to targetBranch.
 * 
 * This function filters the plan's aggregated work summary to include only
 * jobs from leaf nodes where `mergedToTarget === true`. This provides users
 * with an accurate view of work that has actually been integrated into the
 * target branch, rather than all work performed across the plan.
 * 
 * **Dynamic behavior:** This function should be called at render time since
 * `mergedToTarget` changes as nodes complete their merge operations.
 * 
 * **Backward compatibility:** When the plan has no targetBranch specified,
 * returns the full workSummary unchanged.
 * 
 * @param plan - The plan instance containing work summary and leaf node IDs.
 * @param nodeStates - Map of node IDs to their execution states (needed for mergedToTarget status).
 * @returns A filtered WorkSummary with only merged leaf work, or undefined if no work summary exists.
 * 
 * @example
 * ```typescript
 * // In a UI render function:
 * const mergedWork = computeMergedLeafWorkSummary(plan, plan.nodeStates);
 * if (mergedWork) {
 *   console.log(`${mergedWork.totalCommits} commits merged to target`);
 * }
 * ```
 */
export function computeMergedLeafWorkSummary(
  plan: PlanInstance,
  nodeStates: Map<string, NodeExecutionState>
): WorkSummary | undefined {
  // If no work summary exists, return undefined
  if (!plan.workSummary || plan.workSummary.jobSummaries.length === 0) {
    return undefined;
  }

  // If no target branch, return full work summary (backward compatible)
  if (!plan.targetBranch) {
    return plan.workSummary;
  }

  // Filter job summaries to only include merged leaf nodes
  const leafSet = new Set(plan.leaves);
  const filteredJobSummaries: JobWorkSummary[] = [];
  
  for (const jobSummary of plan.workSummary.jobSummaries) {
    if (!leafSet.has(jobSummary.nodeId)) {
      continue;
    }

    // Check if it has been merged to target
    const nodeState = nodeStates.get(jobSummary.nodeId);
    if (nodeState?.mergedToTarget !== true) {
      continue;
    }
    
    // Use aggregatedWorkSummary if available, otherwise fall back to workSummary
    if (nodeState.aggregatedWorkSummary) {
      filteredJobSummaries.push(nodeState.aggregatedWorkSummary);
    } else {
      filteredJobSummaries.push(jobSummary);
    }
  }

  // If no jobs match the filter, return undefined
  if (filteredJobSummaries.length === 0) {
    return undefined;
  }

  // Recompute aggregate totals from filtered summaries
  const filteredSummary: WorkSummary = {
    totalCommits: 0,
    totalFilesAdded: 0,
    totalFilesModified: 0,
    totalFilesDeleted: 0,
    jobSummaries: filteredJobSummaries,
  };

  for (const jobSummary of filteredJobSummaries) {
    filteredSummary.totalCommits += jobSummary.commits;
    filteredSummary.totalFilesAdded += jobSummary.filesAdded;
    filteredSummary.totalFilesModified += jobSummary.filesModified;
    filteredSummary.totalFilesDeleted += jobSummary.filesDeleted;
  }

  return filteredSummary;
}
