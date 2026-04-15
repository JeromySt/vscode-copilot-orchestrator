/**
 * @fileoverview Handler that detects the 'Task complete' marker in stdout.
 *
 * On Windows the Copilot CLI sometimes exits with code=null, signal=null
 * after a successful run. The runner uses this handler to decide whether
 * to coerce that to exit code 0.
 *
 * @see docs/PROCESS_OUTPUT_BUS_DESIGN.md §6.4
 * @module agent/handlers/taskCompleteHandler
 */

import type { IOutputHandler, OutputSource } from '../../interfaces/IOutputHandler';
import { OutputSources } from '../../interfaces/IOutputHandler';
import type { IOutputHandlerFactory } from '../../interfaces/IOutputHandlerRegistry';

export class TaskCompleteHandler implements IOutputHandler {
  readonly name = 'task-complete';
  readonly sources = [OutputSources.stdout];
  readonly windowSize = 1;

  private _sawTaskComplete = false;

  onLine(window: ReadonlyArray<string>, _source: OutputSource): void {
    if (!this._sawTaskComplete && window[window.length - 1].includes('Task complete')) {
      this._sawTaskComplete = true;
    }
  }

  sawTaskComplete(): boolean { return this._sawTaskComplete; }
}

export const TaskCompleteHandlerFactory: IOutputHandlerFactory = {
  name: 'task-complete',
  processFilter: ['copilot'],
  create: () => new TaskCompleteHandler(),
};
