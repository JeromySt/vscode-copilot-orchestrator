/**
 * @fileoverview Default implementation of IPlanRepository.
 * 
 * Provides plan lifecycle management including creation, modification,
 * persistence, and querying. Orchestrates the storage layer and plan builder
 * to provide high-level plan operations.
 * 
 * @module plan/repository/DefaultPlanRepository
 */

import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../../core/logger';
import type { 
  IPlanRepository, 
  ScaffoldOptions, 
  NodeSpec, 
  ImportOptions,
  PlanSummary 
} from '../../interfaces/IPlanRepository';
import type { IPlanDefinition } from '../../interfaces/IPlanDefinition';
import type { 
  StoredPlanMetadata, 
  StoredJobMetadata, 
  IPlanRepositoryStore 
} from '../../interfaces/IPlanRepositoryStore';
import type { 
  PlanInstance, 
  PlanSpec, 
  NodeExecutionState,
  GroupInstance,
  GroupExecutionState 
} from '../types/plan';
import type { WorkSpec, AgentSpec, ShellSpec, ProcessSpec } from '../types/specs';
import { FilePlanDefinition } from './FilePlanDefinition';
import { buildSvJobSpec } from '../svNodeBuilder';
import { 
  detectCycles, 
  computeRootsAndLeaves, 
  validateAllDepsExist, 
  type DagJob 
} from '../dagUtils';

const log = Logger.for('plan-persistence');

/**
 * Default implementation of IPlanRepository.
 * 
 * Orchestrates plan storage and builder to provide high-level plan lifecycle
 * management operations. Handles scaffolding, node addition, finalization,
 * and state persistence.
 */
export class DefaultPlanRepository implements IPlanRepository {
  /** Per-plan write locks — serializes all mutations to avoid plan.json race conditions */
  private readonly _locks = new Map<string, Promise<any>>();

  /**
   * Plan IDs that have been deleted during this session.  Once a plan ID is
   * added here, no save operation will recreate its metadata on disk — even
   * if a stale in-memory reference triggers a late `savePlanState()` call.
   */
  private readonly _deletedPlanIds = new Set<string>();

  constructor(
    private readonly store: IPlanRepositoryStore,
    private readonly repoPath: string,
    private readonly worktreeRoot: string
  ) {}

  /**
   * Acquire a per-plan mutex. All async operations that read-modify-write
   * plan.json must go through this to prevent concurrent writes from
   * dropping nodes or corrupting metadata.
   */
  private withLock<T>(planId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this._locks.get(planId) || Promise.resolve();
    const next = prev.then(fn, fn); // Run fn after previous completes (even if it failed)
    this._locks.set(planId, next.catch(() => {})); // Swallow so chain never rejects
    return next;
  }

  async scaffold(name: string, options: ScaffoldOptions): Promise<PlanInstance> {
    const planId = uuidv4();

    log.info('Scaffolding new plan', { 
      planId,
      name, 
      baseBranch: options.baseBranch,
      targetBranch: options.targetBranch 
    });

    const targetBranch = options.targetBranch || options.baseBranch || 'main';

    // Build the snapshot-validation job spec with a stable UUID
    const svSpec = buildSvJobSpec(targetBranch, undefined, undefined);
    const svId = uuidv4();
    (svSpec as any).id = svId;

    // Create initial plan metadata with SV as the first and only job.
    // SV starts as both root (no deps) and leaf (no dependents).
    const metadata: StoredPlanMetadata = {
      id: planId,
      spec: {
        name,
        status: 'scaffolding',
        baseBranch: options.baseBranch,
        targetBranch,
        maxParallel: options.maxParallel || 0,
        cleanUpSuccessfulWork: true,
        startPaused: true,
        jobs: [svSpec as any],
      },
      jobs: [],
      producerIdToNodeId: { '__snapshot-validation__': svId },
      roots: [svId],
      leaves: [svId],
      nodeStates: {
        [svId]: { status: 'pending', version: 0, attempts: 0 }
      },
      groups: {},
      groupStates: {},
      groupPathToId: {},
      parentPlanId: options.parentPlanId,
      parentNodeId: options.parentNodeId,
      repoPath: options.repoPath,
      baseBranch: options.baseBranch,
      targetBranch,
      worktreeRoot: options.worktreeRoot,
      createdAt: Date.now(),
      maxParallel: options.maxParallel || 0,
      cleanUpSuccessfulWork: true,
      env: options.env,
      resumeAfterPlan: options.resumeAfterPlan,
    };

    await this.store.writePlanMetadata(metadata);
    
    // Build PlanInstance from metadata using the new helper
    const planInstance = this.buildPlanInstanceFromMetadata(metadata);
    
    log.info('Plan scaffolding completed', { planId, name });
    return planInstance;
  }

  async addNode(planId: string, nodeSpec: NodeSpec): Promise<PlanInstance> {
    return this.withLock(planId, () => this._addNodeImpl(planId, nodeSpec));
  }

