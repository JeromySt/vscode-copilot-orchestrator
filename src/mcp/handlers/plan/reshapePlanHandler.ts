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

interface JobSpec {
  producerId: string;
  name?: string;
  task: string;
  work?: any;
  dependencies: string[];
  prechecks?: any;
  postchecks?: any;
  instructions?: string;
  expectsNoChanges?: boolean;
}

interface AddNodeOp {
  type: 'add_node' | 'add_job';  // Schema says add_job, handler historically used add_node
  spec: JobSpec;
}

interface RemoveNodeOp {
  type: 'remove_node' | 'remove_job';  // Schema says remove_job
  nodeId?: string;
  jobId?: string;      // MCP schema field name
  producerId?: string;
}

interface UpdateDepsOp {
  type: 'update_deps';
  nodeId?: string;      // Internal name
  jobId?: string;       // MCP schema field name
  producerId?: string;  // Also accepted
  dependencies: string[];
}

interface AddBeforeOp {
  type: 'add_before';
  existingNodeId?: string;  // Internal name
  existingJobId?: string;   // MCP schema field name
  spec: JobSpec;
}

interface AddAfterOp {
  type: 'add_after';
  existingNodeId?: string;  // Internal name
  existingJobId?: string;   // MCP schema field name
  spec: JobSpec;
}

type ReshapeOperation = AddNodeOp | RemoveNodeOp | UpdateDepsOp | AddBeforeOp | AddAfterOp;

