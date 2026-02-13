/**
 * @fileoverview Tree Data Provider for Activity Bar Badge
 * 
 * Provides a simple TreeView specifically for badge functionality.
 * Works alongside the existing WebviewViewProvider for the main plans interface.
 * 
 * @module ui/planTreeProvider
 */

import * as vscode from 'vscode';
import { PlanRunner, PlanInstance } from '../plan';
import { formatDurationMs } from './templates/helpers';
import type { IPulseEmitter, Disposable as PulseDisposable } from '../interfaces/IPulseEmitter';

/**
 * Tree item representing a plan in the TreeView
 */
export class PlanTreeItem extends vscode.TreeItem {
  constructor(
    public readonly plan: PlanInstance,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    private readonly planRunner: PlanRunner
  ) {
    super(plan.spec.name || plan.id, collapsibleState);
    
    // Set basic properties
    this.id = plan.id;
    this.description = this.getPlanStatusDescription(plan);
    this.tooltip = `Plan: ${plan.spec.name || plan.id}`;
    
    // Set context value for commands
    this.contextValue = 'orchestrator.plan';
  }
  
  private getPlanStatusDescription(plan: PlanInstance): string {
    const nodeCount = plan.nodes.size;
    let description = `(${nodeCount} nodes)`;
    
    // Add duration for running plans
    if (plan.startedAt) {
      const sm = this.planRunner.getStateMachine(plan.id);
      const status = sm?.computePlanStatus();
      
      if (status === 'running' || status === 'pending') {
        const duration = Date.now() - plan.startedAt;
        const durationStr = formatDurationMs(duration);
        description = `${durationStr} • ${description}`;
      }
    }
    
    return description;
  }
}

/**
 * Simple TreeDataProvider for Activity Bar badge functionality.
 * 
 * This provider creates a minimal tree structure to enable badge display.
 * The main plan management UI remains in the WebviewViewProvider.
 */
export class PlanTreeDataProvider implements vscode.TreeDataProvider<PlanTreeItem> {
  
  private _onDidChangeTreeData: vscode.EventEmitter<PlanTreeItem | undefined | null | void> = new vscode.EventEmitter<PlanTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<PlanTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(private planRunner: PlanRunner) {
    // Listen for plan events to refresh tree data
    this.planRunner.on('planCreated', () => this.refresh());
    this.planRunner.on('planDeleted', () => this.refresh());
    this.planRunner.on('planStarted', () => this.refresh());
    this.planRunner.on('planCompleted', () => this.refresh());
    this.planRunner.on('planUpdated', () => this.refresh());
    this.planRunner.on('nodeTransition', () => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: PlanTreeItem): vscode.TreeItem {
    // ALWAYS return fresh tree item with current duration calculation
    return this.createFreshTreeItem(element);
  }

  /**
   * Create a fresh tree item with updated duration
   */
  private createFreshTreeItem(element: PlanTreeItem): vscode.TreeItem {
    const plan = element.plan;
    const item = new vscode.TreeItem(plan.spec.name || plan.id, element.collapsibleState);
    
    item.id = plan.id;
    item.description = this.getFreshPlanStatusDescription(plan);
    item.tooltip = `Plan: ${plan.spec.name || plan.id}`;
    item.contextValue = 'orchestrator.plan';
    
    return item;
  }

  getChildren(element?: PlanTreeItem): Thenable<PlanTreeItem[]> {
    if (!element) {
      // Root level - return all plans
      const plans = this.planRunner.getAll();
      return Promise.resolve(
        plans.map(plan => 
          new PlanTreeItem(plan, vscode.TreeItemCollapsibleState.None, this.planRunner)
        )
      );
    }
    
    // No children for plan items in this simple view
    return Promise.resolve([]);
  }

  /**
   * Get fresh plan status description with current duration calculation
   */
  private getFreshPlanStatusDescription(plan: PlanInstance): string {
    const nodeCount = plan.nodes.size;
    let description = `(${nodeCount} nodes)`;
    
    // Add duration for running/pending plans - calculate FRESH each time
    if (plan.startedAt) {
      const sm = this.planRunner.getStateMachine(plan.id);
      const status = sm?.computePlanStatus();
      
      if (status === 'running' || status === 'pending') {
        // Calculate duration fresh from current time
        const duration = Date.now() - plan.startedAt;
        const durationStr = formatDurationMs(duration);
        description = `${durationStr} • ${description}`;
      }
    }
    
    return description;
  }
}

/**
 * Manager class that handles TreeView creation and badge updates
 */
export class PlanTreeViewManager {
  private treeView: vscode.TreeView<PlanTreeItem> | undefined;
  private treeDataProvider: PlanTreeDataProvider;
  private _pulseSubscription: PulseDisposable | undefined;

  constructor(private planRunner: PlanRunner, private _pulse: IPulseEmitter) {
    this.treeDataProvider = new PlanTreeDataProvider(planRunner);
  }

  /**
   * Create and register the TreeView
   */
  createTreeView(context: vscode.ExtensionContext): vscode.TreeView<PlanTreeItem> {
    this.treeView = vscode.window.createTreeView('copilotOrchestratorPlans', {
      treeDataProvider: this.treeDataProvider,
      showCollapseAll: false,
      canSelectMany: false
    });

    // Set initial badge
    this.updateBadge();

    // Subscribe to events for badge updates
    this.setupEventHandlers();

    // Subscribe to pulse for duration refresh
    this._pulseSubscription = this._pulse.onPulse(() => {
      if (this.hasRunningPlans()) {
        this.treeDataProvider.refresh();
      }
    });

    context.subscriptions.push(this.treeView);
    return this.treeView;
  }

  /**
   * Update the activity bar badge based on running plans
   */
  private updateBadge(): void {
    if (!this.treeView) return;

    const runningCount = this.getRunningPlanCount();
    
    if (runningCount > 0) {
      this.treeView.badge = {
        value: runningCount,
        tooltip: `${runningCount} plan${runningCount > 1 ? 's' : ''} running`
      };
    } else {
      this.treeView.badge = undefined;  // Hide badge when nothing running
    }
  }

  /**
   * Count the number of plans with 'running' status
   */
  private getRunningPlanCount(): number {
    const runningPlans = this.planRunner.getByStatus('running');
    return runningPlans.length;
  }

  /**
   * Set up event handlers to update badge when plan state changes
   */
  private setupEventHandlers(): void {
    // Update badge on any state change that could affect running count
    this.planRunner.on('planStarted', () => this.updateBadge());
    this.planRunner.on('planCompleted', () => this.updateBadge());
    this.planRunner.on('planDeleted', () => this.updateBadge());
    this.planRunner.on('planCreated', () => this.updateBadge());
    this.planRunner.on('planUpdated', () => this.updateBadge());
    
    // Node transitions can change plan status from pending to running
    this.planRunner.on('nodeTransition', () => this.updateBadge());
  }

  /**
   * Clean up pulse subscription on dispose
   */
  public dispose(): void {
    if (this._pulseSubscription) {
      this._pulseSubscription.dispose();
    }
  }

  /**
   * Check if any plans are currently running or pending.
   */
  private hasRunningPlans(): boolean {
    const plans = this.planRunner.getAll();
    for (const plan of plans) {
      const sm = this.planRunner.getStateMachine(plan.id);
      const status = sm?.computePlanStatus();
      if (status === 'running' || status === 'pending') {
        return true;
      }
    }
    return false;
  }
}