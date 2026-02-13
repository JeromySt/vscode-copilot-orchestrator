/**
 * @fileoverview Composition Root — DI container wiring for the extension.
 *
 * Creates a {@link ServiceContainer} with all production service implementations
 * registered. This is the single place where concrete classes meet their interfaces.
 *
 * ## Dependency Graph
 *
 * ```
 * IConfigProvider  ──→ VsCodeConfigProvider   (singleton)
 *   └─ used by: loadConfiguration, Logger
 *
 * IDialogService   ──→ VsCodeDialogService    (singleton)
 *   └─ used by: PlanDetailController, NodeDetailController
 *
 * IClipboardService ─→ VsCodeClipboardService (singleton)
 *   └─ used by: NodeDetailPanel
 *
 * IProcessMonitor  ──→ ProcessMonitor         (singleton)
 *   └─ used by: PlanRunner, NodeDetailPanel
 *
 * ILogger          ──→ Logger (ComponentLogger)(singleton)
 *   └─ used by: all components via Logger.for()
 * ```
 *
 * @module composition
 */

import * as vscode from 'vscode';
import { ServiceContainer } from './core/container';
import * as Tokens from './core/tokens';
import { VsCodeConfigProvider, VsCodeDialogService, VsCodeClipboardService } from './vscode/adapters';
import { ProcessMonitor } from './process/processMonitor';
import { Logger } from './core/logger';
import { PulseEmitter } from './core/pulse';

/**
 * Create and wire the production DI container.
 *
 * Registers every interface → implementation binding used by the extension.
 * Call once during {@link activate} and pass the container (or resolved
 * services) to subsystems that need them.
 *
 * @param context - VS Code extension context, used for subscriptions and storage paths
 * @returns A fully-wired {@link ServiceContainer}
 */
export function createContainer(context: vscode.ExtensionContext): ServiceContainer {
  const container = new ServiceContainer();

  // ─── VS Code Adapter Services ────────────────────────────────────────
  // Thin wrappers over vscode.workspace / vscode.window / vscode.env
  container.registerSingleton<import('./interfaces').IConfigProvider>(
    Tokens.IConfigProvider,
    () => new VsCodeConfigProvider(),
  );

  container.registerSingleton<import('./interfaces').IDialogService>(
    Tokens.IDialogService,
    () => new VsCodeDialogService(),
  );

  container.registerSingleton<import('./interfaces').IClipboardService>(
    Tokens.IClipboardService,
    () => new VsCodeClipboardService(),
  );

  // ─── Infrastructure Services ─────────────────────────────────────────
  container.registerSingleton<import('./interfaces').IProcessMonitor>(
    Tokens.IProcessMonitor,
    () => new ProcessMonitor(),
  );

  // ─── Pulse Emitter ───────────────────────────────────────────────────
  container.registerSingleton<import('./interfaces').IPulseEmitter>(
    Tokens.IPulseEmitter,
    () => new PulseEmitter(),
  );

  // ─── Logger ──────────────────────────────────────────────────────────
  // Logger is a singleton managed by its own static state.
  // We register a factory that initializes it (idempotent) and wires the
  // config provider so logging config is read through the DI layer.
  container.registerSingleton<Logger>(
    Tokens.ILogger,
    (c) => {
      const logger = Logger.initialize(context);
      const configProvider = c.resolve<import('./interfaces').IConfigProvider>(Tokens.IConfigProvider);
      logger.setConfigProvider(configProvider);
      return logger;
    },
  );

  return container;
}
