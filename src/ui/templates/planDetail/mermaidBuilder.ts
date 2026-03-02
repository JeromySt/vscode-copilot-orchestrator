/**
 * @fileoverview Mermaid diagram builder for Plan visualization.
 *
 * Pure data transformation function that generates Mermaid flowchart syntax
 * from a PlanInstance. Extracted from planDetailPanel for testability.
 *
 * @module ui/templates/planDetail/mermaidBuilder
 */

import type { PlanInstance, PlanNode, JobNode } from '../../../plan/types';
import { formatDurationMs, escapeHtml } from '../helpers';

/**
 * Result of Mermaid diagram generation
 */
export interface MermaidDiagramResult {
  /** Complete Mermaid flowchart syntax */
  diagram: string;
  /** Map of sanitized node IDs to full names (for tooltips when truncated) */
  nodeTooltips: Record<string, string>;
  /** Edge metadata for client-side incremental coloring */
  edgeData: Array<{ index: number; from: string; to: string; isLeafToTarget?: boolean }>;
}

/**
 * Build a Mermaid flowchart diagram from a PlanInstance.
 *
 * Generates a visual representation of the plan's DAG structure with:
 * - Branch nodes (base, target source, target dest)
 * - Job nodes with status indicators
 * - Dependencies as edges
 * - Groups as nested subgraphs
 * - Status-based styling
 *
 * @param plan - The plan instance to visualize
 * @returns Mermaid diagram string and metadata for tooltips/edge coloring
 */
