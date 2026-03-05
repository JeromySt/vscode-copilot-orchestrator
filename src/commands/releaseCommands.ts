/**
 * @fileoverview Release management commands.
 *
 * Commands for creating and managing releases.
 *
 * @module commands/releaseCommands
 */

import * as vscode from 'vscode';
import { ReleaseManagementPanel } from '../ui/panels/releaseManagementPanel';
import type { ReleaseDefinition } from '../plan/types/release';
import type { IReleaseManager } from '../interfaces/IReleaseManager';
import type { IPlanRunner } from '../interfaces/IPlanRunner';

/**
 * Register release management commands.
 *
 * @param context - VS Code extension context.
 * @param getReleaseData - Function to fetch release data.
 * @param releaseManager - Release manager instance (optional).
 * @param planRunner - Optional plan runner instance.
 */
export function registerReleaseCommands(
  context: vscode.ExtensionContext,
  getReleaseData: (id: string) => ReleaseDefinition | undefined,
  releaseManager?: import('../interfaces/IReleaseManager').IReleaseManager,
  planRunner?: IPlanRunner,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.showReleasePanel', (releaseId: string) => {
      ReleaseManagementPanel.createOrShow(
        context.extensionUri,
        releaseId,
        getReleaseData,
      );
    }),

    vscode.commands.registerCommand('orchestrator.createRelease', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Enter release name',
        placeHolder: 'v1.0.0',
      });
      if (!name) {
        return;
      }

      const releaseBranch = await vscode.window.showInputBox({
        prompt: 'Enter release branch name',
        placeHolder: 'release/v1.0.0',
        value: `release/${name}`,
      });
      if (!releaseBranch) {
        return;
      }

      const targetBranch = await vscode.window.showInputBox({
        prompt: 'Enter target branch',
        placeHolder: 'main',
        value: 'main',
      });
      if (!targetBranch) {
        return;
      }

      // TODO: Actually create the release in the release manager
      vscode.window.showInformationMessage(`Release "${name}" created (not yet implemented)`);
    }),

    vscode.commands.registerCommand('orchestrator.createReleaseFromBranch', async () => {
      if (!releaseManager) {
        vscode.window.showErrorMessage('Release manager is not available.');
        return;
      }

      try {
        // 1. Get current branch from VS Code git extension (since IGitOperations doesn't have current() method)
        const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
        const git = gitExtension?.getAPI(1);
        
        if (!git || git.repositories.length === 0) {
          vscode.window.showErrorMessage('No git repository found.');
          return;
        }
        
        const repo = git.repositories[0];
        const currentBranch = repo.state.HEAD?.name;
        
        if (!currentBranch) {
          vscode.window.showErrorMessage('Could not detect current branch.');
          return;
        }

        // Don't allow creating release from main
        if (currentBranch === 'main') {
          vscode.window.showWarningMessage('Switch to a release branch first.');
          return;
        }
        
        // 2. Get repository path for PR checks
        const repoPath = repo.rootUri.fsPath;
        
        // 3. Prompt for release name (default to branch name with 'release/' prefix removed)
        const defaultName = currentBranch.replace(/^release\//, '');
        const name = await vscode.window.showInputBox({
          prompt: 'Release name',
          value: defaultName,
          placeHolder: 'v0.15.0',
          validateInput: (value) => {
            if (!value || value.trim().length === 0) {
              return 'Release name is required';
            }
            return null;
          }
        });
        
        if (!name) {
          return; // User cancelled
        }
        
        // 4. Create release via IReleaseManager
        const release = await releaseManager.createRelease({
          name: name.trim(),
          planIds: [], // No plans — this is a manual release
          releaseBranch: currentBranch,
          targetBranch: 'main', // Default target branch
        });
        
        // 5. Check if a PR already exists for this branch (async, don't block)
        // Note: PR adoption happens separately via the PR lifecycle manager
        // The release panel will show if a PR exists and allow adoption
        
        // 6. Open the release panel
        vscode.commands.executeCommand('orchestrator.showReleasePanel', release.id);
        
        vscode.window.showInformationMessage(`Release "${name}" created from branch "${currentBranch}".`);
        
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create release: ${error.message}`);
      }
    }),

    vscode.commands.registerCommand('orchestrator.cancelRelease', async (releaseId: string) => {
      const confirmed = await vscode.window.showWarningMessage(
        'Are you sure you want to cancel this release?',
        { modal: true },
        'Yes',
        'No',
      );
      if (confirmed === 'Yes') {
        // TODO: Implement release cancellation
        vscode.window.showInformationMessage(`Release canceled (not yet implemented)`);
      }
    }),

    vscode.commands.registerCommand('orchestrator.startRelease', async (releaseId: string) => {
      // TODO: Implement release start
      vscode.window.showInformationMessage(`Starting release ${releaseId} (not yet implemented)`);
    }),

    vscode.commands.registerCommand('orchestrator.addPlanToRelease', async (releaseId: string, planId: string) => {
      // TODO: Implement adding plan to release
      vscode.window.showInformationMessage(`Adding plan ${planId} to release ${releaseId} (not yet implemented)`);
    }),

    vscode.commands.registerCommand('orchestrator.removePlanFromRelease', async (releaseId: string, planId: string) => {
      // TODO: Implement removing plan from release
      vscode.window.showInformationMessage(`Removing plan ${planId} from release ${releaseId} (not yet implemented)`);
    }),

    vscode.commands.registerCommand('orchestrator.updateReleaseConfig', async (releaseId: string, config: any) => {
      // TODO: Implement release config update
      vscode.window.showInformationMessage(`Updating release ${releaseId} config (not yet implemented)`);
    }),

    vscode.commands.registerCommand('orchestrator.retryReleaseMerge', async (releaseId: string, planId: string) => {
      // TODO: Implement retry merge
      vscode.window.showInformationMessage(`Retrying merge for plan ${planId} in release ${releaseId} (not yet implemented)`);
    }),

    vscode.commands.registerCommand('orchestrator.addressPRFeedback', async (releaseId: string, feedbackId: string) => {
      // TODO: Implement addressing PR feedback
      vscode.window.showInformationMessage(`Addressing feedback ${feedbackId} in release ${releaseId} (not yet implemented)`);
    }),

    vscode.commands.registerCommand('orchestrator.assignToRelease', async (planIds: string[]) => {
      if (!releaseManager || !planRunner) {
        vscode.window.showErrorMessage('Release manager not available');
        return;
      }

      // Validate that all selected plans are succeeded or partial
      const invalidPlans: string[] = [];
      for (const planId of planIds) {
        const plan = planRunner.get(planId);
        if (!plan) {
          invalidPlans.push(planId);
          continue;
        }
        const sm = planRunner.getStateMachine(planId);
        const status = sm?.computePlanStatus();
        if (status !== 'succeeded' && status !== 'partial') {
          invalidPlans.push(planId);
        }
      }

      if (invalidPlans.length > 0) {
        vscode.window.showErrorMessage(
          `Cannot assign plans to release: ${invalidPlans.length} plan(s) are not in succeeded or partial status`
        );
        return;
      }

      // Get drafting releases
      const draftingReleases = releaseManager.getReleasesByStatus('drafting');
      const items: vscode.QuickPickItem[] = draftingReleases.map(r => ({
        label: r.name,
        description: `${r.planIds.length} plan(s)`,
        detail: `Branch: ${r.releaseBranch} → ${r.targetBranch}`,
      }));

      // Add "Create New" option
      items.push({
        label: '$(plus) Create New Release',
        description: 'Create a new release with selected plans',
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a release or create a new one',
      });

      if (!selected) {
        return;
      }

      if (selected.label.startsWith('$(plus)')) {
        // Create new release
        vscode.commands.executeCommand('orchestrator.createReleaseFromPlans', planIds);
      } else {
        // Add to existing release
        const release = draftingReleases.find(r => r.name === selected.label);
        if (release) {
          // For now, show a message that this will be implemented when we add the addPlanToRelease method
          vscode.window.showInformationMessage(
            `Adding ${planIds.length} plan(s) to release "${release.name}" (pending IReleaseManager.addPlanToRelease implementation)`
          );
        }
      }
    }),

    vscode.commands.registerCommand('orchestrator.createReleaseFromPlans', async (planIds: string[]) => {
      if (!releaseManager || !planRunner) {
        vscode.window.showErrorMessage('Release manager not available');
        return;
      }

      // Validate plans
      const invalidPlans: string[] = [];
      for (const planId of planIds) {
        const plan = planRunner.get(planId);
        if (!plan) {
          invalidPlans.push(planId);
          continue;
        }
        const sm = planRunner.getStateMachine(planId);
        const status = sm?.computePlanStatus();
        if (status !== 'succeeded' && status !== 'partial') {
          invalidPlans.push(planId);
        }
      }

      if (invalidPlans.length > 0) {
        vscode.window.showErrorMessage(
          `Cannot create release: ${invalidPlans.length} plan(s) are not in succeeded or partial status`
        );
        return;
      }

      // Prompt for release details
      const name = await vscode.window.showInputBox({
        prompt: 'Enter release name',
        placeHolder: 'v1.0.0',
      });
      if (!name) {
        return;
      }

      const releaseBranch = await vscode.window.showInputBox({
        prompt: 'Enter release branch name',
        placeHolder: 'release/v1.0.0',
        value: `release/${name}`,
      });
      if (!releaseBranch) {
        return;
      }

      const targetBranch = await vscode.window.showInputBox({
        prompt: 'Enter target branch',
        placeHolder: 'main',
        value: 'main',
      });
      if (!targetBranch) {
        return;
      }

      try {
        const release = await releaseManager.createRelease({
          name,
          planIds,
          releaseBranch,
          targetBranch,
        });

        vscode.window.showInformationMessage(
          `Release "${name}" created with ${planIds.length} plan(s). ID: ${release.id}`
        );
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create release: ${error.message}`);
      }
    }),
  );
}
