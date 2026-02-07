/**
 * @fileoverview Interfaces for MCP server management.
 * 
 * The MCP (Model Context Protocol) server allows external AI agents
 * to interact with the orchestrator via stdio or HTTP transport.
 * 
 * @module interfaces/IMcpManager
 */

import { JsonRpcRequest, JsonRpcResponse } from '../mcp/types';

/** Transport type for MCP communication. */
export type McpTransportKind = 'stdio' | 'http';

/**
 * Routes a JSON-RPC request to the appropriate handler
 * and returns a JSON-RPC response.
 */
export interface IMcpRequestRouter {
  handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse>;
}

/**
 * Transport-agnostic MCP server lifecycle interface.
 */
export interface IMcpServerLifecycle {
  /** Current transport in use. */
  readonly transport: McpTransportKind;

  /** Start the MCP server (stdio listener or HTTP server). */
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
 *   mcpManager.setRegisteredWithVSCode(true);
 * }
 * ```
 */
export interface IMcpManager extends IMcpServerLifecycle {
  /** Get a display-friendly endpoint identifier (URL or "stdio"). */
  getEndpoint(): string;
}
