/**
 * @fileoverview Plan Builder
 * 
 * Builds an immutable Plan topology from a PlanSpec.
 * Handles:
 * - Assigning UUIDs to nodes
 * - Resolving producerId references to node IDs
 * - Computing dependents (reverse edges)
 * - Identifying roots and leaves
 * - Validating the Plan (no cycles, valid references)
 * 
 * @module plan/builder
 */

import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  PlanSpec,
  PlanInstance,
  PlanNode,
  JobNode,
  JobNodeSpec,
  NodeExecutionState,
  GroupSpec,
  GroupInstance,
  GroupExecutionState,
} from './types';

/**
 * Validation error thrown when a {@link PlanSpec} is invalid.
 *
 * @example
 * ```typescript
 * try {
 *   buildPlan(spec);
 * } catch (e) {
 *   if (e instanceof PlanValidationError) {
 *     console.error(e.details); // ['Duplicate producerId: "a"', ...]
 *   }
 * }
 * ```
 */
export class PlanValidationError extends Error {
  /**
   * @param message - Summary error message.
   * @param details - Individual validation errors (one per issue).
   */
  constructor(message: string, public details?: string[]) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

/**
 * Build a {@link PlanInstance} from a {@link PlanSpec}.
 *
 * Performs three passes:
 * 1. Creates nodes and maps `producerId` → `nodeId`.
 * 2. Resolves dependency references from producer IDs to node UUIDs.
 * 3. Computes reverse edges (dependents), identifies roots/leaves, and
 *    validates the DAG for cycles.
 *
 * Root nodes (no dependencies) start in `'ready'` status; all others start
 * as `'pending'`.
 *
 * @param spec    - The plan specification describing jobs and sub-plans.
 * @param options - Optional overrides for parent plan context, repo path, or worktree root.
 * @returns A fully constructed, validated plan instance.
 * @throws {PlanValidationError} If the spec contains duplicate IDs, unknown references,
 *         cycles, or has no nodes.
 *
 * @example
 * ```typescript
 * const plan = buildPlan({
 *   name: 'My Plan',
 *   baseBranch: 'main',
 *   jobs: [
 *     { producerId: 'a', task: 'Build', dependencies: [] },
 *     { producerId: 'b', task: 'Test', dependencies: ['a'] },
 *   ],
 * });
 * ```
 */
export function buildPlan(
  spec: PlanSpec,
  options: {
    parentPlanId?: string;
    parentNodeId?: string;
    repoPath?: string;
    worktreeRoot?: string;
  } = {}
): PlanInstance {
  const planId = uuidv4();
  const errors: string[] = [];
  
  // Maps for building the Plan
  const nodes = new Map<string, PlanNode>();
  const producerIdToNodeId = new Map<string, string>();
  
  // Maps for building groups
  const groups = new Map<string, GroupInstance>();
  const groupStates = new Map<string, GroupExecutionState>();
  const groupPathToId = new Map<string, string>();
  
  // Helper: recursively build groups from spec
  function buildGroups(
    groupSpecs: GroupSpec[] | undefined,
    parentPath: string,
    parentGroupId: string | undefined
  ): void {
    if (!groupSpecs) {return;}
    
    for (const groupSpec of groupSpecs) {
      const groupId = uuidv4();
      const groupPath = parentPath ? `${parentPath}/${groupSpec.name}` : groupSpec.name;
      
      const group: GroupInstance = {
        id: groupId,
        name: groupSpec.name,
        path: groupPath,
        parentGroupId,
        childGroupIds: [],
        nodeIds: [],
        allNodeIds: [],
        totalNodes: 0,
      };
      
      groups.set(groupId, group);
      groupPathToId.set(groupPath, groupId);
      
      // Link to parent
      if (parentGroupId) {
        const parent = groups.get(parentGroupId);
        if (parent) {
          parent.childGroupIds.push(groupId);
        }
      }
      
      // Initialize group state
      groupStates.set(groupId, {
        status: 'pending',
        version: 0,
        runningCount: 0,
        succeededCount: 0,
        failedCount: 0,
        blockedCount: 0,
        canceledCount: 0,
      });
      
      // Recurse into nested groups
      buildGroups(groupSpec.groups, groupPath, groupId);
    }
  }
  
  // Build groups from spec
  buildGroups(spec.groups, '', undefined);
  
  // First pass: Create all nodes and build producerId map
  for (const jobSpec of spec.jobs) {
    if (!jobSpec.producerId) {
      errors.push(`Job is missing required 'producerId' field`);
      continue;
    }
    
    if (producerIdToNodeId.has(jobSpec.producerId)) {
      errors.push(`Duplicate producerId: '${jobSpec.producerId}'`);
      continue;
    }
    
    const nodeId = uuidv4();
    
    // Resolve group path to group ID, auto-creating hierarchy if needed
    let resolvedGroupId: string | undefined;
    if (jobSpec.group) {
      resolvedGroupId = groupPathToId.get(jobSpec.group);
      
      // If no exact match, auto-create the full group hierarchy
      if (!resolvedGroupId) {
        const parts = jobSpec.group.split('/');
        let currentPath = '';
        let parentGroupId: string | undefined;
        
        for (const part of parts) {
          currentPath = currentPath ? `${currentPath}/${part}` : part;
          
          let existingGroupId = groupPathToId.get(currentPath);
          if (!existingGroupId) {
            // Create this group in the hierarchy
            const newGroupId = uuidv4();
            const newGroup: GroupInstance = {
              id: newGroupId,
              name: part,
              path: currentPath,
              parentGroupId,
              childGroupIds: [],
              nodeIds: [],
              allNodeIds: [],
              totalNodes: 0,
            };
            groups.set(newGroupId, newGroup);
            groupPathToId.set(currentPath, newGroupId);
            
            // Link to parent
            if (parentGroupId) {
              const parent = groups.get(parentGroupId);
              if (parent && !parent.childGroupIds.includes(newGroupId)) {
                parent.childGroupIds.push(newGroupId);
              }
            }
            
            // Initialize group state
            groupStates.set(newGroupId, {
              status: 'pending',
              version: 0,
              runningCount: 0,
              succeededCount: 0,
              failedCount: 0,
              blockedCount: 0,
              canceledCount: 0,
            });
            
            existingGroupId = newGroupId;
          }
          
          parentGroupId = existingGroupId;
        }
        
        resolvedGroupId = parentGroupId;
      }
    }
    
    const node: JobNode = {
      id: nodeId,
      producerId: jobSpec.producerId,
      name: jobSpec.name || jobSpec.producerId,
      type: 'job',
      task: jobSpec.task,
      work: jobSpec.work,
      prechecks: jobSpec.prechecks,
      postchecks: jobSpec.postchecks,
      instructions: jobSpec.instructions,
      baseBranch: jobSpec.baseBranch,
      expectsNoChanges: jobSpec.expectsNoChanges,
      autoHeal: jobSpec.autoHeal,
      group: jobSpec.group,
      groupId: resolvedGroupId,
      dependencies: [], // Will be resolved in second pass
      dependents: [],
    };
    
    // Add node to its group
    if (resolvedGroupId) {
      const group =groups.get(resolvedGroupId);
      if (group) {
        group.nodeIds.push(nodeId);
        group.allNodeIds.push(nodeId);
        group.totalNodes++;
        
        // Also add to all ancestor groups' allNodeIds
        let parentId = group.parentGroupId;
        while (parentId) {
          const parent = groups.get(parentId);
          if (parent) {
            parent.allNodeIds.push(nodeId);
            parent.totalNodes++;
            parentId = parent.parentGroupId;
          } else {
            break;
          }
        }
      }
    }
    
    nodes.set(nodeId, node);
    producerIdToNodeId.set(jobSpec.producerId, nodeId);
  }
  
  // Second pass: Resolve dependencies (producerId -> nodeId)
  const allSpecs = [
    ...spec.jobs.map(j => ({ producerId: j.producerId, dependencies: j.dependencies })),
  ];
  
  for (const nodeSpec of allSpecs) {
    const nodeId = producerIdToNodeId.get(nodeSpec.producerId);
    if (!nodeId) {continue;}
    
    const node = nodes.get(nodeId);
    if (!node) {continue;}
    
    const resolvedDeps: string[] = [];
    for (const depProducerId of nodeSpec.dependencies) {
      const depNodeId = producerIdToNodeId.get(depProducerId);
      if (!depNodeId) {
        errors.push(`Node '${nodeSpec.producerId}' references unknown dependency '${depProducerId}'`);
        continue;
      }
      resolvedDeps.push(depNodeId);
    }
    
    node.dependencies = resolvedDeps;
  }
  
  // Third pass: Compute dependents (reverse edges)
  for (const node of nodes.values()) {
    for (const depId of node.dependencies) {
      const depNode = nodes.get(depId);
      if (depNode) {
        depNode.dependents.push(node.id);
      }
    }
  }
  
  // Identify roots (no dependencies) and leaves (no dependents)
  const roots: string[] = [];
  let leaves: string[] = [];
  
  for (const node of nodes.values()) {
    if (node.dependencies.length === 0) {
      roots.push(node.id);
    }
    if (node.dependents.length === 0) {
      leaves.push(node.id);
    }
  }

  // ── Inject snapshot-validation node ──────────────────────────────────────
  // Every plan has a targetBranch (defaults to baseBranch). The snapshot-
  // validation node depends on all current leaves and becomes the new sole
  // leaf. It handles: merge-fi (accumulate leaves) → prechecks (target health)
  // → work (verify-ri) → postchecks (re-check target) → merge-ri (to target).
  const svNodeId = uuidv4();
  const svProducerId = '__snapshot-validation__';
  const svTargetBranch = spec.targetBranch || spec.baseBranch || 'main';
  
  // Prechecks: three-case logic for targetBranch health + snapshot rebase.
  // Runs in the snapshot worktree (HEAD = snapshot branch, shares refs with main repo).
  // The original base commit (targetBranch HEAD when snapshot was created) is written
  // to .orchestrator-snapshot-base by the runner at snapshot creation time.
  //
  // Case 1: targetBranch HEAD == snapshot base commit → success (no changes)
  // Case 2: targetBranch HEAD != snapshot base && target is clean → rebase snapshot
  //         onto new target HEAD, resolve any conflicts, complete success
  // Case 3: targetBranch HEAD != snapshot base && target is dirty → fail with
  //         user message explaining what to fix before retry
  const svPrechecks: import('./types/specs').AgentSpec = {
    type: 'agent',
    modelTier: 'fast',
    instructions: [
      `You are running in the snapshot worktree. Your job is to verify the target branch '${svTargetBranch}' is healthy and rebase the snapshot if the target has advanced.`,
      ``,
      `Step 1: Read the original snapshot base commit and the current target HEAD.`,
      `  SNAPSHOT_BASE = read the file .orchestrator-snapshot-base in the current directory`,
      `  TARGET_HEAD = run: git rev-parse "refs/heads/${svTargetBranch}"`,
      ``,
      `Step 2: Compare them.`,
      ``,
      `  Case A — TARGET_HEAD equals SNAPSHOT_BASE:`,
      `    The target branch has not changed since the snapshot was created.`,
      `    Print "✅ Target branch '${svTargetBranch}' unchanged since snapshot creation. No rebase needed."`,
      `    Exit successfully with no further action.`,
      ``,
      `  Case B — TARGET_HEAD does NOT equal SNAPSHOT_BASE:`,
      `    The target branch has advanced. Check if the target ref is clean:`,
      `    Run: git diff --quiet "refs/heads/${svTargetBranch}"`,
      ``,
      `    If the diff command FAILS (non-zero exit = dirty):`,
      `      Print "❌ Target branch '${svTargetBranch}' has uncommitted changes in the working tree."`,
      `      Print "Please commit or stash your changes on '${svTargetBranch}' before retrying."`,
      `      Exit with failure.`,
      ``,
      `    If the diff command SUCCEEDS (clean):`,
      `      The target advanced but is clean. Rebase the snapshot onto the new target HEAD:`,
      `      Run: git rebase --onto $TARGET_HEAD $SNAPSHOT_BASE HEAD`,
      ``,
      `      If the rebase succeeds cleanly:`,
      `        Update .orchestrator-snapshot-base to contain $TARGET_HEAD (the new base).`,
      `        Print "✅ Snapshot rebased onto updated '${svTargetBranch}' ($TARGET_HEAD)."`,
      `        Exit successfully.`,
      ``,
      `      If the rebase has conflicts:`,
      `        Resolve each conflict by examining both sides and producing a correct merge.`,
      `        For each conflicted file, choose the resolution that preserves both sets of changes.`,
      `        After resolving, run: git add <file> && git rebase --continue`,
      `        Repeat until rebase completes.`,
      `        Update .orchestrator-snapshot-base to contain $TARGET_HEAD (the new base).`,
      `        Print "✅ Snapshot rebased with conflict resolution onto '${svTargetBranch}'."`,
      `        Exit successfully.`,
      ``,
      `IMPORTANT: Do not modify any files except to resolve rebase conflicts and update .orchestrator-snapshot-base. Do not create commits beyond what git rebase produces.`,
    ].join('\n'),
    onFailure: {
      noAutoHeal: true,
      message: `Target branch '${svTargetBranch}' has uncommitted changes or is in a dirty state. Please clean up the target branch before retrying.`,
      resumeFromPhase: 'prechecks',
    },
  };

  // Postchecks: re-verify targetBranch hasn't moved since prechecks before merge-ri.
  // Reads .orchestrator-snapshot-base (updated by prechecks) and compares to current
  // targetBranch HEAD. If target advanced during work, fail and resume from prechecks
  // so the snapshot gets rebased again. Uses node.js for cross-platform compatibility
  // (bash not guaranteed on Windows, PowerShell can't handle bash syntax).
  const postcheckScript = [
    `const fs = require('fs');`,
    `const { execSync } = require('child_process');`,
    `try {`,
    `  const base = fs.readFileSync('.orchestrator-snapshot-base', 'utf8').trim();`,
    `  const head = execSync('git rev-parse "refs/heads/${svTargetBranch}"', { encoding: 'utf8' }).trim();`,
    `  if (head === base) {`,
    `    console.log('✅ Target branch ${svTargetBranch} unchanged since prechecks. Safe to merge.');`,
    `    process.exit(0);`,
    `  }`,
    `  try { execSync('git diff --quiet "refs/heads/${svTargetBranch}"'); } catch {`,
    `    console.error('❌ Target branch ${svTargetBranch} has uncommitted changes. Please clean up before retrying.');`,
    `    process.exit(1);`,
    `  }`,
    `  console.error('❌ Target branch ${svTargetBranch} advanced during validation (' + base.slice(0,8) + ' -> ' + head.slice(0,8) + '). Needs rebase.');`,
    `  process.exit(1);`,
    `} catch (e) {`,
    `  console.error('❌ Post-check failed: ' + e.message);`,
    `  process.exit(1);`,
    `}`,
  ].join('\n');

  const svPostchecks: import('./types/specs').ProcessSpec = {
    type: 'process',
    executable: process.execPath,
    args: ['-e', postcheckScript],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    onFailure: {
      noAutoHeal: false,
      message: `Target branch '${svTargetBranch}' changed during validation. The plan will automatically retry from prechecks to rebase the snapshot.`,
      resumeFromPhase: 'prechecks',
    },
  };
  
  // Only wrap the SV node in a group if the plan already uses groups.
  // For simple ungrouped plans, the bare node is sufficient.
  const planHasGroups = groups.size > 0;
  let svGroupId: string | undefined;
  const svGroupPath = planHasGroups ? 'Final Merge Validation' : undefined;

  if (planHasGroups) {
    // Create or reuse the "Final Merge Validation" group
    svGroupId = groupPathToId.get(svGroupPath!);
    if (!svGroupId) {
      svGroupId = uuidv4();
      groupPathToId.set(svGroupPath!, svGroupId);
      const svGroup: GroupInstance = {
        id: svGroupId,
        name: 'Final Merge Validation',
        path: svGroupPath!,
        nodeIds: [svNodeId],
        allNodeIds: [svNodeId],
        totalNodes: 1,
        childGroupIds: [],
      };
      groups.set(svGroupId, svGroup);
      groupStates.set(svGroupId, {
        status: 'pending',
        version: 0,
        runningCount: 0,
        succeededCount: 0,
        failedCount: 0,
        blockedCount: 0,
        canceledCount: 0,
      });
    } else {
      const existingGroup = groups.get(svGroupId);
      if (existingGroup) {
        existingGroup.nodeIds.push(svNodeId);
      }
    }
  }
  
  const svNode: JobNode = {
    id: svNodeId,
    producerId: svProducerId,
    name: 'Snapshot Validation',
    type: 'job',
    task: `Validate snapshot and merge to '${svTargetBranch}'`,
    prechecks: svPrechecks,
    work: spec.verifyRiSpec,
    postchecks: svPostchecks,
    group: svGroupPath,
    groupId: svGroupId,
    dependencies: [...leaves],
    dependents: [],
    // assignedWorktreePath is set later by the pump when the snapshot is created
  };
  
  // Wire current leaves to point to the snapshot-validation node
  for (const leafId of leaves) {
    const leafNode = nodes.get(leafId);
    if (leafNode) {
      leafNode.dependents.push(svNodeId);
    }
  }
  
  nodes.set(svNodeId, svNode);
  producerIdToNodeId.set(svProducerId, svNodeId);
  
  // Snapshot-validation node is now the sole leaf
  leaves = [svNodeId];
  
  // Validate: Check for cycles
  const cycleError = detectCycles(nodes);
  if (cycleError) {
    errors.push(cycleError);
  }
  
  // Validate: Must have at least one node
  if (nodes.size === 0) {
    errors.push('Plan must have at least one node');
  }
  
  // Validate: Must have at least one root
  if (roots.length === 0 && nodes.size > 0) {
    errors.push('Plan has no root nodes (all nodes have dependencies) - this indicates a cycle');
  }
  
  // Throw if there are errors
  if (errors.length > 0) {
    throw new PlanValidationError('Invalid Plan specification', errors);
  }
  
  // Build initial node states
  const nodeStates = new Map<string, NodeExecutionState>();
  for (const node of nodes.values()) {
    const initialStatus = node.dependencies.length === 0 ? 'ready' : 'pending';
    nodeStates.set(node.id, {
      status: initialStatus,
      version: 0,
      attempts: 0,
    });
  }
  
  // Determine worktree root (flat structure under .worktrees)
  const repoPath = options.repoPath || spec.repoPath || process.cwd();
  const worktreeRoot = options.worktreeRoot || path.join(repoPath, '.worktrees');
  
  return {
    id: planId,
    spec,
    nodes,
    producerIdToNodeId,
    roots,
    leaves,
    nodeStates,
    groups,
    groupStates,
    groupPathToId,
    parentPlanId: options.parentPlanId,
    parentNodeId: options.parentNodeId,
    repoPath,
    baseBranch: spec.baseBranch || 'main',
    targetBranch: spec.targetBranch || spec.baseBranch || 'main',
    worktreeRoot,
    createdAt: Date.now(),
    stateVersion: 0,
    cleanUpSuccessfulWork: spec.cleanUpSuccessfulWork !== false,
    maxParallel: spec.maxParallel || 4,
  };
}

/**
 * Detect cycles in the dependency DAG using iterative DFS.
 *
 * @param nodes - Map of node ID → node definition.
 * @returns A human-readable error message describing the cycle, or `null` if acyclic.
 */
function detectCycles(nodes: Map<string, PlanNode>): string | null {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];
  
