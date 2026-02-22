/**
 * @fileoverview Reshape Plan MCP Tool Handler
 *
 * Implements handler for reshaping a plan's DAG topology at runtime —
 * adding, removing, reordering nodes and updating dependency edges.
 *
 * @module mcp/handlers/plan/reshapePlanHandler
 */

import { Logger } from '../../../core/logger';
import {
  addNode,
  removeNode,
  updateNodeDependencies,
  addNodeBefore,
  addNodeAfter,
} from '../../../plan/reshaper';
import type { JobNodeSpec } from '../../../plan/types';
import {
  PlanHandlerContext,
  errorResult,
  validateRequired,
  lookupPlan,
  isError,
} from '../utils';

const log = Logger.for('mcp');

// ---------------------------------------------------------------------------
// Operation types
// ---------------------------------------------------------------------------

interface AddNodeOp {
  type: 'add_node';
  spec: {
    producerId: string;
    name?: string;
    task: string;
    work?: any;
    dependencies: string[];
    prechecks?: any;
    postchecks?: any;
    instructions?: string;
    expectsNoChanges?: boolean;
  };
}

interface RemoveNodeOp {
  type: 'remove_node';
  nodeId?: string;
  producerId?: string;
}

interface UpdateDepsOp {
  type: 'update_deps';
  nodeId: string;
  dependencies: string[];
}

interface AddBeforeOp {
  type: 'add_before';
  existingNodeId: string;
  spec: AddNodeOp['spec'];
}

interface AddAfterOp {
  type: 'add_after';
  existingNodeId: string;
  spec: AddNodeOp['spec'];
}

type ReshapeOperation = AddNodeOp | RemoveNodeOp | UpdateDepsOp | AddBeforeOp | AddAfterOp;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a raw spec from the MCP input into a JobNodeSpec. */
function toJobNodeSpec(raw: AddNodeOp['spec']): JobNodeSpec {
  return {
    producerId: raw.producerId,
    name: raw.name,
    task: raw.task,
    work: raw.work,
    dependencies: raw.dependencies ?? [],
    prechecks: raw.prechecks,
    postchecks: raw.postchecks,
    instructions: raw.instructions,
    expectsNoChanges: raw.expectsNoChanges,
  };
}

/** Resolve a nodeId from either nodeId or producerId on the plan. */
function resolveNodeId(
  plan: import('../../../plan/types').PlanInstance,
  nodeId?: string,
  producerId?: string,
): string | undefined {
  if (nodeId) {
    if (plan.jobs.has(nodeId)) { return nodeId; }
    // Maybe it's actually a producerId
    return plan.producerIdToNodeId.get(nodeId);
  }
  if (producerId) {
    return plan.producerIdToNodeId.get(producerId);
  }
  return undefined;
}

const SV_PRODUCER_ID = '__snapshot-validation__';

