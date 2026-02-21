/**
 * @fileoverview File-based plan definition implementation.
 * 
 * Provides a read-only view of plan structure with lazy loading of work specifications
 * from disk. Uses StoredPlanMetadata and IPlanRepositoryStore for efficient access.
 * 
 * @module plan/repository/FilePlanDefinition
 */

import { Logger } from '../../core/logger';
import type { IPlanDefinition, NodeDefinition } from '../../interfaces/IPlanDefinition';
import type { StoredPlanMetadata, IPlanRepositoryStore } from '../../interfaces/IPlanRepositoryStore';
import type { PlanStatus } from '../types/plan';
import type { WorkSpec, AgentSpec } from '../types/specs';

const log = Logger.for('plan-persistence');

/**
 * File-based implementation of IPlanDefinition with lazy spec loading.
 * 
 * Wraps StoredPlanMetadata + IPlanRepositoryStore to provide efficient
 * read-only access to plan structure with lazy loading of specifications.
 */
export class FilePlanDefinition implements IPlanDefinition {
  constructor(
    private readonly metadata: StoredPlanMetadata,
    private readonly store: IPlanRepositoryStore
  ) {}

  get id(): string {
    return this.metadata.id;
  }

  get name(): string {
    return this.metadata.spec.name;
  }

  get status(): PlanStatus {
    // Cast is safe since StoredPlanMetadata.spec contains the plan status
    // and we control the values that get written to storage
    return this.metadata.spec.status as PlanStatus;
  }

  get baseBranch(): string {
    return this.metadata.baseBranch;
  }

  get targetBranch(): string | undefined {
    return this.metadata.targetBranch;
  }

  get maxParallel(): number {
    return this.metadata.maxParallel;
  }

  get createdAt(): number {
    return this.metadata.createdAt;
  }

  getNodeIds(): string[] {
    return this.metadata.jobs.map(node => node.id);
  }

  getNode(nodeId: string): NodeDefinition | undefined {
    const storedNode = this.metadata.jobs.find(node => node.id === nodeId);
    if (!storedNode) {
      return undefined;
    }

    return {
      id: storedNode.id,
      producerId: storedNode.producerId,
      name: storedNode.name,
      task: storedNode.task,
      dependencies: storedNode.dependencies,
      group: storedNode.group,
      hasWork: storedNode.hasWork,
      hasPrechecks: storedNode.hasPrechecks,
      hasPostchecks: storedNode.hasPostchecks
    };
  }

  getNodeByProducerId(producerId: string): NodeDefinition | undefined {
    const storedNode = this.metadata.jobs.find(node => node.producerId === producerId);
    if (!storedNode) {
      return undefined;
    }

    return {
      id: storedNode.id,
      producerId: storedNode.producerId,
      name: storedNode.name,
      task: storedNode.task,
      dependencies: storedNode.dependencies,
      group: storedNode.group,
      hasWork: storedNode.hasWork,
      hasPrechecks: storedNode.hasPrechecks,
      hasPostchecks: storedNode.hasPostchecks
    };
  }

  async getWorkSpec(nodeId: string): Promise<WorkSpec | undefined> {
    const node = this.metadata.jobs.find(n => n.id === nodeId);
    if (!node) {
      log.debug('getWorkSpec: node not found', { nodeId, planId: this.metadata.id });
      return undefined;
    }

    // Check if node has work spec stored on disk
    if (node.hasWork) {
      log.debug('getWorkSpec: reading work spec from disk', { nodeId, planId: this.metadata.id });
      const spec = await this.store.readNodeSpec(this.metadata.id, node.id, 'work');
      if (spec) {
        return spec;
      }
      
      // If hasWork is true but no spec found, this indicates a data consistency issue
      log.warn('getWorkSpec: hasWork=true but no spec found on disk', { 
        nodeId, 
        producerId: node.producerId, 
        planId: this.metadata.id 
      });
    }

    return undefined;
  }

  async getPrechecksSpec(nodeId: string): Promise<WorkSpec | undefined> {
    const node = this.metadata.jobs.find(n => n.id === nodeId);
    if (!node) {
      log.debug('getPrechecksSpec: node not found', { nodeId, planId: this.metadata.id });
      return undefined;
    }

    // Check if node has prechecks spec stored on disk
    if (node.hasPrechecks) {
      log.debug('getPrechecksSpec: reading from disk', { nodeId, planId: this.metadata.id });
      const spec = await this.store.readNodeSpec(this.metadata.id, node.id, 'prechecks');
      if (spec) {
        return spec;
      }
      
      log.warn('getPrechecksSpec: hasPrechecks=true but no spec found on disk', { 
        nodeId, 
        producerId: node.producerId, 
        planId: this.metadata.id 
      });
    }

    return undefined;
  }

  async getPostchecksSpec(nodeId: string): Promise<WorkSpec | undefined> {
    const node = this.metadata.jobs.find(n => n.id === nodeId);
    if (!node) {
      log.debug('getPostchecksSpec: node not found', { nodeId, planId: this.metadata.id });
      return undefined;
    }

    // Check if node has postchecks spec stored on disk
    if (node.hasPostchecks) {
      log.debug('getPostchecksSpec: reading from disk', { nodeId, planId: this.metadata.id });
      const spec = await this.store.readNodeSpec(this.metadata.id, node.id, 'postchecks');
      if (spec) {
        return spec;
      }
      
      log.warn('getPostchecksSpec: hasPostchecks=true but no spec found on disk', { 
        nodeId, 
        producerId: node.producerId, 
        planId: this.metadata.id 
      });
    }

    return undefined;
  }

  getDependencies(nodeId: string): string[] {
    const node = this.metadata.jobs.find(n => n.id === nodeId);
    if (!node) {
      log.debug('getDependencies: node not found', { nodeId, planId: this.metadata.id });
      return [];
    }

    return [...node.dependencies]; // Return a copy to prevent external mutation
  }

  getVerifyRiSpec(): WorkSpec | undefined {
    // The verify-ri spec is stored in the plan spec metadata
    return this.metadata.spec.verifyRiSpec;
  }
}