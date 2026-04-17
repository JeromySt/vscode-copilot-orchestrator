/**
 * @fileoverview Output handler registry implementation.
 *
 * Holds handler factories registered at composition time. When a managed
 * process is created, the factory queries the registry for all factories
 * matching the process label, creating handler instances that are then
 * registered on the process's output bus.
 *
 * @see docs/PROCESS_OUTPUT_BUS_DESIGN.md §5.4
 * @module process/outputHandlerRegistry
 */

import type { IOutputHandlerRegistry, IOutputHandlerFactory, HandlerContext } from '../interfaces/IOutputHandlerRegistry';
import type { IOutputHandler } from '../interfaces/IOutputHandler';
import { Logger } from '../core/logger';

const log = Logger.for('process-output-bus');

export class OutputHandlerRegistry implements IOutputHandlerRegistry {
  private _factories = new Map<string, IOutputHandlerFactory>();

  registerFactory(factory: IOutputHandlerFactory): void {
    this._factories.set(factory.name, factory);
  }

  createHandlers(context: HandlerContext): IOutputHandler[] {
    const handlers: IOutputHandler[] = [];
    const skipped: string[] = [];
    for (const factory of this._factories.values()) {
      if (factory.processFilter.includes('*') ||
          factory.processFilter.includes(context.processLabel)) {
        try {
          const handler = factory.create(context);
          if (handler) { handlers.push(handler); }
          else { skipped.push(factory.name); }
        } catch (err) {
          log.error('Handler factory threw', { factory: factory.name, error: String(err) });
        }
      }
    }
    log.info('Handlers created', {
      label: context.processLabel,
      planId: context.planId ?? '(none)',
      nodeId: context.nodeId ?? '(none)',
      created: handlers.map(h => h.name).join(', ') || '(none)',
      skipped: skipped.join(', ') || '(none)',
    });
    return handlers;
  }
}
