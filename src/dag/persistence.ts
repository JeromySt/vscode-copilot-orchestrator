/**
 * @fileoverview DAG Persistence
 * 
 * Handles saving and loading DAG state to/from disk.
 * Uses JSON format for simplicity and human readability.
 * 
 * @module dag/persistence
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  DagInstance,
  DagNode,
  JobNode,
  SubDagNode,
  NodeExecutionState,
  WorkSummary,
} from './types';
import { Logger } from '../core/logger';

const log = Logger.for('dag-persistence');

/**
 * Serialized DAG format for persistence
 */
interface SerializedDag {
  id: string;
  spec: any;
  nodes: SerializedNode[];
  producerIdToNodeId: Record<string, string>;
  roots: string[];
  leaves: string[];
  nodeStates: Record<string, NodeExecutionState>;
  parentDagId?: string;
  parentNodeId?: string;
  repoPath: string;
  baseBranch: string;
  targetBranch?: string;
  worktreeRoot: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  cleanUpSuccessfulWork: boolean;
  maxParallel: number;
  workSummary?: WorkSummary;
}

interface SerializedNode {
  id: string;
  producerId: string;
  name: string;
  type: 'job' | 'subdag';
  dependencies: string[];
  dependents: string[];
  // Job-specific
  task?: string;
  work?: string;
  prechecks?: string;
  postchecks?: string;
  instructions?: string;
  baseBranch?: string;
  // SubDag-specific
  childSpec?: any;
  maxParallel?: number;
  childDagId?: string;
}

/**
 * DAG Persistence Manager
 */
