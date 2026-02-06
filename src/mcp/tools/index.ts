/**
 * @fileoverview Tools module - aggregates all MCP tool definitions.
 * 
 * @module mcp/tools
 */

export { getDagToolDefinitions, PRODUCER_ID_PATTERN } from './dagTools';

import { McpTool } from '../types';
import { getDagToolDefinitions } from './dagTools';

/**
 * Get all MCP tool definitions.
 */
export function getAllToolDefinitions(): McpTool[] {
  return getDagToolDefinitions();
}
