/**
 * @fileoverview Tools module - aggregates all MCP tool definitions.
 * 
 * @module mcp/tools
 */

export { getJobToolDefinitions } from './jobTools';
export { getPlanToolDefinitions } from './planTools';

import { McpTool } from '../types';
import { getJobToolDefinitions } from './jobTools';
import { getPlanToolDefinitions } from './planTools';

/**
 * Get all MCP tool definitions.
 */
export function getAllToolDefinitions(): McpTool[] {
  return [
    ...getJobToolDefinitions(),
    ...getPlanToolDefinitions()
  ];
}
