/**
 * @fileoverview Configuration type definitions.
 * 
 * These types define the shape of configuration files and settings
 * used throughout the orchestrator.
 * 
 * @module types/config
 */

/**
 * Configuration for the HTTP API server.
 */
export interface HttpServerConfig {
  /** Whether the HTTP server is enabled */
  enabled: boolean;
  /** Host to bind to (default: 127.0.0.1) */
  host: string;
  /** Port to listen on (default: 39218) */
  port: number;
}

/**
 * Configuration for the MCP server.
 */
export interface McpServerConfig {
  /** Whether the MCP server is enabled */
  enabled: boolean;
  /** Host for the orchestrator API */
  host: string;
  /** Port for the orchestrator API */
  port: number;
}

/**
 * Workspace-level orchestrator configuration.
 * Stored in .orchestrator/config.json
 */
export interface OrchestratorConfig {
  /** Directory for git worktrees (relative to repo root) */
  worktreeRoot?: string;
  /** Maximum concurrent job workers */
  maxWorkers?: number;
  /** HTTP server configuration */
  http?: HttpServerConfig;
}

/**
 * VS Code extension settings for the orchestrator.
 * Accessed via vscode.workspace.getConfiguration('copilotOrchestrator')
 */
export interface ExtensionSettings {
  mcp: {
    /** Whether MCP server auto-starts */
    enabled: boolean;
    /** Host for orchestrator API */
    host: string;
    /** Port for orchestrator API */
    port: number;
  };
}
