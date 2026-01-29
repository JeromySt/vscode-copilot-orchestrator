/**
 * @fileoverview MCP (Model Context Protocol) module exports.
 * 
 * This module provides MCP server functionality for the Copilot Orchestrator.
 * 
 * Structure:
 * - types.ts - Shared type definitions
 * - tools/ - Tool definitions (schemas)
 *   - jobTools.ts - Job-related tool schemas
 *   - planTools.ts - Plan-related tool schemas
 * - handlers/ - Tool implementations
 *   - jobHandlers.ts - Job tool handlers
 *   - planHandlers.ts - Plan tool handlers
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

// Tools and handlers (for advanced use)
export { getAllToolDefinitions } from './tools';
export { handleToolCall } from './handlers';
