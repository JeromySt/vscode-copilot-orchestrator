/**
 * @fileoverview MCP tool definitions for retrieving orchestrator logs.
 *
 * Provides tools for accessing daemon logs and per-repo execution logs.
 *
 * @module mcp/tools/logTools
 */

import { McpTool } from '../types';

/**
 * Return all log-related MCP tool definitions.
 *
 * @returns Array of {@link McpTool} definitions for log retrieval.
 */
export function getLogToolDefinitions(): McpTool[] {
  return [
    {
      name: 'get_orchestrator_logs',
      description: 'Retrieve AiOrchestrator daemon or repository logs. Use kind="daemon" for global daemon logs, or kind="repo" with a repo_root path for repo-specific execution logs.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['daemon', 'repo'],
            description: 'Which logs to retrieve: "daemon" for the global daemon log, "repo" for the repo-specific execution log.',
          },
          repo_root: {
            type: 'string',
            description: 'Repository root path (required when kind="repo").',
          },
          tail_lines: {
            type: 'number',
            description: 'Number of lines from the end to return (default: 200). Use 0 for the full log.',
          },
        },
        required: ['kind'],
      },
    },
  ];
}
