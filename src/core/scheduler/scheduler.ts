/**
 * @fileoverview Base Scheduler - Generic work unit queue management.
 * 
 * Provides the common orchestration mechanics shared by JobRunner and PlanRunner:
 * - Queue management (enqueue, dequeue)
 * - Concurrency control (maxConcurrency)
 * - Pump loop (periodic scheduling)
 * - Persistence (save/load state)
 * - Event emission (state changes)
 * 
 * The "how" of execution is delegated to an ExecutionStrategy.
 * 
 * @module core/scheduler/scheduler
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Logger, ComponentLogger } from '../logger';
import {
  WorkUnit,
  WorkUnitSpec,
  WorkUnitStatus,
  IScheduler,
  SchedulerConfig,
  ExecutionStrategy,
  isTerminalStatus,
} from './types';

/**
 * Base scheduler implementation.
 * 
 * @template TSpec - Work unit specification type
 * @template TState - Work unit state type
 */
export class Scheduler<TSpec extends WorkUnitSpec, TState extends WorkUnit>
  implements IScheduler<TSpec, TState> {
  
  /** Work units by ID */
  protected items = new Map<string, TState>();
  
  /** Specifications by ID (for retry/reference) */
  protected specs = new Map<string, TSpec>();
  
  /** Pump interval handle */
  private pumpInterval?: NodeJS.Timeout;
  
  /** Event emitters */
  private _onDidChange = new vscode.EventEmitter<void>();
  private _onDidComplete = new vscode.EventEmitter<TState>();
  
  /** Component logger */
  protected log: ComponentLogger;
  
  constructor(
    protected readonly config: SchedulerConfig,
    protected readonly strategy: ExecutionStrategy<TSpec, TState>,
    logComponent: string = 'scheduler'
  ) {
    this.log = Logger.for(logComponent as any);
    
    // Ensure persistence directory exists
    const dir = path.dirname(config.persistPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Load persisted state
    this.loadFromDisk();
  }
  
  // ============================================================================
  // EVENTS
  // ============================================================================
  
  get onDidChange(): vscode.Event<void> {
    return this._onDidChange.event;
  }
  
  get onDidComplete(): vscode.Event<TState> {
    return this._onDidComplete.event;
  }
  
  protected notifyChange(): void {
    this._onDidChange.fire();
  }
  
  protected notifyComplete(state: TState): void {
    this._onDidComplete.fire(state);
  }
  
  // ============================================================================
  // QUEUE MANAGEMENT
  // ============================================================================
  
  /**
   * Add a work unit to the queue.
   * @returns The work unit ID
   */
  enqueue(spec: TSpec): string {
    // Generate ID if not provided
    const id = spec.id || randomUUID();
    spec.id = id;
    
    this.log.info(`Enqueueing work unit: ${id}`);
    
    // Store spec for later reference
    this.specs.set(id, spec);
    
    // Create initial state from spec
    const state = this.strategy.createState(spec);
    state.queuedAt = Date.now();
    
    this.items.set(id, state);
    this.persist();
    
    // Trigger pump to potentially start execution
    this.pump();
    
    return id;
  }
  
  /**
   * List all work units.
   */
  list(): TState[] {
    return Array.from(this.items.values());
  }
  
  /**
   * Get a specific work unit.
   */
  get(id: string): TState | undefined {
    return this.items.get(id);
  }
  
  /**
   * Get the specification for a work unit.
   */
  getSpec(id: string): TSpec | undefined {
    return this.specs.get(id);
  }
  
  // ============================================================================
  // LIFECYCLE CONTROL
  // ============================================================================
  
  /**
   * Cancel a work unit.
   */
  cancel(id: string): boolean {
    const state = this.items.get(id);
    if (!state) {
      this.log.warn(`Cannot cancel: work unit ${id} not found`);
      return false;
    }
    
    if (isTerminalStatus(state.status)) {
      this.log.warn(`Cannot cancel: work unit ${id} already in terminal state ${state.status}`);
      return false;
    }
    
    this.log.info(`Canceling work unit: ${id}`);
    this.strategy.cancel(id, state);
    state.status = 'canceled';
    state.endedAt = Date.now();
    
    this.persist();
    this.notifyChange();
    this.notifyComplete(state);
    
    return true;
  }
  
  /**
   * Retry a failed/canceled work unit.
   */
  retry(id: string, context?: string): boolean {
    const state = this.items.get(id);
    if (!state) {
      this.log.warn(`Cannot retry: work unit ${id} not found`);
      return false;
    }
    
    if (!['failed', 'canceled', 'partial'].includes(state.status)) {
      this.log.warn(`Cannot retry: work unit ${id} in non-retriable state ${state.status}`);
      return false;
    }
    
    this.log.info(`Retrying work unit: ${id}`);
    const success = this.strategy.retry(id, state, context);
    
    if (success) {
      this.persist();
      this.notifyChange();
      this.pump();
    }
    
    return success;
  }
  
  /**
   * Delete a work unit.
   */
  delete(id: string): boolean {
    const state = this.items.get(id);
    if (!state) {
      this.log.warn(`Cannot delete: work unit ${id} not found`);
      return false;
    }
    
    // Cancel first if still active
    if (!isTerminalStatus(state.status)) {
      this.cancel(id);
    }
    
    this.log.info(`Deleting work unit: ${id}`);
    
    // Clean up resources
    this.strategy.cleanup(id, state).catch(err => {
      this.log.error(`Error during cleanup of ${id}`, { error: err });
    });
    
    this.items.delete(id);
    this.specs.delete(id);
    this.persist();
    this.notifyChange();
    
    return true;
  }
  
  // ============================================================================
  // SCHEDULER CONTROL
  // ============================================================================
  
  /**
   * Start the scheduler pump loop.
   */
  start(): void {
    if (this.pumpInterval) {
      return; // Already running
    }
    
    const intervalMs = this.config.pumpIntervalMs ?? 1000;
    if (intervalMs > 0) {
      this.log.info(`Starting scheduler pump loop (${intervalMs}ms interval)`);
      this.pumpInterval = setInterval(() => this.pump(), intervalMs);
    }
    
    // Initial pump
    this.pump();
  }
  
  /**
   * Stop the scheduler pump loop.
   */
  stop(): void {
    if (this.pumpInterval) {
      this.log.info('Stopping scheduler pump loop');
      clearInterval(this.pumpInterval);
      this.pumpInterval = undefined;
    }
  }
  
  /**
   * Execute one pump cycle.
   * 
   * 1. Update status of running work units
   * 2. Get ready work units (up to available capacity)
   * 3. Execute ready work units
   */
  pump(): void {
    // Count currently running
    let running = 0;
    for (const state of this.items.values()) {
      if (state.status === 'running') {
        running++;
        // Update status of running items
        this.strategy.updateStatus(state);
      }
    }
    
    // Check for newly completed items
    for (const state of this.items.values()) {
      if (isTerminalStatus(state.status) && !state.endedAt) {
        state.endedAt = Date.now();
        this.notifyComplete(state);
      }
    }
    
    // Calculate available capacity
    const available = this.config.maxConcurrency - running;
    if (available <= 0) {
      return;
    }
    
    // Get ready work units from each active item
    for (const state of this.items.values()) {
      if (state.status === 'queued' || state.status === 'running') {
        const ready = this.strategy.getReady(state, available);
        
        for (const readyId of ready) {
          if (running >= this.config.maxConcurrency) {
            break;
          }
          
          // Execute the ready work unit
          this.strategy.execute(readyId, state).catch(err => {
            this.log.error(`Execution error for ${readyId}`, { error: err });
          });
          
          running++;
        }
      }
    }
    
    this.persist();
    this.notifyChange();
  }
  
  /**
   * Dispose of resources.
   */
  dispose(): void {
    this.stop();
    this._onDidChange.dispose();
    this._onDidComplete.dispose();
  }
  
  // ============================================================================
  // PERSISTENCE
  // ============================================================================
  
  /** Debounce timer for async persistence */
  private saveTimer?: NodeJS.Timeout;
  
  /** Flag to prevent overlapping saves */
  private isSaving = false;
  
  /** Debounce interval for persistence (ms) */
  private static readonly SAVE_DEBOUNCE_MS = 100;
  
  /**
   * Save state to disk (debounced, async).
   * Multiple rapid calls are coalesced into a single write.
   */
  protected persist(): void {
    // If already scheduled, let the existing timer handle it
    if (this.saveTimer) return;
    
    // Schedule an async save
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.doSaveAsync();
    }, Scheduler.SAVE_DEBOUNCE_MS);
  }
  
  /**
   * Perform the actual async save.
   */
  private async doSaveAsync(): Promise<void> {
    if (this.isSaving) return;
    this.isSaving = true;
    
    try {
      const data: any[] = [];
      
      for (const [id, state] of this.items) {
        const spec = this.specs.get(id);
        data.push({
          spec: spec,
          state: this.strategy.serialize(state)
        });
      }
      
      const dir = path.dirname(this.config.persistPath);
      try {
        await fs.promises.access(dir);
      } catch {
        await fs.promises.mkdir(dir, { recursive: true });
      }
      
      await fs.promises.writeFile(
        this.config.persistPath,
        JSON.stringify({ items: data }, null, 2),
        'utf-8'
      );
    } catch (err) {
      this.log.error('Failed to persist state', { error: err });
    } finally {
      this.isSaving = false;
    }
  }
  
  /**
   * Load state from disk (sync, called only at startup).
   */
  protected loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.config.persistPath)) {
        return;
      }
      
      const content = fs.readFileSync(this.config.persistPath, 'utf-8');
      const data = JSON.parse(content);
      
      if (!data.items || !Array.isArray(data.items)) {
        return;
      }
      
      for (const item of data.items) {
        if (item.spec && item.state) {
          const spec = item.spec as TSpec;
          const state = this.strategy.deserialize(item.state);
          
          if (spec.id) {
            this.specs.set(spec.id, spec);
            this.items.set(spec.id, state);
          }
        }
      }
      
      this.log.info(`Loaded ${this.items.size} work units from disk`);
    } catch (err) {
      this.log.error('Failed to load state from disk', { error: err });
    }
  }
}
