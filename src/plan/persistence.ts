/**
 * @fileoverview Plan Persistence
 * 
 * Handles saving and loading Plan state to/from disk.
 * Uses JSON format for simplicity and human readability.
 * 
 * @module plan/persistence
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  PlanInstance,
  PlanNode,
  JobNode,
  NodeExecutionState,
  WorkSummary,
  WorkSpec,
  GroupInstance,
  GroupExecutionState,
} from './types';
import { Logger } from '../core/logger';
import { ensureOrchestratorDirs, ensureDir } from '../core';

const log = Logger.for('plan-persistence');

/**
 * Serialized Plan format for persistence
 */
interface SerializedPlan {
  id: string;
  spec: any;
  nodes: SerializedNode[];
  producerIdToNodeId: Record<string, string>;
  roots: string[];
  leaves: string[];
  nodeStates: Record<string, NodeExecutionState>;
  groups?: Record<string, GroupInstance>;
  groupStates?: Record<string, GroupExecutionState>;
  groupPathToId?: Record<string, string>;
  parentPlanId?: string;
  parentNodeId?: string;
  repoPath: string;
  baseBranch: string;
  targetBranch?: string;
  worktreeRoot: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  stateVersion?: number;
  cleanUpSuccessfulWork: boolean;
  maxParallel: number;
  workSummary?: WorkSummary;
  isPaused?: boolean;
}

interface SerializedNode {
  id: string;
  producerId: string;
  name: string;
  type: 'job';
  dependencies: string[];
  dependents: string[];
  // Job-specific
  task?: string;
  work?: WorkSpec;
  prechecks?: WorkSpec;
  postchecks?: WorkSpec;
  instructions?: string;
  baseBranch?: string;
  expectsNoChanges?: boolean;
  autoHeal?: boolean;
  group?: string;
  groupId?: string;
}

/**
 * Manages reading and writing Plan state as JSON files on disk.
 *
 * Each plan is stored as `plan-{id}.json` alongside a `plans-index.json`
 * index file that enables fast listing without parsing every plan file.
 *
 * @example
 * ```typescript
 * const persistence = new PlanPersistence('/data/plans');
 * persistence.save(plan);
 * const loaded = persistence.load(plan.id);
 * ```
 */
export class PlanPersistence {
  private storagePath: string;
  /** Cached workspace root — only set when storagePath follows workspace/.orchestrator/plans */
  private workspacePath: string | undefined;
  
  /**
   * @param storagePath - Directory where plan JSON files are stored. Created if it doesn't exist.
   */
  constructor(storagePath: string) {
    this.storagePath = storagePath;
    // Only derive workspace if storagePath follows workspacePath/.orchestrator/plans convention
    const normalizedStoragePath = path.resolve(storagePath);
    const storageDirName = path.basename(normalizedStoragePath);
    const parentDir = path.dirname(normalizedStoragePath);
    const parentDirName = path.basename(parentDir);

    if (storageDirName === 'plans' && parentDirName === '.orchestrator') {
      this.workspacePath = path.dirname(parentDir);
      ensureOrchestratorDirs(this.workspacePath);
    }
    this.ensureStorageDir();
  }
  
  private ensureStorageDir(): void {
    ensureDir(this.storagePath);
  }
  
  private getPlanFilePath(planId: string): string {
    return path.join(this.storagePath, `plan-${planId}.json`);
  }
  
  private getIndexFilePath(): string {
    return path.join(this.storagePath, 'plans-index.json');
  }
  
  /**
   * Persist a Plan to disk as JSON and update the plans index.
   *
   * @param plan - The plan instance to save.
   * @throws If the file system write fails.
   */
  save(plan: PlanInstance): void {
    try {
      // Guard against deleted directories
      if (this.workspacePath) {
        ensureOrchestratorDirs(this.workspacePath);
      } else {
        this.ensureStorageDir();
      }
      
      const serialized = this.serialize(plan);
      const filePath = this.getPlanFilePath(plan.id);
      fs.writeFileSync(filePath, JSON.stringify(serialized, null, 2));
      
      // Update index
      this.updateIndex(plan.id, plan.spec.name, plan.createdAt);
      
      log.debug(`Saved Plan: ${plan.id}`, { name: plan.spec.name });
    } catch (error: any) {
      log.error(`Failed to save Plan: ${plan.id}`, { error: error.message });
      throw error;
    }
  }
  
  /**
   * Synchronous save — delegates to {@link save}.
   * Provided as a named entry point for shutdown paths where the intent is explicit.
   *
   * @param plan - The plan instance to save.
   */
  saveSync(plan: PlanInstance): void {
    this.save(plan);
  }
  
