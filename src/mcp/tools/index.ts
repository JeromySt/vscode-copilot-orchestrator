/**
 * @fileoverview Tools module - aggregates all MCP tool definitions.
 * 
 * @module mcp/tools
 */

export { getPlanToolDefinitions, PRODUCER_ID_PATTERN } from './planTools';

import { McpTool } from '../types';
import { getPlanToolDefinitions } from './planTools';

/**
 * Get all MCP tool definitions.
 */
export function getAllToolDefinitions(): McpTool[] {
  return getPlanToolDefinitions();
}
