/**
 * @fileoverview Tools module - aggregates all MCP tool definitions.
 * 
 * @module mcp/tools
 */

export { getPlanToolDefinitions, PRODUCER_ID_PATTERN } from './planTools';
export { getJobToolDefinitions } from './jobTools';
export { getReleaseToolDefinitions } from './releaseTools';
export { getTestToolDefinitions } from './testTools';

import { McpTool } from '../types';
import { getPlanToolDefinitions } from './planTools';
import { getJobToolDefinitions } from './jobTools';
import { getReleaseToolDefinitions } from './releaseTools';

/**
 * Get all MCP tool definitions across all tool modules.
 *
 * Combines plan tools, job-centric tools, and release tools.
 *
 * @returns Combined array of all {@link McpTool} definitions.
 */
export async function getAllToolDefinitions(): Promise<McpTool[]> {
  return [
    ...(await getPlanToolDefinitions()),
    ...(await getJobToolDefinitions()),
    ...(await getReleaseToolDefinitions()),
  ];
}
