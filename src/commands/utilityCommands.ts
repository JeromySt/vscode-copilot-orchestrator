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
 * - Orphaned resource cleanup
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
      const files = await git.merge.listConflicts(ws);
      
      if (!files.length) {
        vscode.window.showInformationMessage('No merge conflicts detected.');
        return;
      }

      const side = await vscode.window.showQuickPick(['theirs', 'ours'], {
        placeHolder: 'Prefer which side by default?'
      });
      if (!side) return;

      for (const f of files) {
        await git.merge.resolveBySide(f, side as 'theirs' | 'ours', ws);
      }

      await git.repository.stageAll(ws);
      const ok = await git.repository.commit(ws, `orchestrator: resolved conflicts preferring ${side}`);
      
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

  // Clean up orphaned worktrees and branches
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.cleanupOrphans', async () => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
      }

      const git = await import('../git');
      const log = Logger.for('jobs'); // Use 'jobs' component for cleanup logging

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Cleaning up orphaned resources...',
        cancellable: false
      }, async (progress) => {
        let removedWorktrees = 0;
        let removedBranches = 0;

        // 1. List and remove orphaned worktrees
        progress.report({ message: 'Scanning worktrees...' });
        const worktrees = await git.worktrees.list(ws);
        const orphanedWorktrees = worktrees.filter(wt => 
          wt.branch?.startsWith('copilot_jobs/') || 
          wt.path.includes('.worktrees')
        );

        for (const wt of orphanedWorktrees) {
          // Skip the main worktree
          if (wt.path === ws) continue;
          
          try {
            progress.report({ message: `Removing worktree: ${wt.branch || wt.path}` });
            await git.worktrees.removeSafe(ws, wt.path, { force: true });
            removedWorktrees++;
            log.info(`Removed orphaned worktree: ${wt.path}`);
          } catch (e) {
            log.warn(`Failed to remove worktree ${wt.path}: ${e}`);
          }
        }

        // 2. Prune stale worktree references
        progress.report({ message: 'Pruning stale references...' });
        await git.worktrees.prune(ws);

        // 3. List and remove orphaned branches
        progress.report({ message: 'Scanning branches...' });
        const branches = await git.branches.list(ws);
        const currentBranch = await git.branches.current(ws);
        
        // Find copilot_jobs branches that are orphaned
        const orphanedBranches = branches.filter(branch => 
          branch.startsWith('copilot_jobs/') && 
          branch !== currentBranch
        );

        // Checkout to a safe branch first if we're on a copilot_jobs branch
        if (currentBranch.startsWith('copilot_jobs/')) {
          progress.report({ message: 'Switching to safe branch...' });
          try {
            await git.branches.checkout(ws, 'main');
          } catch {
            try {
              await git.branches.checkout(ws, 'master');
            } catch {
              log.warn('Could not switch to main/master branch');
            }
          }
        }

        for (const branch of orphanedBranches) {
          try {
            progress.report({ message: `Removing branch: ${branch}` });
            const deleted = await git.branches.deleteLocal(ws, branch, { force: true });
            if (deleted) {
              removedBranches++;
              log.info(`Removed orphaned branch: ${branch}`);
            }
          } catch (e) {
            log.warn(`Failed to remove branch ${branch}: ${e}`);
          }
        }

        vscode.window.showInformationMessage(
          `Cleanup complete: removed ${removedWorktrees} worktrees and ${removedBranches} branches.`
        );
        
        log.info(`Cleanup complete`, { removedWorktrees, removedBranches });
      });
    })
  );
}
