/**
 * @fileoverview Centralized logging system with per-component debug control.
 * 
 * Provides a VS Code OutputChannel-based logging system that allows
 * debug logging to be enabled/disabled per component via settings.
 * 
 * When running outside VS Code (e.g., stdio MCP server), falls back to
 * console-only logging.
 * 
 * Components:
 * - mcp: MCP protocol handler and server management
 * - http: HTTP server requests and responses
 * - jobs: Job runner and execution
 * - plans: Plan runner and execution
 * - git: Git operations and worktrees
 * - ui: UI/Webview operations
 * 
 * @example
 * ```typescript
 * import { Logger } from './core/logger';
 * 
 * const log = Logger.for('mcp');
 * log.info('MCP server started');
 * log.debug('Request received', { method: 'tools/list' });
 * log.error('Connection failed', error);
 * ```
 * 
 * @module core/logger
 */

// Conditionally import vscode - may not be available in standalone processes
let vscode: typeof import('vscode') | undefined;
try {
  vscode = require('vscode');
} catch {
  // Running outside VS Code extension host (e.g., stdio server)
  vscode = undefined;
}

import { IConfigProvider } from '../interfaces/IConfigProvider';

/**
 * Log levels supported by the logger
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Components that can have logging enabled
 */
export type LogComponent = 'mcp' | 'http' | 'jobs' | 'plans' | 'git' | 'ui' | 'extension' | 'scheduler' | 'plan' | 'plan-runner' | 'plan-state' | 'plan-persistence' | 'job-executor' | 'init' | 'global-capacity';

/**
 * Configuration keys for logging settings
 */
export const LOGGING_LEVEL_KEY = 'copilotOrchestrator.logging.level';
export const LOGGING_COMPONENTS_KEY = 'copilotOrchestrator.logging.components';

/**
 * Debug configuration per component
 */
interface DebugConfig {
  mcp: boolean;
  http: boolean;
  jobs: boolean;
  plans: boolean;
  git: boolean;
  ui: boolean;
  extension: boolean;
  scheduler: boolean;
  plan: boolean;
  'plan-runner': boolean;
  'plan-state': boolean;
  'plan-persistence': boolean;
  'job-executor': boolean;
  init: boolean;
  'global-capacity': boolean;
}

/**
 * Centralized logger with per-component debug control.
 * 
 * Uses a VS Code OutputChannel for visibility in the Output panel.
 * Debug logging can be enabled/disabled per component via settings.
 * Falls back to console-only logging when running outside VS Code.
 */
export class Logger {
  private static instance: Logger | undefined;
  private outputChannel: { appendLine: (s: string) => void; show: () => void; dispose: () => void } | undefined;
  private debugConfig: DebugConfig = {
    mcp: false,
    http: false,
    jobs: false,
    plans: false,
    git: false,
    ui: false,
    extension: false,
    scheduler: false,
    plan: false,
    'plan-runner': false,
    'plan-state': false,
    'plan-persistence': false,
    'job-executor': false,
    init: false,
    'global-capacity': false
  };
  private configListener: { dispose: () => void } | undefined;
  private configProvider?: IConfigProvider;
  private currentLogLevel: LogLevel = 'info';