  private async _addNodeImpl(planId: string, nodeSpec: NodeSpec): Promise<PlanInstance> {
    log.debug('Adding node to plan', { planId, producerId: nodeSpec.producerId, name: nodeSpec.name });

    // Read existing metadata
    const metadata = await this.store.readPlanMetadata(planId);
    if (!metadata) {
      throw new Error(`Plan not found: ${planId}`);
    }

    // Validate plan is in scaffolding state
    if (metadata.spec.status !== 'scaffolding') {
      throw new Error(
        `Cannot add jobs to plan in status '${metadata.spec.status}' using add_copilot_plan_job. ` +
        `This tool only works during scaffolding (before finalize). ` +
        `For finalized/running/paused plans, use reshape_copilot_plan with an 'add_node' operation instead.`
      );
    }

    // Validate no duplicate producerId
    const existingJobs = metadata.spec.jobs || [];
    if (existingJobs.some((j: any) => j.producerId === nodeSpec.producerId)) {
      throw new Error(`Duplicate producerId: ${nodeSpec.producerId}`);
    }

    // Resolve instructionsFile to inline content if provided
    const resolvedWork = await this.resolveInstructionsFile(nodeSpec.work || nodeSpec.workWithFile);

    // Create stable node ID
    const jobId = uuidv4();

    // Build job spec with stable ID
    const jobSpec: any = {
      id: jobId,
      producerId: nodeSpec.producerId,
      task: nodeSpec.task || nodeSpec.name,
      name: nodeSpec.name,
      dependencies: nodeSpec.dependencies || [],
      group: nodeSpec.group,
      work: resolvedWork,
      prechecks: nodeSpec.prechecks,
      postchecks: nodeSpec.postchecks,
      autoHeal: nodeSpec.autoHeal,
      expectsNoChanges: nodeSpec.expectsNoChanges,
    };

    // Temporarily add the job to the jobs array
    if (!metadata.spec.jobs) { metadata.spec.jobs = []; }
    metadata.spec.jobs.push(jobSpec);
    metadata.producerIdToNodeId[nodeSpec.producerId] = jobId;

    // Auto-wire SV: recompute SV's dependencies to include all user leaves
    this.rewireSvDependencies(metadata);

    // Validate the DAG
    const jobs = metadata.spec.jobs.map((j: any) => ({
      producerId: j.producerId,
      dependencies: j.dependencies || []
    }));

    const cycleError = detectCycles(jobs);
    if (cycleError) {
      // ROLLBACK: remove the job we just added
      metadata.spec.jobs.pop();
      delete metadata.producerIdToNodeId[nodeSpec.producerId];
      throw new Error(cycleError);
    }

    // Validate all dependencies exist
    try {
      validateAllDepsExist(jobs);
    } catch (err: any) {
      // ROLLBACK: remove the job we just added
      metadata.spec.jobs.pop();
      delete metadata.producerIdToNodeId[nodeSpec.producerId];
      throw err;
    }

    // Update topology (roots/leaves by node ID)
    const { roots, leaves } = computeRootsAndLeaves(jobs);
    metadata.roots = roots.map(pid => metadata.producerIdToNodeId[pid]);
    metadata.leaves = leaves.map(pid => metadata.producerIdToNodeId[pid]);

    // Initialize node state
    metadata.nodeStates[jobId] = { 
      status: jobSpec.dependencies.length === 0 ? 'ready' : 'pending',
      version: 0, 
      attempts: 0 
    };

    // Commit to store
    await this.store.writePlanMetadata(metadata);

    // Build PlanInstance from updated metadata
    const planInstance = this.buildPlanInstanceFromMetadata(metadata);

    log.debug('Node added and plan rebuilt', { planId, producerId: nodeSpec.producerId, nodeCount: planInstance.jobs.size });
    return planInstance;
  }

  async removeNode(planId: string, producerId: string): Promise<PlanInstance> {
    return this.withLock(planId, () => this._removeNodeImpl(planId, producerId));
  }

  private async _removeNodeImpl(planId: string, producerId: string): Promise<PlanInstance> {
    log.debug('Removing node from plan', { planId, producerId });

    const metadata = await this.store.readPlanMetadata(planId);
    if (!metadata) { throw new Error(`Plan not found: ${planId}`); }
    if (metadata.spec.status !== 'scaffolding') {
      throw new Error(
        `Cannot remove jobs from plan in status '${metadata.spec.status}' using this method. ` +
        `For finalized/running/paused plans, use reshape_copilot_plan with a 'remove_node' operation.`
      );
    }

    // Prevent removal of the SV node
    if (producerId === '__snapshot-validation__') {
      throw new Error('Cannot remove the snapshot-validation node');
    }

    const jobs = metadata.spec.jobs || [];
    const idx = jobs.findIndex((j: any) => j.producerId === producerId);
    if (idx === -1) { throw new Error(`Node not found: ${producerId}`); }

    // Remove the job
    const removedJob = jobs.splice(idx, 1)[0];
    delete metadata.producerIdToNodeId[producerId];
    delete metadata.nodeStates[(removedJob as any).id];

    // Also remove this producerId from other jobs' dependencies
    for (const job of jobs) {
      if (job.dependencies) {
        job.dependencies = job.dependencies.filter((d: string) => d !== producerId);
      }
    }

    // Auto-wire SV
    this.rewireSvDependencies(metadata);

    // Validate the DAG
    const dagJobs = jobs.map((j: any) => ({
      producerId: j.producerId,
      dependencies: j.dependencies || []
    }));

    const cycleError = detectCycles(dagJobs);
    if (cycleError) {
      throw new Error(cycleError);
    }

    validateAllDepsExist(dagJobs);

    // Update topology
    const { roots, leaves } = computeRootsAndLeaves(dagJobs);
    metadata.roots = roots.map(pid => metadata.producerIdToNodeId[pid]);
    metadata.leaves = leaves.map(pid => metadata.producerIdToNodeId[pid]);

    // Commit
    await this.store.writePlanMetadata(metadata);

    // Build PlanInstance
    const planInstance = this.buildPlanInstanceFromMetadata(metadata);

    log.debug('Node removed and plan rebuilt', { planId, producerId, nodeCount: planInstance.jobs.size });
    return planInstance;
  }

  async updateNode(planId: string, producerId: string, updates: Partial<import('../../interfaces/IPlanRepository').NodeSpec>): Promise<PlanInstance> {
    return this.withLock(planId, () => this._updateNodeImpl(planId, producerId, updates));
  }