/** Returns true if the resolved node is the auto-managed Snapshot Validation node. */
function isSnapshotValidationNode(
  plan: import('../../../plan/types').PlanInstance,
  nodeId: string,
): boolean {
  const node = plan.jobs.get(nodeId);
  return node?.producerId === SV_PRODUCER_ID;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle the `reshape_copilot_plan` MCP tool call.
 *
 * Executes a sequence of topology-changing operations on a running or paused
 * plan. Each operation is executed in order; failures are reported per-operation
 * but do not abort subsequent operations.
 *
 * @param args - Must contain `planId` and `operations` array.
 * @param ctx  - Handler context.
 * @returns Per-operation results plus updated plan topology summary.
 */
export async function handleReshapePlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId', 'operations']);
  if (fieldError) { return fieldError; }

  if (!Array.isArray(args.operations) || args.operations.length === 0) {
    return errorResult('operations must be a non-empty array');
  }

  const planResult = lookupPlan(ctx, args.planId, 'getPlan');
  if (isError(planResult)) { return planResult; }
  const plan = planResult;

  const isScaffolding = (plan.spec as any)?.status === 'scaffolding';

  const results: Array<{ operation: string; success: boolean; nodeId?: string; error?: string }> = [];

  for (const op of args.operations as ReshapeOperation[]) {
    if (isScaffolding) {
      // Scaffolding plans: modify spec.jobs[] via repository and rebuild via buildPlan()
      try {
        const result = await handleScaffoldingOp(op, plan, ctx);
        results.push(result);
      } catch (e: any) {
        results.push({ operation: op.type, success: false, error: e.message });
      }
    } else {
      // Running/paused plans: use in-memory reshaper
      const result = handleRunningOp(op, plan);
      results.push(result);
    }
  }

  // Persist changes
  if (isScaffolding) {
    // For scaffolding, the repository already wrote metadata in each op.
    // Just emit planUpdated so the UI refreshes.
    (ctx.PlanRunner as any)._state?.events?.emitPlanUpdated?.(args.planId);
  } else {
    // For running plans: async save via repository, then emit
    if (ctx.PlanRepository) {
      try { await ctx.PlanRepository.saveState(plan); } catch { /* fallback below */ }
    }
    ctx.PlanRunner.savePlan(args.planId);
    ctx.PlanRunner.emit('planUpdated', args.planId);
  }

  // Build topology summary
  const nodes: Array<{ id: string; producerId?: string; name: string; dependencies: string[]; dependents: string[] }> = [];
  for (const [, node] of plan.jobs) {
    nodes.push({
      id: node.id,
      producerId: node.producerId,
      name: node.name,
      dependencies: node.dependencies,
      dependents: node.dependents,
    });
  }

  log.info('Plan reshaped', { planId: args.planId, opCount: results.length });

  return {
    success: results.every(r => r.success),
    planId: args.planId,
    results,
    topology: {
      nodeCount: plan.jobs.size,
      roots: plan.roots,
      leaves: plan.leaves,
      nodes,
    },
  };
}

/**
 * Handle a reshape operation on a scaffolding plan via the repository.
 * Modifies spec.jobs[] and rebuilds the in-memory plan via buildPlan().
 */
async function handleScaffoldingOp(
  op: ReshapeOperation,
  plan: import('../../../plan/types').PlanInstance,
  ctx: PlanHandlerContext,
): Promise<{ operation: string; success: boolean; nodeId?: string; error?: string }> {
  const planId = plan.id;
  
  switch (op.type) {
    case 'add_node': {
      if (!op.spec) { return { operation: 'add_node', success: false, error: 'spec is required' }; }
      const rebuilt = await ctx.PlanRepository.addNode(planId, {
        producerId: op.spec.producerId,
        name: op.spec.name || op.spec.task,
        task: op.spec.task,
        dependencies: op.spec.dependencies || [],
        work: op.spec.work,
        prechecks: op.spec.prechecks,
        postchecks: op.spec.postchecks,
        expectsNoChanges: op.spec.expectsNoChanges,
      });
      replaceInMemoryPlan(plan, rebuilt);
      return { operation: 'add_node', success: true, nodeId: op.spec.producerId };
    }

    case 'remove_node': {
      const producerId = op.producerId || (() => {
        if (op.nodeId) {
          const node = plan.jobs.get(op.nodeId);
          return node?.producerId;
        }
        return undefined;
      })();
      if (!producerId) { return { operation: 'remove_node', success: false, error: `Job not found: ${op.nodeId ?? op.producerId}` }; }
      if (producerId === SV_PRODUCER_ID) { return { operation: 'remove_node', success: false, error: 'The Snapshot Validation job is auto-managed and cannot be removed.' }; }
      const rebuilt = await ctx.PlanRepository.removeNode(planId, producerId);
      replaceInMemoryPlan(plan, rebuilt);
      return { operation: 'remove_node', success: true };
    }

    case 'update_deps': {
      const producerId = (() => {
        if (op.nodeId) {
          const node = plan.jobs.get(op.nodeId);
          return node?.producerId || plan.producerIdToNodeId.has(op.nodeId) ? op.nodeId : undefined;
        }
        return undefined;
      })();
      if (!producerId) { return { operation: 'update_deps', success: false, error: `Job not found: ${op.nodeId}` }; }
      // Find the actual producerId from nodeId
      const node = plan.jobs.get(op.nodeId!);
      const pid = node?.producerId || producerId;
      const rebuilt = await ctx.PlanRepository.updateNode(planId, pid, { dependencies: op.dependencies });
      replaceInMemoryPlan(plan, rebuilt);
      return { operation: 'update_deps', success: true };
    }

    default:
      return { operation: (op as any).type ?? 'unknown', success: false, error: `Operation '${(op as any).type}' not supported for scaffolding plans. Use add_copilot_plan_job / remove_node / update_deps.` };
  }
}

