/**
 * @fileoverview PR lifecycle management commands.
 *
 * Commands for managing active pull requests.
 *
 * @module commands/prLifecycleCommands
 */

import * as vscode from 'vscode';
import { ActivePRPanel } from '../ui/panels/activePRPanel';
import type { ManagedPR } from '../plan/types/prLifecycle';

/**
 * Register PR lifecycle management commands.
 *
 * Only fully-implemented commands are registered here. Commands marked as
 * TODO are intentionally omitted until they are wired to IPRLifecycleManager
 * to avoid user-visible dead functionality.
 *
 * @param context - VS Code extension context.
 * @param getPRData - Function to fetch managed PR data.
 */
export function registerPRLifecycleCommands(
  context: vscode.ExtensionContext,
  getPRData: (id: string) => ManagedPR | undefined,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.showActivePR', (managedPRId: string) => {
      ActivePRPanel.createOrShow(
        context.extensionUri,
        managedPRId,
        getPRData,
      );
    }),
  );
}