export class DagPersistence {
  private storagePath: string;
  
  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.ensureStorageDir();
  }
  
  private ensureStorageDir(): void {
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }
  }
  
  private getDagFilePath(dagId: string): string {
    return path.join(this.storagePath, `dag-${dagId}.json`);
  }
  
  private getIndexFilePath(): string {
    return path.join(this.storagePath, 'dags-index.json');
  }
  
  /**
   * Save a DAG to disk
   */
  save(dag: DagInstance): void {
    try {
      const serialized = this.serialize(dag);
      const filePath = this.getDagFilePath(dag.id);
      fs.writeFileSync(filePath, JSON.stringify(serialized, null, 2));
      
      // Update index
      this.updateIndex(dag.id, dag.spec.name, dag.createdAt);
      
      log.debug(`Saved DAG: ${dag.id}`, { name: dag.spec.name });
    } catch (error: any) {
      log.error(`Failed to save DAG: ${dag.id}`, { error: error.message });
      throw error;
    }
  }
  
  /**
   * Save a DAG synchronously (for shutdown)
   */
  saveSync(dag: DagInstance): void {
    this.save(dag);
  }
  
  /**
   * Load a DAG from disk
   */
  load(dagId: string): DagInstance | undefined {
    try {
      const filePath = this.getDagFilePath(dagId);
      if (!fs.existsSync(filePath)) {
        return undefined;
      }
      
      const content = fs.readFileSync(filePath, 'utf-8');
      const serialized: SerializedDag = JSON.parse(content);
      return this.deserialize(serialized);
    } catch (error: any) {
      log.error(`Failed to load DAG: ${dagId}`, { error: error.message });
      return undefined;
    }
  }
  
  /**
   * Load all DAGs from disk
   */
  loadAll(): DagInstance[] {
    const dags: DagInstance[] = [];
    
    try {
      const files = fs.readdirSync(this.storagePath)
        .filter(f => f.startsWith('dag-') && f.endsWith('.json'));
      
      for (const file of files) {
        try {
          const dagId = file.replace('dag-', '').replace('.json', '');
          const dag = this.load(dagId);
          if (dag) {
            dags.push(dag);
          }
        } catch (error: any) {
          log.warn(`Failed to load DAG file: ${file}`, { error: error.message });
        }
      }
    } catch (error: any) {
      log.error('Failed to load DAGs', { error: error.message });
    }
    
    return dags;
  }
  
  /**
   * Delete a DAG from disk
   */
  delete(dagId: string): boolean {
    try {
      const filePath = this.getDagFilePath(dagId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.removeFromIndex(dagId);
        log.debug(`Deleted DAG: ${dagId}`);
        return true;
      }
      return false;
    } catch (error: any) {
      log.error(`Failed to delete DAG: ${dagId}`, { error: error.message });
      return false;
    }
  }
  
  /**
   * Get list of all DAG IDs
   */
  listDagIds(): string[] {
    try {
      const indexPath = this.getIndexFilePath();
      if (!fs.existsSync(indexPath)) {
        return [];
      }
      
      const content = fs.readFileSync(indexPath, 'utf-8');
      const index: DagIndex = JSON.parse(content);
      return Object.keys(index.dags);
    } catch (error: any) {
      log.error('Failed to list DAG IDs', { error: error.message });
      return [];
    }
  }
  
  /**
   * Serialize a DAG for storage
   */
  private serialize(dag: DagInstance): SerializedDag {
    const nodes: SerializedNode[] = [];
    
    for (const node of dag.nodes.values()) {
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
      } else if (node.type === 'subdag') {
        const subDagNode = node as SubDagNode;
        serializedNode.childSpec = subDagNode.childSpec;
        serializedNode.maxParallel = subDagNode.maxParallel;
        serializedNode.childDagId = subDagNode.childDagId;
      }
      
      nodes.push(serializedNode);
    }
    
    // Convert nodeStates Map to object
    const nodeStates: Record<string, NodeExecutionState> = {};
    for (const [nodeId, state] of dag.nodeStates) {
      nodeStates[nodeId] = state;
    }
    
    // Convert producerIdToNodeId Map to object
    const producerIdToNodeId: Record<string, string> = {};
    for (const [producerId, nodeId] of dag.producerIdToNodeId) {
      producerIdToNodeId[producerId] = nodeId;
    }
    
    return {
      id: dag.id,
      spec: dag.spec,
      nodes,
      producerIdToNodeId,
      roots: dag.roots,
      leaves: dag.leaves,
      nodeStates,
      parentDagId: dag.parentDagId,
      parentNodeId: dag.parentNodeId,
      repoPath: dag.repoPath,
      baseBranch: dag.baseBranch,
      targetBranch: dag.targetBranch,
      worktreeRoot: dag.worktreeRoot,
      createdAt: dag.createdAt,
      startedAt: dag.startedAt,
      endedAt: dag.endedAt,
      cleanUpSuccessfulWork: dag.cleanUpSuccessfulWork,
      maxParallel: dag.maxParallel,
      workSummary: dag.workSummary,
    };
  }
  
  /**
   * Deserialize a DAG from storage
   */
  private deserialize(data: SerializedDag): DagInstance {
    // Rebuild nodes Map
    const nodes = new Map<string, DagNode>();
    
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
          dependencies: serializedNode.dependencies,
          dependents: serializedNode.dependents,
        };
        nodes.set(node.id, node);
      } else if (serializedNode.type === 'subdag') {
        const node: SubDagNode = {
          id: serializedNode.id,
          producerId: serializedNode.producerId,
          name: serializedNode.name,
          type: 'subdag',
          childSpec: serializedNode.childSpec,
          maxParallel: serializedNode.maxParallel,
          childDagId: serializedNode.childDagId,
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
    
    return {
      id: data.id,
      spec: data.spec,
      nodes,
      producerIdToNodeId,
      roots: data.roots,
      leaves: data.leaves,
      nodeStates,
      parentDagId: data.parentDagId,
      parentNodeId: data.parentNodeId,
      repoPath: data.repoPath,
      baseBranch: data.baseBranch,
      targetBranch: data.targetBranch,
      worktreeRoot: data.worktreeRoot,
      createdAt: data.createdAt,
      startedAt: data.startedAt,
      endedAt: data.endedAt,
      cleanUpSuccessfulWork: data.cleanUpSuccessfulWork,
      maxParallel: data.maxParallel,
      workSummary: data.workSummary,
    };
  }
  
  /**
   * Update the DAG index
   */
  private updateIndex(dagId: string, name: string, createdAt: number): void {
    const indexPath = this.getIndexFilePath();
    let index: DagIndex = { dags: {} };
    
    if (fs.existsSync(indexPath)) {
      try {
        index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      } catch {
        // Start fresh if corrupted
      }
    }
    
    index.dags[dagId] = { name, createdAt };
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  }
  
  /**
   * Remove a DAG from the index
   */
  private removeFromIndex(dagId: string): void {
    const indexPath = this.getIndexFilePath();
    if (!fs.existsSync(indexPath)) return;
    
    try {
      const index: DagIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      delete index.dags[dagId];
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    } catch {
      // Ignore errors
    }
  }
}

/**
 * Index file format
 */
interface DagIndex {
  dags: Record<string, { name: string; createdAt: number }>;
}