  function dfs(nodeId: string): string | null {
    if (visiting.has(nodeId)) {
      // Found a cycle - build the cycle path
      const cycleStart = path.indexOf(nodeId);
      const cyclePath = path.slice(cycleStart).map(id => {
        const node = nodes.get(id);
        return node?.producerId || id;
      });
      cyclePath.push(nodes.get(nodeId)?.producerId || nodeId);
      return `Circular dependency detected: ${cyclePath.join(' -> ')}`;
    }
    
    if (visited.has(nodeId)) {
      return null;
    }
    
    visiting.add(nodeId);
    path.push(nodeId);
    
    const node = nodes.get(nodeId);
    if (node) {
      for (const depId of node.dependencies) {
        const error = dfs(depId);
        if (error) {return error;}
      }
    }
    
    visiting.delete(nodeId);
    path.pop();
    visited.add(nodeId);
    
    return null;
  }
  
  for (const nodeId of nodes.keys()) {
    const error = dfs(nodeId);
    if (error) {return error;}
  }
  
  return null;
}

/**
 * Create a Plan with a single job node from minimal input.
 *
 * Generates a `producerId` from the job name and delegates to {@link buildPlan}.
 *
 * @param jobSpec - Minimal job definition (name, task, optional work/checks/branches).
 * @param options - Optional overrides for repo path and worktree root.
 * @returns A single-node plan instance.
 * @throws {PlanValidationError} If the generated spec is somehow invalid.
 */
