/**
 * @fileoverview Release management commands.
 *
 * Commands for creating and managing releases.
 *
 * @module commands/releaseCommands
 */

import * as vscode from 'vscode';
import { ReleaseManagementPanel } from '../ui/panels/releaseManagementPanel';
import type { AvailablePlanSummary } from '../ui/panels/releaseManagementPanel';
import type { ReleaseDefinition } from '../plan/types/release';
import type { IReleaseManager } from '../interfaces/IReleaseManager';
import type { IPlanRunner } from '../interfaces/IPlanRunner';
import type { IRemoteProviderDetector } from '../interfaces/IRemoteProviderDetector';
import type { IPulseEmitter } from '../interfaces/IPulseEmitter';

/**
 * Register release management commands.
 *
 * @param context - VS Code extension context.
 * @param getReleaseData - Function to fetch release data.
 * @param releaseManager - Release manager instance (optional).
 * @param planRunner - Optional plan runner instance.
 * @param providerDetector - Optional remote provider detector instance.
 */
export function registerReleaseCommands(
  context: vscode.ExtensionContext,
  getReleaseData: (id: string) => ReleaseDefinition | undefined,
  releaseManager?: import('../interfaces/IReleaseManager').IReleaseManager,
  planRunner?: IPlanRunner,
  providerDetector?: IRemoteProviderDetector,
  pulse?: IPulseEmitter,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.showReleasePanel', (releaseId: string) => {
      if (!releaseManager) {
        vscode.window.showErrorMessage('Release manager not initialized');
        return;
      }
      const getAvailablePlans = (): AvailablePlanSummary[] => {
        if (!planRunner) { return []; }
        return planRunner.getAll()
          .filter(p => p.spec.name && (p.nodeStates.size > 0))
          .map(p => ({
            id: p.id,
            name: p.spec.name,
            status: Array.from(p.nodeStates.values()).every(n => n.status === 'succeeded') ? 'succeeded' :
                    Array.from(p.nodeStates.values()).some(n => n.status === 'running') ? 'running' : 'pending',
            nodeCount: p.nodeStates.size,
          }));
      };
      ReleaseManagementPanel.createOrShow(
        context.extensionUri,
        releaseId,
        getReleaseData,
        releaseManager,
        undefined, // options
        undefined, // dialogService
        pulse,
        getAvailablePlans,
        planRunner,
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
          repoPath: repoPath,
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

    vscode.commands.registerCommand('orchestrator.scaffoldReleaseTasks', async () => {
      const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
      const git = gitExtension?.getAPI(1);
      
      if (!git || git.repositories.length === 0) {
        vscode.window.showErrorMessage('No git repository found.');
        return;
      }
      
      const repo = git.repositories[0];
      const repoPath = repo.rootUri.fsPath;
      
      // Show confirmation dialog
      const confirmed = await vscode.window.showInformationMessage(
        'Create default release task files in .orchestrator/release/tasks/?',
        { modal: true },
        'Create',
        'Cancel'
      );
      
      if (confirmed !== 'Create') {
        return;
      }
      
      try {
        // Import the scaffold function
        const { scaffoldDefaultTaskFiles } = await import('../plan/releaseTaskLoader');
        const created = await scaffoldDefaultTaskFiles(repoPath);
        
        if (created.length === 0) {
          vscode.window.showInformationMessage('All default task files already exist.');
          return;
        }
        
        // Show success message
        vscode.window.showInformationMessage(
          `Created ${created.length} task file(s): ${created.map(f => require('path').basename(f)).join(', ')}`
        );
        
        // Open the first created file
        if (created.length > 0) {
          const doc = await vscode.workspace.openTextDocument(created[0]);
          await vscode.window.showTextDocument(doc);
        }
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to scaffold release tasks: ${error.message}`);
      }
    }),

    vscode.commands.registerCommand('orchestrator.selectGitAccount', async () => {
      if (!providerDetector) {
        vscode.window.showErrorMessage('Provider detector not available.');
        return;
      }

      try {
        // Get current repository path
        const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
        const git = gitExtension?.getAPI(1);
        
        if (!git || git.repositories.length === 0) {
          vscode.window.showErrorMessage('No git repository found.');
          return;
        }
        
        const repo = git.repositories[0];
        const repoPath = repo.rootUri.fsPath;

        // Detect provider
        const provider = await providerDetector.detect(repoPath);
        
        // List accounts
        const accounts = await providerDetector.listAccounts(provider);
        
        if (accounts.length === 0) {
          vscode.window.showErrorMessage('No accounts found. Please use "Login Git Account" command first.');
          return;
        }

        // EMU hint
        const hostname = provider.type === 'github' ? 'github.com' : provider.hostname || 'github.com';
        const recommendedAccount = accounts.find(acct => 
          acct.toLowerCase().endsWith('_' + provider.owner.toLowerCase())
        );

        const items = accounts.map(account => {
          const isRecommended = account === recommendedAccount;
          return {
            label: account,
            description: isRecommended ? '(recommended)' : '',
          };
        });

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: `Select Git account for ${hostname}`,
        });

        if (!selected) {
          return; // User cancelled
        }

        // Store in repo-local git config
        const key = `credential.https://${hostname}.username`;
        const terminal = vscode.window.createTerminal({ name: 'Set Git Account' });
        terminal.sendText(`git config --local ${key} ${selected.label}`);
        terminal.show();
        
        vscode.window.showInformationMessage(`Using account "${selected.label}" for ${hostname}`);
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to select account: ${error.message}`);
      }
    }),

    vscode.commands.registerCommand('orchestrator.loginGitAccount', async () => {
      if (!providerDetector) {
        vscode.window.showErrorMessage('Provider detector not available.');
        return;
      }

      try {
        // Get current repository path
        const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
        const git = gitExtension?.getAPI(1);
        
        if (!git || git.repositories.length === 0) {
          vscode.window.showErrorMessage('No git repository found.');
          return;
        }
        
        const repo = git.repositories[0];
        const repoPath = repo.rootUri.fsPath;

        // Detect provider
        const provider = await providerDetector.detect(repoPath);
        
        // Launch appropriate login command
        const terminal = vscode.window.createTerminal({ name: 'Git Login' });
        
        switch (provider.type) {
          case 'github':
            terminal.sendText('git credential-manager github login');
            break;
          case 'github-enterprise':
            terminal.sendText(`git credential-manager github login --hostname ${provider.hostname}`);
            break;
          case 'azure-devops':
            terminal.sendText('az login');
            break;
          default:
            vscode.window.showErrorMessage(`Login not supported for provider type: ${provider.type}`);
            return;
        }
        
        terminal.show();
        vscode.window.showInformationMessage('Login command started in terminal. Follow the prompts.');
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to start login: ${error.message}`);
      }
    }),

    // Show a PR comment as an inline decoration on a file
    vscode.commands.registerCommand(
      'orchestrator.showPRCommentDecoration',
      (filePath: string, line: number, author: string, body: string, source: string) => {
        const uri = vscode.Uri.file(filePath);

        // Create a decoration type for the PR comment
        const decorationType = vscode.window.createTextEditorDecorationType({
          after: {
            contentText: ` — ${author}: ${body.length > 100 ? body.substring(0, 100) + '...' : body}`,
            color: new vscode.ThemeColor('editorCodeLens.foreground'),
            fontStyle: 'italic',
            margin: '0 0 0 16px',
          },
          backgroundColor: source === 'codeql'
            ? new vscode.ThemeColor('diffEditor.removedTextBackground')
            : new vscode.ThemeColor('diffEditor.insertedTextBackground'),
          isWholeLine: true,
          overviewRulerColor: source === 'codeql'
            ? new vscode.ThemeColor('editorOverviewRuler.errorForeground')
            : new vscode.ThemeColor('editorOverviewRuler.infoForeground'),
          overviewRulerLane: vscode.OverviewRulerLane.Right,
        });

        // Find the editor showing this file, or wait for it
        const applyDecoration = (editor: vscode.TextEditor) => {
          const lineIdx = Math.max(0, line - 1);
          const range = new vscode.Range(lineIdx, 0, lineIdx, 0);

          editor.setDecorations(decorationType, [{
            range,
            hoverMessage: new vscode.MarkdownString(
              `**${author}** (${source})\n\n${body}`,
            ),
          }]);

          // Show a CodeLens-like info message at the top
          vscode.window.showInformationMessage(
            `PR Comment from ${author} on line ${line}`,
            'Dismiss',
          ).then(() => {
            // Clear decoration when dismissed
            editor.setDecorations(decorationType, []);
            decorationType.dispose();
          });

          // Auto-clear after 5 minutes
          setTimeout(() => {
            try {
              editor.setDecorations(decorationType, []);
              decorationType.dispose();
            } catch { /* editor may be closed */ }
          }, 300000);
        };

        // Look for an already-open editor with this file
        const editor = vscode.window.visibleTextEditors.find(
          (e) => e.document.uri.fsPath === uri.fsPath,
        );
        if (editor) {
          applyDecoration(editor);
        } else {
          // Wait briefly for the editor to open (it was just opened by vscode.open)
          const disposable = vscode.window.onDidChangeVisibleTextEditors((editors) => {
            const found = editors.find((e) => e.document.uri.fsPath === uri.fsPath);
            if (found) {
              disposable.dispose();
              applyDecoration(found);
            }
          });
          // Cleanup if editor never opens
          setTimeout(() => disposable.dispose(), 5000);
        }
      },
    ),
  );
}
