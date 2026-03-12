
import * as vscode from 'vscode';
import { isCopilotCliAvailable, checkCopilotCliAsync, isCliCachePopulated, cmdOkAsync } from './cliCheckCore';
import { evaluateCliAvailability, determineInstallMethod, getInstallInstructions } from './cliCheckLogic';
import type { IConfigProvider } from '../interfaces/IConfigProvider';
import type { IDialogService } from '../interfaces/IDialogService';

export async function ensureCopilotCliInteractive(reason: string, configProvider?: IConfigProvider, dialogService?: IDialogService): Promise<boolean> {
  const config = configProvider || { getConfig: <T>(section: string, key: string, defaultValue: T): T => vscode.workspace.getConfiguration(section).get<T>(key, defaultValue) };
  const dialogs = dialogService || { showWarning: (message: string, options?: any, ...actions: string[]) => vscode.window.showWarningMessage(message, ...actions) } as IDialogService;

  const cliConfig = {
    required: config.getConfig('copilotOrchestrator', 'copilotCli.required', true),
    preferredInstall: config.getConfig('copilotOrchestrator', 'copilotCli.preferredInstall', 'auto' as 'auto')
  };

  const cliAvailable = isCliCachePopulated() ? isCopilotCliAvailable() : await checkCopilotCliAsync();
  const decision = evaluateCliAvailability(cliConfig, cliAvailable);
  if (decision === 'not-required' || decision === 'available') {return true;}

  const hasGh = await cmdOkAsync('gh --version');
  const installMethod = determineInstallMethod(cliConfig.preferredInstall, hasGh);
  const instructions = getInstallInstructions(installMethod);
  
  const actions = installMethod === 'gh' ? [instructions.label, 'Install via npm'] : ['Install via npm'];
  const choice = await dialogs.showWarning(`GitHub Copilot CLI was not found${reason ? ` (${reason})` : ''}. Some orchestrations may rely on it.`, undefined, ...actions, 'Learn more');

  if (!choice) {return false;}
  if (choice === 'Learn more') { vscode.env.openExternal(vscode.Uri.parse('https://github.com/github/gh-copilot')); return false; }

  const selectedInstructions = choice === 'Install via npm' ? getInstallInstructions('npm') : instructions;
  const terminal = vscode.window.createTerminal({ name: `Install Copilot CLI (${choice.includes('gh') ? 'gh extension' : 'npm'})` });
  terminal.show();
  selectedInstructions.commands.forEach(cmd => terminal.sendText(cmd, true));
  return false;
}

export function registerCopilotCliCheck(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand('orchestrator.copilotCli.check', async () => {
    const ok = await ensureCopilotCliInteractive('startup check');
    vscode.window.showInformationMessage(ok? 'Copilot CLI detected.' : 'Copilot CLI not detected (prompt shown).');
  }));
}

/**
 * Check CLI availability at startup and offer setup if needed.
 * Delays the check to avoid false negatives during VS Code's busy startup window.
 */
export async function checkCopilotCliOnStartup(): Promise<void> {
  // Wait for VS Code to finish initializing — process spawning is slow during startup
  await new Promise(resolve => setTimeout(resolve, 8000));

  const cliAvailable = isCliCachePopulated() ? isCopilotCliAvailable() : await checkCopilotCliAsync();
  
  if (!cliAvailable) {
    // Retry once after a short delay (the first check may have timed out)
    await new Promise(resolve => setTimeout(resolve, 3000));
    const retryResult = await checkCopilotCliAsync();
    if (retryResult) return;

    const action = await vscode.window.showWarningMessage(
      'Copilot CLI not detected. The orchestrator requires it for agent work.',
      'Setup Now',
      'Dismiss'
    );
    if (action === 'Setup Now') {
      vscode.commands.executeCommand('copilotOrchestrator.setupCopilotCli');
    }
  }
}
