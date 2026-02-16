/**
 * @fileoverview Status Bar Integration
 * 
 * Shows Plan execution status in the VS Code status bar.
 * 
 * @module ui/statusBar
 */

import * as vscode from 'vscode';
import { PlanRunner } from '\.\./plan';
import type { IPulseEmitter } from '../interfaces/IPulseEmitter';

/**
 * Create and attach a status bar item that displays live Plan execution status.
 *
 * Polls every 1 second to show the number of running Plans and active jobs,
 * or an idle/total count when nothing is executing. Clicking the item triggers
 * the `orchestrator.refreshPlans` command.
 *
 * The status bar item and its polling interval are automatically disposed when
 * the extension deactivates (via `context.subscriptions`).
 *
 * @param context - The VS Code extension context for registering disposables.
 * @param planRunner - The {@link PlanRunner} instance used to query Plan state.
 *
 * @example
 * ```ts
 * attachStatusBar(context, planRunner);
 * ```
 */
export function attachStatusBar(context: vscode.ExtensionContext, planRunner: PlanRunner, pulse: IPulseEmitter) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.text = 'Orchestrator: idle';
  item.tooltip = 'Copilot Orchestrator';
  item.command = 'orchestrator.refreshPlans';
  item.show();
  
  const pulseSub = pulse.onPulse(async () => {
    const plans = planRunner.getAll();
    const runningPlans = plans.filter(plan => {
      const sm = planRunner.getStateMachine(plan.id);
      const status = sm?.computePlanStatus();
      return status === 'running';
    });
    
    // Get global capacity stats
    const globalStats = await planRunner.getGlobalCapacityStats().catch(() => null);
    
    if (runningPlans.length > 0) {
      // Count running nodes across all Plans
      let runningNodes = 0;
      for (const plan of runningPlans) {
        for (const state of plan.nodeStates.values()) {
          if (state.status === 'running') {runningNodes++;}
        }
      }
      item.text = `Orchestrator: ${runningPlans.length} Plan${runningPlans.length > 1 ? 's' : ''} (${runningNodes} jobs)`;
      
      // Check if we're at global capacity limit
      if (globalStats && globalStats.totalGlobalJobs >= globalStats.globalMaxParallel) {
        item.text += ' (global limit)';
        item.tooltip = `Global job limit reached (${globalStats.activeInstances} instance${globalStats.activeInstances > 1 ? 's' : ''})`;
      } else {
        item.tooltip = 'Copilot Orchestrator';
      }
    } else {
      const total = plans.length;
      item.text = total > 0 ? `Orchestrator: ${total} Plan${total > 1 ? 's' : ''}` : 'Orchestrator: idle';
      item.tooltip = 'Copilot Orchestrator';
    }
  });
  
  context.subscriptions.push({
    dispose() {
      try {
        pulseSub.dispose();
        item.dispose();
      } catch (e) {
        // Item may already be disposed
      }
    }
  });
}
