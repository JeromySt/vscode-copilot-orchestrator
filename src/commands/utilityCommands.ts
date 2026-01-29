/**
 * @fileoverview Utility and Git-related VS Code commands.
 * 
 * Contains command handlers for:
 * - Git conflict resolution
 * - Test generation
 * - Documentation generation
 * - Dashboard management
 * - Status inspection
 * - Log viewing
 * 
 * @module commands/utilityCommands
 */

import * as vscode from 'vscode';
import { TaskRunner } from '../core/taskRunner';
import { Logger } from '../core/logger';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Dashboard interface - matches the return type of createDashboard.
 */
export interface DashboardPanel {
  update(jobs: any[]): void;
  dispose(): void;
}

/**
 * Dependencies for utility commands.
 */
export interface UtilityCommandsDependencies {
  /** Callback to trigger UI refresh */
  updateUI: () => void;
  /** Function to create dashboard panel */
  createDashboard: (context: vscode.ExtensionContext) => DashboardPanel;
  /** Reference to dashboard panel (may be null) */
  getDashboard: () => DashboardPanel | undefined;
  /** Setter for dashboard panel */
  setDashboard: (panel: DashboardPanel | undefined) => void;
}

// ============================================================================
// UTILITY COMMAND REGISTRATION
// ============================================================================

/**
 * Register utility and Git commands with VS Code.
 * 
 * @param context - Extension context for subscription management
 * @param deps - Command dependencies
 */
export function registerUtilityCommands(
  context: vscode.ExtensionContext,
  deps: UtilityCommandsDependencies
): void {
  const { updateUI, createDashboard, getDashboard, setDashboard } = deps;

  // Inspect Status - Refresh UI
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.inspectStatus', () => {
      updateUI();
    })
  );

  // Open Dashboard
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.openDashboard', () => {
      let dashboard = getDashboard();
      if (!dashboard) {
        dashboard = createDashboard(context);
        setDashboard(dashboard);
        context.subscriptions.push(dashboard);
      }
      updateUI();
    })
  );

  // Resolve Git Conflicts
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.resolveConflicts', async () => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) return;

      const git = await import('../git');
      const files = git.merge.listConflicts(ws);
      
      if (!files.length) {
        vscode.window.showInformationMessage('No merge conflicts detected.');
        return;
      }

      const side = await vscode.window.showQuickPick(['theirs', 'ours'], {
        placeHolder: 'Prefer which side by default?'
      });
      if (!side) return;

      for (const f of files) {
        git.merge.resolveBySide(f, side as 'theirs' | 'ours', ws);
      }

      git.repository.stageAll(ws);
      const ok = git.repository.commit(ws, `orchestrator: resolved conflicts preferring ${side}`);
      
      vscode.window.showInformationMessage(
        ok ? 'Conflicts resolved and committed.' : 'Resolution applied; commit may be required.'
      );
    })
  );

  // Generate Tests
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.generateTests', async () => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) return;

      const rc = await TaskRunner.runShell(
        'orchestrator:gen-tests',
        'npm run gen:tests || echo "no generator"',
        ws
      );

      vscode.window.showInformationMessage(`Generate tests exit ${rc}`);
    })
  );

  // Produce Documentation
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.produceDocs', async () => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) return;

      const rc = await TaskRunner.runShell(
        'orchestrator:docs',
        'npm run docs || docfx build || echo "no docs step"',
        ws
      );

      vscode.window.showInformationMessage(`Docs step exit ${rc}`);
    })
  );

  // Show Logs Output Channel
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.showLogs', () => {
      Logger.show();
    })
  );
}