  private async _updateNodeImpl(planId: string, producerId: string, updates: Partial<import('../../interfaces/IPlanRepository').NodeSpec>): Promise<PlanInstance> {
    log.debug('Updating node in plan', { planId, producerId });

    const metadata = await this.store.readPlanMetadata(planId);
    if (!metadata) { throw new Error(`Plan not found: ${planId}`); }
    if (metadata.spec.status !== 'scaffolding') {
      throw new Error(
        `Cannot update jobs in plan in status '${metadata.spec.status}' using this method. ` +
        `For finalized/running/paused plans, use update_copilot_plan_job or reshape_copilot_plan.`
      );
    }

    const jobs = metadata.spec.jobs || [];
    const job = jobs.find((j: any) => j.producerId === producerId);
    if (!job) { throw new Error(`Node not found: ${producerId}`); }

    // Prevent updating the SV node
    if (producerId === '__snapshot-validation__') {
      throw new Error('Cannot update the snapshot-validation node');
    }

    // Track if dependencies changed
    const depsChanged = updates.dependencies !== undefined && 
      JSON.stringify(updates.dependencies) !== JSON.stringify(job.dependencies);

    // Apply updates
    if (updates.name !== undefined) { job.name = updates.name; }
    if (updates.task !== undefined) { job.task = updates.task; }
    if (updates.dependencies !== undefined) { job.dependencies = updates.dependencies; }
    if (updates.group !== undefined) { job.group = updates.group; }
    if (updates.work !== undefined) { job.work = updates.work; }
    if (updates.prechecks !== undefined) { job.prechecks = updates.prechecks; }
    if (updates.postchecks !== undefined) { job.postchecks = updates.postchecks; }
    if (updates.autoHeal !== undefined) { job.autoHeal = updates.autoHeal; }
    if (updates.expectsNoChanges !== undefined) { job.expectsNoChanges = updates.expectsNoChanges; }

    // If dependencies changed, rewire SV
    if (depsChanged) {
      this.rewireSvDependencies(metadata);
    }

    // Validate the DAG
    const dagJobs = jobs.map((j: any) => ({
      producerId: j.producerId,
      dependencies: j.dependencies || []
    }));

    const cycleError = detectCycles(dagJobs);
    if (cycleError) {
      throw new Error(cycleError);
    }

    validateAllDepsExist(dagJobs);

    // Update topology
    const { roots, leaves } = computeRootsAndLeaves(dagJobs);
    metadata.roots = roots.map(pid => metadata.producerIdToNodeId[pid]);
    metadata.leaves = leaves.map(pid => metadata.producerIdToNodeId[pid]);

    // Update node state if dependencies changed
    if (depsChanged) {
      const nodeId = metadata.producerIdToNodeId[producerId];
      if (nodeId && metadata.nodeStates[nodeId]) {
        metadata.nodeStates[nodeId].status = job.dependencies.length === 0 ? 'ready' : 'pending';
      }
    }

    // Commit
    await this.store.writePlanMetadata(metadata);

    // Build PlanInstance
    const planInstance = this.buildPlanInstanceFromMetadata(metadata);

    log.debug('Node updated and plan rebuilt', { planId, producerId, nodeCount: planInstance.jobs.size });
    return planInstance;
  }

  async finalize(planId: string): Promise<PlanInstance> {
    return this.withLock(planId, () => this._finalizeImpl(planId));
  }

  private async _finalizeImpl(planId: string): Promise<PlanInstance> {
    log.info('Finalizing plan', { planId });

    // Read metadata
    const metadata = await this.store.readPlanMetadata(planId);
    if (!metadata) {
      throw new Error(`Plan not found: ${planId}`);
    }

    // Validate plan is in scaffolding state
    if (metadata.spec.status !== 'scaffolding') {
      throw new Error(`Cannot finalize plan in status '${metadata.spec.status}'. Plan must be in 'scaffolding' status.`);
    }

    const jobs = metadata.spec.jobs || [];

    // Ensure all jobs have stable IDs in producerIdToNodeId
    // (handles both normal flow via addNode and test fixtures)
    for (const job of jobs) {
      const producerId = (job as any).producerId;
      if (!metadata.producerIdToNodeId[producerId]) {
        const nodeId = (job as any).id || uuidv4();
        metadata.producerIdToNodeId[producerId] = nodeId;
        (job as any).id = nodeId;
      } else if (!(job as any).id) {
        (job as any).id = metadata.producerIdToNodeId[producerId];
      }
    }

    // Must have at least the SV node (could be a 0-user-job plan)
    // Validate DAG one final time
    const dagJobs = jobs.map((j: any) => ({
      producerId: j.producerId,
      dependencies: j.dependencies || []
    }));

    const cycleError = detectCycles(dagJobs);
    if (cycleError) {
      throw new Error(cycleError);
    }

    validateAllDepsExist(dagJobs);

    const { roots, leaves } = computeRootsAndLeaves(dagJobs);
    metadata.roots = roots.map(pid => metadata.producerIdToNodeId[pid]);
    metadata.leaves = leaves.map(pid => metadata.producerIdToNodeId[pid]);

    // Write spec files for ALL jobs (including SV)
    for (const job of jobs) {
      const nodeId = metadata.producerIdToNodeId[(job as any).producerId];
      if (!nodeId) {
        log.warn('Job missing stable node ID during finalize, skipping spec write', { producerId: (job as any).producerId });
        continue;
      }

      if ((job as any).work) {
        await this.store.writeNodeSpec(planId, nodeId, 'work', (job as any).work);
      }
      if ((job as any).prechecks) {
        await this.store.writeNodeSpec(planId, nodeId, 'prechecks', (job as any).prechecks);
      }
      if ((job as any).postchecks) {
        await this.store.writeNodeSpec(planId, nodeId, 'postchecks', (job as any).postchecks);
      }
    }

    // Populate metadata.jobs from jobs
    metadata.jobs = jobs.map((job: any) => {
      const nodeId = metadata.producerIdToNodeId[job.producerId];
      return {
        id: nodeId,
        producerId: job.producerId,
        name: job.name || job.task,
        task: job.task,
        dependencies: (job.dependencies || []).map((dep: string) => metadata.producerIdToNodeId[dep] || dep),
        group: job.group,
        hasWork: !!job.work,
        hasPrechecks: !!job.prechecks,
        hasPostchecks: !!job.postchecks,
        autoHeal: job.autoHeal,
        expectsNoChanges: job.expectsNoChanges,
        baseBranch: job.baseBranch,
        assignedWorktreePath: job.assignedWorktreePath,
      };
    });

    // Initialize node states for any new nodes
    for (const job of jobs) {
      const nodeId = metadata.producerIdToNodeId[(job as any).producerId];
      if (nodeId && !metadata.nodeStates[nodeId]) {
        const isRoot = roots.includes((job as any).producerId);
        metadata.nodeStates[nodeId] = {
          status: isRoot ? 'ready' : 'pending',
          version: 0,
          attempts: 0,
        };
      }
    }

    // Build groups from job.group fields
    this.buildGroupsFromJobs(metadata, jobs);

    // Seal: clear inline specs, set status
    metadata.spec.status = 'pending';
    metadata.spec.jobs = []; // Specs now on disk

    await this.store.writePlanMetadata(metadata);

    // Build PlanInstance from updated metadata
    const planInstance = this.buildPlanInstanceFromMetadata(metadata);

    log.info('Plan finalized successfully', { 
      planId, 
      nodeCount: planInstance.jobs.size,
      rootCount: planInstance.roots.length,
      leafCount: planInstance.leaves.length
    });

    return planInstance;
  }

