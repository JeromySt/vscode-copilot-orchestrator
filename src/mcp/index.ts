/**
 * @fileoverview MCP (Model Context Protocol) module exports.
 * 
 * This module provides MCP server functionality for the Copilot Orchestrator.
 * 
 * Structure:
 * - types.ts - Shared type definitions
 * - tools/planTools.ts - Plan tool definitions (schemas)
 * - handlers/planHandlers.ts - Plan tool handlers
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
export { getAllToolDefinitions, getPlanToolDefinitions } from './tools';
