/**
 * @fileoverview Handlers module - aggregates all MCP tool handlers.
 * 
 * All MCP tool handlers are now DAG-based. The main McpHandler class
 * routes tool calls directly to dagHandlers.
 * 
 * @module mcp/handlers
 */

export * from './dagHandlers';
