/**
 * @fileoverview Configuration type definitions.
 * 
 * These types define the shape of configuration files and settings
 * used throughout the orchestrator.
 * 
 * @module types/config
 */

/**
 * Configuration for the MCP server.
 */
export interface McpServerConfig {
  /** Whether the MCP server is enabled */
  enabled: boolean;
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
}

/**
 * VS Code extension settings for the orchestrator.
 * Accessed via vscode.workspace.getConfiguration('copilotOrchestrator')
 */
export interface ExtensionSettings {
  mcp: {
    /** Whether MCP server auto-starts */
    enabled: boolean;
  };
}