  async getDefinition(planId: string): Promise<IPlanDefinition | undefined> {
    const metadata = await this.store.readPlanMetadata(planId);
    if (!metadata) {
      return undefined;
    }
    
    return new FilePlanDefinition(metadata, this.store);
  }

  async loadState(planId: string): Promise<PlanInstance | undefined> {
    const metadata = await this.store.readPlanMetadata(planId);
    if (!metadata) {
      return undefined;
    }

    // Migration: rename nodes → jobs if needed
    if ((metadata as any).nodes && !metadata.jobs) {
      metadata.jobs = (metadata as any).nodes;
      delete (metadata as any).nodes;
    }

    // Skip tombstoned plans — they were deleted but directory cleanup may have failed
    if (metadata.deleted) {
      log.info(`Skipping deleted plan ${planId} (tombstoned)`);
      // Attempt cleanup on next load
      try {
        await this.store.deletePlan(planId);
        log.info(`Cleaned up tombstoned plan directory: ${planId}`);
      } catch (cleanupErr: any) {
        log.warn(`Failed to clean up tombstoned plan ${planId}: ${cleanupErr.message}`);
      }
      return undefined;
    }

    // For scaffolding plans, rebuild from metadata using stable node IDs
    const isScaffolding = (metadata.spec as any)?.status === 'scaffolding';
    
    if (isScaffolding) {
      // Use buildPlanInstanceFromMetadata to preserve stable IDs
      const plan = this.buildPlanInstanceFromMetadata(metadata);
      plan.stateVersion = metadata.stateVersion || 0;
      plan.isPaused = metadata.isPaused;
      plan.startedAt = metadata.startedAt;
      plan.endedAt = metadata.endedAt;
      plan.baseCommitAtStart = metadata.baseCommitAtStart;
      return plan;
    }

    // For finalized plans, reconstruct PlanInstance directly from metadata.
    // We do NOT call buildPlan() here because it assigns new UUIDs — the
    // metadata already has stable node IDs from finalization, and nodeStates
    // are keyed by those IDs.
    const nodes = new Map<string, any>();
    const nodeStates = new Map<string, any>();
    const producerIdToNodeId = new Map<string, string>();
    const groups = new Map<string, any>();
    const groupStates = new Map<string, any>();
    const groupPathToId = new Map<string, string>();

    for (const node of metadata.jobs) {
      // Load work specs from disk if available
      let work: WorkSpec | undefined;
      let prechecks: WorkSpec | undefined;
      let postchecks: WorkSpec | undefined;
      
      if (node.hasWork) {
        work = await this.store.readNodeSpec(planId, node.id, 'work');
      }
      if (node.hasPrechecks) {
        prechecks = await this.store.readNodeSpec(planId, node.id, 'prechecks');
      }
      if (node.hasPostchecks) {
        postchecks = await this.store.readNodeSpec(planId, node.id, 'postchecks');
      }

      nodes.set(node.id, {
        id: node.id,
        producerId: node.producerId,
        name: node.name,
        type: 'job',
        task: node.task,
        work,
        prechecks,
        postchecks,
        autoHeal: node.autoHeal,
        expectsNoChanges: node.expectsNoChanges,
        baseBranch: node.baseBranch,
        assignedWorktreePath: node.assignedWorktreePath,
        dependencies: node.dependencies || [],
        dependents: [],
        group: node.group,
        // Resolve groupId (UUID) from group path — needed for state machine group updates
        groupId: node.group && metadata.groupPathToId ? metadata.groupPathToId[node.group] : undefined,
      });

      producerIdToNodeId.set(node.producerId, node.id);
      
      const storedState = metadata.nodeStates[node.id];
      nodeStates.set(node.id, storedState || { status: 'pending', version: 0, attempts: 0 });
    }

    // Compute dependents (reverse edges) from dependencies
    for (const [nodeId, node] of nodes) {
      for (const depId of node.dependencies) {
        const depNode = nodes.get(depId);
        if (depNode) {
          depNode.dependents.push(nodeId);
        }
      }
    }

    // Restore groups
    if (metadata.groups) {
      for (const [groupId, group] of Object.entries(metadata.groups)) {
        groups.set(groupId, group);
      }
    }
    if (metadata.groupStates) {
      for (const [groupId, state] of Object.entries(metadata.groupStates)) {
        groupStates.set(groupId, state);
      }
    }
    if (metadata.groupPathToId) {
      for (const [path, id] of Object.entries(metadata.groupPathToId)) {
        groupPathToId.set(path, id as string);
      }
    }

    const planInstance: PlanInstance = {
      id: metadata.id,
      spec: metadata.spec as any,
      jobs: nodes,
      nodeStates,
      producerIdToNodeId,
      roots: metadata.roots || [],
      leaves: metadata.leaves || [],
      groups,
      groupStates,
      groupPathToId,
      parentPlanId: metadata.parentPlanId,
      parentNodeId: metadata.parentNodeId,
      repoPath: metadata.repoPath,
      baseBranch: metadata.baseBranch,
      targetBranch: metadata.targetBranch,
      worktreeRoot: metadata.worktreeRoot,
      createdAt: metadata.createdAt,
      startedAt: metadata.startedAt,
      endedAt: metadata.endedAt,
      baseCommitAtStart: metadata.baseCommitAtStart,
      isPaused: metadata.isPaused,
      resumeAfterPlan: metadata.resumeAfterPlan,
      branchReady: metadata.branchReady,
      env: metadata.env,
      snapshot: metadata.snapshot,
      workSummary: metadata.workSummary,
      stateVersion: metadata.stateVersion || 0,
      cleanUpSuccessfulWork: metadata.cleanUpSuccessfulWork,
      maxParallel: metadata.maxParallel,
      definition: new FilePlanDefinition(metadata, this.store),
    } as PlanInstance;

    return planInstance;
  }