export function buildSingleJobPlan(
  jobSpec: {
    name: string;
    task: string;
    work?: string;
    prechecks?: string;
    postchecks?: string;
    instructions?: string;
    baseBranch?: string;
    targetBranch?: string;
    repoPath?: string;
    expectsNoChanges?: boolean;
    autoHeal?: boolean;
  },
  options?: {
    repoPath?: string;
    worktreeRoot?: string;
  }
): PlanInstance {
  const producerId = jobSpec.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64);
  
  const spec: PlanSpec = {
    name: jobSpec.name,
    baseBranch: jobSpec.baseBranch,
    targetBranch: jobSpec.targetBranch,
    repoPath: jobSpec.repoPath,
    jobs: [{
      producerId,
      name: jobSpec.name,
      task: jobSpec.task,
      work: jobSpec.work,
      prechecks: jobSpec.prechecks,
      postchecks: jobSpec.postchecks,
      instructions: jobSpec.instructions,
      dependencies: [],
      expectsNoChanges: jobSpec.expectsNoChanges,
      autoHeal: jobSpec.autoHeal,
    }],
  };
  
  return buildPlan(spec, options);
}

// ============================================================================
// NODE-CENTRIC BUILDER (Simplified Node Model)
// ============================================================================

/**
 * Build node instances from node specs with optional group info.
 *
 * Performs three passes:
 * 1. Creates NodeInstance objects and maps producerId → nodeId.
 * 2. Resolves dependency references from producer IDs to node UUIDs.
 * 3. Computes reverse edges (dependents) and validates the DAG.
 *
 * Root nodes (no dependencies) start in 'ready' status; all others start as 'pending'.
 *
 * @param specs     - Array of NodeSpec definitions.
 * @param options   - Optional group info, repo path, and worktree root.
 * @returns Array of fully constructed, validated NodeInstance objects plus optional GroupInfo.
 * @throws {PlanValidationError} If specs contain duplicate IDs, unknown references, cycles, or no nodes.
 */