  /**
   * Load a Plan from disk by its ID.
   *
   * @param planId - The plan identifier (used to derive the filename).
   * @returns The deserialized plan instance, or `undefined` if the file is missing or corrupt.
   */
  load(planId: string): PlanInstance | undefined {
    try {
      const filePath = this.getPlanFilePath(planId);
      if (!fs.existsSync(filePath)) {
        return undefined;
      }
      
      const content = fs.readFileSync(filePath, 'utf-8');
      const serialized: SerializedPlan = JSON.parse(content);
      return this.deserialize(serialized);
    } catch (error: any) {
      log.error(`Failed to load Plan: ${planId}`, { error: error.message });
      return undefined;
    }
  }
  
  /**
   * Load all persisted Plans from the storage directory.
   *
   * Corrupt files are logged and skipped rather than throwing.
   *
   * @returns Array of successfully loaded plan instances.
   */
  loadAll(): PlanInstance[] {
    const plans: PlanInstance[] = [];
    
    try {
      const files = fs.readdirSync(this.storagePath)
        .filter(f => f.startsWith('plan-') && f.endsWith('.json'));
      
      for (const file of files) {
        try {
          const planId = file.replace('plan-', '').replace('.json', '');
          const plan = this.load(planId);
          if (plan) {
            plans.push(plan);
          }
        } catch (error: any) {
          log.warn(`Failed to load Plan file: ${file}`, { error: error.message });
        }
      }
    } catch (error: any) {
      log.error('Failed to load Plans', { error: error.message });
    }
    
    return plans;
  }
  
  /**
   * Delete a Plan's JSON file from disk and remove it from the index.
   *
   * @param planId - The plan identifier.
   * @returns `true` if the file existed and was deleted, `false` otherwise.
   */
  delete(planId: string): boolean {
    try {
      const filePath = this.getPlanFilePath(planId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.removeFromIndex(planId);
        log.debug(`Deleted Plan: ${planId}`);
        return true;
      }
      return false;
    } catch (error: any) {
      log.error(`Failed to delete Plan: ${planId}`, { error: error.message });
      return false;
    }
  }
  
  /**
   * List all known Plan IDs from the index file.
   *
   * @returns Array of plan ID strings; empty if the index is missing or corrupt.
   */
  listplanIds(): string[] {
    try {
      const indexPath = this.getIndexFilePath();
      if (!fs.existsSync(indexPath)) {
        return [];
      }
      
      const content = fs.readFileSync(indexPath, 'utf-8');
      const index: PlanIndex = JSON.parse(content);
      return Object.keys(index.plans);
    } catch (error: any) {
      log.error('Failed to list Plan IDs', { error: error.message });
      return [];
    }
  }
  
  /**
   * Serialize a Plan for storage
   */
  private serialize(plan: PlanInstance): SerializedPlan {
    const nodes: SerializedNode[] = [];
    
    for (const node of plan.nodes.values()) {
      const serializedNode: SerializedNode = {
        id: node.id,
        producerId: node.producerId,
        name: node.name,
        type: node.type,
        dependencies: node.dependencies,
        dependents: node.dependents,
      };
      
      if (node.type === 'job') {
        const jobNode = node as JobNode;
        serializedNode.task = jobNode.task;
        serializedNode.work = jobNode.work;
        serializedNode.prechecks = jobNode.prechecks;
        serializedNode.postchecks = jobNode.postchecks;
        serializedNode.instructions = jobNode.instructions;
        serializedNode.baseBranch = jobNode.baseBranch;
        serializedNode.expectsNoChanges = jobNode.expectsNoChanges;
        serializedNode.autoHeal = jobNode.autoHeal;
        serializedNode.group = jobNode.group;
        serializedNode.groupId = jobNode.groupId;
      }
      
      nodes.push(serializedNode);
    }
    
    // Convert nodeStates Map to object
    const nodeStates: Record<string, NodeExecutionState> = {};
    for (const [nodeId, state] of plan.nodeStates) {
      nodeStates[nodeId] = state;
    }
    
    // Convert producerIdToNodeId Map to object
    const producerIdToNodeId: Record<string, string> = {};
    for (const [producerId, nodeId] of plan.producerIdToNodeId) {
      producerIdToNodeId[producerId] = nodeId;
    }
    
    // Convert groups Map to object
    const groups: Record<string, GroupInstance> = {};
    for (const [groupId, group] of plan.groups) {
      groups[groupId] = group;
    }
    
    // Convert groupStates Map to object
    const groupStates: Record<string, GroupExecutionState> = {};
    for (const [groupId, state] of plan.groupStates) {
      groupStates[groupId] = state;
    }
    
    // Convert groupPathToId Map to object
    const groupPathToId: Record<string, string> = {};
    for (const [path, groupId] of plan.groupPathToId) {
      groupPathToId[path] = groupId;
    }
    
    return {
      id: plan.id,
      spec: plan.spec,
      nodes,
      producerIdToNodeId,
      roots: plan.roots,
      leaves: plan.leaves,
      nodeStates,
      groups,
      groupStates,
      groupPathToId,
      parentPlanId: plan.parentPlanId,
      parentNodeId: plan.parentNodeId,
      repoPath: plan.repoPath,
      baseBranch: plan.baseBranch,
      targetBranch: plan.targetBranch,
      worktreeRoot: plan.worktreeRoot,
      createdAt: plan.createdAt,
      startedAt: plan.startedAt,
      endedAt: plan.endedAt,
      stateVersion: plan.stateVersion,
      cleanUpSuccessfulWork: plan.cleanUpSuccessfulWork,
      maxParallel: plan.maxParallel,
      workSummary: plan.workSummary,
      isPaused: plan.isPaused,
    };
  }
  