export function buildMermaidDiagram(plan: PlanInstance): MermaidDiagramResult {
  const lines: string[] = ['flowchart LR'];
  
  // Maximum total character width for a node label (icon + name + duration).
  // Labels exceeding this are truncated with '...' and a hover tooltip.
  const MAX_NODE_LABEL_CHARS = 45;
  
  // Track full names for tooltip display when labels are truncated
  const nodeTooltips: Record<string, string> = {};
  
  // Check if this is a scaffolding plan
  const isScaffolding = (plan.spec as any).status === 'scaffolding';
  
  // Get branch names
  const baseBranchName = plan.baseBranch || 'main';
  const targetBranchName = plan.targetBranch || baseBranchName;
  const showBaseBranch = baseBranchName !== targetBranchName;
  const showTargetBranch = !!plan.targetBranch;
  
  // Add style definitions
  lines.push('  classDef pending fill:#3c3c3c,stroke:#858585');
  lines.push('  classDef ready fill:#2d4a6e,stroke:#3794ff');
  lines.push('  classDef running fill:#2d4a6e,stroke:#3794ff,stroke-width:2px');
  lines.push('  classDef succeeded fill:#1e4d40,stroke:#4ec9b0');
  lines.push('  classDef failed fill:#4d2929,stroke:#f48771');
  lines.push('  classDef blocked fill:#3c3c3c,stroke:#858585,stroke-dasharray:5');
  lines.push('  classDef draft fill:#2d3748,stroke:#4a5568,stroke-dasharray:5,opacity:0.8');
  lines.push('  classDef branchNode fill:#0e639c,stroke:#0e639c,color:#ffffff');
  lines.push('  classDef baseBranchNode fill:#6e6e6e,stroke:#888888,color:#ffffff');
  lines.push('');
  
  // Track edge indices for linkStyle
  let edgeIndex = 0;
  const successEdges: number[] = [];
  const failedEdges: number[] = [];
  // Edge data for client-side incremental edge coloring
  const edgeData: Array<{ index: number; from: string; to: string; isLeafToTarget?: boolean }> = [];
  
  // Truncate branch names for display (they can be very long)
  const truncBranch = (name: string, maxLen: number) => {
    if (name.length <= maxLen) {return name;}
    // Show the last segment after / for readability
    const lastSlash = name.lastIndexOf('/');
    if (lastSlash > 0 && name.length - lastSlash < maxLen) {
      return '...' + name.substring(lastSlash);
    }
    return name.substring(0, maxLen - 3) + '...';
  };
  
  // Add base branch node if different from target
  if (showBaseBranch) {
    const truncBase = truncBranch(baseBranchName, MAX_NODE_LABEL_CHARS);
    lines.push(`  BASE_BRANCH["🔀 ${escapeForMermaid(truncBase)}"]`);
    lines.push('  class BASE_BRANCH baseBranchNode');
    if (truncBase !== baseBranchName) {nodeTooltips['BASE_BRANCH'] = baseBranchName;}
  }
  
  // Add source target branch node
  if (showTargetBranch) {
    const truncTarget = truncBranch(targetBranchName, MAX_NODE_LABEL_CHARS);
    lines.push(`  TARGET_SOURCE["📍 ${escapeForMermaid(truncTarget)}"]`);
    lines.push('  class TARGET_SOURCE branchNode');
    if (truncTarget !== targetBranchName) {nodeTooltips['TARGET_SOURCE'] = targetBranchName;}
    
    if (showBaseBranch) {
      lines.push('  BASE_BRANCH --> TARGET_SOURCE');
      successEdges.push(edgeIndex++);
    }
  }
  
  lines.push('');
  
  // Track node entry/exit points for edge connections
  const nodeEntryExitMap = new Map<string, { entryIds: string[], exitIds: string[] }>();
  
  // Track leaf node states for mergedToTarget status
  const leafnodeStates = new Map<string, any>();
  
  // Counter for unique group subgraph IDs
  let groupSubgraphCounter = 0;
  
  // Track all edges to add at the end
  const edgesToAdd: Array<{ from: string; to: string; status?: string }> = [];
  
  // Helper function to render a single job node
  const renderJobNode = (
    node: JobNode,
    nodeId: string,
    d: PlanInstance,
    prefix: string,
    indent: string,
    nodeHasDependents: Set<string>,
    localRoots: string[],
    localLeaves: string[]
  ) => {
    const state = d.nodeStates.get(nodeId);
    const status = state?.status || 'pending';
    const sanitizedId = prefix + sanitizeId(nodeId);
    
    const isRoot = node.dependencies.length === 0;
    const isLeaf = !nodeHasDependents.has(nodeId);
    
    const label = escapeForMermaid(node.name);
    const icon = getStatusIcon(status);
    
    // Calculate duration for completed or running nodes.
    // ALL nodes get rendered with ' | 00h 00s ' sizing template so Mermaid
    // allocates consistent rect widths. Client-side strips the suffix from
    // non-started nodes after render.
    const DURATION_TEMPLATE = ' | 00h 00s '; // fixed-width sizing template (hours format with trailing space)
    let durationLabel = DURATION_TEMPLATE;
    if (!isScaffolding && state?.startedAt) {
      const endTime = state.endedAt || Date.now();
      const duration = endTime - state.startedAt;
      durationLabel = ' | ' + formatDurationMs(duration);
    }
    
    // Truncate long node labels using the sizing template width.
    const displayLabel = truncateLabel(label, DURATION_TEMPLATE, MAX_NODE_LABEL_CHARS);
    if (displayLabel !== label) {
      nodeTooltips[sanitizedId] = node.name;
    }
    
    lines.push(`${indent}${sanitizedId}["${icon} ${displayLabel}${durationLabel}"]`);
    lines.push(`${indent}class ${sanitizedId} ${isScaffolding ? 'draft' : status}`);
    
    nodeEntryExitMap.set(sanitizedId, { entryIds: [sanitizedId], exitIds: [sanitizedId] });
    
    if (isRoot) {localRoots.push(sanitizedId);}
    if (isLeaf) {
      localLeaves.push(sanitizedId);
      leafnodeStates.set(sanitizedId, state);
    }
    
    // Add edges from dependencies
    for (const depId of node.dependencies) {
      const depSanitizedId = prefix + sanitizeId(depId);
      edgesToAdd.push({ from: depSanitizedId, to: sanitizedId, status: d.nodeStates.get(depId)?.status });
    }
  };
  
  // Recursive function to render Plan structure
  const renderPlanInstance = (d: PlanInstance, prefix: string, depth: number): { roots: string[], leaves: string[] } => {
    const indent = '  '.repeat(depth + 1);
    const localRoots: string[] = [];
    const localLeaves: string[] = [];
    
    // First pass: determine which nodes are roots and leaves in this Plan
    const nodeHasDependents = new Set<string>();
    for (const [nodeId, node] of d.jobs) {
      for (const depId of node.dependencies) {
        nodeHasDependents.add(depId);
      }
    }
    
    // Organize nodes by group tag
    const groupedNodes = new Map<string, { nodeId: string; node: PlanNode }[]>();
    const ungroupedNodes: { nodeId: string; node: PlanNode }[] = [];
    
    for (const [nodeId, node] of d.jobs) {
      const groupTag = node.group;
      if (groupTag) {
        if (!groupedNodes.has(groupTag)) {
          groupedNodes.set(groupTag, []);
        }
        groupedNodes.get(groupTag)!.push({ nodeId, node });
      } else {
        ungroupedNodes.push({ nodeId, node });
      }
    }
    
    // Build a tree structure from group paths
    interface GroupTreeNode {
      name: string;
      children: Map<string, GroupTreeNode>;
      nodes: { nodeId: string; node: PlanNode }[];
    }
    
    const groupTree: GroupTreeNode = { name: '', children: new Map(), nodes: [] };
    
    for (const [groupPath, nodes] of groupedNodes) {
      const parts = groupPath.split('/');
      let current = groupTree;
      
      for (const part of parts) {
        if (!current.children.has(part)) {
          current.children.set(part, { name: part, children: new Map(), nodes: [] });
        }
        current = current.children.get(part)!;
      }
      
      // Nodes belong to the leaf group
      current.nodes = nodes;
    }
    
    // Pre-compute rendered label width for each node (icon + name + duration)
    // so that group labels can be truncated to the widest descendant node.
    const nodeLabelWidths = new Map<string, number>();
    for (const [nodeId, node] of d.jobs) {
      const escapedName = escapeForMermaid(node.name);
      const st = d.nodeStates.get(nodeId);
      let dur = ' | --';
      if (st?.startedAt) {
        const endTime = st.endedAt || Date.now();
        dur = ' | ' + formatDurationMs(endTime - st.startedAt);
      }
      // Total = icon(2) + name + duration (matches the formula in truncateLabel)
      // Cap to MAX_NODE_LABEL_CHARS so group widths reflect truncated nodes.
      const rawWidth = 2 + escapedName.length + dur.length;
      nodeLabelWidths.set(nodeId, Math.min(rawWidth, MAX_NODE_LABEL_CHARS));
    }

    // Recursively compute the max descendant-node label width for each group
    const computeMaxGroupWidth = (treeNode: GroupTreeNode): number => {
      let maxW = 0;
      for (const { nodeId } of treeNode.nodes) {
        const w = nodeLabelWidths.get(nodeId) || 0;
        if (w > maxW) {maxW = w;}
      }
      for (const child of treeNode.children.values()) {
        const w = computeMaxGroupWidth(child);
        if (w > maxW) {maxW = w;}
      }
      return maxW;
    };

    const groupMaxWidths = new Map<string, number>();
    const precomputeGroupWidths = (treeNode: GroupTreeNode, path: string) => {
      groupMaxWidths.set(path, computeMaxGroupWidth(treeNode));
      for (const [childName, child] of treeNode.children) {
        const childPath = path ? `${path}/${childName}` : childName;
        precomputeGroupWidths(child, childPath);
      }
    };
    for (const [name, child] of groupTree.children) {
      precomputeGroupWidths(child, name);
    }

    // Recursively render group tree as nested subgraphs
    const renderGroupTree = (
      treeNode: GroupTreeNode,
      groupPath: string,
      currentIndent: string
    ): void => {
      // Look up the group UUID from the path
      const groupUuid = d.groupPathToId.get(groupPath);
      const groupState = groupUuid ? d.groupStates.get(groupUuid) : undefined;
      const groupStatus = groupState?.status || 'pending';
      
      // Use sanitized group UUID as the subgraph ID (same pattern as nodes)
      const sanitizedGroupId = groupUuid ? sanitizeId(groupUuid) : `grp${groupSubgraphCounter++}`;
      
      // Get icon for group status (same as nodes)
      const icon = getStatusIcon(groupStatus);
      
      // Calculate duration for groups
      // Always include a duration placeholder to maintain consistent sizing
      const GROUP_DURATION_TEMPLATE = ' | 00h 00s ';
      let groupDurationLabel = GROUP_DURATION_TEMPLATE;
      if (groupState?.startedAt) {
        const endTime = groupState.endedAt || Date.now();
        const duration = endTime - groupState.startedAt;
        groupDurationLabel = ' | ' + formatDurationMs(duration);
      }
      
      // Status-specific styling for groups (same colors as nodes)
      const groupColors: Record<string, { fill: string; stroke: string }> = {
        pending: { fill: '#1a1a2e', stroke: '#6a6a8a' },
        ready: { fill: '#1a2a4e', stroke: '#3794ff' },
        running: { fill: '#1a2a4e', stroke: '#3794ff' },
        succeeded: { fill: '#1a3a2e', stroke: '#4ec9b0' },
        failed: { fill: '#3a1a1e', stroke: '#f48771' },
        blocked: { fill: '#3a1a1e', stroke: '#f48771' },
        canceled: { fill: '#1a1a2e', stroke: '#6a6a8a' },
      };
      const colors = groupColors[groupStatus] || groupColors.pending;
      
      // Truncate group names based on the widest descendant node's rendered
      // label width, so the group title never overflows its content box.
      // However, ensure group names are never truncated below their natural
      // length — mermaid subgraphs expand to fit their title.
      const displayName = treeNode.name;
      const escapedName = escapeForMermaid(displayName);
      const maxWidth = groupMaxWidths.get(groupPath) || 0;
      const groupNameTotal = 3 + escapedName.length + GROUP_DURATION_TEMPLATE.length; // ICON_WIDTH + name + duration
      const effectiveMaxWidth = Math.max(maxWidth, groupNameTotal);
      const truncatedGroupName = effectiveMaxWidth > 0
        ? truncateLabel(escapedName, GROUP_DURATION_TEMPLATE, effectiveMaxWidth)
        : escapedName;
      // Show full path in tooltip for nested groups or when truncated
      if (truncatedGroupName !== escapedName || groupPath.includes('/')) {
        nodeTooltips[sanitizedGroupId] = groupPath.includes('/') ? groupPath : displayName;
      }
      const emSp = '\u2003'; // em space — proportional-font-safe padding
      const padding = ''; // no extra padding — sizing template handles width
      
      lines.push(`${currentIndent}subgraph ${sanitizedGroupId}["${icon} ${truncatedGroupName}${groupDurationLabel}${padding}"]`);
      
      const childIndent = currentIndent + '  ';
      
      // Render child groups first (nested subgraphs)
      for (const childGroup of treeNode.children.values()) {
        const childPath = groupPath ? `${groupPath}/${childGroup.name}` : childGroup.name;
        renderGroupTree(childGroup, childPath, childIndent);
      }
      
      // Render nodes directly in this group
      for (const { nodeId, node } of treeNode.nodes) {
        renderJobNode(node as JobNode, nodeId, d, prefix, childIndent, nodeHasDependents, localRoots, localLeaves);
      }
      
      lines.push(`${currentIndent}end`);
      lines.push(`${currentIndent}style ${sanitizedGroupId} fill:${colors.fill},stroke:${colors.stroke},stroke-width:2px,stroke-dasharray:5`);
    };
    
    // Render ungrouped nodes first
    for (const { nodeId, node } of ungroupedNodes) {
      renderJobNode(node as JobNode, nodeId, d, prefix, indent, nodeHasDependents, localRoots, localLeaves);
    }
    
    // Render group tree (top-level groups)
    for (const topGroup of groupTree.children.values()) {
      renderGroupTree(topGroup, topGroup.name, indent);
    }
    
    return { roots: localRoots, leaves: localLeaves };
  };
  
  // Render the main Plan
  const mainResult = renderPlanInstance(plan, '', 0);
  
  lines.push('');
  
  // Add edges from target branch to root nodes
  if (showTargetBranch) {
    for (const rootId of mainResult.roots) {
      const mapping = nodeEntryExitMap.get(rootId);
      const entryIds = mapping ? mapping.entryIds : [rootId];
      for (const entryId of entryIds) {
        const edgeStyle = isScaffolding ? '-.->' : '-->';
        lines.push(`  TARGET_SOURCE ${edgeStyle} ${entryId}`);
        edgeData.push({ index: edgeIndex, from: 'TARGET_SOURCE', to: entryId });
        successEdges.push(edgeIndex++);
      }
    }
  }
  
  // Add all collected edges
  for (const edge of edgesToAdd) {
    const fromMapping = nodeEntryExitMap.get(edge.from);
    const toMapping = nodeEntryExitMap.get(edge.to);
    
    const fromExits = fromMapping ? fromMapping.exitIds : [edge.from];
    const toEntries = toMapping ? toMapping.entryIds : [edge.to];
    
    for (const exit of fromExits) {
      for (const entry of toEntries) {
        // Dashed edge while source is pending/ready; solid once scheduled+
        // For scaffolding plans, all edges are dashed
        const edgeStyle = isScaffolding || (!edge.status || edge.status === 'pending' || edge.status === 'ready') ? '-.->' : '-->';
        lines.push(`  ${exit} ${edgeStyle} ${entry}`);
        edgeData.push({ index: edgeIndex, from: exit, to: entry });
        if (edge.status === 'succeeded') {
          successEdges.push(edgeIndex);
        } else if (edge.status === 'failed') {
          failedEdges.push(edgeIndex);
        }
        edgeIndex++;
      }
    }
  }
  
  // Add edges to target branch from leaf nodes
  if (showTargetBranch) {
    lines.push('');
    lines.push(`  TARGET_DEST["🎯 ${escapeForMermaid(truncBranch(targetBranchName, MAX_NODE_LABEL_CHARS))}"]`);
    lines.push('  class TARGET_DEST branchNode');
    if (targetBranchName.length > MAX_NODE_LABEL_CHARS) {nodeTooltips['TARGET_DEST'] = targetBranchName;}

    // The snapshot-validation JobNode is a real node in the plan and renders
    // naturally through the standard node loop above. Connect its exit to
    // TARGET_DEST so the diagram shows the merge-ri → targetBranch flow.
    const svNodeId = plan.producerIdToNodeId.get('__snapshot-validation__');
    if (svNodeId) {
      const svSanitizedId = sanitizeId(svNodeId);
      const mapping = nodeEntryExitMap.get(svSanitizedId);
      const exitIds = mapping ? mapping.exitIds : [svSanitizedId];
      const svState = leafnodeStates.get(svSanitizedId);
      const svSucceeded = svState?.status === 'succeeded';
      for (const exitId of exitIds) {
        if (isScaffolding) {
          lines.push(`  ${exitId} -.-> TARGET_DEST`);
        } else if (svSucceeded) {
          lines.push(`  ${exitId} --> TARGET_DEST`);
          successEdges.push(edgeIndex);
        } else {
          lines.push(`  ${exitId} -.-> TARGET_DEST`);
        }
        edgeData.push({ index: edgeIndex, from: exitId, to: 'TARGET_DEST' });
        edgeIndex++;
      }
    } else {
      // Legacy plans without snapshot-validation: connect leaf nodes directly
      // to TARGET_DEST based on their merge-ri / succeeded status.
      for (const leafId of mainResult.leaves) {
        const mapping = nodeEntryExitMap.get(leafId);
        const exitIds = mapping ? mapping.exitIds : [leafId];
        for (const exitId of exitIds) {
          const leafState = leafnodeStates.get(exitId);
          const isMerged = leafState?.mergedToTarget === true
            || leafState?.status === 'succeeded';
          if (isScaffolding) {
            lines.push(`  ${exitId} -.-> TARGET_DEST`);
          } else if (isMerged) {
            lines.push(`  ${exitId} --> TARGET_DEST`);
            successEdges.push(edgeIndex);
          } else {
            lines.push(`  ${exitId} -.-> TARGET_DEST`);
          }
          edgeData.push({ index: edgeIndex, from: exitId, to: 'TARGET_DEST' });
          edgeIndex++;
        }
      }
    }
  }
  
  // Add linkStyle for colored edges
  if (successEdges.length > 0) {
    lines.push(`  linkStyle ${successEdges.join(',')} stroke:#4ec9b0,stroke-width:2px`);
  }
  if (failedEdges.length > 0) {
    lines.push(`  linkStyle ${failedEdges.join(',')} stroke:#f48771,stroke-width:2px`);
  }
  
  return { diagram: lines.join('\n'), nodeTooltips, edgeData };
}

