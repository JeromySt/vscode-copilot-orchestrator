/**
 * @fileoverview Interfaces for MCP server management.
 * 
 * The MCP (Model Context Protocol) server allows external AI agents
 * to interact with the orchestrator via stdio transport.
 * 
 * @module interfaces/IMcpManager
 */

import { JsonRpcRequest, JsonRpcResponse } from '../mcp/types';

/**
 * Routes a JSON-RPC request to the appropriate handler
 * and returns a JSON-RPC response.
 */
export interface IMcpRequestRouter {
  handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse>;
}

/**
 * MCP server lifecycle interface for stdio transport.
 */
export interface IMcpServerLifecycle {
  /** Transport identifier (always 'stdio'). */
  readonly transport: 'stdio';

  /** Start the MCP server (marks as available). */
  start(): void;

  /** Stop the MCP server. */
  stop(): void;

  /** Whether the server is ready to accept requests. */
  isRunning(): boolean;

  /** Subscribe to status changes. */
  onStatusChange(
    callback: (status: 'connected' | 'available' | 'stopped' | 'error') => void,
  ): () => void;
}

/**
 * Interface for managing the MCP server status and configuration.
 * Extends {@link IMcpServerLifecycle} with an endpoint accessor.
 * 
 * @example
 * ```typescript
 * if (config.mcp.enabled) {
 *   mcpManager.start(); // Mark as available
 * }
 * ```
 */
export interface IMcpManager extends IMcpServerLifecycle {
  /** Get a display-friendly endpoint identifier (always "stdio"). */
  getEndpoint(): string;
}