/**
 * Handle a reshape operation on a running/paused plan via the in-memory reshaper.
 */
function handleRunningOp(
  op: ReshapeOperation,
  plan: import('../../../plan/types').PlanInstance,
): { operation: string; success: boolean; nodeId?: string; error?: string } {
  switch (op.type) {
    case 'add_node': {
      if (!op.spec) { return { operation: 'add_node', success: false, error: 'spec is required' }; }
      const res = addNode(plan, toJobNodeSpec(op.spec));
      return { operation: 'add_node', success: res.success, nodeId: res.nodeId, error: res.error };
    }
    case 'remove_node': {
      const id = resolveNodeId(plan, op.nodeId, op.producerId);
      if (!id) { return { operation: 'remove_node', success: false, error: `Job not found: ${op.nodeId ?? op.producerId}` }; }
      if (isSnapshotValidationNode(plan, id)) { return { operation: 'remove_node', success: false, error: 'The Snapshot Validation job is auto-managed and cannot be removed.' }; }
      const res = removeNode(plan, id);
      return { operation: 'remove_node', success: res.success, error: res.error };
    }
    case 'update_deps': {
      if (!op.nodeId || !Array.isArray(op.dependencies)) { return { operation: 'update_deps', success: false, error: 'nodeId and dependencies array are required' }; }
      const id = resolveNodeId(plan, op.nodeId);
      if (!id) { return { operation: 'update_deps', success: false, error: `Job not found: ${op.nodeId}` }; }
      if (isSnapshotValidationNode(plan, id)) { return { operation: 'update_deps', success: false, error: 'SV job dependencies are auto-managed.' }; }
      const resolvedDeps: string[] = [];
      for (const dep of op.dependencies) {
        const depId = resolveNodeId(plan, dep);
        if (!depId) { return { operation: 'update_deps', success: false, error: `Dependency not found: ${dep}` }; }
        resolvedDeps.push(depId);
      }
      const res = updateNodeDependencies(plan, id, resolvedDeps);
      return { operation: 'update_deps', success: res.success, error: res.error };
    }
    case 'add_before': {
      if (!op.existingNodeId || !op.spec) { return { operation: 'add_before', success: false, error: 'existingNodeId and spec are required' }; }
      const id = resolveNodeId(plan, op.existingNodeId);
      if (!id) { return { operation: 'add_before', success: false, error: `Job not found: ${op.existingNodeId}` }; }
      const res = addNodeBefore(plan, id, toJobNodeSpec(op.spec));
      return { operation: 'add_before', success: res.success, nodeId: res.nodeId, error: res.error };
    }
    case 'add_after': {
      if (!op.existingNodeId || !op.spec) { return { operation: 'add_after', success: false, error: 'existingNodeId and spec are required' }; }
      const id = resolveNodeId(plan, op.existingNodeId);
      if (!id) { return { operation: 'add_after', success: false, error: `Job not found: ${op.existingNodeId}` }; }
      const res = addNodeAfter(plan, id, toJobNodeSpec(op.spec));
      return { operation: 'add_after', success: res.success, nodeId: res.nodeId, error: res.error };
    }
    default:
      return { operation: (op as any).type ?? 'unknown', success: false, error: `Unknown operation type: ${(op as any).type}` };
  }
}

/** Replace in-memory plan topology with rebuilt plan from repository. */
function replaceInMemoryPlan(
  plan: import('../../../plan/types').PlanInstance,
  rebuilt: import('../../../plan/types').PlanInstance,
): void {
  plan.jobs = rebuilt.jobs;
  plan.nodeStates = rebuilt.nodeStates;
  plan.producerIdToNodeId = rebuilt.producerIdToNodeId;
  plan.roots = rebuilt.roots;
  plan.leaves = rebuilt.leaves;
  plan.groups = rebuilt.groups || new Map();
  plan.groupStates = rebuilt.groupStates || new Map();
  plan.groupPathToId = rebuilt.groupPathToId || new Map();
  plan.stateVersion = (plan.stateVersion || 0) + 1;
}
