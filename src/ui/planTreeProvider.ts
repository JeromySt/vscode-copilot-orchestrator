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

/**
 * Tree item representing a plan in the TreeView
 */
export class PlanTreeItem extends vscode.TreeItem {
  constructor(
    public readonly plan: PlanInstance,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
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
    // Simple status indicator - the main UI is in the webview
    const nodeCount = plan.nodes.size;
    return `(${nodeCount} nodes)`;
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
    return element;
  }

  getChildren(element?: PlanTreeItem): Thenable<PlanTreeItem[]> {
    if (!element) {
      // Root level - return all plans
      const plans = this.planRunner.getAll();
      return Promise.resolve(
        plans.map(plan => 
          new PlanTreeItem(plan, vscode.TreeItemCollapsibleState.None)
        )
      );
    }
    
    // No children for plan items in this simple view
    return Promise.resolve([]);
  }
}

/**
 * Manager class that handles TreeView creation and badge updates
 */
export class PlanTreeViewManager {
  private treeView: vscode.TreeView<PlanTreeItem> | undefined;
  private treeDataProvider: PlanTreeDataProvider;

  constructor(private planRunner: PlanRunner) {
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
}