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
import { validateAgentPlugins } from '../../validation';
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
    producer_id: string;
    name?: string;
    task: string;
    work?: any;
    dependencies: string[];
    prechecks?: any;
    postchecks?: any;
    instructions?: string;
    expects_no_changes?: boolean;
  };
}

interface RemoveNodeOp {
  type: 'remove_node';
  nodeId?: string;
  producer_id?: string;
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
    producerId: raw.producer_id,
    name: raw.name,
    task: raw.task,
    work: raw.work,
    dependencies: raw.dependencies ?? [],
    prechecks: raw.prechecks,
    postchecks: raw.postchecks,
    instructions: raw.instructions,
    expectsNoChanges: raw.expects_no_changes,
  };
}

/** Resolve a nodeId from either nodeId or producer_id on the plan. */
function resolveNodeId(
  plan: import('../../../plan/types').PlanInstance,
  nodeId?: string,
  producerId?: string,
): string | undefined {
  if (nodeId) {
    if (plan.nodes.has(nodeId)) { return nodeId; }
    // Maybe it's actually a producer_id
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
  const node = plan.nodes.get(nodeId);
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

  // Validate agent plugins in any add_node operations
  if (ctx.spawner && ctx.env && ctx.configProvider) {
    const pluginValidation = await validateAgentPlugins(args, ctx.spawner, ctx.env, ctx.configProvider, ctx.workspacePath);
    if (!pluginValidation.valid) {
      return { success: false, error: pluginValidation.error };
    }
  }

  const results: Array<{ operation: string; success: boolean; nodeId?: string; error?: string }> = [];

  for (const op of args.operations as ReshapeOperation[]) {
    switch (op.type) {
      case 'add_node': {
        if (!op.spec) {
          results.push({ operation: 'add_node', success: false, error: 'spec is required' });
          break;
        }
        const res = addNode(plan, toJobNodeSpec(op.spec));
        results.push({ operation: 'add_node', success: res.success, nodeId: res.nodeId, error: res.error });
        break;
      }

      case 'remove_node': {
        const id = resolveNodeId(plan, op.nodeId, op.producer_id);
        if (!id) {
          results.push({ operation: 'remove_node', success: false, error: `Node not found: ${op.nodeId ?? op.producer_id}` });
          break;
        }
        if (isSnapshotValidationNode(plan, id)) {
          results.push({ operation: 'remove_node', success: false, error: 'The Snapshot Validation node is auto-managed and cannot be removed. It updates automatically when plan topology changes.' });
          break;
        }
        const res = removeNode(plan, id);
        results.push({ operation: 'remove_node', success: res.success, error: res.error });
        break;
      }

      case 'update_deps': {
        if (!op.nodeId || !Array.isArray(op.dependencies)) {
          results.push({ operation: 'update_deps', success: false, error: 'nodeId and dependencies array are required' });
          break;
        }
        const id = resolveNodeId(plan, op.nodeId);
        if (!id) {
          results.push({ operation: 'update_deps', success: false, error: `Node not found: ${op.nodeId}` });
          break;
        }
        if (isSnapshotValidationNode(plan, id)) {
          results.push({ operation: 'update_deps', success: false, error: 'The Snapshot Validation node\'s dependencies are auto-managed and cannot be updated directly. They sync automatically when plan topology changes.' });
          break;
        }
        // Resolve dependency producer_ids to node IDs
        const resolvedDeps: string[] = [];
        let depError: string | undefined;
        for (const dep of op.dependencies) {
          const depId = resolveNodeId(plan, dep);
          if (!depId) { depError = `Dependency not found: ${dep}`; break; }
          resolvedDeps.push(depId);
        }
        if (depError) {
          results.push({ operation: 'update_deps', success: false, error: depError });
          break;
        }
        const res = updateNodeDependencies(plan, id, resolvedDeps);
        results.push({ operation: 'update_deps', success: res.success, error: res.error });
        break;
      }

      case 'add_before': {
        if (!op.existingNodeId || !op.spec) {
          results.push({ operation: 'add_before', success: false, error: 'existingNodeId and spec are required' });
          break;
        }
        const id = resolveNodeId(plan, op.existingNodeId);
        if (!id) {
          results.push({ operation: 'add_before', success: false, error: `Node not found: ${op.existingNodeId}` });
          break;
        }
        const res = addNodeBefore(plan, id, toJobNodeSpec(op.spec));
        results.push({ operation: 'add_before', success: res.success, nodeId: res.nodeId, error: res.error });
        break;
      }

      case 'add_after': {
        if (!op.existingNodeId || !op.spec) {
          results.push({ operation: 'add_after', success: false, error: 'existingNodeId and spec are required' });
          break;
        }
        const id = resolveNodeId(plan, op.existingNodeId);
        if (!id) {
          results.push({ operation: 'add_after', success: false, error: `Node not found: ${op.existingNodeId}` });
          break;
        }
        const res = addNodeAfter(plan, id, toJobNodeSpec(op.spec));
        results.push({ operation: 'add_after', success: res.success, nodeId: res.nodeId, error: res.error });
        break;
      }

      default:
        results.push({ operation: (op as any).type ?? 'unknown', success: false, error: `Unknown operation type: ${(op as any).type}` });
    }
  }

  // Persist changes and notify UI
  ctx.PlanRunner.savePlan(args.planId);
  ctx.PlanRunner.emit('planUpdated', args.planId);

  // Build topology summary
  const nodes: Array<{ id: string; producerId?: string; name: string; dependencies: string[]; dependents: string[] }> = [];
  for (const [, node] of plan.nodes) {
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
      nodeCount: plan.nodes.size,
      roots: plan.roots,
      leaves: plan.leaves,
      nodes,
    },
  };
}