  async saveState(plan: PlanInstance): Promise<void> {
    return this.withLock(plan.id, () => this._saveStateImpl(plan));
  }

  private async _saveStateImpl(plan: PlanInstance): Promise<void> {
    log.debug('Saving plan state', { planId: plan.id });

    // In-memory guard: once deleted, never recreate
    if (this._deletedPlanIds.has(plan.id)) {
      log.debug('Skipping save for deleted plan (in-memory guard)', { planId: plan.id });
      return;
    }
    
    const isScaffoldingPlan = (plan.spec as any)?.status === 'scaffolding';
    let metadata = await this.store.readPlanMetadata(plan.id);

    // Don't resurrect a tombstoned plan
    if (metadata?.deleted) {
      log.debug('Skipping save for deleted plan', { planId: plan.id });
      return;
    }

    if (isScaffoldingPlan) {
      // Scaffolding plans keep specs inline in metadata.spec.jobs — managed
      // by addNode(). Only sync lightweight state fields here.
      if (metadata) {
        metadata.stateVersion = plan.stateVersion;
        metadata.isPaused = plan.isPaused;
        metadata.resumeAfterPlan = plan.resumeAfterPlan;
        await this.store.writePlanMetadata(metadata);
      }
      log.debug('Scaffolding plan state saved', { planId: plan.id });
      return;
    }

    if (!metadata) {
      // First save — build metadata from scratch
      metadata = {
        id: plan.id,
        spec: { ...plan.spec, jobs: [] }, // Strip jobs — nodes are the source of truth
        nodes: [],
        producerIdToNodeId: {},
        roots: plan.roots || [],
        leaves: plan.leaves || [],
        nodeStates: {},
        repoPath: plan.repoPath,
        baseBranch: plan.baseBranch,
        targetBranch: plan.targetBranch,
        worktreeRoot: plan.worktreeRoot,
        createdAt: plan.createdAt,
        maxParallel: plan.maxParallel,
        cleanUpSuccessfulWork: plan.cleanUpSuccessfulWork,
      } as any;
    }
    
    // At this point metadata is guaranteed to exist
    const meta = metadata!;

    // For finalized/running plans: strip spec.jobs — nodes on disk are the source of truth
    if (meta.spec) {
      meta.spec.jobs = [];
    }

    // Sync jobs from in-memory plan
    meta.jobs = [];
    for (const [nodeId, node] of plan.jobs) {
      const jobNode = node as any;
      meta.jobs.push({
        id: nodeId,
        producerId: jobNode.producerId,
        name: jobNode.name,
        task: jobNode.task,
        dependencies: jobNode.dependencies || [],
        group: jobNode.group,
        hasWork: !!jobNode.work || await this.store.hasNodeSpec(plan.id, nodeId, 'work'),
        hasPrechecks: !!jobNode.prechecks || await this.store.hasNodeSpec(plan.id, nodeId, 'prechecks'),
        hasPostchecks: !!jobNode.postchecks || await this.store.hasNodeSpec(plan.id, nodeId, 'postchecks'),
        workRef: await this.store.hasNodeSpec(plan.id, nodeId, 'work') ? `specs/${nodeId}/current/work.json` : undefined,
        prechecksRef: await this.store.hasNodeSpec(plan.id, nodeId, 'prechecks') ? `specs/${nodeId}/current/prechecks.json` : undefined,
        postchecksRef: await this.store.hasNodeSpec(plan.id, nodeId, 'postchecks') ? `specs/${nodeId}/current/postchecks.json` : undefined,
        autoHeal: jobNode.autoHeal,
        expectsNoChanges: jobNode.expectsNoChanges,
        baseBranch: jobNode.baseBranch,
        assignedWorktreePath: jobNode.assignedWorktreePath,
      });
    }

    // Sync producerIdToNodeId
    meta.producerIdToNodeId = {};
    for (const [pid, nid] of plan.producerIdToNodeId) {
      meta.producerIdToNodeId[pid] = nid;
    }

    // Update metadata with current plan state
    meta.startedAt = plan.startedAt;
    meta.endedAt = plan.endedAt;
    meta.baseCommitAtStart = plan.baseCommitAtStart;
    meta.isPaused = plan.isPaused;
    meta.resumeAfterPlan = plan.resumeAfterPlan;
    meta.branchReady = plan.branchReady;
    meta.snapshot = plan.snapshot;
    meta.workSummary = plan.workSummary;
    meta.stateVersion = plan.stateVersion;
    meta.roots = plan.roots;
    meta.leaves = plan.leaves;

    // Update node states
    meta.nodeStates = {};
    for (const [nodeId, nodeState] of plan.nodeStates) {
      meta.nodeStates[nodeId] = { ...nodeState };
    }

    // Update group states
    if (plan.groupStates) {
      meta.groupStates = {};
      for (const [groupId, groupState] of plan.groupStates) {
        meta.groupStates[groupId] = { ...groupState };
      }
    }

    await this.store.writePlanMetadata(meta);
    log.debug('Plan state saved successfully', { planId: plan.id });
  }

