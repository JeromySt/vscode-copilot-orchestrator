/**
 * @fileoverview Precheck Phase Executor
 *
 * Handles the prechecks execution phase: runs the node's precheck
 * work spec (process, shell, or agent) and reports success/failure.
 *
 * @module plan/phases/precheckPhase
 */

import type { IPhaseExecutor, PhaseContext, PhaseResult } from '../../interfaces/IPhaseExecutor';
import type { IProcessSpawner } from '../../interfaces/IProcessSpawner';
import { normalizeWorkSpec } from '../types';
import type { ProcessSpec, ShellSpec, AgentSpec } from '../types';
import { runProcess } from './workPhase';
import { runShell } from './workPhase';
import { runAgent } from './workPhase';

/**
 * Executes the prechecks phase of a job node.
 */
export class PrecheckPhaseExecutor implements IPhaseExecutor {
  private agentDelegator?: any;
  private getCopilotConfigDir: (worktreePath: string) => string;
  private spawner: IProcessSpawner;

  constructor(deps: {
    agentDelegator?: any;
    getCopilotConfigDir: (worktreePath: string) => string;
    spawner: IProcessSpawner;
  }) {
    this.agentDelegator = deps.agentDelegator;
    this.getCopilotConfigDir = deps.getCopilotConfigDir;
    this.spawner = deps.spawner;
  }

  async execute(context: PhaseContext): Promise<PhaseResult> {
    const normalized = normalizeWorkSpec(context.workSpec);

    if (!normalized) {
      return { success: true };
    }

    context.logInfo(`Work type: ${normalized.type}`);

    switch (normalized.type) {
      case 'process':
        return runProcess(normalized as ProcessSpec, context, this.spawner);
      case 'shell':
        return runShell(normalized as ShellSpec, context, this.spawner);
      case 'agent':
        return runAgent(
          normalized as AgentSpec,
          context,
          this.agentDelegator,
          this.getCopilotConfigDir,
        );
      default:
        return { success: false, error: `Unknown work type: ${(normalized as any).type}` };
    }
  }
}
