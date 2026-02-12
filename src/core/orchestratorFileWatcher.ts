/**
 * @fileoverview Filesystem watcher for .orchestrator directory.
 * 
 * Monitors plan files and synchronizes in-memory state when files
 * are externally deleted (e.g., `git clean -dfx`).
 * 
 * @module core/orchestratorFileWatcher
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { Logger, ComponentLogger } from './logger';

const log: ComponentLogger = Logger.for('extension');

/**
 * Callback fired when a plan file is deleted from the filesystem.
 */
export type PlanFileDeletedCallback = (planId: string) => void;

/**
 * Callback fired when a plan file is created on the filesystem.
 */
export type PlanFileCreatedCallback = (planId: string, filePath: string) => void;

/**
 * Watches the .orchestrator/plans/ directory for file changes.
 * 
 * When plan JSON files are externally deleted (e.g., by git clean),
 * notifies the PlanRunner to update in-memory state.
 * 
 * @example
 * ```typescript
 * const watcher = new OrchestratorFileWatcher(
 *   workspacePath,
 *   (planId) => this.handleExternalPlanDeletion(planId)
 * );
 * 
 * // Later, on extension deactivation:
 * watcher.dispose();
 * ```
 */
export class OrchestratorFileWatcher implements vscode.Disposable {
  private readonly _watcher: vscode.FileSystemWatcher;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _onPlanFileDeleted: PlanFileDeletedCallback;
  private readonly _onPlanFileCreated?: PlanFileCreatedCallback;
  
  /** Debounce timer for rapid successive events */
  private _debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private static readonly DEBOUNCE_MS = 100;
  
  /**
   * Create a new filesystem watcher for the .orchestrator directory.
   * 
   * @param workspacePath - Root path of the workspace
   * @param onPlanFileDeleted - Callback when a plan file is deleted
   * @param onPlanFileCreated - Optional callback when a plan file is created
   */
  constructor(
    workspacePath: string,
    onPlanFileDeleted: PlanFileDeletedCallback,
    onPlanFileCreated?: PlanFileCreatedCallback
  ) {
    this._onPlanFileDeleted = onPlanFileDeleted;
    this._onPlanFileCreated = onPlanFileCreated;
    
    // Watch pattern: .orchestrator/plans/*.json
    // Use RelativePattern for better performance (scoped to workspace)
    const plansPattern = new vscode.RelativePattern(
      workspacePath,
      '.orchestrator/plans/*.json'
    );
    
    this._watcher = vscode.workspace.createFileSystemWatcher(
      plansPattern,
      false, // Don't ignore creates
      true,  // Ignore changes (we handle persistence ourselves)
      false  // Don't ignore deletes
    );
    
    // Handle file deletion
    this._disposables.push(
      this._watcher.onDidDelete((uri) => this._handleDelete(uri))
    );
    
    // Handle file creation (optional, for external plan imports)
    if (onPlanFileCreated) {
      this._disposables.push(
        this._watcher.onDidCreate((uri) => this._handleCreate(uri))
      );
    }
    
    this._disposables.push(this._watcher);
    
    log.info(`Watching for plan file changes in ${workspacePath}/.orchestrator/plans/`);
  }
  
  /**
   * Handle a plan file deletion event.
   * 
   * Extracts the plan ID from the filename and notifies the callback.
   * Debounces rapid events to handle filesystem quirks.
   */
  private _handleDelete(uri: vscode.Uri): void {
    const planId = this._extractPlanId(uri);
    if (!planId) {
      log.debug(`Ignoring delete of non-plan file: ${uri.fsPath}`);
      return;
    }
    
    // Debounce rapid successive deletes (e.g., git clean deleting many files)
    this._debounced(planId, () => {
      log.info(`Plan file deleted externally: ${planId}`);
      this._onPlanFileDeleted(planId);
    });
  }
  
  /**
   * Handle a plan file creation event.
   * 
   * Could be used for external plan import functionality.
   */
  private _handleCreate(uri: vscode.Uri): void {
    const planId = this._extractPlanId(uri);
    if (!planId || !this._onPlanFileCreated) {
      return;
    }
    
    this._debounced(planId, () => {
      log.info(`Plan file created externally: ${planId}`);
      this._onPlanFileCreated!(planId, uri.fsPath);
    });
  }
  
  /**
   * Extract plan ID from a plan file URI.
   * 
   * Plan files are named plan-{uuid}.json, so we strip the prefix and extension.
   * Returns undefined if the filename doesn't look like a valid plan file.
   */
  private _extractPlanId(uri: vscode.Uri): string | undefined {
    const filename = path.basename(uri.fsPath);
    
    // Check if it's a plan file (plan-{uuid}.json)
    if (!filename.startsWith('plan-') || !filename.endsWith('.json')) {
      return undefined;
    }
    
    // Extract the UUID part
    const planId = filename.slice(5, -5); // Remove 'plan-' prefix and '.json' suffix
    
    // Validate it looks like a UUID (basic check)
    // UUID format: 8-4-4-4-12 hex chars
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(planId)) {
      return undefined;
    }
    
    return planId;
  }
  
  /**
   * Debounce a callback for a specific plan ID.
   * 
   * Prevents rapid successive events from firing multiple callbacks.
   */
  private _debounced(planId: string, callback: () => void): void {
    // Clear existing timer for this plan
    const existing = this._debounceTimers.get(planId);
    if (existing) {
      clearTimeout(existing);
    }
    
    // Set new timer
    const timer = setTimeout(() => {
      this._debounceTimers.delete(planId);
      callback();
    }, OrchestratorFileWatcher.DEBOUNCE_MS);
    
    this._debounceTimers.set(planId, timer);
  }
  
  /**
   * Dispose of the watcher and all subscriptions.
   */
  dispose(): void {
    // Clear all pending debounce timers
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();
    
    // Dispose all subscriptions
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables.length = 0;
    
    log.info('File watcher disposed');
  }
}