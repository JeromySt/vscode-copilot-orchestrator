/**
 * @fileoverview Node MCP Tool Definitions
 *
 * Defines the schema for all node-centric MCP tools.
 * These are the new simplified API alongside the legacy plan tools.
 *
 * @module mcp/tools/nodeTools
 */

import { McpTool } from '../types';
import { PRODUCER_ID_PATTERN } from './planTools';

/**
 * Return all node-centric MCP tool definitions.
 *
 * Tools are grouped into three categories:
 * 1. **Creation** – `create_copilot_node`
 * 2. **Status & Queries** – `get_copilot_node`, `list_copilot_nodes`,
 *    `get_copilot_group_status`, `list_copilot_groups`
 * 3. **Control** – `cancel_copilot_group`, `delete_copilot_group`,
 *    `retry_copilot_group`, `retry_copilot_node`,
 *    `get_copilot_node_failure_context`
 *
 * @returns Array of {@link McpTool} definitions.
 */
export function getNodeToolDefinitions(): McpTool[] {
  return [
    // =========================================================================
    // NODE CREATION
    // =========================================================================
    {
      name: 'create_copilot_node',
      description: `Create one or more work nodes, optionally grouped.

SEMANTICS:
- If 'group' is omitted and 'nodes' has one entry → standalone node (like create_copilot_job).
- If 'group' is provided → all nodes share the group (like create_copilot_plan).
- If 'group' is omitted and 'nodes' has multiple entries → ungrouped batch with resolved dependencies.

PRODUCER_ID IS REQUIRED:
- Every node MUST have a 'producer_id' field
- Format: lowercase letters (a-z), numbers (0-9), and hyphens (-) only, 3-64 characters
- Used in 'dependencies' arrays to establish execution order

WORK OPTIONS (work/prechecks/postchecks accept):
1. String: "npm run build" or "@agent Implement feature"
2. Process spec: { type: "process", executable: "dotnet", args: ["build"] }
3. Shell spec: { type: "shell", command: "Get-ChildItem", shell: "powershell" }
4. Agent spec: { type: "agent", instructions: "# Task\\n1. Step one" }

Agent instructions MUST be in Markdown format.`,
      inputSchema: {
        type: 'object',
        properties: {
          nodes: {
            type: 'array',
            description: 'Array of node specifications',
            items: {
              type: 'object',
              properties: {
                producer_id: {
                  type: 'string',
                  description: 'REQUIRED. Unique identifier (3-64 chars, lowercase/numbers/hyphens)',
                  pattern: '^[a-z0-9-]{3,64}$'
                },
                name: {
                  type: 'string',
                  description: 'Display name (defaults to producer_id)'
                },
                task: {
                  type: 'string',
                  description: 'Task description (required)'
                },
                work: {
                  description: 'Work to perform. String, process, shell, or agent spec.'
                },
                prechecks: {
                  description: 'Validation before work'
                },
                postchecks: {
                  description: 'Validation after work'
                },
                instructions: {
                  type: 'string',
                  description: 'Additional agent instructions in Markdown format'
                },
                dependencies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of producer_id values this node depends on. Empty [] for root nodes.'
                },
                base_branch: {
                  type: 'string',
                  description: 'Override base branch (root nodes only)'
                }
              },
              required: ['producer_id', 'task', 'dependencies']
            }
          },
          group: {
            type: 'object',
            description: 'Optional group to assign all nodes to',
            properties: {
              name: {
                type: 'string',
                description: 'Human-readable group name'
              },
              base_branch: {
                type: 'string',
                description: 'Base branch (default: main)'
              },
              target_branch: {
                type: 'string',
                description: 'Target branch for final merge'
              },
              max_parallel: {
                type: 'integer',
                minimum: 1,
                description: 'Max concurrent nodes (default: 4)'
              },
              clean_up_successful_work: {
                type: 'boolean',
                description: 'Clean up worktrees after merge (default: true)'
              }
            }
          }
        },
        required: ['nodes']
      }
    },

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

    {
      name: 'get_copilot_group_status',
      description: 'Get status of a group including progress and node states. Replaces get_copilot_plan_status.',
      inputSchema: {
        type: 'object',
        properties: {
          group_id: {
            type: 'string',
            description: 'Group ID (UUID)'
          }
        },
        required: ['group_id']
      }
    },

    {
      name: 'list_copilot_groups',
      description: 'List all groups with their status. Replaces list_copilot_plans.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'running', 'succeeded', 'failed', 'partial', 'canceled'],
            description: 'Filter by group status (optional)'
          }
        }
      }
    },

    // =========================================================================
    // CONTROL
    // =========================================================================
    {
      name: 'cancel_copilot_group',
      description: 'Cancel all running nodes in a group. Replaces cancel_copilot_plan.',
      inputSchema: {
        type: 'object',
        properties: {
          group_id: {
            type: 'string',
            description: 'Group ID to cancel'
          }
        },
        required: ['group_id']
      }
    },

    {
      name: 'delete_copilot_group',
      description: 'Delete a group and all its nodes. Replaces delete_copilot_plan.',
      inputSchema: {
        type: 'object',
        properties: {
          group_id: {
            type: 'string',
            description: 'Group ID to delete'
          }
        },
        required: ['group_id']
      }
    },

    {
      name: 'retry_copilot_group',
      description: `Retry failed nodes in a group. Replaces retry_copilot_plan.

RETRY WORKFLOW:
1. Use get_copilot_node_failure_context to analyze why the node failed
2. Optionally provide newWork to replace the original work
3. Call retry_copilot_group with the group ID

NEW WORK OPTIONS:
- String: Shell command or "@agent Do something"
- Process: { type: "process", executable: "node", args: ["script.js"] }
- Shell: { type: "shell", command: "Get-ChildItem", shell: "powershell" }
- Agent: { type: "agent", instructions: "# Fix\\n1. Step", resumeSession: true }

Agent instructions MUST be in Markdown format.`,
      inputSchema: {
        type: 'object',
        properties: {
          group_id: {
            type: 'string',
            description: 'Group ID to retry'
          },
          node_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: specific node IDs to retry. If omitted, retries all failed nodes.'
          },
          newWork: {
            description: 'Optional replacement work for the retry'
          },
          clearWorktree: {
            type: 'boolean',
            description: 'Reset worktree to base commit before retry (default: false)'
          }
        },
        required: ['group_id']
      }
    },

    {
      name: 'retry_copilot_node',
      description: `Retry a specific failed node. No group/plan ID required.

The node must be in 'failed' state to be retried.

WORKFLOW:
1. Use get_copilot_node_failure_context to analyze the failure
2. Call retry_copilot_node with optional newWork
3. Monitor with get_copilot_node or get_copilot_group_status`,
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
  ];
}
