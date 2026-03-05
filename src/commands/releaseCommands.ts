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

/**
 * Register release management commands.
 *
 * @param context - VS Code extension context.
 * @param getReleaseData - Function to fetch release data.
 */
export function registerReleaseCommands(
  context: vscode.ExtensionContext,
  getReleaseData: (id: string) => ReleaseDefinition | undefined,
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
  );
}
