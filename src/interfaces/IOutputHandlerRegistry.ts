/**
 * @fileoverview Interface for the output handler registry.
 *
 * The registry holds handler factories registered at composition time.
 * When a managed process is created, the factory queries the registry
 * for all factories matching the process label, creating handler instances
 * that are then registered on the process's output bus.
 *
 * @see docs/PROCESS_OUTPUT_BUS_DESIGN.md §4.5
 * @module interfaces/IOutputHandlerRegistry
 */

import type { IOutputHandler } from './IOutputHandler';

/**
 * Context passed to handler factories when creating handler instances.
 */
export interface HandlerContext {
  /** Process identity (e.g., 'copilot', 'git') — used for factory filtering */
  processLabel: string;
  /** Plan context for per-job handler creation */
  planId?: string;
  nodeId?: string;
  worktreePath?: string;
}

/**
 * Factory that creates output handler instances for specific process types.
 */
export interface IOutputHandlerFactory {
  /** Unique factory name */
  readonly name: string;
  /** Which process labels this factory creates handlers for. ['*'] = all. */
  readonly processFilter: string[];
  /** Create a handler instance, or undefined to skip (e.g., missing required context) */
  create(context: HandlerContext): IOutputHandler | undefined;
}

/**
 * Registry of handler factories for creating output handlers.
 *
 * Factories are registered at composition time. When a managed process is
 * created, {@link createHandlers} is called with the process context to
 * produce the matching handler instances.
 */
export interface IOutputHandlerRegistry {
  /** Register a handler factory (called at composition time) */
  registerFactory(factory: IOutputHandlerFactory): void;
  /** Create handler instances matching the given context's processLabel */
  createHandlers(context: HandlerContext): IOutputHandler[];
}
