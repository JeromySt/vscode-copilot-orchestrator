/**
 * @fileoverview Plan-based Extension Initialization
 * 
 * Replaces the old initialization with the new Plan-based system.
 * Everything is now a Plan - even single jobs.
 * 
 * @module core/planInitialization
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import { PlanRunner, PlanRunnerConfig, DefaultJobExecutor } from '\.\./plan';
import { ProcessMonitor } from '../process/processMonitor';
import { McpServerManager } from '../mcp/mcpServerManager';
import { registerMcpDefinitionProvider } from '../mcp/mcpDefinitionProvider';
import { Logger } from './logger';
import { isCopilotCliAvailable } from '../agent/cliCheckCore';

const log = Logger.for('init');

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface HttpConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface McpServerConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface ExtensionConfig {
  http: HttpConfig;
  mcp: McpServerConfig;
  maxParallel: number;
}

/**
 * Load extension configuration from VS Code settings
 */
export function loadConfiguration(): ExtensionConfig {
  const httpCfg = vscode.workspace.getConfiguration('copilotOrchestrator.http');
  const mcpCfg = vscode.workspace.getConfiguration('copilotOrchestrator.mcp');
  const rootCfg = vscode.workspace.getConfiguration('copilotOrchestrator');

  return {
    http: {
      enabled: httpCfg.get<boolean>('enabled', true),
      host: httpCfg.get<string>('host', 'localhost'),
      port: httpCfg.get<number>('port', 39219)
    },
    mcp: {
      enabled: mcpCfg.get<boolean>('enabled', true),
      host: httpCfg.get<string>('host', 'localhost'),
      port: httpCfg.get<number>('port', 39219)
    },
    maxParallel: rootCfg.get<number>('maxWorkers', 0) || 4,
  };
}

// ============================================================================
// GITIGNORE HELPER
// ============================================================================

/**
 * Ensure entries are in .gitignore (adds them if missing)
 */
function ensureGitignoreEntries(workspacePath: string, entries: string[]): void {
  const fs = require('fs');
  const gitignorePath = path.join(workspacePath, '.gitignore');
  
  try {
    // Read existing .gitignore or create empty
    let content = '';
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, 'utf8');
    }
    
    const lines = content.split('\n');
    const toAdd: string[] = [];
    
    for (const entry of entries) {
      // Check if entry already exists (with or without trailing slash)
      const entryBase = entry.replace(/\/$/, '');
      const exists = lines.some((line: string) => {
        const trimmed = line.trim();
        return trimmed === entry || trimmed === entryBase || trimmed === entryBase + '/';
      });
      
      if (!exists) {
        toAdd.push(entry);
      }
    }
    
    if (toAdd.length > 0) {
      // Add a comment and the entries
      const addition = '\n# Copilot Orchestrator\n' + toAdd.join('\n') + '\n';
      const newContent = content.endsWith('\n') ? content + addition : content + '\n' + addition;
      fs.writeFileSync(gitignorePath, newContent, 'utf8');
      log.info('Added entries to .gitignore', { entries: toAdd });
    }
  } catch (err: any) {
    log.warn('Failed to update .gitignore', { error: err.message });
  }
}

// ============================================================================
// AGENT DELEGATOR ADAPTER
// ============================================================================

/**
 * Create an agent delegator adapter for the executor.
 * 
 * This bridges the executor's expected interface to the Copilot CLI.
 * It handles session resumption and session ID capture.
 */
function createAgentDelegatorAdapter(log: any) {
  return {
    async delegate(options: {
      task: string;
      instructions?: string;
      worktreePath: string;
      model?: string;
      contextFiles?: string[];
      maxTurns?: number;
      sessionId?: string;
      logOutput?: (line: string) => void;
    }): Promise<{
      success: boolean;
      sessionId?: string;
      error?: string;
      exitCode?: number;
    }> {
      const { task, instructions, worktreePath, sessionId, logOutput } = options;
      
      // Check if Copilot CLI is available
      if (!isCopilotCliAvailable()) {
        log.warn('Copilot CLI not available, skipping agent delegation');
        return { success: true }; // Silent success - work can be done manually
      }
      
      // Build the prompt
      const prompt = instructions ? `${task}\n\nAdditional context:\n${instructions}` : task;
      
      // Build Copilot CLI command
      let copilotCmd = `copilot -p ${JSON.stringify(prompt)} --allow-all-paths --allow-all-tools`;
      
      // Add session resumption if available
      if (sessionId) {
        copilotCmd += ` --resume ${sessionId}`;
        log.info(`Resuming Copilot session: ${sessionId}`);
      }
      
      return new Promise((resolve) => {
        let capturedSessionId: string | undefined = sessionId;
        
        const proc = spawn(copilotCmd, [], {
          cwd: worktreePath,
          shell: true,
        });
        
        // Extract session ID from output
        const extractSession = (text: string) => {
          if (capturedSessionId) return;
          const match = text.match(/Session ID[:\\s]+([a-f0-9-]{36})/i) ||
                       text.match(/session[:\\s]+([a-f0-9-]{36})/i) ||
                       text.match(/Starting session[:\\s]+([a-f0-9-]{36})/i);
          if (match) {
            capturedSessionId = match[1];
            log.info(`Captured Copilot session ID: ${capturedSessionId}`);
          }
        };
        
        proc.stdout?.on('data', (data: Buffer) => {
          const text = data.toString();
          const lines = text.split('\n');
          lines.forEach(line => {
            if (line.trim()) {
              log.debug(`[agent] ${line.trim()}`);
              logOutput?.(`[copilot] ${line.trim()}`);
            }
          });
          extractSession(text);
        });
        
        proc.stderr?.on('data', (data: Buffer) => {
          const text = data.toString();
          const lines = text.split('\n');
          lines.forEach(line => {
            if (line.trim()) {
              log.debug(`[agent] ${line.trim()}`);
              logOutput?.(`[copilot] ${line.trim()}`);
            }
          });
          extractSession(text);
        });
        
        proc.on('exit', (code) => {
          if (code !== 0) {
            log.error(`Copilot CLI exited with code ${code}`);
            resolve({
              success: false,
              sessionId: capturedSessionId,
              error: `Copilot CLI exited with code ${code}`,
              exitCode: code ?? undefined,
            });
          } else {
            log.info('Copilot CLI completed successfully');
            resolve({
              success: true,
              sessionId: capturedSessionId,
            });
          }
        });
        
        proc.on('error', (err) => {
          log.error(`Copilot CLI error: ${err.message}`);
          resolve({
            success: false,
            error: err.message,
          });
        });
      });
    }
  };
}

