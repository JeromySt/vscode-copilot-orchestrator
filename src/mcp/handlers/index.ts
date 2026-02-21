/**
 * @fileoverview Handlers module - aggregates all MCP tool handlers.
 * 
 * Exports both legacy plan handlers and new job-centric handlers.
 * Legacy adapters bridge old tool names to new implementations.
 * 
 * @module mcp/handlers
 */

export * from './planHandlers';
export * from './jobHandlers';
export * from './legacyAdapters';
export * from './utils';
