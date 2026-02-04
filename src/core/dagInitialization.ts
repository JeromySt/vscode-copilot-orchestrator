/**
 * @fileoverview DAG-based Extension Initialization
 * 
 * Replaces the old initialization with the new DAG-based system.
 * Everything is now a DAG - even single jobs.
 * 
 * @module core/dagInitialization
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { DagRunner, DagRunnerConfig, DefaultJobExecutor } from '../dag';
import { ProcessMonitor } from '../process/processMonitor';
import { McpServerManager } from '../mcp/mcpServerManager';
import { registerMcpDefinitionProvider } from '../mcp/mcpDefinitionProvider';
import { Logger } from './logger';

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
// CORE SERVICES
// ============================================================================

/**
 * Initialize the DAG runner and executor
 */
export function initializeDagRunner(
  context: vscode.ExtensionContext
): { dagRunner: DagRunner; executor: DefaultJobExecutor; processMonitor: ProcessMonitor } {
  log.info('Initializing DAG runner...');
  
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  const storagePath = path.join(context.globalStorageUri.fsPath, 'dags');
  
  const config: DagRunnerConfig = {
    storagePath,
    defaultRepoPath: workspacePath,
    maxParallel: loadConfiguration().maxParallel,
    pumpInterval: 1000,
  };
  
  const dagRunner = new DagRunner(config);
  const executor = new DefaultJobExecutor();
  const processMonitor = new ProcessMonitor();
  
  // Wire up executor with storage path for logs
  executor.setStoragePath(storagePath);
  dagRunner.setExecutor(executor);
  
  // Initialize (load persisted DAGs)
  dagRunner.initialize().catch(err => {
    log.error('Failed to initialize DAG runner', { error: err.message });
  });
  
  // Register cleanup
  context.subscriptions.push({
    dispose: () => {
      dagRunner.shutdown();
    }
  });
  
  log.info('DAG runner initialized', { storagePath, workspacePath });
  
  return { dagRunner, executor, processMonitor };
}

// ============================================================================
// HTTP SERVER
// ============================================================================

/**
 * Initialize HTTP server with MCP endpoint
 */
export async function initializeHttpServer(
  context: vscode.ExtensionContext,
  dagRunner: DagRunner,
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
  
  const mcpHandler = new McpHandler(dagRunner, workspacePath);
  
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
    
    // DAG status endpoint
    if (req.url?.startsWith('/api/dags')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const dags = dagRunner.getAll().map(dag => ({
        id: dag.id,
        name: dag.spec.name,
        status: dagRunner.getStateMachine(dag.id)?.computeDagStatus(),
        nodes: dag.nodes.size,
      }));
      res.end(JSON.stringify({ dags }));
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
  
  return manager;
}

// ============================================================================
// UI COMPONENTS
// ============================================================================

/**
 * Initialize the DAGs view in the sidebar
 */
export function initializeDagsView(
  context: vscode.ExtensionContext,
  dagRunner: DagRunner
): void {
  log.info('Initializing DAGs view...');
  
  // Import the view provider
  const { DagsViewProvider } = require('../ui/dagsViewProvider');
  
  const dagsView = new DagsViewProvider(context, dagRunner);
  
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('orchestrator.dagsView', dagsView)
  );
  
  log.info('DAGs view initialized');
}

/**
 * Register commands for the DAG system
 */
export function registerDagCommands(
  context: vscode.ExtensionContext,
  dagRunner: DagRunner
): void {
  log.info('Registering DAG commands...');
  
  // Show DAG details
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.showDagDetails', (dagId: string) => {
      const { DagDetailPanel } = require('../ui/panels/dagDetailPanel');
      DagDetailPanel.createOrShow(context.extensionUri, dagId, dagRunner);
    })
  );
  
  // Show node details
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.showNodeDetails', (dagId: string, nodeId: string) => {
      const { NodeDetailPanel } = require('../ui/panels/nodeDetailPanel');
      NodeDetailPanel.createOrShow(context.extensionUri, dagId, nodeId, dagRunner);
    })
  );
  
  // Cancel DAG
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.cancelDag', async (dagId: string) => {
      const dag = dagRunner.get(dagId);
      if (!dag) {
        vscode.window.showErrorMessage(`DAG not found: ${dagId}`);
        return;
      }
      
      const confirm = await vscode.window.showWarningMessage(
        `Cancel DAG "${dag.spec.name}"?`,
        { modal: true },
        'Cancel DAG'
      );
      
      if (confirm === 'Cancel DAG') {
        dagRunner.cancel(dagId);
        vscode.window.showInformationMessage(`DAG "${dag.spec.name}" canceled`);
      }
    })
  );
  
  // Delete DAG
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.deleteDag', async (dagId: string) => {
      const dag = dagRunner.get(dagId);
      if (!dag) {
        vscode.window.showErrorMessage(`DAG not found: ${dagId}`);
        return;
      }
      
      const confirm = await vscode.window.showWarningMessage(
        `Delete DAG "${dag.spec.name}"? This cannot be undone.`,
        { modal: true },
        'Delete'
      );
      
      if (confirm === 'Delete') {
        dagRunner.delete(dagId);
        vscode.window.showInformationMessage(`DAG "${dag.spec.name}" deleted`);
      }
    })
  );
  
  // Refresh view
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.refreshDags', () => {
      vscode.commands.executeCommand('orchestrator.dagsView.refresh');
    })
  );
  
  log.info('DAG commands registered');
}
