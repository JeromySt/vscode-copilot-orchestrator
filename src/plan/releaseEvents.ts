/**
 * @fileoverview Release Event Emitter
 *
 * Typed event emitter for all release lifecycle events.
 * Used by the UI to update views when release execution progresses.
 *
 * @module plan/releaseEvents
 */

import { EventEmitter } from 'events';
import type {
  ReleaseDefinition,
  ReleaseStatus,
  ReleaseProgress,
  PRMonitorCycle,
  PRActionTaken,
} from './types/release';

/**
 * Events emitted by the Release Manager.
 *
 * Subscribe with `emitter.on('release:created', handler)`.
 */
export interface ReleaseEvents {
  /** Emitted when a new release is created */
  'release:created': (release: ReleaseDefinition) => void;

  /** Emitted when release status changes */
  'release:statusChanged': (releaseId: string, oldStatus: ReleaseStatus, newStatus: ReleaseStatus) => void;

  /** Emitted when release progress updates */
  'release:progress': (releaseId: string, progress: ReleaseProgress) => void;

  /** Emitted when a PR monitoring cycle completes */
  'release:prCycle': (releaseId: string, cycle: PRMonitorCycle) => void;

  /** Emitted when a release completes successfully */
  'release:completed': (release: ReleaseDefinition) => void;

  /** Emitted when a release fails */
  'release:failed': (release: ReleaseDefinition, error: string) => void;

  /** Emitted when a release is canceled */
  'release:canceled': (releaseId: string) => void;

  /** Emitted when a release is deleted */
  'release:deleted': (releaseId: string) => void;

  /** Emitted when a preparation task status changes */
  'release:taskStatusChanged': (releaseId: string, taskId: string, status: import('./types/releasePrep').PrepTaskStatus) => void;

  /** Emitted when plans are added to a release */
  'release:plansAdded': (releaseId: string, planIds: string[]) => void;

  /** Emitted when an existing PR is adopted for a release */
  'release:prAdopted': (releaseId: string, prNumber: number) => void;

  /** Emitted when a preparation task outputs a log line */
  'release:taskOutput': (releaseId: string, taskId: string, line: string) => void;

  /** Emitted when an autonomous action is taken on a PR */
  'release:actionTaken': (releaseId: string, action: PRActionTaken & { timestamp?: number }) => void;

  /** Emitted when findings are being processed by the AI fixer */
  'release:findingsProcessing': (releaseId: string, findingIds: string[], status: 'queued' | 'processing' | 'started' | 'completed' | 'failed') => void;

  /** Emitted when findings have been resolved */
  'release:findingsResolved': (releaseId: string, findingIds: string[], hasCommit: boolean) => void;

  /** Emitted when PR monitoring stops */
  'release:monitoringStopped': (releaseId: string, cycleCount: number) => void;

  /** Emitted when the polling interval changes */
  'release:pollIntervalChanged': (releaseId: string, newIntervalTicks: number) => void;
}

/**
 * Typed event emitter for release lifecycle events.
 *
 * Wraps Node's EventEmitter with strongly-typed event signatures
 * matching {@link ReleaseEvents}.
 */
export class ReleaseEventEmitter extends EventEmitter {
  // Typed overloads for type-safe event subscription
  on<K extends keyof ReleaseEvents>(event: K, listener: ReleaseEvents[K]): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  emit<K extends keyof ReleaseEvents>(event: K, ...args: Parameters<ReleaseEvents[K]>): boolean;
  emit(event: string | symbol, ...args: any[]): boolean;
  emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Emit a release:created event.
   */
  emitReleaseCreated(release: ReleaseDefinition): void {
    this.emit('release:created', release);
  }

  /**
   * Emit a release:statusChanged event.
   */
  emitReleaseStatusChanged(releaseId: string, oldStatus: ReleaseStatus, newStatus: ReleaseStatus): void {
    this.emit('release:statusChanged', releaseId, oldStatus, newStatus);
  }

  /**
   * Emit a release:progress event.
   */
  emitReleaseProgress(releaseId: string, progress: ReleaseProgress): void {
    this.emit('release:progress', releaseId, progress);
  }

  /**
   * Emit a release:prCycle event.
   */
  emitReleasePrCycle(releaseId: string, cycle: PRMonitorCycle): void {
    this.emit('release:prCycle', releaseId, cycle);
  }

  /**
   * Emit a release:completed event.
   */
  emitReleaseCompleted(release: ReleaseDefinition): void {
    this.emit('release:completed', release);
  }

  /**
   * Emit a release:failed event.
   */
  emitReleaseFailed(release: ReleaseDefinition, error: string): void {
    this.emit('release:failed', release, error);
  }

  /**
   * Emit a release:canceled event.
   */
  emitReleaseCanceled(releaseId: string): void {
    this.emit('release:canceled', releaseId);
  }

  /**
   * Emit a release:deleted event.
   */
  emitReleaseDeleted(releaseId: string): void {
    this.emit('release:deleted', releaseId);
  }

  /**
   * Emit a release:taskStatusChanged event.
   */
  emitReleaseTaskStatusChanged(releaseId: string, taskId: string, status: import('./types/releasePrep').PrepTaskStatus): void {
    this.emit('release:taskStatusChanged', releaseId, taskId, status);
  }

  /**
   * Emit a release:plansAdded event.
   */
  emitReleasePlansAdded(releaseId: string, planIds: string[]): void {
    this.emit('release:plansAdded', releaseId, planIds);
  }

  /**
   * Emit a release:prAdopted event.
   */
  emitReleasePrAdopted(releaseId: string, prNumber: number): void {
    this.emit('release:prAdopted', releaseId, prNumber);
  }

  /**
   * Emit a release:taskOutput event.
   */
  emitReleaseTaskOutput(releaseId: string, taskId: string, line: string): void {
    this.emit('release:taskOutput', releaseId, taskId, line);
  }

  /**
   * Emit a release:actionTaken event.
   */
  emitReleaseActionTaken(releaseId: string, action: PRActionTaken & { timestamp?: number }): void {
    this.emit('release:actionTaken', releaseId, action);
  }

  /**
   * Emit a release:findingsProcessing event.
   */
  emitFindingsProcessing(releaseId: string, findingIds: string[], status: 'queued' | 'processing' | 'started' | 'completed' | 'failed'): void {
    this.emit('release:findingsProcessing', releaseId, findingIds, status);
  }

  /**
   * Emit a release:findingsResolved event.
   */
  emitFindingsResolved(releaseId: string, findingIds: string[], hasCommit: boolean): void {
    this.emit('release:findingsResolved', releaseId, findingIds, hasCommit);
  }

  /**
   * Emit a release:monitoringStopped event.
   */
  emitMonitoringStopped(releaseId: string, cycleCount: number): void {
    this.emit('release:monitoringStopped', releaseId, cycleCount);
  }

  /**
   * Emit a release:pollIntervalChanged event.
   */
  emitPollIntervalChanged(releaseId: string, newIntervalTicks: number): void {
    this.emit('release:pollIntervalChanged', releaseId, newIntervalTicks);
  }
}
