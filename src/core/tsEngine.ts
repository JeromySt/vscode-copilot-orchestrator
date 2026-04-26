/**
 * @fileoverview TypeScript Orchestration Engine
 *
 * Wraps the existing PlanRunner into the IOrchestrationEngine interface.
 * This is the "zero-change" path — all existing behavior is preserved.
 *
 * @module core/tsEngine
 */

import { EventEmitter } from 'events';
import type { IPlanRunner } from '../interfaces/IPlanRunner';
import type {
  IOrchestrationEngine,
  EngineKind,
} from '../interfaces/IOrchestrationEngine';
import type {
  PlanSpec,
  PlanInstance,
  PlanStatus,
  NodeStatus,
  ExecutionPhase,
  AttemptRecord,
} from '../plan/types';
import type { RetryNodeOptions } from '../interfaces/IPlanRunner';
import { Logger } from './logger';

const log = Logger.for('ts-engine');

/**
 * Wraps the existing TypeScript PlanRunner into the IOrchestrationEngine interface.
 *
 * All method calls delegate directly to PlanRunner. Events from PlanRunner are
 * re-emitted on this instance so consumers only need one event source.
 */
export class TsOrchestrationEngine extends EventEmitter implements IOrchestrationEngine {
  readonly kind: EngineKind = 'typescript';

  constructor(private readonly planRunner: IPlanRunner) {
    super();
    // Forward all PlanRunner events to engine consumers
    const forwardEvent = (event: string) => {
      this.planRunner.on(event, (...args: unknown[]) => this.emit(event, ...args));
    };
    for (const event of [
      'planCreated', 'planStarted', 'planCompleted', 'planDeleted',
      'planUpdated', 'planReshaped',
      'nodeTransition', 'nodeStarted', 'nodeCompleted', 'nodeRetry', 'nodeUpdated',
    ]) {
      forwardEvent(event);
    }
  }

  async initialize(): Promise<void> {
    log.info('Initializing TypeScript engine');
    await this.planRunner.initialize();
  }

  async shutdown(): Promise<void> {
    log.info('Shutting down TypeScript engine');
    await this.planRunner.shutdown();
  }

  persistSync(): void {
    this.planRunner.persistSync();
  }

  async enqueue(spec: PlanSpec): Promise<PlanInstance> {
    return this.planRunner.enqueue(spec);
  }

  async enqueueJob(jobSpec: Parameters<IOrchestrationEngine['enqueueJob']>[0]): Promise<PlanInstance> {
    return this.planRunner.enqueueJob(jobSpec);
  }

  get(planId: string) { return this.planRunner.get(planId); }
  getAll() { return this.planRunner.getAll(); }
  getByStatus(status: PlanStatus) { return this.planRunner.getByStatus(status); }
  getStatus(planId: string) { return this.planRunner.getStatus(planId); }
  getGlobalStats() { return this.planRunner.getGlobalStats(); }

  getNodeLogs(planId: string, nodeId: string, phase?: 'all' | ExecutionPhase, attemptNumber?: number) {
    return this.planRunner.getNodeLogs(planId, nodeId, phase, attemptNumber);
  }

  getNodeAttempts(planId: string, nodeId: string) {
    return this.planRunner.getNodeAttempts(planId, nodeId);
  }

  getNodeFailureContext(planId: string, nodeId: string) {
    return this.planRunner.getNodeFailureContext(planId, nodeId);
  }

  async pause(planId: string) { return this.planRunner.pause(planId); }
  async resume(planId: string) { return this.planRunner.resume(planId); }
  async cancel(planId: string) { return this.planRunner.cancel(planId); }
  async delete(planId: string) { return this.planRunner.delete(planId); }

  async retryNode(planId: string, nodeId: string, options?: RetryNodeOptions) {
    return this.planRunner.retryNode(planId, nodeId, options);
  }

  async forceFailNode(planId: string, nodeId: string) {
    return this.planRunner.forceFailNode(planId, nodeId);
  }

  async getDaemonLogs(): Promise<string | null> {
    return null; // TS engine has no daemon
  }

  async getRepoLogs(_repoRoot: string): Promise<string | null> {
    return null; // TS engine doesn't write repo logs
  }
}
