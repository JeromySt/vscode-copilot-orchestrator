/**
 * @fileoverview Read-only plan structure with lazy spec loading.
 * 
 * Provides a read-only view of plan structure with efficient lazy loading
 * of work specifications from disk. Used for plan inspection without
 * loading the entire plan state into memory.
 * 
 * @module interfaces/IPlanDefinition
 */

import type { PlanStatus } from '../plan/types/plan';
import type { WorkSpec } from '../plan/types/specs';

/**
 * Lightweight node metadata without full specifications.
 * Contains essential node information for navigation and filtering.
 */
export interface NodeDefinition {
  /** Node unique identifier */
  id: string;
  
  /** Producer identifier */
  producerId: string;
  
  /** Human-readable node name */
  name: string;
  
  /** Brief task description */
  task?: string;
  
  /** Node dependencies */
  dependencies: string[];
  
  /** Group path if part of a group */
  group?: string;
  
  /** Whether this node has work specifications */
  hasWork: boolean;
  
  /** Whether this node has prechecks specifications */
  hasPrechecks: boolean;
  
  /** Whether this node has postchecks specifications */
  hasPostchecks: boolean;
}

/**
 * Read-only plan definition with lazy specification loading.
 * Provides efficient access to plan structure and selective loading of specs.
 */
export interface IPlanDefinition {
  /** Plan unique identifier */
  readonly id: string;
  
  /** Plan display name */
  readonly name: string;
  
  /** Current plan status */
  readonly status: PlanStatus;
  
  /** Base branch name */
  readonly baseBranch: string;
  
  /** Target branch name */
  readonly targetBranch?: string;
  
  /** Maximum parallel nodes */
  readonly maxParallel: number;
  
  /** Plan creation timestamp */
  readonly createdAt: number;
  
  /**
   * Get all node IDs in the plan.
   * @returns Array of node identifiers
   */
  getNodeIds(): string[];
  
  /**
   * Get node definition by node ID.
   * @param nodeId Node unique identifier
   * @returns Node definition or undefined if not found
   */
  getNode(nodeId: string): NodeDefinition | undefined;
  
  /**
   * Get node definition by producer ID.
   * @param producerId Producer identifier
   * @returns Node definition or undefined if not found
   */
  getNodeByProducerId(producerId: string): NodeDefinition | undefined;
  
  /**
   * Get work specification for a node (lazy loaded from disk).
   * @param nodeId Node unique identifier
   * @returns Work specification or undefined if not available
   */
  getWorkSpec(nodeId: string): Promise<WorkSpec | undefined>;
  
  /**
   * Get prechecks specification for a node (lazy loaded from disk).
   * @param nodeId Node unique identifier
   * @returns Prechecks specification or undefined if not available
   */
  getPrechecksSpec(nodeId: string): Promise<WorkSpec | undefined>;
  
  /**
   * Get postchecks specification for a node (lazy loaded from disk).
   * @param nodeId Node unique identifier
   * @returns Postchecks specification or undefined if not available
   */
  getPostchecksSpec(nodeId: string): Promise<WorkSpec | undefined>;
  
  /**
   * Get node dependencies.
   * @param nodeId Node unique identifier
   * @returns Array of dependency node IDs
   */
  getDependencies(nodeId: string): string[];
  
  /**
   * Get verify-ri specification if available.
   * @returns Verify-ri specification or undefined if not set
   */
  getVerifyRiSpec(): WorkSpec | undefined;
}