// ============================================================================
// CORE SERVICES
// ============================================================================

/**
 * Initialize the Plan Runner and executor
 */
export function initializePlanRunner(
  context: vscode.ExtensionContext
): { planRunner: PlanRunner; executor: DefaultJobExecutor; processMonitor: ProcessMonitor } {
  log.info('Initializing Plan Runner...');
  
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  
  // Store everything in workspace .orchestrator folder (or fallback to globalStorage)
  const storagePath = workspacePath 
    ? path.join(workspacePath, '.orchestrator', 'plans')
    : path.join(context.globalStorageUri.fsPath, 'plans');
  
  const config: PlanRunnerConfig = {
    storagePath,
    defaultRepoPath: workspacePath,
    maxParallel: loadConfiguration().maxParallel,
    pumpInterval: 1000,
  };
  
  const planRunner = new PlanRunner(config);
  const executor = new DefaultJobExecutor();
  const processMonitor = new ProcessMonitor();
  
  // Wire up executor with logs in the same .orchestrator directory
  const logsPath = workspacePath 
    ? path.join(workspacePath, '.orchestrator')
    : path.join(context.globalStorageUri.fsPath);
  executor.setStoragePath(logsPath);
  
  // Create agent delegator adapter for the executor
  const agentDelegator = createAgentDelegatorAdapter(log);
  executor.setAgentDelegator(agentDelegator);
  
  planRunner.setExecutor(executor);
  
  // Ensure .orchestrator and .worktrees are in .gitignore
  if (workspacePath) {
    ensureGitignoreEntries(workspacePath, ['.orchestrator/', '.worktrees/']);
  }
  
  // Initialize (load persisted Plans)
  planRunner.initialize().catch(err => {
    log.error('Failed to initialize Plan Runner', { error: err.message });
  });
  
  // Register cleanup
  context.subscriptions.push({
    dispose: () => {
      planRunner.shutdown();
    }
  });
  
  log.info('Plan Runner initialized', { storagePath, workspacePath });
  
  return { planRunner, executor, processMonitor };
}

// ============================================================================
// HTTP SERVER
// ============================================================================

/**
 * Initialize HTTP server with MCP endpoint
 */
