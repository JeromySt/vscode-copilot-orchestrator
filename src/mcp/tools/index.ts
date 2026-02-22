/**
 * @fileoverview Tools module - aggregates all MCP tool definitions.
 * 
 * @module mcp/tools
 */

export { getPlanToolDefinitions, PRODUCER_ID_PATTERN } from './planTools';
export { getJobToolDefinitions } from './jobTools';

import { McpTool } from '../types';
import { getPlanToolDefinitions } from './planTools';
import { getJobToolDefinitions } from './jobTools';

/**
 * Get all MCP tool definitions across all tool modules.
 *
 * Combines legacy plan tools with new job-centric tools.
 *
 * @returns Combined array of all {@link McpTool} definitions.
 */
export async function getAllToolDefinitions(): Promise<McpTool[]> {
  return [
    ...(await getPlanToolDefinitions()),
    ...(await getJobToolDefinitions()),
  ];
}