export function buildNodes(
  specs: import('./types').NodeSpec[],
  options: {
    group?: import('./types').GroupInfo;
    repoPath?: string;
    worktreeRoot?: string;
  } = {}
): { nodes: import('./types').NodeInstance[]; group?: import('./types').GroupInfo } {
  const errors: string[] = [];
  const nodeMap = new Map<string, import('./types').NodeInstance>();
  const producerIdToNodeId = new Map<string, string>();
  const repoPath = options.repoPath || process.cwd();

  // First pass: Create all NodeInstance objects
  for (const spec of specs) {
    if (!spec.producerId) {
      errors.push(`Node is missing required 'producerId' field`);
      continue;
    }

    if (producerIdToNodeId.has(spec.producerId)) {
      errors.push(`Duplicate producerId: '${spec.producerId}'`);
      continue;
    }

    const nodeId = uuidv4();
    const node: import('./types').NodeInstance = {
      id: nodeId,
      producerId: spec.producerId,
      name: spec.name || spec.producerId,
      task: spec.task,
      work: spec.work,
      prechecks: spec.prechecks,
      postchecks: spec.postchecks,
      instructions: spec.instructions,
      baseBranch: spec.baseBranch,
      dependencies: [],  // Resolved in second pass
      dependents: [],
      group: options.group,
      status: 'pending',
      repoPath,
      attempts: 0,
    };

    nodeMap.set(nodeId, node);
    producerIdToNodeId.set(spec.producerId, nodeId);
  }

  // Second pass: Resolve dependencies (producerId -> nodeId)
  for (const spec of specs) {
    const nodeId = producerIdToNodeId.get(spec.producerId);
    if (!nodeId) {continue;}

    const node = nodeMap.get(nodeId);
    if (!node) {continue;}

    const resolvedDeps: string[] = [];
    for (const depProducerId of spec.dependencies) {
      const depNodeId = producerIdToNodeId.get(depProducerId);
      if (!depNodeId) {
        errors.push(`Node '${spec.producerId}' references unknown dependency '${depProducerId}'`);
        continue;
      }
      resolvedDeps.push(depNodeId);
    }

    node.dependencies = resolvedDeps;
  }

  // Third pass: Compute dependents (reverse edges)
  for (const node of nodeMap.values()) {
    for (const depId of node.dependencies) {
      const depNode = nodeMap.get(depId);
      if (depNode) {
        depNode.dependents.push(node.id);
      }
    }
  }

  // Set root nodes to 'ready'
  for (const node of nodeMap.values()) {
    if (node.dependencies.length === 0) {
      node.status = 'ready';
    }
  }

  // Validate: detect cycles using a simple map
  const nodeMapForCycles = new Map<string, { id: string; producerId: string; dependencies: string[] }>();
  for (const node of nodeMap.values()) {
    nodeMapForCycles.set(node.id, { id: node.id, producerId: node.producerId, dependencies: node.dependencies });
  }
  const cycleError = detectNodeCycles(nodeMapForCycles);
  if (cycleError) {
    errors.push(cycleError);
  }

  // Validate: Must have at least one node
  if (nodeMap.size === 0) {
    errors.push('Must have at least one node');
  }

  // Validate: Must have at least one root
  const hasRoot = Array.from(nodeMap.values()).some(n => n.dependencies.length === 0);
  if (!hasRoot && nodeMap.size > 0) {
    errors.push('No root nodes (all nodes have dependencies) - this indicates a cycle');
  }

  if (errors.length > 0) {
    throw new PlanValidationError('Invalid node specification', errors);
  }

  return {
    nodes: Array.from(nodeMap.values()),
    group: options.group,
  };
}

/**
 * Detect cycles in a node dependency graph using iterative DFS.
 */
function detectNodeCycles(nodes: Map<string, { id: string; producerId: string; dependencies: string[] }>): string | null {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const pathStack: string[] = [];

  function dfs(nodeId: string): string | null {
    if (visiting.has(nodeId)) {
      const cycleStart = pathStack.indexOf(nodeId);
      const cyclePath = pathStack.slice(cycleStart).map(id => {
        const node = nodes.get(id);
        return node?.producerId || id;
      });
      cyclePath.push(nodes.get(nodeId)?.producerId || nodeId);
      return `Circular dependency detected: ${cyclePath.join(' -> ')}`;
    }

    if (visited.has(nodeId)) {
      return null;
    }

    visiting.add(nodeId);
    pathStack.push(nodeId);

    const node = nodes.get(nodeId);
    if (node) {
      for (const depId of node.dependencies) {
        const error = dfs(depId);
        if (error) {return error;}
      }
    }

    visiting.delete(nodeId);
    pathStack.pop();
    visited.add(nodeId);

    return null;
  }

  for (const nodeId of nodes.keys()) {
    const error = dfs(nodeId);
    if (error) {return error;}
  }

  return null;
}