  constructor(configProvider?: IConfigProvider) {
    this.configProvider = configProvider;
    
    if (vscode) {
      this.outputChannel = vscode.window.createOutputChannel('Copilot Orchestrator');
      this.loadConfig();
      
      // Listen for configuration changes
      this.configListener = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('copilotOrchestrator.logging')) {
          this.loadConfig();
          this.info('extension', 'Logging configuration updated');
        }
      });
    }
    // When vscode is not available, we just use console (outputChannel stays undefined)
  }

  /**
   * Initialize the logger. Should be called once during extension activation.
   */
  static initialize(context: { subscriptions: { push: (d: { dispose: () => void }) => void } }): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
      if (Logger.instance.outputChannel) {
        context.subscriptions.push(Logger.instance.outputChannel);
      }
      if (Logger.instance.configListener) {
        context.subscriptions.push(Logger.instance.configListener);
      }
    }
    return Logger.instance;
  }

  /**
   * Get the singleton logger instance.
   * Falls back to console if not initialized.
   */
  private static getInstance(): Logger | undefined {
    return Logger.instance;
  }

  /**
   * Set a config provider for the logger instance.
   */
  setConfigProvider(provider: IConfigProvider): void {
    this.configProvider = provider;
    this.loadConfig();
  }

  /**
   * Create a component-scoped logger.
   * 
   * @param component - The component name for log prefixes
   * @returns A ComponentLogger bound to the specified component
   */
  static for(component: LogComponent): ComponentLogger {
    return new ComponentLogger(component);
  }

  /**
   * Show the output channel in VS Code.
   */
  static show(): void {
    Logger.instance?.outputChannel?.show();
  }

  /**
   * Load debug configuration from VS Code settings or config provider.
   */
  private loadConfig(): void {
    if (this.configProvider) {
      // Use injected config provider
      this.currentLogLevel = this.configProvider.getConfig(LOGGING_LEVEL_KEY, '', 'info') as LogLevel;
      
      // Load debug config for each component
      this.debugConfig = {
        mcp: this.configProvider.getConfig('copilotOrchestrator.logging.debug', 'mcp', false),
        http: this.configProvider.getConfig('copilotOrchestrator.logging.debug', 'http', false),
        jobs: this.configProvider.getConfig('copilotOrchestrator.logging.debug', 'jobs', false),
        plans: this.configProvider.getConfig('copilotOrchestrator.logging.debug', 'plans', false),
        git: this.configProvider.getConfig('copilotOrchestrator.logging.debug', 'git', false),
        ui: this.configProvider.getConfig('copilotOrchestrator.logging.debug', 'ui', false),
        extension: this.configProvider.getConfig('copilotOrchestrator.logging.debug', 'extension', false),
        scheduler: this.configProvider.getConfig('copilotOrchestrator.logging.debug', 'scheduler', false),
        plan: this.configProvider.getConfig('copilotOrchestrator.logging.debug', 'plan', false),
        'plan-runner': this.configProvider.getConfig('copilotOrchestrator.logging.debug', 'plan-runner', false),
        'plan-state': this.configProvider.getConfig('copilotOrchestrator.logging.debug', 'plan-state', false),
        'plan-persistence': this.configProvider.getConfig('copilotOrchestrator.logging.debug', 'plan-persistence', false),
        'job-executor': this.configProvider.getConfig('copilotOrchestrator.logging.debug', 'job-executor', false),
        init: this.configProvider.getConfig('copilotOrchestrator.logging.debug', 'init', false),
        'global-capacity': this.configProvider.getConfig('copilotOrchestrator.logging.debug', 'global-capacity', false),
      };
    } else if (vscode) {
      // Use VS Code directly (backward compatibility)
      const vscodeConfig = vscode.workspace.getConfiguration('copilotOrchestrator.logging');
      this.currentLogLevel = vscodeConfig.get('level', 'info') as LogLevel;
      
      this.debugConfig = {
        mcp: vscodeConfig.get('debug.mcp', false),
        http: vscodeConfig.get('debug.http', false),
        jobs: vscodeConfig.get('debug.jobs', false),
        plans: vscodeConfig.get('debug.plans', false),
        git: vscodeConfig.get('debug.git', false),
        ui: vscodeConfig.get('debug.ui', false),
        extension: vscodeConfig.get('debug.extension', false),
        scheduler: vscodeConfig.get('debug.scheduler', false),
        plan: vscodeConfig.get('debug.plan', false),
        'plan-runner': vscodeConfig.get('debug.plan-runner', false),
        'plan-state': vscodeConfig.get('debug.plan-state', false),
        'plan-persistence': vscodeConfig.get('debug.plan-persistence', false),
        'job-executor': vscodeConfig.get('debug.job-executor', false),
        init: vscodeConfig.get('debug.init', false),
        'global-capacity': vscodeConfig.get('debug.global-capacity', false),
      };
    } else {
      // Not in VS Code and no provider, keep default config (all false)
      return;
    }
  }

  /**
   * Check if debug logging is enabled for a component.
   */
  isDebugEnabled(component: LogComponent): boolean {
    return this.debugConfig[component] ?? false;
  }

  /**
   * Format a log message with timestamp and component prefix.
   */
  private formatMessage(level: LogLevel, component: LogComponent, message: string): string {
    const timestamp = new Date().toISOString();
    const levelStr = level.toUpperCase().padEnd(5);
    return `[${timestamp}] [${levelStr}] [${component}] ${message}`;
  }

  /**
   * Format additional data for logging.
   */
  private formatData(data?: any): string {
    if (data === undefined) return '';
    if (data instanceof Error) {
      return `\n  Error: ${data.message}${data.stack ? `\n  Stack: ${data.stack}` : ''}`;
    }
    try {
      return '\n  ' + JSON.stringify(data, null, 2).split('\n').join('\n  ');
    } catch {
      return `\n  [Unserializable data: ${typeof data}]`;
    }
  }

  /**
   * Write a log entry.
   */
  log(level: LogLevel, component: LogComponent, message: string, data?: any): void {
    // Skip debug logs if not enabled for this component
    if (level === 'debug' && !this.isDebugEnabled(component)) {
      return;
    }

    // Skip logs below current log level
    const logLevels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const currentLevelIndex = logLevels.indexOf(this.currentLogLevel);
    const messageLevelIndex = logLevels.indexOf(level);
    
    if (messageLevelIndex < currentLevelIndex) {
      return;
    }

    const formattedMessage = this.formatMessage(level, component, message) + this.formatData(data);
    
    // Write to output channel if available (VS Code context)
    if (this.outputChannel) {
      this.outputChannel.appendLine(formattedMessage);
    }

    // Also log to console for development or standalone mode
    // In standalone mode (stdio server), ALL output must go to stderr
    // since stdout is reserved for JSON-RPC messages
    if (!this.outputChannel) {
      // Standalone mode: always use stderr
      console.error(`[Orchestrator:${component}] ${message}`, data ?? '');
    } else {
      // VS Code mode: use appropriate console method
      const consoleFn = level === 'error' ? console.error :
                        level === 'warn' ? console.warn :
                        level === 'debug' ? console.debug :
                        console.log;
      consoleFn(`[Orchestrator:${component}] ${message}`, data ?? '');
    }
  }

  /**
   * Set the log level.
   */
  setLevel(level: LogLevel): void {
    this.currentLogLevel = level;
  }

  /**
   * Get the current log level.
   */
  getLevel(): string {
    return this.currentLogLevel;
  }

  /**
   * Log at debug level.
   */
  debug(component: LogComponent, message: string, data?: any): void {
    this.log('debug', component, message, data);
  }

  /**
   * Log at info level.
   */
  info(component: LogComponent, message: string, data?: any): void {
    this.log('info', component, message, data);
  }

  /**
   * Log at warn level.
   */
  warn(component: LogComponent, message: string, data?: any): void {
    this.log('warn', component, message, data);
  }

  /**
   * Log at error level.
   */
  error(component: LogComponent, message: string, data?: any): void {
    this.log('error', component, message, data);
  }
}

