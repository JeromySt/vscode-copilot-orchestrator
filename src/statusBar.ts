
import * as vscode from 'vscode';
import { JobRunner } from './jobRunner';
export function attachStatusBar(context:vscode.ExtensionContext, runner: JobRunner){ const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100); item.text='Orchestrator: idle'; item.tooltip='Copilot Orchestrator'; item.show(); const iv = setInterval(()=>{ const running = runner.list().filter(j=>j.status==='running').length; item.text = running? `Orchestrator: ${running} running` : 'Orchestrator: idle'; }, 1000); context.subscriptions.push({ dispose(){ clearInterval(iv); item.dispose(); }}); }
