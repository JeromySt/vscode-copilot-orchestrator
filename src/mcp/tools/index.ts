/**
 * @fileoverview Tools module - aggregates all MCP tool definitions.
 * 
 * @module mcp/tools
 */

export { getPlanToolDefinitions, PRODUCER_ID_PATTERN } from './planTools';

import { McpTool } from '../types';
import { getPlanToolDefinitions } from './planTools';

/**
 * Get all MCP tool definitions across all tool modules.
 *
 * Currently delegates entirely to {@link getPlanToolDefinitions}. If
 * additional tool modules are added in the future, their definitions
 * should be merged here.
 *
 * @returns Combined array of all {@link McpTool} definitions.
 */
export function getAllToolDefinitions(): McpTool[] {
  return getPlanToolDefinitions();
}