  /**
   * Deserialize a Plan from storage
   */
  private deserialize(data: SerializedPlan): PlanInstance {
    // Rebuild nodes Map
    const nodes = new Map<string, PlanNode>();
    
    for (const serializedNode of data.nodes) {
      if (serializedNode.type === 'job') {
        const node: JobNode = {
          id: serializedNode.id,
          producerId: serializedNode.producerId,
          name: serializedNode.name,
          type: 'job',
          task: serializedNode.task || '',
          work: serializedNode.work,
          prechecks: serializedNode.prechecks,
          postchecks: serializedNode.postchecks,
          instructions: serializedNode.instructions,
          baseBranch: serializedNode.baseBranch,
          expectsNoChanges: serializedNode.expectsNoChanges,
          autoHeal: serializedNode.autoHeal,
          group: serializedNode.group,
          groupId: serializedNode.groupId,
          dependencies: serializedNode.dependencies,
          dependents: serializedNode.dependents,
        };
        nodes.set(node.id, node);
      }
    }
    
    // Rebuild nodeStates Map
    const nodeStates = new Map<string, NodeExecutionState>();
    for (const [nodeId, state] of Object.entries(data.nodeStates)) {
      nodeStates.set(nodeId, state);
    }
    
    // Rebuild producerIdToNodeId Map
    const producerIdToNodeId = new Map<string, string>();
    for (const [producerId, nodeId] of Object.entries(data.producerIdToNodeId)) {
      producerIdToNodeId.set(producerId, nodeId);
    }
    
    // Rebuild groups Map
    const groups = new Map<string, GroupInstance>();
    if (data.groups) {
      for (const [groupId, group] of Object.entries(data.groups)) {
        groups.set(groupId, group as GroupInstance);
      }
    }
    
    // Rebuild groupStates Map
    const groupStates = new Map<string, GroupExecutionState>();
    if (data.groupStates) {
      for (const [groupId, state] of Object.entries(data.groupStates)) {
        groupStates.set(groupId, state as GroupExecutionState);
      }
    }
    
    // Rebuild groupPathToId Map
    const groupPathToId = new Map<string, string>();
    if (data.groupPathToId) {
      for (const [path, groupId] of Object.entries(data.groupPathToId)) {
        groupPathToId.set(path, groupId);
      }
    }
    
    return {
      id: data.id,
      spec: data.spec,
      nodes,
      producerIdToNodeId,
      roots: data.roots,
      leaves: data.leaves,
      nodeStates,
      groups,
      groupStates,
      groupPathToId,
      parentPlanId: data.parentPlanId,
      parentNodeId: data.parentNodeId,
      repoPath: data.repoPath,
      baseBranch: data.baseBranch,
      targetBranch: data.targetBranch,
      worktreeRoot: data.worktreeRoot,
      createdAt: data.createdAt,
      startedAt: data.startedAt,
      endedAt: data.endedAt,
      stateVersion: data.stateVersion || 0,
      cleanUpSuccessfulWork: data.cleanUpSuccessfulWork,
      maxParallel: data.maxParallel,
      workSummary: data.workSummary,
      isPaused: data.isPaused,
    };
  }
  
  /**
   * Update the Plan index
   */
  private updateIndex(planId: string, name: string, createdAt: number): void {
    const indexPath = this.getIndexFilePath();
    let index: PlanIndex = { plans: {} };
    
    if (fs.existsSync(indexPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        if (parsed && typeof parsed.plans === 'object') {
          index = parsed;
        }
      } catch {
        // Start fresh if corrupted
      }
    }
    
    index.plans[planId] = { name, createdAt };
    
    // Guard against deleted directories
    if (this.workspacePath) {
      ensureOrchestratorDirs(this.workspacePath);
    } else {
      this.ensureStorageDir();
    }
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  }
  
  /**
   * Remove a Plan from the index
   */
  private removeFromIndex(planId: string): void {
    const indexPath = this.getIndexFilePath();
    if (!fs.existsSync(indexPath)) return;
    
    try {
      const index: PlanIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      delete index.plans[planId];
      
      // Guard against deleted directories
      if (this.workspacePath) {
        ensureOrchestratorDirs(this.workspacePath);
      } else {
        this.ensureStorageDir();
      }
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    } catch {
      // Ignore errors
    }
  }
}

/**
 * Index file format
 */
interface PlanIndex {
  plans: Record<string, { name: string; createdAt: number }>;
}
