/**
 * @fileoverview Interface for MCP server management.
 * 
 * The MCP (Model Context Protocol) server allows external AI agents
 * to interact with the orchestrator via stdio transport.
 * 
 * @module interfaces/IMcpManager
 */

/**
 * Interface for managing the MCP server status and configuration.
 * 
 * The MCP server is spawned by VS Code via stdio transport for
 * communication with GitHub Copilot. This interface manages the
 * status display and configuration.
 * 
 * @example
 * ```typescript
 * if (config.mcp.enabled) {
 *   mcpManager.start(); // Mark as available
 *   mcpManager.setRegisteredWithVSCode(true);
 * }
 * ```
 */
export interface IMcpManager {
  /**
   * Mark the MCP server as available.
   */
  start(): void;
  
  /**
   * Mark the MCP server as stopped.
   */
  stop(): void;
  
  /**
   * Check if the MCP server is available.
   * @returns true if the server is registered/available
   */
  isRunning(): boolean;
  
  /**
   * Get the MCP server identifier.
   * @returns Server identifier string
   */
  getEndpoint(): string;
  
  /**
   * Subscribe to server status changes.
   * @param callback - Called when status changes
   * @returns Unsubscribe function
   */
  onStatusChange(callback: (status: 'connected' | 'available' | 'stopped' | 'error') => void): () => void;
}
