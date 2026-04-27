/**
 * @fileoverview MCP Server Definition Provider for automatic registration.
 * 
 * This module implements VS Code's McpServerDefinitionProvider interface
 * to automatically register the Copilot Orchestrator MCP server with
 * GitHub Copilot Chat using stdio transport.
 * 
 * @module mcp/mcpDefinitionProvider
 */

import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Event emitter fired when the MCP server definition changes
 * (e.g. settings update, server start/stop).
 *
 * VS Code listens to this event to re-query
 * {@link vscode.McpServerDefinitionProvider.provideMcpServerDefinitions}.
 */
const serverChangedEmitter = new vscode.EventEmitter<void>();

/** Current workspace path. */
let currentWorkspacePath: string | undefined;

/** Current IPC server path (named pipe or Unix socket). */
let currentIpcPath: string | undefined;

/** Auth nonce for the IPC connection. */
let currentAuthNonce: string | undefined;

/** Daemon pipe name for .NET bridge mode. */
let currentDaemonPipeName: string | undefined;

/** Whether the MCP server feature is enabled in user settings. */
let isEnabled = true;

/** Which engine backs the MCP server: TS (default) or .NET. */
let currentEngineKind: 'typescript' | 'dotnet' = 'typescript';

/**
 * Create and register the MCP Server Definition Provider with VS Code.
 *
 * Uses stdio transport where VS Code spawns a child process that
 * communicates via stdin/stdout using the MCP protocol.
 * The stdio server connects back to the extension via IPC.
 *
 * @param context - VS Code extension context.
 * @param workspacePath - Absolute path to the workspace root.
 * @param ipcPath - Path to the IPC server (named pipe or Unix socket).
 * @param authNonce - Auth nonce for the IPC connection (passed via env, not command line).
 * @returns A composite {@link vscode.Disposable}.
 */
export function registerMcpDefinitionProvider(
  context: vscode.ExtensionContext,
  workspacePath: string,
  ipcPath: string,
  authNonce: string
): vscode.Disposable {
  currentWorkspacePath = workspacePath;
  currentIpcPath = ipcPath;
  currentAuthNonce = authNonce;
  
  // Check if MCP is enabled
  const mcpConfig = vscode.workspace.getConfiguration('copilotOrchestrator.mcp');
  isEnabled = mcpConfig.get<boolean>('enabled', true);

  // Check if the API is available
  if (!vscode.lm || typeof vscode.lm.registerMcpServerDefinitionProvider !== 'function') {
    console.warn('[MCP Provider] vscode.lm.registerMcpServerDefinitionProvider is not available. MCP auto-registration requires VS Code 1.99+ with GitHub Copilot.');
    return { dispose: () => {} };
  }

  // Check if stdio is available at runtime
  const stdioAvailable = typeof (vscode as any).McpStdioServerDefinition === 'function';
  if (!stdioAvailable) {
    console.warn('[MCP Provider] McpStdioServerDefinition not available. Requires VS Code 1.99+.');
    return { dispose: () => {} };
  }

  console.log('[MCP Provider] Registering MCP server definition provider (stdio)...');
  console.log(`[MCP Provider] Workspace: ${workspacePath}`);

  // Create the provider
  const provider: vscode.McpServerDefinitionProvider<vscode.McpServerDefinition> = {
    onDidChangeMcpServerDefinitions: serverChangedEmitter.event,
    
    provideMcpServerDefinitions(
      _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.McpServerDefinition[]> {
      console.log(`[MCP Provider] provideMcpServerDefinitions called, enabled=${isEnabled}, workspace=${currentWorkspacePath || '<none>'}`);
      
      if (!isEnabled) {
        console.log('[MCP Provider] Returning empty list (disabled)');
        return [];
      }

      // Require a workspace to be open - plans are workspace-relative
      if (!currentWorkspacePath) {
        console.log('[MCP Provider] Returning empty list (no workspace open)');
        return [];
      }

      const extensionPath = context.extensionPath;
      let server: vscode.McpServerDefinition;

      if (currentEngineKind === 'dotnet') {
        // .NET engine: spawn the bridge process that relays stdin/stdout
        // to the already-running daemon's named pipe.
        if (!currentDaemonPipeName) {
          console.log('[MCP Provider] Returning empty list (.NET engine but no daemon pipe name)');
          return [];
        }

        const platformDir = process.platform === 'win32' ? 'win-x64'
          : process.platform === 'darwin' ? 'osx-x64'
          : 'linux-x64';
        const exe = process.platform === 'win32' ? 'AiOrchestrator.Cli.exe' : 'AiOrchestrator.Cli';
        const binaryPath = path.join(extensionPath, 'dotnet-bin', platformDir, exe);

        server = new (vscode as any).McpStdioServerDefinition(
          'Copilot Orchestrator (.NET)',  // label
          binaryPath,                     // command — native .NET binary
          ['mcp', 'bridge', '--pipe-name', currentDaemonPipeName],
          {},                             // no special env vars needed
          context.extension.packageJSON.version
        );
        (server as any).cwd = vscode.Uri.file(currentWorkspacePath);
        console.log(`[MCP Provider] Returning .NET bridge server: ${(server as any).label}, pipe: ${currentDaemonPipeName}`);
      } else {
        // TypeScript engine (default): spawn via VS Code's bundled Node.js
        // Require IPC path for the stdio server to connect back
        if (!currentIpcPath) {
          console.log('[MCP Provider] Returning empty list (no IPC path)');
          return [];
        }

        const serverScript = path.join(extensionPath, 'dist', 'mcp-stdio-server.js');
        server = new (vscode as any).McpStdioServerDefinition(
          'Copilot Orchestrator',  // label
          process.execPath,        // command — VS Code's bundled Electron/Node binary
          [serverScript],          // args - no variable args, keeps shape stable
          {
            ELECTRON_RUN_AS_NODE: '1',           // Run Electron as plain Node.js
            MCP_IPC_PATH: currentIpcPath,        // IPC connection path
            MCP_AUTH_NONCE: currentAuthNonce,    // Security: auth nonce for IPC
          },
          context.extension.packageJSON.version  // version
        );
        // Set cwd separately (it's a property, not a constructor param)
        (server as any).cwd = vscode.Uri.file(currentWorkspacePath);
        console.log(`[MCP Provider] Returning TS stdio server: ${(server as any).label}, ipc: ${currentIpcPath}`);
      }

      return [server];
    },
    
    resolveMcpServerDefinition(
      server: vscode.McpServerDefinition,
      _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.McpServerDefinition> {
      console.log(`[MCP Provider] Resolving server: ${(server as any).label}`);
      return server;
    }
  };
  
  // Register with VS Code
  try {
    const registration = vscode.lm.registerMcpServerDefinitionProvider(
      'copilot-orchestrator.mcp-server',
      provider
    );
    console.log('[MCP Provider] Successfully registered with VS Code');
    
    // Listen for configuration changes
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('copilotOrchestrator.mcp')) {
        const mcpConfig = vscode.workspace.getConfiguration('copilotOrchestrator.mcp');
        isEnabled = mcpConfig.get<boolean>('enabled', true);
        
        serverChangedEmitter.fire();
        console.log('[MCP Provider] Configuration changed, notifying VS Code');
      }
    });
    
    console.log('[MCP Provider] Registered Copilot Orchestrator MCP server with VS Code');
    
    return vscode.Disposable.from(registration, configWatcher, serverChangedEmitter);
  } catch (error) {
    console.error('[MCP Provider] Failed to register:', error);
    return { dispose: () => {} };
  }
}