// ============================================================================
// Private Helper Functions
// ============================================================================

/**
 * Convert a node ID (UUID) to a Mermaid-safe identifier.
 * Simply prefixes with 'n' and strips hyphens from UUID.
 * 
 * @param id - The raw node ID (UUID like "abc12345-6789-...").
 * @returns Mermaid-safe ID like "nabc123456789..."
 */
function sanitizeId(id: string): string {
  // UUIDs have hyphens; just remove them and prefix with 'n'
  return 'n' + id.replace(/-/g, '');
}

/**
 * Escape a string for safe inclusion in a Mermaid node label.
 *
 * @param str - The raw label text.
 * @returns The escaped string with Mermaid-special characters removed or replaced.
 */
function escapeForMermaid(str: string): string {
  return str
    .replace(/"/g, "'")
    .replace(/[<>{}|:#]/g, '')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')');
}

/**
 * Truncate a label name so that the combined label (icon + name + duration)
 * stays within the given `maxLen` characters. When truncation occurs the
 * name is trimmed and an ellipsis ('...') is appended.
 *
 * @param name - The escaped display name.
 * @param durationLabel - The duration suffix (e.g., ' | 2m 34s'), may be empty.
 * @param maxLen - Maximum total character count (icon(2) + name + duration).
 * @returns The (possibly truncated) name.
 */
function truncateLabel(name: string, durationLabel: string, maxLen: number): string {
  // +3 accounts for the status icon + space prefix ("✓ " renders ~3 chars wide
  // in proportional fonts due to Unicode symbol width)
  const ICON_WIDTH = 3;
  const totalLen = ICON_WIDTH + name.length + durationLabel.length;
  if (totalLen <= maxLen) {
    return name;
  }
  // Reserve space for icon, duration, and ellipsis
  const available = maxLen - ICON_WIDTH - durationLabel.length - 3; // 3 = '...'
  if (available <= 0) {
    return name; // duration alone exceeds limit – don't truncate name to nothing
  }
  return name.slice(0, available).trimEnd() + '...';
}

/**
 * Map a node status string to a single-character icon.
 *
 * @param status - The node status (e.g., `'succeeded'`, `'failed'`, `'running'`).
 * @returns A Unicode status icon character.
 */
function getStatusIcon(status: string): string {
  switch (status) {
    case 'succeeded': return '✓';
    case 'failed': return '✗';
    case 'running': return '▶';
    case 'blocked': return '⊘';
    default: return '○';
  }
}
