/**
 * @fileoverview Plan Event Emitter
 *
 * Typed event emitter for all plan and node state changes.
 * Used by the UI to update views when plan execution progresses.
 *
 * @module plan/planEvents
 */

import { EventEmitter } from 'events';
import type {
  PlanInstance,
  PlanStatus,
  NodeStatus,
  NodeTransitionEvent,
} from './types';

/**
 * Events emitted by the PlanRunner.
 *
 * Subscribe with `emitter.on('planCreated', handler)`.
 */
export interface PlanRunnerEvents {
  'planCreated': (plan: PlanInstance) => void;
  'planStarted': (plan: PlanInstance) => void;
  'planCompleted': (plan: PlanInstance, status: PlanStatus) => void;
  'planDeleted': (planId: string) => void;
  'planUpdated': (planId: string) => void;
  'nodeTransition': (event: NodeTransitionEvent) => void;
  'nodeStarted': (planId: string, nodeId: string) => void;
  'nodeCompleted': (planId: string, nodeId: string, success: boolean) => void;
  'nodeRetry': (planId: string, nodeId: string) => void;
  'nodeUpdated': (planId: string, nodeId: string) => void;
}

/**
 * Typed event emitter for plan/node state changes.
 *
 * Wraps Node's EventEmitter with strongly-typed event signatures
 * matching {@link PlanRunnerEvents}.
 */
export class PlanEventEmitter extends EventEmitter {
  /**
   * Emit a planCreated event.
   */
  emitPlanCreated(plan: PlanInstance): void {
    this.emit('planCreated', plan);
  }

  /**
   * Emit a planStarted event.
   */
  emitPlanStarted(plan: PlanInstance): void {
    this.emit('planStarted', plan);
  }

  /**
   * Emit a planCompleted event.
   */
  emitPlanCompleted(plan: PlanInstance, status: PlanStatus): void {
    this.emit('planCompleted', plan, status);
  }

  /**
   * Emit a planDeleted event.
   */
  emitPlanDeleted(planId: string): void {
    this.emit('planDeleted', planId);
  }

  /**
   * Emit a planUpdated event.
   */
  emitPlanUpdated(planId: string): void {
    this.emit('planUpdated', planId);
  }

  /**
   * Emit a nodeTransition event.
   */
  emitNodeTransition(event: NodeTransitionEvent): void {
    this.emit('nodeTransition', event);
  }

  /**
   * Emit a nodeStarted event.
   */
  emitNodeStarted(planId: string, nodeId: string): void {
    this.emit('nodeStarted', planId, nodeId);
  }

  /**
   * Emit a nodeCompleted event.
   */
  emitNodeCompleted(planId: string, nodeId: string, success: boolean): void {
    this.emit('nodeCompleted', planId, nodeId, success);
  }

  /**
   * Emit a nodeRetry event.
   */
  emitNodeRetry(planId: string, nodeId: string): void {
    this.emit('nodeRetry', planId, nodeId);
  }

  /**
   * Emit a nodeUpdated event.
   */
  emitNodeUpdated(planId: string, nodeId: string): void {
    this.emit('nodeUpdated', planId, nodeId);
  }

  /**
   * Emit a combined node transition event for UI updates.
   */
  emitNodeTransitionFull(event: {
    planId: string;
    nodeId: string;
    previousStatus: NodeStatus;
    newStatus: NodeStatus;
    reason: string;
  }): void {
    this.emit('nodeTransition', event);
    this.emit('nodeUpdated', event.planId, event.nodeId);
    this.emit('planUpdated', event.planId);
  }
}
