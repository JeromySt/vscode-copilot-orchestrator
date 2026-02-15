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
 * IProcessSpawner  ──→ DefaultProcessSpawner  (singleton)
 *   └─ used by: ProcessMonitor, PowerManager, WorkPhase, etc.
 *
 * IProcessMonitor  ──→ ProcessMonitor         (singleton, uses IProcessSpawner)
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
import { DefaultProcessSpawner } from './interfaces/IProcessSpawner';
import { Logger } from './core/logger';
import { PulseEmitter } from './core/pulse';
import { DefaultEnvironment } from './interfaces/IEnvironment';
import { CopilotCliRunner } from './agent/copilotCliRunner';
import { DefaultJobExecutor } from './plan/executor';
import { DefaultEvidenceValidator } from './plan/evidenceValidator';
import { GlobalCapacityManager } from './core/globalCapacity';
import { PlanConfigManager } from './plan/configManager';
import { PlanPersistence } from './plan/persistence';
import { StdioMcpServerManager } from './mcp/mcpServerManager';
import { DefaultGitOperations } from './git/DefaultGitOperations';

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

  // ─── Git Operations Service ──────────────────────────────────────────
  container.registerSingleton<import('./interfaces/IGitOperations').IGitOperations>(
    Tokens.IGitOperations,
    () => new DefaultGitOperations(),
  );

  // ─── Infrastructure Services ─────────────────────────────────────────
  // Process spawning abstraction
  container.registerSingleton<import('./interfaces').IProcessSpawner>(
    Tokens.IProcessSpawner,
    () => new DefaultProcessSpawner(),
  );

  // Process monitoring (now with spawner dependency)
  container.registerSingleton<import('./interfaces').IProcessMonitor>(
    Tokens.IProcessMonitor,
    (c) => {
      const spawner = c.resolve<import('./interfaces').IProcessSpawner>(Tokens.IProcessSpawner);
      return new ProcessMonitor(spawner);
    },
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

  // ─── Environment ────────────────────────────────────────────────────
  container.registerSingleton<import('./interfaces').IEnvironment>(
    Tokens.IEnvironment,
    () => new DefaultEnvironment(),
  );

  // ─── Copilot Runner ─────────────────────────────────────────────────
  container.registerSingleton<import('./interfaces').ICopilotRunner>(
    Tokens.ICopilotRunner,
    (c) => {
      const spawner = c.resolve<import('./interfaces').IProcessSpawner>(Tokens.IProcessSpawner);
      const env = c.resolve<import('./interfaces').IEnvironment>(Tokens.IEnvironment);
      return new CopilotCliRunner(undefined, spawner, env);
    },
  );

  // ─── Node Executor ──────────────────────────────────────────────────
  container.registerSingleton(
    Tokens.INodeExecutor,
    (c) => {
      const spawner = c.resolve<import('./interfaces').IProcessSpawner>(Tokens.IProcessSpawner);
      const evidenceValidator = c.resolve<import('./interfaces').IEvidenceValidator>(Tokens.IEvidenceValidator);
      const processMonitor = c.resolve<import('./interfaces').IProcessMonitor>(Tokens.IProcessMonitor);
      const git = c.resolve<import('./interfaces/IGitOperations').IGitOperations>(Tokens.IGitOperations);
      const copilotRunner = c.resolve<import('./interfaces/ICopilotRunner').ICopilotRunner>(Tokens.ICopilotRunner);
      return new DefaultJobExecutor(spawner, evidenceValidator, processMonitor, git, copilotRunner);
    },
  );

  // ─── Node State Machine ─────────────────────────────────────────────
  // PlanStateMachine requires a PlanInstance at construction time.
  // Scoped containers override this registration with a configured instance.
  container.register(
    Tokens.INodeStateMachine,
    () => { throw new Error('INodeStateMachine must be resolved from a scoped container with a PlanInstance'); },
  );

  // ─── Node Persistence ───────────────────────────────────────────────
  container.registerSingleton(
    Tokens.INodePersistence,
    () => new PlanPersistence(context.globalStorageUri.fsPath),
  );

  // ─── Evidence Validator ─────────────────────────────────────────────
  container.registerSingleton<import('./interfaces').IEvidenceValidator>(
    Tokens.IEvidenceValidator,
    () => new DefaultEvidenceValidator(),
  );

  // ─── MCP Request Router ─────────────────────────────────────────────
  // McpHandler requires a PlanRunner and workspacePath at construction time.
  // Scoped containers override this registration with a configured instance.
  container.register(
    Tokens.IMcpRequestRouter,
    () => { throw new Error('IMcpRequestRouter must be resolved from a scoped container with a PlanRunner'); },
  );

  // ─── MCP Manager ───────────────────────────────────────────────────
  container.registerSingleton<import('./interfaces').IMcpManager>(
    Tokens.IMcpManager,
    () => new StdioMcpServerManager(context),
  );

  // ─── Global Capacity ────────────────────────────────────────────────
  container.registerSingleton(
    Tokens.IGlobalCapacity,
    () => new GlobalCapacityManager(context.globalStorageUri.fsPath),
  );

  // ─── Plan Config Manager ────────────────────────────────────────────
  container.registerSingleton(
    Tokens.IPlanConfigManager,
    (c) => {
      const configProvider = c.resolve<import('./interfaces').IConfigProvider>(Tokens.IConfigProvider);
      return new PlanConfigManager(configProvider);
    },
  );

  return container;
}
