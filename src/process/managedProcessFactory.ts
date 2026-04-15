/**
 * @fileoverview Managed process factory implementation.
 *
 * Wraps an already-spawned {@link ChildProcessLike} with a
 * {@link ProcessOutputBus}, registered handlers from the
 * {@link IOutputHandlerRegistry}, and {@link LogFileTailer}s.
 *
 * @see docs/PROCESS_OUTPUT_BUS_DESIGN.md §5.5
 * @module process/managedProcessFactory
 */

import type { ChildProcessLike } from '../interfaces/IProcessSpawner';
import type { IProcessSpawner } from '../interfaces/IProcessSpawner';
import type { IEnvironment } from '../interfaces/IEnvironment';
import type { IManagedProcessFactory, ManagedProcessOptions } from '../interfaces/IManagedProcessFactory';
import type { IManagedProcess } from '../interfaces/IManagedProcess';
import type { IOutputHandlerRegistry } from '../interfaces/IOutputHandlerRegistry';
import { ProcessOutputBus } from './processOutputBus';
import { ManagedProcess } from './managedProcess';

export class ManagedProcessFactory implements IManagedProcessFactory {
  constructor(
    private readonly _registry: IOutputHandlerRegistry,
    private readonly _spawner: IProcessSpawner,
    private readonly _environment: IEnvironment,
  ) {}

  create(proc: ChildProcessLike, options: ManagedProcessOptions): IManagedProcess {
    const now = performance.now();
    const timestamps = { requested: now, created: now };

    const bus = new ProcessOutputBus();

    const handlers = this._registry.createHandlers({
      processLabel: options.label,
      planId: options.planId,
      nodeId: options.nodeId,
      worktreePath: options.worktreePath,
    });
    for (const h of handlers) { bus.register(h); }

    return new ManagedProcess(
      proc,
      bus,
      options.logSources ?? [],
      timestamps,
      this._spawner,
      this._environment.platform,
    );
  }
}
