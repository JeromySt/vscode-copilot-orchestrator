/**
 * @fileoverview Release State Machine
 * 
 * Manages valid state transitions for releases, enforcing transition rules
 * and guard conditions. Emits typed events on transitions.
 * 
 * Key Principles:
 * - All state transitions go through the state machine
 * - Invalid transitions are rejected with detailed error messages
 * - Transition history is tracked for timeline rendering
 * - Thread-safe via mutex to prevent concurrent transitions
 * - Events are emitted for all state changes
 * 
 * @module plan/releaseStateMachine
 */

import { EventEmitter } from 'events';
import type {
  ReleaseDefinition,
  ReleaseStatus,
} from './types/release';
import { Logger } from '../core/logger';

const log = Logger.for('plan');

// ============================================================================
// VALID TRANSITIONS
// ============================================================================

/**
 * Valid state transitions for releases.
 * 
 * Some transitions have guard conditions (e.g., source='from-plans').
 * The transition table represents structural validity; guards are checked
 * in canTransition().
 */
export const VALID_RELEASE_TRANSITIONS: Record<ReleaseStatus, readonly ReleaseStatus[]> = {
  'drafting': ['preparing', 'merging', 'ready-for-pr', 'canceled'],
  'preparing': ['ready-for-pr', 'drafting', 'canceled'],
  'merging': ['ready-for-pr', 'failed', 'canceled'],
  'ready-for-pr': ['creating-pr', 'drafting', 'canceled'],
  'creating-pr': ['pr-active', 'failed', 'canceled'],
  'pr-active': ['monitoring', 'addressing', 'drafting', 'canceled'],
  'monitoring': ['addressing', 'succeeded', 'pr-active', 'canceled'],
  'addressing': ['monitoring', 'failed', 'canceled'],
  'succeeded': [], // Terminal
  'failed': ['drafting', 'preparing', 'ready-for-pr'],    // Can retry from failed
  'canceled': [],  // Terminal
};

/**
 * Terminal states that cannot transition further.
 */
export const TERMINAL_RELEASE_STATES: readonly ReleaseStatus[] = [
  'succeeded',
  'canceled',
] as const;

/**
 * Check if a status is terminal.
 */
export function isTerminalReleaseStatus(status: ReleaseStatus): boolean {
  return TERMINAL_RELEASE_STATES.includes(status);
}

/**
 * Check if a transition is structurally valid (ignoring guard conditions).
 */
export function isValidReleaseTransition(from: ReleaseStatus, to: ReleaseStatus): boolean {
  return VALID_RELEASE_TRANSITIONS[from].includes(to);
}

// ============================================================================
// GUARD CONDITIONS
// ============================================================================

/**
 * Reason a transition was rejected.
 */
export interface TransitionGuardError {
  /** Error code for programmatic handling */
  code: string;
  /** Human-readable error message */
  message: string;
}

/**
 * Check guard conditions for a transition.
 * 
 * @param release - The release attempting to transition
 * @param to - The target status
 * @returns null if transition is allowed, error object otherwise
 */
function checkTransitionGuards(
  release: ReleaseDefinition,
  to: ReleaseStatus
): TransitionGuardError | null {
  const from = release.status;

  // drafting -> merging: requires source='from-plans'
  if (from === 'drafting' && to === 'merging') {
    if (release.source !== 'from-plans') {
      return {
        code: 'INVALID_SOURCE',
        message: `Cannot transition to 'merging' from source='${release.source}'. Only 'from-plans' releases can merge.`,
      };
    }
    if (release.planIds.length === 0) {
      return {
        code: 'NO_PLANS',
        message: 'Cannot transition to \'merging\' with no plans to merge.',
      };
    }
  }

  // drafting -> ready-for-pr (skip merge): typically source='from-branch'
  // No hard guard here - allow both sources to go directly to ready-for-pr
  // (plan-based can skip merge if plans already merged manually)

  // preparing -> ready-for-pr: all preparation tasks must be completed
  if (from === 'preparing' && to === 'ready-for-pr') {
    const tasks = release.preparationTasks || [];
    const incompleteTasks = tasks.filter(
      (t) => t.status !== 'completed' && t.status !== 'skipped'
    );
    if (incompleteTasks.length > 0) {
      return {
        code: 'INCOMPLETE_TASKS',
        message: `Cannot transition to 'ready-for-pr' with ${incompleteTasks.length} incomplete preparation tasks.`,
      };
    }
  }

  return null;
}

// ============================================================================
// STATE MACHINE EVENTS
// ============================================================================

/**
 * Event emitted when release status changes.
 */