  saveStateSync(plan: PlanInstance): void {
    log.debug('Saving plan state synchronously', { planId: plan.id });

    // In-memory guard: once deleted, never recreate
    if (this._deletedPlanIds.has(plan.id)) {
      log.debug('Skipping sync save for deleted plan (in-memory guard)', { planId: plan.id });
      return;
    }
    
    const isScaffoldingPlan = (plan.spec as any)?.status === 'scaffolding';
    
    // For scaffolding plans, skip — spec.jobs is managed by addNode/removeNode
    if (isScaffoldingPlan) { return; }

    // Use synchronous store write for finalized/running plans
    try {
      const metadata = this.store.readPlanMetadataSync?.(plan.id);
      if (!metadata) {
        // Fall back to legacy persistence only
        log.debug('No metadata found for sync save, skipping repository save', { planId: plan.id });
        return;
      }
      if (metadata.deleted) { return; }

      metadata.spec.jobs = [];
      // Preserve existing hasWork/hasPrechecks/hasPostchecks from on-disk metadata
      // when the in-memory node doesn't have inline specs (finalized plans store
      // specs on disk, not inline — so node.work is undefined even if hasWork was true)
      const existingJobFlags = new Map<string, { hasWork: boolean; hasPrechecks: boolean; hasPostchecks: boolean }>();
      for (const job of metadata.jobs || []) {
        existingJobFlags.set(job.id, { hasWork: !!job.hasWork, hasPrechecks: !!job.hasPrechecks, hasPostchecks: !!job.hasPostchecks });
      }
      metadata.jobs = [];
      for (const [nodeId, node] of plan.jobs) {
        const jobNode = node as any;
        const existing = existingJobFlags.get(nodeId);
        metadata.jobs.push({
          id: nodeId, producerId: jobNode.producerId, name: jobNode.name, task: jobNode.task,
          dependencies: jobNode.dependencies || [], group: jobNode.group,
          hasWork: !!jobNode.work || (existing?.hasWork ?? false),
          hasPrechecks: !!jobNode.prechecks || (existing?.hasPrechecks ?? false),
          hasPostchecks: !!jobNode.postchecks || (existing?.hasPostchecks ?? false),
          autoHeal: jobNode.autoHeal, expectsNoChanges: jobNode.expectsNoChanges,
          baseBranch: jobNode.baseBranch, assignedWorktreePath: jobNode.assignedWorktreePath,
        });
      }
      metadata.producerIdToNodeId = Object.fromEntries(plan.producerIdToNodeId);
      metadata.roots = plan.roots;
      metadata.leaves = plan.leaves;
      metadata.stateVersion = plan.stateVersion;
      metadata.isPaused = plan.isPaused;
      metadata.resumeAfterPlan = plan.resumeAfterPlan;
      metadata.startedAt = plan.startedAt;
      metadata.endedAt = plan.endedAt;
      metadata.nodeStates = {};
      for (const [nodeId, nodeState] of plan.nodeStates) {
        metadata.nodeStates[nodeId] = { ...nodeState };
      }
      // Persist group states (duration tracking, status)
      if (plan.groupStates) {
        metadata.groupStates = {};
        for (const [groupId, groupState] of plan.groupStates) {
          metadata.groupStates[groupId] = { ...groupState };
        }
      }
      this.store.writePlanMetadataSync(metadata);
    } catch (error: any) {
      log.warn('Sync state save failed, falling back to legacy persistence only', { planId: plan.id, error: error.message });
    }
  }

  async list(): Promise<PlanSummary[]> {
    const planIds = await this.store.listPlanIds();
    const summaries: PlanSummary[] = [];
    
    for (const planId of planIds) {
      const metadata = await this.store.readPlanMetadata(planId);
      if (!metadata) { continue; }
      
      // Clean up tombstoned plans encountered during listing
      if (metadata.deleted) {
        try {
          await this.store.deletePlan(planId);
          log.info(`Cleaned up tombstoned plan directory: ${planId}`);
        } catch (err: any) {
          log.warn(`Failed to clean up tombstoned plan ${planId}: ${err.message}`);
        }
        continue;
      }

      // Migration: rename nodes → jobs if needed
      if ((metadata as any).nodes && !metadata.jobs) {
        metadata.jobs = (metadata as any).nodes;
        delete (metadata as any).nodes;
      }
      
      summaries.push({
        id: metadata.id,
        name: metadata.spec.name,
        status: metadata.spec.status as any,
        nodeCount: metadata.jobs.length,
        createdAt: metadata.createdAt,
        startedAt: metadata.startedAt,
        endedAt: metadata.endedAt
      });
    }

    return summaries;
  }

  async delete(planId: string): Promise<void> {
    // Ensure in-memory guard is set even if markDeletedSync wasn't called
    this._deletedPlanIds.add(planId);

    return this.withLock(planId, async () => {
      log.info('Deleting plan', { planId });

      // Tombstone first: mark deleted in plan.json before physical removal.
      // If the directory delete fails (locked files, permissions), the plan
      // won't be rehydrated on next load because loadState/list skip deleted plans.
      // NOTE: the sync tombstone is typically already written by planLifecycle
      // via markDeletedSync() — this is a belt-and-suspenders check.
      try {
        const metadata = await this.store.readPlanMetadata(planId);
        if (metadata && !metadata.deleted) {
          metadata.deleted = true;
          await this.store.writePlanMetadata(metadata);
        }
      } catch (err: any) {
        log.warn(`Could not write delete tombstone for ${planId}`, { error: err.message });
      }

      // Physical delete
      await this.store.deletePlan(planId);
      this._locks.delete(planId); // Clean up lock chain
      log.info('Plan deleted successfully', { planId });
    });
  }

  markDeletedSync(planId: string): void {
    // Record in memory FIRST — even if the disk write fails, no in-memory
    // save path will recreate this plan during this session.
    this._deletedPlanIds.add(planId);

    try {
      const metadata = this.store.readPlanMetadataSync?.(planId);
      if (metadata && !metadata.deleted) {
        metadata.deleted = true;
        this.store.writePlanMetadataSync(metadata);
        log.info('Wrote deletion tombstone (sync)', { planId });
      }
    } catch (err: any) {
      log.warn(`Could not write sync delete tombstone for ${planId}`, { error: err.message });
    }
  }