/** Normalize operation field names: MCP schema uses jobId/existingJobId, handler uses nodeId/existingNodeId */
function normalizeOp(op: any): any {
  // Normalize type: add_job -> add_node, remove_job -> remove_node
  if (op.type === 'add_job') op.type = 'add_node';
  if (op.type === 'remove_job') op.type = 'remove_node';
  // Normalize field names: jobId -> nodeId, existingJobId -> existingNodeId
  if (op.jobId && !op.nodeId) op.nodeId = op.jobId;
  if (op.existingJobId && !op.existingNodeId) op.existingNodeId = op.existingJobId;
  return op;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a raw spec from the MCP input into a JobNodeSpec. */
function toJobNodeSpec(raw: JobSpec): JobNodeSpec {
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
  nodeIdOrJobId?: string,
  producerId?: string,
): string | undefined {
  if (nodeIdOrJobId) {
    if (plan.jobs.has(nodeIdOrJobId)) { return nodeIdOrJobId; }
    // Maybe it's a producerId
    const fromProducer = plan.producerIdToNodeId.get(nodeIdOrJobId);
    if (fromProducer) { return fromProducer; }
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

  for (const rawOp of args.operations as ReshapeOperation[]) {
    const op = normalizeOp(rawOp);
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

  // Record reshape event in state history for timeline rendering
  if (!plan.stateHistory) plan.stateHistory = [];
  const opSummary = results.map(r => `${r.operation}:${r.success ? 'ok' : 'fail'}`).join(', ');
  const lastStatus = plan.stateHistory?.length ? plan.stateHistory[plan.stateHistory.length - 1].to : 'running';
  plan.stateHistory.push({ from: lastStatus || 'running', to: 'reshaped', timestamp: Date.now(), reason: `reshape: ${opSummary}` });

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
      if (!op.nodeId || !Array.isArray(op.dependencies)) {
        return { operation: 'update_deps', success: false, error: 'nodeId and dependencies array are required' };
      }
      // Resolve nodeId: could be a UUID (job.id) or a producerId
      const resolvedNodeId = plan.jobs.has(op.nodeId) ? op.nodeId : plan.producerIdToNodeId.get(op.nodeId);
      if (!resolvedNodeId) { return { operation: 'update_deps', success: false, error: `Job not found: ${op.nodeId}` }; }
      const node = plan.jobs.get(resolvedNodeId);
      if (!node) { return { operation: 'update_deps', success: false, error: `Job not found: ${op.nodeId}` }; }
      if (node.producerId === SV_PRODUCER_ID) { return { operation: 'update_deps', success: false, error: 'SV job dependencies are auto-managed.' }; }
      // Resolve dependency producerIds to ensure they exist
      for (const dep of op.dependencies) {
        const depResolved = plan.jobs.has(dep) || plan.producerIdToNodeId.has(dep);
        if (!depResolved) { return { operation: 'update_deps', success: false, error: `Dependency not found: ${dep}` }; }
      }
      const rebuilt = await ctx.PlanRepository.updateNode(planId, node.producerId, { dependencies: op.dependencies });
      replaceInMemoryPlan(plan, rebuilt);
      return { operation: 'update_deps', success: true };
    }

    case 'add_before': {
      if (!op.existingNodeId || !op.spec) {
        return { operation: 'add_before', success: false, error: 'existingNodeId and spec are required' };
      }
      // Resolve existingNodeId (UUID or producerId)
      const existingResolved = plan.jobs.has(op.existingNodeId) ? op.existingNodeId : plan.producerIdToNodeId.get(op.existingNodeId);
      if (!existingResolved) { return { operation: 'add_before', success: false, error: `Job not found: ${op.existingNodeId}` }; }
      const existingNode = plan.jobs.get(existingResolved);
      if (!existingNode) { return { operation: 'add_before', success: false, error: `Job not found: ${op.existingNodeId}` }; }
      // For scaffolding: add new node with the existing node's deps, then update existing node to depend on new node
      const newSpec = {
        producerId: op.spec.producerId,
        name: op.spec.name || op.spec.task,
        task: op.spec.task,
        dependencies: op.spec.dependencies || [],
        work: op.spec.work,
        prechecks: op.spec.prechecks,
        postchecks: op.spec.postchecks,
        expectsNoChanges: op.spec.expectsNoChanges,
      };
      // Step 1: Add the new node
      let rebuilt = await ctx.PlanRepository.addNode(planId, newSpec);
      // Step 2: Update existing node's dependencies to include the new node's producerId
      const existingDeps = existingNode.dependencies
        .map(depId => plan.jobs.get(depId)?.producerId)
        .filter((p): p is string => !!p);
      // Replace deps that the new node now satisfies, or simply add new node as additional dep
      const updatedDeps = [...new Set([...existingDeps, op.spec.producerId])];
      rebuilt = await ctx.PlanRepository.updateNode(planId, existingNode.producerId, { dependencies: updatedDeps });
      replaceInMemoryPlan(plan, rebuilt);
      return { operation: 'add_before', success: true, nodeId: op.spec.producerId };
    }

    case 'add_after': {
      if (!op.existingNodeId || !op.spec) {
        return { operation: 'add_after', success: false, error: 'existingNodeId and spec are required' };
      }
      const afterResolved = plan.jobs.has(op.existingNodeId) ? op.existingNodeId : plan.producerIdToNodeId.get(op.existingNodeId);
      if (!afterResolved) { return { operation: 'add_after', success: false, error: `Job not found: ${op.existingNodeId}` }; }
      const afterNode = plan.jobs.get(afterResolved);
      if (!afterNode) { return { operation: 'add_after', success: false, error: `Job not found: ${op.existingNodeId}` }; }
      // For scaffolding: add new node that depends on the existing node
      const afterSpec = {
        producerId: op.spec.producerId,
        name: op.spec.name || op.spec.task,
        task: op.spec.task,
        dependencies: [...new Set([...(op.spec.dependencies || []), afterNode.producerId])],
        work: op.spec.work,
        prechecks: op.spec.prechecks,
        postchecks: op.spec.postchecks,
        expectsNoChanges: op.spec.expectsNoChanges,
      };
      const rebuilt = await ctx.PlanRepository.addNode(planId, afterSpec);
      replaceInMemoryPlan(plan, rebuilt);
      return { operation: 'add_after', success: true, nodeId: op.spec.producerId };
    }

    default:
      return { operation: (op as any).type ?? 'unknown', success: false, error: `Operation '${(op as any).type}' not supported for scaffolding plans. Supported: add_node, remove_node, update_deps, add_before, add_after.` };
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