/**
 * Notify VS Code that the MCP server availability has changed.
 *
 * Call this whenever the server starts, stops, or changes configuration
 * so that VS Code re-queries the provider for updated definitions.
 */
export function notifyServerChanged(): void {
  serverChangedEmitter.fire();
}

/**
 * Programmatically update the enabled state of the MCP server definition.
 *
 * Fires a change notification only if the state actually changes, causing
 * VS Code to re-query the provider.
 *
 * @param enabled - `true` to advertise the server, `false` to hide it.
 */
export function setMcpServerEnabled(enabled: boolean): void {
  if (isEnabled !== enabled) {
    isEnabled = enabled;
    serverChangedEmitter.fire();
  }
}

/**
 * Switch the MCP server between the TypeScript and .NET engines.
 *
 * Fires a change notification when the kind actually changes, causing
 * VS Code to re-query the provider and pick up the new server definition.
 *
 * @param kind - `'typescript'` for the Node.js stdio server, `'dotnet'` for the native CLI.
 */
export function setMcpEngineKind(kind: 'typescript' | 'dotnet'): void {
  if (currentEngineKind !== kind) {
    currentEngineKind = kind;
    serverChangedEmitter.fire();
  }
}

/**
 * Set the daemon pipe name for .NET bridge mode.
 *
 * When the .NET engine is active, the MCP definition provider spawns
 * `aio mcp bridge --pipe-name <name>` instead of `aio mcp serve`.
 * Call this after the daemon starts so the bridge knows which pipe to connect to.
 *
 * @param pipeName - The daemon's named pipe name (e.g. `aio-daemon-abc123`).
 */
export function setDaemonPipeName(pipeName: string): void {
  if (currentDaemonPipeName !== pipeName) {
    currentDaemonPipeName = pipeName;
    serverChangedEmitter.fire();
  }
}
