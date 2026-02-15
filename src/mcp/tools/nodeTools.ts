/**
 * @fileoverview Node MCP Tool Definitions
 *
 * Defines the schema for all node-centric MCP tools.
 * These are the new simplified API alongside the legacy plan tools.
 *
 * @module mcp/tools/nodeTools
 */

import { McpTool } from '../types';
import { discoverAvailableModelsLegacy } from '../../agent/modelDiscovery';

/**
 * Return all node-centric MCP tool definitions.
 *
 * Tools are grouped into three categories:
 * 1. **Status & Queries** – `get_copilot_node`, `list_copilot_nodes`
 * 2. **Control** – `retry_copilot_node`, `get_copilot_node_failure_context`
 *
 * @returns Array of {@link McpTool} definitions.
 */
export async function getNodeToolDefinitions(): Promise<McpTool[]> {
  const modelResult = await discoverAvailableModelsLegacy();
  const modelEnum = modelResult.rawChoices.length > 0
    ? modelResult.rawChoices
    : ['gpt-5', 'claude-sonnet-4.5'];

  return [
    // =========================================================================
    // STATUS & QUERIES
    // =========================================================================
    {
      name: 'get_copilot_node',
      description: 'Get detailed information about a specific node. No group/plan ID required — nodes are looked up globally.',
      inputSchema: {
        type: 'object',
        properties: {
          node_id: {
            type: 'string',
            description: 'Node UUID or producer_id'
          }
        },
        required: ['node_id']
      }
    },

    {
      name: 'list_copilot_nodes',
      description: 'List nodes with optional filters by group or status.',
      inputSchema: {
        type: 'object',
        properties: {
          group_id: {
            type: 'string',
            description: 'Filter by group ID'
          },
          status: {
            type: 'string',
            enum: ['pending', 'ready', 'scheduled', 'running', 'succeeded', 'failed', 'blocked', 'canceled'],
            description: 'Filter by node status'
          },
          group_name: {
            type: 'string',
            description: 'Filter by group name (partial match)'
          }
        }
      }
    },

    // =========================================================================
    // CONTROL
    // =========================================================================
    {
      name: 'retry_copilot_node',
      description: `Retry a specific failed node. No group/plan ID required.

The node must be in 'failed' state to be retried.

WORKFLOW:
1. Use get_copilot_node_failure_context to analyze the failure
2. Call retry_copilot_node with optional newWork
3. Monitor with get_copilot_node`,
      inputSchema: {
        type: 'object',
        properties: {
          node_id: {
            type: 'string',
            description: 'Node ID to retry'
          },
          newWork: {
            description: 'Optional replacement work for the retry'
          },
          clearWorktree: {
            type: 'boolean',
            description: 'Reset worktree to base commit before retry (default: false)'
          }
        },
        required: ['node_id']
      }
    },

    {
      name: 'force_fail_copilot_node',
      description: `Force a stuck running node to failed state.

Use this when a node's process has crashed or hung but the node is still 
showing as "running" or "scheduled". This allows the node to be retried.

Only works on nodes in 'running' or 'scheduled' state.`,
      inputSchema: {
        type: 'object',
        properties: {
          node_id: {
            type: 'string',
            description: 'Node ID to force fail'
          },
          reason: {
            type: 'string',
            description: 'Optional reason for the forced failure (for logging)'
          }
        },
        required: ['node_id']
      }
    },

    {
      name: 'get_copilot_node_failure_context',
      description: `Get detailed failure context for a failed node. No group/plan ID required.

Returns:
- Execution logs from the failed attempt
- Which phase failed
- Error message
- Copilot session ID (if agent work was involved)
- Worktree path (for manual inspection)`,
      inputSchema: {
        type: 'object',
        properties: {
          node_id: {
            type: 'string',
            description: 'Node ID to get failure context for'
          }
        },
        required: ['node_id']
      }
    },

    {
      name: 'update_copilot_plan_node',
      description: `Update a node's job specification. Any provided stage (prechecks, work, postchecks) will replace the existing definition and reset execution to re-run from that stage.

RESTRICTIONS:
- Cannot update a node that is currently running (wait for completion or force-fail first)
- Cannot update dependencies/consumesFrom (use a new plan for structural changes)

WORKFLOW:
1. Provide planId and nodeId to identify the node
2. Specify which stages to update (prechecks, work, postchecks)
3. Optionally set resetToStage to control execution restart point
4. Updated stages will replace existing definitions completely
5. Execution resets to the earliest updated stage (or resetToStage if specified)

STAGE DEFINITIONS:
Each stage (prechecks/work/postchecks) can be:
1. String: "npm run test" or "@agent Check implementation"
2. Process spec: { "type": "process", "executable": "node", "args": ["test.js"] }
3. Shell spec: { "type": "shell", "command": "Get-ChildItem", "shell": "powershell" }
4. Agent spec: { "type": "agent", "instructions": "# Task\\n1. Validate code", "model": "${modelEnum[0]}" }`,
      inputSchema: {
        type: 'object',
        properties: {
          planId: {
            type: 'string',
            description: 'The plan ID'
          },
          nodeId: {
            type: 'string',
            description: 'The node ID to update'
          },
          prechecks: {
            description: `New prechecks definition. If provided, prechecks will be re-run.
Can be string or object with type (process/shell/agent).`
          },
          work: {
            description: `New work definition. If provided, work stage will be re-run.
Can be string or object with type (process/shell/agent).`
          },
          postchecks: {
            description: `New postchecks definition. If provided, postchecks will be re-run.
Can be string or object with type (process/shell/agent).`
          },
          resetToStage: {
            type: 'string',
            enum: ['prechecks', 'work', 'postchecks'],
            description: 'Explicitly reset execution to start from this stage. If not provided, resets to the earliest updated stage.'
          }
        },
        required: ['planId', 'nodeId']
      }
    },
  ];
}