  /**
   * Auto-wire the snapshot-validation node to depend on all user leaf nodes.
   * 
   * Finds all jobs that have no dependents (excluding SV itself), and sets
   * the SV node's dependencies to those producerIds. If there are no user jobs,
   * SV has no dependencies (it becomes both root and leaf).
   * 
   * @param metadata - Plan metadata to modify in-place.
   */
  private rewireSvDependencies(metadata: StoredPlanMetadata): void {
    const jobs = metadata.spec.jobs || [];
    const svJob = jobs.find((j: any) => j.producerId === '__snapshot-validation__');
    if (!svJob) {
      return; // No SV node (shouldn't happen, but defensive)
    }

    // Find all jobs that are referenced in dependencies (excluding SV)
    const referencedProducers = new Set<string>();
    for (const j of jobs) {
      if ((j as any).producerId === '__snapshot-validation__') {
        continue;
      }
      for (const dep of (j as any).dependencies || []) {
        referencedProducers.add(dep);
      }
    }

    // User leaves = jobs with no dependents (excluding SV)
    const userLeaves = jobs
      .filter((j: any) => 
        j.producerId !== '__snapshot-validation__' && 
        !referencedProducers.has(j.producerId)
      )
      .map((j: any) => j.producerId);

    // SV depends on all user leaves (or has no deps if no user jobs)
    (svJob as any).dependencies = userLeaves;

    // Auto-assign SV to a group if any user jobs use groups.
    // This keeps the SV node visually nested in the diagram alongside grouped jobs.
    const hasGroupedJobs = jobs.some((j: any) =>
      j.producerId !== '__snapshot-validation__' && j.group
    );
    if (hasGroupedJobs && !(svJob as any).group) {
      (svJob as any).group = 'Snapshot Validation';
    }
  }

  /**
   * Build groups from job.group fields and populate metadata.groups/groupStates/groupPathToId.
   * 
   * For each unique group path in jobs:
   * - Auto-create the full hierarchy (split by '/')
   * - Assign stable group UUIDs (reuse if already exists in metadata)
   * - Initialize GroupExecutionState if not present
   * - Link nodes to their groups
   * 
   * @param metadata - Plan metadata to modify in-place.
   * @param jobs - Array of job specs with optional group field.
   */
  private buildGroupsFromJobs(metadata: StoredPlanMetadata, jobs: any[]): void {
    const groups: Record<string, GroupInstance> = metadata.groups || {};
    const groupStates: Record<string, GroupExecutionState> = metadata.groupStates || {};
    const groupPathToId: Record<string, string> = metadata.groupPathToId || {};

    // Collect all unique group paths from jobs
    const groupPaths = new Set<string>();
    for (const job of jobs) {
      if (job.group) {
        groupPaths.add(job.group);
      }
    }

    // Build the group hierarchy
    for (const groupPath of groupPaths) {
      const parts = groupPath.split('/');
      let currentPath = '';
      let parentGroupId: string | undefined;

      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;

        // Reuse existing group or create new one
        let groupId = groupPathToId[currentPath];
        if (!groupId) {
          groupId = uuidv4();
          groupPathToId[currentPath] = groupId;

          const group: GroupInstance = {
            id: groupId,
            name: part,
            path: currentPath,
            parentGroupId,
            childGroupIds: [],
            nodeIds: [],
            allNodeIds: [],
            totalNodes: 0,
          };

          groups[groupId] = group;

          // Link to parent
          if (parentGroupId && groups[parentGroupId]) {
            groups[parentGroupId].childGroupIds.push(groupId);
          }

          // Initialize group state
          groupStates[groupId] = {
            status: 'pending',
            version: 0,
            runningCount: 0,
            succeededCount: 0,
            failedCount: 0,
            blockedCount: 0,
            canceledCount: 0,
          };
        }

        parentGroupId = groupId;
      }
    }

