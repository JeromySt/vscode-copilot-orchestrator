/**
 * @fileoverview MCP (Model Context Protocol) module exports.
 * 
 * This module provides MCP server functionality for the Copilot Orchestrator.
 * 
 * Structure:
 * - types.ts - Shared type definitions
 * - tools/dagTools.ts - DAG tool definitions (schemas)
 * - handlers/dagHandlers.ts - DAG tool handlers
 * - handler.ts - Main MCP protocol handler
 * - mcpServerManager.ts - Server lifecycle management
 * - mcpDefinitionProvider.ts - VS Code MCP registration
 * 
 * @module mcp
 */

// Core handler
export { McpHandler } from './handler';

// Types
export * from './types';

// Server management
export * from './mcpServerManager';
export * from './mcpDefinitionProvider';

// Tools (for advanced use)
export { getAllToolDefinitions, getDagToolDefinitions } from './tools';