/**
 * Component-scoped logger for convenience.
 * 
 * Provides log methods pre-bound to a specific component.
 */
export class ComponentLogger {
  constructor(private readonly component: LogComponent) {}

  private getInstance(): Logger | undefined {
    return (Logger as any).getInstance();
  }

  /**
   * Log at debug level (only if debug enabled for this component).
   */
  debug(message: string, data?: any): void {
    const instance = this.getInstance();
    if (instance) {
      instance.debug(this.component, message, data);
    } else {
      console.debug(`[Orchestrator:${this.component}] ${message}`, data ?? '');
    }
  }

  /**
   * Log at info level.
   */
  info(message: string, data?: any): void {
    const instance = this.getInstance();
    if (instance) {
      instance.info(this.component, message, data);
    } else {
      console.log(`[Orchestrator:${this.component}] ${message}`, data ?? '');
    }
  }

  /**
   * Log at warn level.
   */
  warn(message: string, data?: any): void {
    const instance = this.getInstance();
    if (instance) {
      instance.warn(this.component, message, data);
    } else {
      console.warn(`[Orchestrator:${this.component}] ${message}`, data ?? '');
    }
  }

  /**
   * Log at error level.
   */
  error(message: string, data?: any): void {
    const instance = this.getInstance();
    if (instance) {
      instance.error(this.component, message, data);
    } else {
      console.error(`[Orchestrator:${this.component}] ${message}`, data ?? '');
    }
  }

  /**
   * Check if debug logging is enabled for this component.
   */
  isDebugEnabled(): boolean {
    return this.getInstance()?.isDebugEnabled(this.component) ?? false;
  }

  /**
   * Set the log level.
   */
  setLevel(level: 'debug' | 'info' | 'warn' | 'error'): void {
    this.getInstance()?.setLevel(level);
  }

  /**
   * Get the current log level.
   */
  getLevel(): string {
    return this.getInstance()?.getLevel() ?? 'info';
  }
}