    // Link nodes to their groups
    for (const job of jobs) {
      if (job.group) {
        const nodeId = metadata.producerIdToNodeId[job.producerId];
        if (!nodeId) continue;

        const groupId = groupPathToId[job.group];
        if (!groupId) continue;

        const group = groups[groupId];
        if (group) {
          group.nodeIds.push(nodeId);
          group.allNodeIds.push(nodeId);
          group.totalNodes++;

          // Also add to all ancestor groups' allNodeIds
          let parentId = group.parentGroupId;
          while (parentId) {
            const parent = groups[parentId];
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
    }

    // Update metadata
    metadata.groups = groups;
    metadata.groupStates = groupStates;
    metadata.groupPathToId = groupPathToId;
  }

  /**
   * Build a PlanInstance from metadata without calling buildPlan().
   * 
   * Uses stable node IDs from metadata.producerIdToNodeId. This is the
   * authoritative reconstruction path for scaffolding plans — no UUID
   * regeneration, no duplicate SV injection.
   * 
   * @param metadata - Stored plan metadata.
   * @returns Fully constructed PlanInstance with stable IDs.
   */
  private buildPlanInstanceFromMetadata(metadata: StoredPlanMetadata): PlanInstance {
    // For scaffolding plans, jobs are inline in spec.jobs (with full specs).
    // For finalized plans, spec.jobs is [] and jobs are in metadata.jobs
    // (StoredJobMetadata[] with hasWork/hasPrechecks/hasPostchecks flags).
    const specJobs = metadata.spec.jobs || [];
    const storedJobs = metadata.jobs || [];
    const jobs = specJobs.length > 0 ? specJobs : storedJobs;
    
    const nodes = new Map<string, any>();
    const nodeStates = new Map<string, NodeExecutionState>();
    const producerIdToNodeId = new Map<string, string>();
    const groups = new Map<string, GroupInstance>();
    const groupStates = new Map<string, GroupExecutionState>();
    const groupPathToId = new Map<string, string>();

    // First pass: create nodes from job specs using stable IDs
    for (const jobSpec of jobs) {
      const nodeId = (jobSpec as any).id || metadata.producerIdToNodeId[(jobSpec as any).producerId];
      if (!nodeId) {
        log.warn('Job missing stable ID, skipping', { producerId: (jobSpec as any).producerId });
        continue;
      }

      const node: any = {
        id: nodeId,
        producerId: (jobSpec as any).producerId,
        name: (jobSpec as any).name || (jobSpec as any).producerId,
        type: 'job',
        task: (jobSpec as any).task,
        work: (jobSpec as any).work,
        prechecks: (jobSpec as any).prechecks,
        postchecks: (jobSpec as any).postchecks,
        autoHeal: (jobSpec as any).autoHeal,
        expectsNoChanges: (jobSpec as any).expectsNoChanges,
        baseBranch: (jobSpec as any).baseBranch,
        assignedWorktreePath: (jobSpec as any).assignedWorktreePath,
        dependencies: [], // Resolve in second pass
        dependents: [],
        group: (jobSpec as any).group,
        groupId: undefined, // Resolved after groupPathToId is populated
      };

      nodes.set(nodeId, node);
      producerIdToNodeId.set((jobSpec as any).producerId, nodeId);

      // Restore or initialize node state
      const storedState = metadata.nodeStates[nodeId];
      nodeStates.set(nodeId, storedState || {
        status: (jobSpec as any).dependencies?.length === 0 ? 'ready' : 'pending',
        version: 0,
        attempts: 0
      });
    }

    // Second pass: resolve dependencies
    // Dependencies may be producerIds (scaffolding plans) or nodeIds (finalized plans).
    // Try producerId lookup first, fall back to direct nodeId if the value is already a UUID.
    for (const jobSpec of jobs) {
      const nodeId = (jobSpec as any).id || metadata.producerIdToNodeId[(jobSpec as any).producerId];
      if (!nodeId) {continue;}

      const node = nodes.get(nodeId);
      if (!node) {continue;}

      const deps = (jobSpec as any).dependencies || [];
      const resolvedDeps: string[] = [];
      for (const dep of deps) {
        // Try as producerId first (scaffolding plans store producerIds)
        const depNodeId = producerIdToNodeId.get(dep);
        if (depNodeId) {
          resolvedDeps.push(depNodeId);
        } else if (nodes.has(dep)) {
          // Already a nodeId (finalized plans store resolved UUIDs)
          resolvedDeps.push(dep);
        } else {
          log.warn('Dependency not found, skipping', { producerId: (jobSpec as any).producerId, dep });
        }
      }
      node.dependencies = resolvedDeps;
    }

    // Third pass: compute dependents (reverse edges)
    for (const node of nodes.values()) {
      for (const depId of node.dependencies) {
        const depNode = nodes.get(depId);
        if (depNode) {
          depNode.dependents.push(node.id);
        }
      }
    }

    // Restore groups if present
    if (metadata.groups) {
      for (const [groupId, group] of Object.entries(metadata.groups)) {
        groups.set(groupId, group as GroupInstance);
      }
    }
    if (metadata.groupStates) {
      for (const [groupId, state] of Object.entries(metadata.groupStates)) {
        groupStates.set(groupId, state as GroupExecutionState);
      }
    }
    if (metadata.groupPathToId) {
      for (const [path, id] of Object.entries(metadata.groupPathToId)) {
        groupPathToId.set(path, id as string);
      }
    }

    // Resolve groupId on nodes: map group path → UUID so the state machine
    // can push node transitions to parent groups (updateGroupState checks node.groupId)
    for (const node of nodes.values()) {
      if (node.group && !node.groupId) {
        node.groupId = groupPathToId.get(node.group);
      }
    }

    const planInstance: PlanInstance = {
      id: metadata.id,
      spec: metadata.spec as any,
      jobs: nodes,
      nodeStates,
      producerIdToNodeId,
      roots: metadata.roots || [],
      leaves: metadata.leaves || [],
      groups,
      groupStates,
      groupPathToId,
      parentPlanId: metadata.parentPlanId,
      parentNodeId: metadata.parentNodeId,
      repoPath: metadata.repoPath || this.repoPath,
      baseBranch: metadata.baseBranch || 'main',
      targetBranch: metadata.targetBranch || metadata.baseBranch || 'main',
      worktreeRoot: metadata.worktreeRoot || this.worktreeRoot,
      createdAt: metadata.createdAt,
      startedAt: metadata.startedAt,
      endedAt: metadata.endedAt,
      baseCommitAtStart: metadata.baseCommitAtStart,
      isPaused: metadata.isPaused,
      resumeAfterPlan: metadata.resumeAfterPlan,
      branchReady: metadata.branchReady,
      env: metadata.env,
      snapshot: metadata.snapshot,
      workSummary: metadata.workSummary,
      stateVersion: metadata.stateVersion || 0,
      cleanUpSuccessfulWork: metadata.cleanUpSuccessfulWork !== false,
      maxParallel: metadata.maxParallel || 0,
      // Attach lazy spec loader so the execution engine can hydrate
      // work/prechecks/postchecks from disk when they aren't inline
      definition: new FilePlanDefinition(metadata, this.store),
    } as PlanInstance;

    return planInstance;
  }

  /**
   * Resolve instructionsFile references to inline content.
   * If the work spec has an instructionsFile, reads the file and inlines the
   * content into the spec's instructions field for storage in metadata.spec.jobs.
   */
  private async resolveInstructionsFile(workSpec: WorkSpec | undefined): Promise<WorkSpec | undefined> {
    if (!workSpec) { return undefined; }

    const workWithFile = workSpec as any;
    if (typeof workSpec === 'object' && workWithFile.instructionsFile && typeof workWithFile.instructionsFile === 'string') {
      try {
        const fs = require('fs');
        const path = require('path');
        const filePath = path.resolve(this.repoPath, workWithFile.instructionsFile);
        const content = await fs.promises.readFile(filePath, 'utf8');
        // Return a new spec with inline instructions, without the file ref
        const { instructionsFile, ...rest } = workWithFile;
        return { ...rest, instructions: content } as WorkSpec;
      } catch (err: any) {
        log.warn('Failed to read instructionsFile, storing reference', { file: workWithFile.instructionsFile, error: err.message });
        return workSpec;
      }
    }

    return workSpec;
  }
  
  async writeNodeSpec(planId: string, nodeId: string, phase: 'work' | 'prechecks' | 'postchecks', spec: WorkSpec): Promise<void> {
    await this.store.writeNodeSpec(planId, nodeId, phase, spec);
  }

  async snapshotSpecsForAttempt(planId: string, nodeId: string, attemptNumber: number): Promise<void> {
    await this.store.snapshotSpecsForAttempt(planId, nodeId, attemptNumber);
  }
  
  async migrateLegacy(planId: string): Promise<void> {
    await this.store.migrateLegacy(planId);
  }
}