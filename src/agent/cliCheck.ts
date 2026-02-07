
import * as vscode from 'vscode';
import { isCopilotCliAvailable, checkCopilotCliAsync, isCliCachePopulated } from './cliCheckCore';

// Async command check helper
async function cmdOkAsync(cmd: string): Promise<boolean> {
  const cp = await import('child_process');
  return new Promise((resolve) => {
    const proc = cp.spawn(cmd, [], { shell: true, stdio: 'ignore' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
    setTimeout(() => { proc.kill(); resolve(false); }, 5000);
  });
}

export async function ensureCopilotCliInteractive(reason: string) {
  const cfg = vscode.workspace.getConfiguration('copilotOrchestrator');
  const required = cfg.get<boolean>('copilotCli.required', true);
  if (!required) return true;
  
  // Wait for async check to complete if cache not yet populated
  let cliAvailable: boolean;
  if (isCliCachePopulated()) {
    cliAvailable = isCopilotCliAvailable();
  } else {
    // Do the actual async check and wait for result
    cliAvailable = await checkCopilotCliAsync();
  }
  
  if (cliAvailable) return true;

  const preferred = cfg.get<'gh'|'npm'|'auto'>('copilotCli.preferredInstall','auto');
  const hasGh = await cmdOkAsync('gh --version');
  const ghAction = (preferred==='gh' || (preferred==='auto' && hasGh)) && hasGh ? 'Install via gh' : undefined;

  const choice = await vscode.window.showWarningMessage(
    `GitHub Copilot CLI was not found${reason? ` (${reason})`:''}. Some orchestrations may rely on it.`,
    ...(ghAction ? [ghAction] as const : []), 'Install via npm', 'Learn more'
  );

  if (!choice) return false;
  if (choice==='Learn more') { vscode.env.openExternal(vscode.Uri.parse('https://github.com/github/gh-copilot')); return false; }
  if (choice==='Install via npm') { const t = vscode.window.createTerminal({ name: 'Install Copilot CLI (npm)' }); t.show(); t.sendText('npm i -g @githubnext/github-copilot-cli', true); t.sendText('# When complete, run: copilot --help', true); return false; }
  if (choice==='Install via gh') { const t = vscode.window.createTerminal({ name: 'Install Copilot CLI (gh extension)' }); t.show(); t.sendText('gh extension install github/gh-copilot', true); t.sendText('# When complete, run: gh copilot --help', true); return false; }
  return false;
}

export function registerCopilotCliCheck(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand('orchestrator.copilotCli.check', async () => {
    const ok = await ensureCopilotCliInteractive('startup check');
    vscode.window.showInformationMessage(ok? 'Copilot CLI detected.' : 'Copilot CLI not detected (prompt shown).');
  }));
}
