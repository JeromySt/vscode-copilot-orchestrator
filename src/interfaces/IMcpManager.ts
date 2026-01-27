/**
 * @fileoverview Interface for MCP server management.
 * 
 * The MCP (Model Context Protocol) server allows external AI agents
 * to interact with the orchestrator.
 * 
 * @module interfaces/IMcpManager
 */

/**
 * Interface for managing the MCP HTTP server lifecycle.
 * 
 * The MCP server is a separate Node.js process that provides
 * SSE (Server-Sent Events) for real-time communication with
 * AI agents like GitHub Copilot.
 * 
 * @example
 * ```typescript
 * if (config.mcp.enabled) {
 *   mcpManager.start();
 *   // MCP server now listening on mcpManager.getEndpoint()
 * }
 * ```
 */
export interface IMcpManager {
  /**
   * Start the MCP server.
   * No-op if already running.
   */
  start(): void;
  
  /**
   * Stop the MCP server.
   * Gracefully terminates the server process.
   */
  stop(): void;
  
  /**
   * Check if the MCP server is currently running.
   * @returns true if the server process is alive
   */
  isRunning(): boolean;
  
  /**
   * Get the endpoint URL for the MCP server.
   * @returns URL string (e.g., 'http://127.0.0.1:39219')
   */
  getEndpoint(): string;
  
  /**
   * Subscribe to server status changes.
   * @param callback - Called when status changes
   * @returns Unsubscribe function
   */
  onStatusChange(callback: (status: 'running' | 'stopped' | 'error') => void): () => void;
}