export interface ReleaseTransitionEvent {
  releaseId: string;
  from: ReleaseStatus;
  to: ReleaseStatus;
  timestamp: number;
  reason?: string;
}

/**
 * Events emitted by the state machine.
 */
export interface ReleaseStateMachineEvents {
  'transition': (event: ReleaseTransitionEvent) => void;
  'completed': (releaseId: string, finalStatus: 'succeeded' | 'failed' | 'canceled') => void;
}

// ============================================================================
// STATE MACHINE
// ============================================================================

/**
 * Release State Machine — manages state transitions for a single release.
 * 
 * Every status change must flow through {@link transition}, which validates
 * the transition, checks guard conditions, updates timestamps, and emits events.
 * 
 * Thread-safe via internal mutex to prevent concurrent transitions.
 * 
 * @example
 * ```typescript
 * const sm = new ReleaseStateMachine(release);
 * sm.on('transition', (evt) => console.log(`${evt.from} → ${evt.to}`));
 * const result = sm.transition('merging', 'All plans ready to merge');
 * if (!result.success) {
 *   console.error(result.error);
 * }
 * ```
 */
export class ReleaseStateMachine extends EventEmitter {
  private transitionMutex = false;

  /**
   * @param release - The release definition whose state this machine manages.
   */
  constructor(private readonly release: ReleaseDefinition) {
    super();
  }

  /**
   * Get the current status of the release.
   */
  getCurrentStatus(): ReleaseStatus {
    return this.release.status;
  }

  /**
   * Check if a transition is valid for the current state.
   * 
   * @param to - The target status
   * @returns Object with { valid: boolean, error?: string }
   */
  canTransition(to: ReleaseStatus): { valid: boolean; error?: string } {
    const from = this.release.status;

    // Check structural validity
    if (!isValidReleaseTransition(from, to)) {
      return {
        valid: false,
        error: `Invalid transition: ${from} -> ${to}. Valid transitions from ${from}: ${VALID_RELEASE_TRANSITIONS[from].join(', ')}`,
      };
    }

    // Check guard conditions
    const guardError = checkTransitionGuards(this.release, to);
    if (guardError) {
      return {
        valid: false,
        error: guardError.message,
      };
    }

    return { valid: true };
  }

  /**
   * Transition the release to a new status.
   * 
   * Thread-safe: Prevents concurrent transitions via simple mutex.
   * 
   * @param newStatus - The target status
   * @param reason - Optional reason for the transition
   * @returns Object with { success: boolean, error?: string }
   */
  transition(
    newStatus: ReleaseStatus,
    reason?: string
  ): { success: boolean; error?: string } {
    // Acquire mutex
    if (this.transitionMutex) {
      return {
        success: false,
        error: 'Concurrent transition in progress',
      };
    }
    this.transitionMutex = true;

    try {
      const currentStatus = this.release.status;

      // Check if transition is valid
      const canTransitionResult = this.canTransition(newStatus);
      if (!canTransitionResult.valid) {
        log.warn(
          `Transition rejected: ${this.release.id} ${currentStatus} -> ${newStatus}`,
          { releaseId: this.release.id, error: canTransitionResult.error }
        );
        return {
          success: false,
          error: canTransitionResult.error,
        };
      }

      // Apply the transition
      const now = Date.now();
      this.release.status = newStatus;

      // Record in state history
      this.release.stateHistory.push({
        from: currentStatus,
        to: newStatus,
        timestamp: now,
        reason,
      });

      // Update timestamps based on status
      if (newStatus === 'merging' && !this.release.startedAt) {
        this.release.startedAt = now;
      }
      if (isTerminalReleaseStatus(newStatus) && !this.release.endedAt) {
        this.release.endedAt = now;
      }

      log.info(`Release transition: ${currentStatus} -> ${newStatus}`, {
        releaseId: this.release.id,
        releaseName: this.release.name,
        reason,
      });

      // Emit transition event
      const event: ReleaseTransitionEvent = {
        releaseId: this.release.id,
        from: currentStatus,
        to: newStatus,
        timestamp: now,
        reason,
      };
      this.emit('transition', event);

      // Emit completion event if terminal
      if (isTerminalReleaseStatus(newStatus)) {
        this.emit('completed', this.release.id, newStatus as 'succeeded' | 'failed' | 'canceled');
      }

      return { success: true };
    } finally {
      // Release mutex
      this.transitionMutex = false;
    }
  }

  /**
   * Get the full state history.
   */
  getStateHistory(): ReleaseDefinition['stateHistory'] {
    return this.release.stateHistory;
  }

  /**
   * Check if the release is in a terminal state.
   */
  isTerminal(): boolean {
    return isTerminalReleaseStatus(this.release.status);
  }
}
