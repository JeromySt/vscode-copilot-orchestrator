/**
 * @fileoverview Plan Graph MCP Tool Handler
 *
 * Returns a Mermaid dependency graph and per-node dependency info
 * for a plan, enabling agents to verify the DAG structure.
 *
 * @module mcp/handlers/plan/graphPlanHandler
 */

import type { PlanHandlerContext } from '../utils';
import { errorResult, validateRequired } from '../utils';
import type { JobNode } from '../../../plan/types';

/**
 * Handle get_copilot_plan_graph MCP tool call.
 *
 * Returns a Mermaid flowchart of the plan's dependency graph plus
 * a structured adjacency list showing, for each node, its direct
 * dependencies and which nodes depend on it.
 */
export async function handleGetPlanGraph(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId']);
  if (fieldError) return fieldError;

  const status = ctx.PlanRunner.getStatus(args.planId);
  if (!status) {
    return errorResult(`Plan not found: ${args.planId}`);
  }

  const { plan } = status;

  // Build Mermaid diagram
  const lines: string[] = ['flowchart LR'];
  const adjacency: Array<{
    producerId: string;
    name: string;
    status: string;
    group?: string;
    dependsOn: string[];
    dependedOnBy: string[];
  }> = [];

  // Map nodeId → producerId for readable output
  const nodeIdToProducer = new Map<string, string>();
  for (const [nodeId, node] of plan.jobs) {
    nodeIdToProducer.set(nodeId, node.producerId);
  }

  // Collect groups for subgraph rendering
  const groupNodes = new Map<string, string[]>();

  for (const [nodeId, node] of plan.jobs) {
    if (node.type !== 'job') continue;
    const job = node as JobNode;
    const state = plan.nodeStates.get(nodeId);
    const statusStr = state?.status || 'pending';

    // Build Mermaid node
    const sanitizedId = node.producerId.replace(/[^a-zA-Z0-9-]/g, '_');
    const label = `${node.name || node.producerId}`;
    const statusIcon = statusStr === 'succeeded' ? '✅' :
                       statusStr === 'failed' ? '❌' :
                       statusStr === 'running' ? '🔄' :
                       statusStr === 'blocked' ? '🚫' :
                       statusStr === 'canceled' ? '⏹️' :
                       statusStr === 'ready' ? '🟡' : '⏳';

    // Track groups
    if (job.group) {
      if (!groupNodes.has(job.group)) groupNodes.set(job.group, []);
      groupNodes.get(job.group)!.push(sanitizedId);
    }

    // Node definition
    lines.push(`  ${sanitizedId}["${statusIcon} ${label}"]`);

    // Edges
    for (const depId of node.dependencies) {
      const depProducer = nodeIdToProducer.get(depId);
      if (depProducer) {
        const depSanitized = depProducer.replace(/[^a-zA-Z0-9-]/g, '_');
        lines.push(`  ${depSanitized} --> ${sanitizedId}`);
      }
    }

    // Adjacency entry
    adjacency.push({
      producerId: node.producerId,
      name: node.name,
      status: statusStr,
      group: job.group,
      dependsOn: node.dependencies.map(d => nodeIdToProducer.get(d) || d),
      dependedOnBy: node.dependents.map(d => nodeIdToProducer.get(d) || d),
    });
  }

  // Add group subgraphs
  for (const [groupName, nodes] of groupNodes) {
    const sanitizedGroup = groupName.replace(/[^a-zA-Z0-9-]/g, '_');
    // Insert subgraph lines after the flowchart declaration
    lines.splice(1, 0,
      `  subgraph ${sanitizedGroup}["${groupName}"]`,
      ...nodes.map(n => `    ${n}`),
      `  end`
    );
  }

  // Style classes
  lines.push('  classDef succeeded fill:#2ea04370,stroke:#2ea043');
  lines.push('  classDef failed fill:#f8514970,stroke:#f85149');
  lines.push('  classDef running fill:#58a6ff70,stroke:#58a6ff');
  lines.push('  classDef pending fill:#48484870,stroke:#484848');

  // Apply styles
  for (const [nodeId, node] of plan.jobs) {
    const state = plan.nodeStates.get(nodeId);
    const cls = state?.status || 'pending';
    if (['succeeded', 'failed', 'running'].includes(cls)) {
      const sanitizedId = node.producerId.replace(/[^a-zA-Z0-9-]/g, '_');
      lines.push(`  class ${sanitizedId} ${cls}`);
    }
  }

  const mermaid = lines.join('\n');

  return {
    success: true,
    planId: plan.id,
    name: plan.spec.name,
    nodeCount: adjacency.length,
    mermaid,
    nodes: adjacency,
  };
}
