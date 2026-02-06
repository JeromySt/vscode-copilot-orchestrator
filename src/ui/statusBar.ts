/**
 * @fileoverview Status Bar Integration
 * 
 * Shows DAG execution status in the VS Code status bar.
 * 
 * @module ui/statusBar
 */

import * as vscode from 'vscode';
import { DagRunner } from '../dag';

/**
 * Attach status bar item that shows DAG execution status.
 */
export function attachStatusBar(context: vscode.ExtensionContext, dagRunner: DagRunner) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.text = 'Orchestrator: idle';
  item.tooltip = 'Copilot Orchestrator (DAG Mode)';
  item.command = 'orchestrator.refreshDags';
  item.show();
  
  const iv = setInterval(() => {
    const dags = dagRunner.getAll();
    const runningDags = dags.filter(dag => {
      const sm = dagRunner.getStateMachine(dag.id);
      const status = sm?.computeDagStatus();
      return status === 'running';
    });
    
    if (runningDags.length > 0) {
      // Count running nodes across all DAGs
      let runningNodes = 0;
      for (const dag of runningDags) {
        for (const state of dag.nodeStates.values()) {
          if (state.status === 'running') runningNodes++;
        }
      }
      item.text = `Orchestrator: ${runningDags.length} DAG${runningDags.length > 1 ? 's' : ''} (${runningNodes} jobs)`;
    } else {
      const total = dags.length;
      item.text = total > 0 ? `Orchestrator: ${total} DAG${total > 1 ? 's' : ''}` : 'Orchestrator: idle';
    }
  }, 1000);
  
  context.subscriptions.push({
    dispose() {
      clearInterval(iv);
      item.dispose();
    }
  });
}
