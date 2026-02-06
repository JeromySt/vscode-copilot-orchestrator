/**
 * @fileoverview Status Bar Integration
 * 
 * Shows Plan execution status in the VS Code status bar.
 * 
 * @module ui/statusBar
 */

import * as vscode from 'vscode';
import { PlanRunner } from '\.\./plan';

/**
 * Attach status bar item that shows Plan execution status.
 */
export function attachStatusBar(context: vscode.ExtensionContext, planRunner: PlanRunner) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.text = 'Orchestrator: idle';
  item.tooltip = 'Copilot Orchestrator';
  item.command = 'orchestrator.refreshPlans';
  item.show();
  
  const iv = setInterval(() => {
    const plans = planRunner.getAll();
    const runningPlans = plans.filter(plan => {
      const sm = planRunner.getStateMachine(plan.id);
      const status = sm?.computePlanStatus();
      return status === 'running';
    });
    
    if (runningPlans.length > 0) {
      // Count running nodes across all Plans
      let runningNodes = 0;
      for (const plan of runningPlans) {
        for (const state of plan.nodeStates.values()) {
          if (state.status === 'running') runningNodes++;
        }
      }
      item.text = `Orchestrator: ${runningPlans.length} Plan${runningPlans.length > 1 ? 's' : ''} (${runningNodes} jobs)`;
    } else {
      const total = plans.length;
      item.text = total > 0 ? `Orchestrator: ${total} Plan${total > 1 ? 's' : ''}` : 'Orchestrator: idle';
    }
  }, 1000);
  
  context.subscriptions.push({
    dispose() {
      clearInterval(iv);
      item.dispose();
    }
  });
}
