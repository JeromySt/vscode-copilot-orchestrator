/**
 * @fileoverview PR lifecycle management commands.
 *
 * Commands for adopting and managing pull requests.
 *
 * @module commands/prLifecycleCommands
 */

import * as vscode from 'vscode';
import type { IPRLifecycleManager } from '../interfaces/IPRLifecycleManager';
import type { AvailablePR } from '../plan/types/prLifecycle';

/**
 * PR Quick Pick Item for the adoption UI.
 */
interface PRQuickPickItem extends vscode.QuickPickItem {
  prNumber?: number;
  isManual?: boolean;
}

/**
 * Register PR lifecycle commands.
 *
 * @param context - VS Code extension context.
 * @param prLifecycleManager - The PR lifecycle manager instance.
 */
export function registerPRLifecycleCommands(
  context: vscode.ExtensionContext,
  prLifecycleManager: IPRLifecycleManager,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.adoptPR', async () => {
      await handleAdoptPR(prLifecycleManager);
    }),
  );
}

/**
 * Handle the adopt PR command.
 *
 * Implements the Quick Pick flow:
 * 1. Get repo path
 * 2. List available PRs
 * 3. Show Quick Pick with PR items + manual entry option
 * 4. Adoption options (start monitoring, create isolated clone)
 * 5. Execute adoption with progress notification
 * 6. Open Active PR Panel on success (if available)
 *
 * @param prLifecycleManager - The PR lifecycle manager instance.
 */
async function handleAdoptPR(prLifecycleManager: IPRLifecycleManager): Promise<void> {
  try {
    // Step 1: Get repository path
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder open. Please open a git repository first.');
      return;
    }

    // Use the first workspace folder as the repo path
    // TODO: Allow selection if multiple workspace folders
    const repoPath = workspaceFolders[0].uri.fsPath;

    // Step 2: List available PRs
    let availablePRs: AvailablePR[];
    try {
      availablePRs = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Loading pull requests...',
          cancellable: false,
        },
        async () => {
          return await prLifecycleManager.listAvailablePRs({ repoPath, state: 'open', limit: 50 });
        }
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to list pull requests: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    if (availablePRs.length === 0) {
      vscode.window.showInformationMessage('No open pull requests found in this repository.');
      return;
    }

    // Step 3: Show Quick Pick with PR items + manual entry option
    const quickPickItems: PRQuickPickItem[] = availablePRs.map(pr => ({
      label: pr.isManaged ? `$(pass-filled) #${pr.prNumber}: ${pr.title}` : `#${pr.prNumber}: ${pr.title}`,
      description: pr.isManaged ? '(already managed)' : `${pr.headBranch} → ${pr.baseBranch}`,
      detail: `Author: ${pr.author} | State: ${pr.state}`,
      prNumber: pr.prNumber,
      // Disable items that are already managed
      ...(pr.isManaged ? { alwaysShow: false } : {}),
    }));

    // Add manual entry option at the top
    quickPickItems.unshift({
      label: '$(edit) Enter PR number manually',
      description: 'Specify a PR number directly',
      isManual: true,
    });

    const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
      placeHolder: 'Select a pull request to adopt',
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (!selectedItem) {
      return; // User cancelled
    }

    // Handle manual entry
    let prNumber: number;
    if (selectedItem.isManual) {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter PR number',
        placeHolder: '123',
        validateInput: (value) => {
          const num = parseInt(value, 10);
          if (isNaN(num) || num <= 0) {
            return 'Please enter a valid PR number';
          }
          return undefined;
        },
      });
      if (!input) {
        return; // User cancelled
      }
      prNumber = parseInt(input, 10);
    } else if (selectedItem.prNumber !== undefined) {
      prNumber = selectedItem.prNumber;
    } else {
      return; // Invalid selection
    }

    // Find the PR to check if it's already managed
    const prToAdopt = availablePRs.find(pr => pr.prNumber === prNumber);
    if (prToAdopt?.isManaged) {
      vscode.window.showWarningMessage(`PR #${prNumber} is already managed.`);
      return;
    }

    // Step 4: Adoption options
    const options = await vscode.window.showQuickPick(
      [
        {
          label: 'Adopt and start monitoring',
          description: 'Immediately begin monitoring for checks and comments',
          action: 'monitor' as const,
        },
        {
          label: 'Adopt only',
          description: 'Add to managed PRs without starting monitoring',
          action: 'adopt' as const,
        },
      ],
      {
        placeHolder: 'How would you like to adopt this PR?',
      }
    );

    if (!options) {
      return; // User cancelled
    }

    // Step 5: Execute adoption with progress notification
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Adopting PR #${prNumber}...`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Fetching PR details...' });

        const adoptResult = await prLifecycleManager.adoptPR({
          prNumber,
          repoPath,
          // Default to repoPath for working directory (no isolated clone for now)
          workingDirectory: repoPath,
        });

        if (!adoptResult.success || !adoptResult.managedPR) {
          return adoptResult;
        }

        // If user chose to start monitoring, do it now
        if (options.action === 'monitor') {
          progress.report({ message: 'Starting monitoring...' });
          try {
            await prLifecycleManager.startMonitoring(adoptResult.managedPR.id);
          } catch (error) {
            // Monitoring failed, but adoption succeeded
            vscode.window.showWarningMessage(
              `PR #${prNumber} adopted, but monitoring failed: ${error instanceof Error ? error.message : String(error)}`
            );
            return adoptResult;
          }
        }

        return adoptResult;
      }
    );

    // Show result
    if (result.success) {
      const action = options.action === 'monitor' ? 'adopted and monitoring started' : 'adopted';
      vscode.window.showInformationMessage(`PR #${prNumber} ${action} successfully!`);

      // Step 6: Open Active PR Panel on success (if available)
      // TODO: Implement when Active PR Panel exists
      // For now, this is a placeholder for future integration
    } else {
      vscode.window.showErrorMessage(`Failed to adopt PR #${prNumber}: ${result.error || 'Unknown error'}`);
    }
  } catch (error) {
    vscode.window.showErrorMessage(
      `Error during PR adoption: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