export async function initializeHttpServer(
  context: vscode.ExtensionContext,
  planRunner: PlanRunner,
  config: HttpConfig
): Promise<void> {
  if (!config.enabled) {
    log.info('HTTP server disabled');
    return;
  }
  
  log.info(`Starting HTTP server on ${config.host}:${config.port}...`);
  
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  
  // Create a simple HTTP server with the MCP handler
  const http = require('http');
  const { McpHandler } = require('../mcp/handler');
  
  const mcpHandler = new McpHandler(planRunner, workspacePath);
  
  const server = http.createServer(async (req: any, res: any) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    // Health check
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: '0.6.0' }));
      return;
    }
    
    // MCP endpoint
    if (req.url === '/mcp' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => body += chunk.toString());
      req.on('end', async () => {
        try {
          const request = JSON.parse(body);
          const response = await mcpHandler.handleRequest(request);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        } catch (error: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    }
    
    // Plan status endpoint
    if (req.url?.startsWith('/api/plans')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const Plans = planRunner.getAll().map(plan => ({
        id: plan.id,
        name: plan.spec.name,
        status: planRunner.getStateMachine(plan.id)?.computePlanStatus(),
        nodes: plan.nodes.size,
      }));
      res.end(JSON.stringify({ Plans }));
      return;
    }
    
    // Default: 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  
  return new Promise((resolve, reject) => {
    server.listen(config.port, config.host, () => {
      log.info(`HTTP server started at http://${config.host}:${config.port}`);
      log.info(`MCP endpoint: http://${config.host}:${config.port}/mcp`);
      
      context.subscriptions.push({
        dispose: () => {
          server.close();
        }
      });
      
      resolve();
    });
    
    server.on('error', (err: any) => {
      log.error('HTTP server error', { error: err.message });
      reject(err);
    });
  });
}

// ============================================================================
// MCP REGISTRATION
// ============================================================================

/**
 * Initialize MCP server registration with VS Code
 */
export function initializeMcpServer(
  context: vscode.ExtensionContext,
  httpConfig: HttpConfig,
  mcpConfig: McpServerConfig
): McpServerManager | undefined {
  if (!mcpConfig.enabled) {
    log.info('MCP registration disabled');
    return undefined;
  }
  
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  
  const manager = new McpServerManager(context, {
    enabled: true,
    host: httpConfig.host,
    port: httpConfig.port,
    workspacePath
  });
  
  manager.start();
  context.subscriptions.push({ dispose: () => manager.stop() });
  
  // Register with VS Code
  const providerDisposable = registerMcpDefinitionProvider(context, {
    host: httpConfig.host,
    port: httpConfig.port,
    workspacePath
  });
  context.subscriptions.push(providerDisposable);
  
  manager.setRegisteredWithVSCode(true);
  
  log.info(`MCP registered at http://${httpConfig.host}:${httpConfig.port}/mcp`);
  
  // Show one-time reminder to enable MCP server if not previously acknowledged
  const MCP_ENABLED_KEY = 'mcpServerEnabledAcknowledged';
  if (!context.globalState.get<boolean>(MCP_ENABLED_KEY)) {
    vscode.window.showInformationMessage(
      'Copilot Orchestrator MCP server is registered. Enable it in the MCP Servers panel to use plan/job tools with GitHub Copilot.',
      'Got it',
      'Show MCP Servers'
    ).then(choice => {
      if (choice === 'Got it' || choice === 'Show MCP Servers') {
        context.globalState.update(MCP_ENABLED_KEY, true);
      }
      if (choice === 'Show MCP Servers') {
        vscode.commands.executeCommand('workbench.action.chat.listMcpServers');
      }
    });
  }
  
  return manager;
}

// ============================================================================
// UI COMPONENTS
// ============================================================================

/**
 * Initialize the Plans view in the sidebar
 */
export function initializePlansView(
  context: vscode.ExtensionContext,
  planRunner: PlanRunner
): void {
  log.info('Initializing Plans view...');
  
  // Import the view provider
  const { plansViewProvider } = require('../ui/plansViewProvider');
  
  const plansView = new plansViewProvider(context, planRunner);
  
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('orchestrator.plansView', plansView)
  );
  
  log.info('Plans view initialized');
}

/**
 * Register commands for the Plan system
 */
export function registerPlanCommands(
  context: vscode.ExtensionContext,
  planRunner: PlanRunner
): void {
  log.info('Registering Plan commands...');
  
  // Show Plan details
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.showPlanDetails', (planId: string) => {
      const { planDetailPanel } = require('../ui/panels/planDetailPanel');
      planDetailPanel.createOrShow(context.extensionUri, planId, planRunner);
    })
  );
  
  // Show node details
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.showNodeDetails', (planId: string, nodeId: string) => {
      const { NodeDetailPanel } = require('../ui/panels/nodeDetailPanel');
      NodeDetailPanel.createOrShow(context.extensionUri, planId, nodeId, planRunner);
    })
  );
  
  // Cancel Plan
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.cancelPlan', async (planId: string) => {
      const plan = planRunner.get(planId);
      if (!plan) {
        vscode.window.showErrorMessage(`Plan not found: ${planId}`);
        return;
      }
      
      const confirm = await vscode.window.showWarningMessage(
        `Cancel Plan "${plan.spec.name}"?`,
        { modal: true },
        'Cancel Plan'
      );
      
      if (confirm === 'Cancel Plan') {
        planRunner.cancel(planId);
        vscode.window.showInformationMessage(`Plan "${plan.spec.name}" canceled`);
      }
    })
  );
  
  // Delete Plan
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.deletePlan', async (planId: string) => {
      const plan = planRunner.get(planId);
      if (!plan) {
        vscode.window.showErrorMessage(`Plan not found: ${planId}`);
        return;
      }
      
      const confirm = await vscode.window.showWarningMessage(
        `Delete Plan "${plan.spec.name}"? This will cancel any running jobs and remove all worktrees, logs, and state.`,
        { modal: true },
        'Delete'
      );
      
      if (confirm === 'Delete') {
        planRunner.delete(planId);
        vscode.window.showInformationMessage(`Plan "${plan.spec.name}" deleted`);
      }
    })
  );
  
  // Refresh view
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.refreshPlans', () => {
      vscode.commands.executeCommand('orchestrator.plansView.refresh');
    })
  );
  
  log.info('Plan commands registered');
}
