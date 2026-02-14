/**
 * @fileoverview Postcheck Phase Executor
 *
 * Handles the postchecks execution phase: runs the node's postcheck
 * work spec (process, shell, or agent) and reports success/failure.
 *
 * @module plan/phases/postcheckPhase
 */

import type { IPhaseExecutor, PhaseContext, PhaseResult } from '../../interfaces/IPhaseExecutor';
import type { IProcessSpawner } from '../../interfaces/IProcessSpawner';
import { normalizeWorkSpec } from '../types';
import type { ProcessSpec, ShellSpec, AgentSpec } from '../types';
import { runProcess, runShell, runAgent } from './workPhase';

/**
 * Executes the postchecks phase of a job node.
 */
export class PostcheckPhaseExecutor implements IPhaseExecutor {
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
