/**
 * @fileoverview DAG MCP Tool Definitions
 * 
 * Defines the schema for all DAG-related tools exposed via MCP.
 * All work is now a DAG - even single jobs.
 * 
 * @module mcp/tools/dagTools
 */

import { McpTool } from '../types';

/** Regex pattern for valid producer_id values */
export const PRODUCER_ID_PATTERN = /^[a-z0-9-]{3,64}$/;

/**
 * Get all DAG-related tool definitions.
 */
export function getDagToolDefinitions(): McpTool[] {
  return [
    // =========================================================================
    // DAG CREATION
    // =========================================================================
    {
      name: 'create_copilot_dag',
      description: `Create a DAG (Directed Acyclic Graph) of work units. Everything is a DAG - even a single job.

PRODUCER_ID IS REQUIRED:
- Every job MUST have a 'producer_id' field
- Format: lowercase letters (a-z), numbers (0-9), and hyphens (-) only, 3-64 characters
- Used in 'dependencies' arrays to establish execution order
- Jobs with dependencies: [] are root jobs that start immediately

EXECUTION CONTEXT:
- All commands run in a SHELL PROCESS (cmd.exe on Windows, /bin/sh on Unix)
- Each job gets its own git worktree for isolated work
- Dependencies chain commits - dependent jobs start from their parent's commit

WORK OPTIONS:
- Shell command: "npm run build"
- Agent delegation: "@agent Implement the login feature"

EXAMPLE:
{
  "name": "Build and Test",
  "jobs": [
    { "producer_id": "build", "task": "Build app", "dependencies": [], "work": "npm run build" },
    { "producer_id": "test", "task": "Run tests", "dependencies": ["build"], "work": "npm test" }
  ]
}`,
      inputSchema: {
        type: 'object',
        properties: {
          name: { 
            type: 'string', 
            description: 'Human-readable name for the DAG' 
          },
          baseBranch: { 
            type: 'string', 
            description: 'Starting branch (default: main). Root jobs branch from here.' 
          },
          targetBranch: { 
            type: 'string', 
            description: 'Optional branch to merge final results into' 
          },
          maxParallel: { 
            type: 'number', 
            description: 'Max concurrent jobs (default: 4)' 
          },
          cleanUpSuccessfulWork: { 
            type: 'boolean', 
            description: 'Clean up worktrees after successful merges (default: true)' 
          },
          jobs: {
            type: 'array',
            description: 'Array of job specifications',
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
                  type: 'string', 
                  description: 'Shell command OR "@agent <task>" for AI delegation' 
                },
                dependencies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of producer_id values this job depends on. Empty [] for root jobs.'
                },
                prechecks: { 
                  type: 'string', 
                  description: 'Shell command to validate before work' 
                },
                postchecks: { 
                  type: 'string', 
                  description: 'Shell command to validate after work' 
                },
                instructions: { 
                  type: 'string', 
                  description: 'Additional context for @agent tasks' 
                }
              },
              required: ['producer_id', 'task', 'dependencies']
            }
          },
          subDags: {
            type: 'array',
            description: 'Optional nested DAGs that run as a unit',
            items: {
              type: 'object',
              properties: {
                producer_id: { 
                  type: 'string', 
                  description: 'Unique identifier for the sub-DAG',
                  pattern: '^[a-z0-9-]{3,64}$'
                },
                name: { 
                  type: 'string', 
                  description: 'Display name' 
                },
                dependencies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Producer IDs this sub-DAG depends on'
                },
                maxParallel: { 
                  type: 'number', 
                  description: 'Max concurrent jobs in this sub-DAG' 
                },
                jobs: {
                  type: 'array',
                  description: 'Jobs within this sub-DAG (same schema as top-level jobs)',
                  items: { type: 'object' }
                }
              },
              required: ['producer_id', 'dependencies', 'jobs']
            }
          }
        },
        required: ['name', 'jobs']
      }
    },
    
    // =========================================================================
    // SINGLE JOB (CONVENIENCE)
    // =========================================================================
    {
      name: 'create_copilot_job',
      description: `Create a single job (internally becomes a DAG with one node). 
Use this for simple one-off tasks. For multiple related tasks, use create_copilot_dag instead.

EXECUTION CONTEXT:
- Commands run in a shell (cmd.exe on Windows, /bin/sh on Unix)
- Job gets its own git worktree for isolated work
- Use @agent prefix for AI delegation

EXAMPLES:
- Shell: { "name": "Build", "task": "Build the app", "work": "npm run build" }
- Agent: { "name": "Refactor", "task": "Refactor auth", "work": "@agent Refactor the authentication module" }`,
      inputSchema: {
        type: 'object',
        properties: {
          name: { 
            type: 'string', 
            description: 'Job name (required)' 
          },
          task: { 
            type: 'string', 
            description: 'Task description (required)' 
          },
          work: { 
            type: 'string', 
            description: 'Shell command OR "@agent <task>"' 
          },
          prechecks: { 
            type: 'string', 
            description: 'Validation before work' 
          },
          postchecks: { 
            type: 'string', 
            description: 'Validation after work' 
          },
          instructions: { 
            type: 'string', 
            description: 'Additional context for @agent' 
          },
          baseBranch: { 
            type: 'string', 
            description: 'Branch to start from (default: main)' 
          },
          targetBranch: { 
            type: 'string', 
            description: 'Branch to merge results into' 
          }
        },
        required: ['name', 'task']
      }
    },
    
    // =========================================================================
    // STATUS & QUERIES
    // =========================================================================
    {
      name: 'get_copilot_dag_status',
      description: 'Get status of a DAG including progress and node states.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { 
            type: 'string', 
            description: 'DAG ID (UUID returned from create_copilot_dag)' 
          }
        },
        required: ['id']
      }
    },
    
    {
      name: 'list_copilot_dags',
      description: 'List all DAGs with their status.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'running', 'succeeded', 'failed', 'partial', 'canceled'],
            description: 'Filter by status (optional)'
          }
        }
      }
    },
    
    {
      name: 'get_copilot_node_details',
      description: 'Get detailed information about a specific node in a DAG.',
      inputSchema: {
        type: 'object',
        properties: {
          dagId: { 
            type: 'string', 
            description: 'DAG ID' 
          },
          nodeId: { 
            type: 'string', 
            description: 'Node ID (UUID) or producer_id' 
          }
        },
        required: ['dagId', 'nodeId']
      }
    },
    
    {
      name: 'get_copilot_node_logs',
      description: 'Get execution logs for a node.',
      inputSchema: {
        type: 'object',
        properties: {
          dagId: { 
            type: 'string', 
            description: 'DAG ID' 
          },
          nodeId: { 
            type: 'string', 
            description: 'Node ID or producer_id' 
          },
          phase: {
            type: 'string',
            enum: ['prechecks', 'work', 'postchecks', 'commit', 'all'],
            description: 'Filter by execution phase (default: all)'
          }
        },
        required: ['dagId', 'nodeId']
      }
    },
    
    // =========================================================================
    // CONTROL
    // =========================================================================
    {
      name: 'cancel_copilot_dag',
      description: 'Cancel a running DAG and all its jobs.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { 
            type: 'string', 
            description: 'DAG ID to cancel' 
          }
        },
        required: ['id']
      }
    },
    
    {
      name: 'delete_copilot_dag',
      description: 'Delete a DAG and its history.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { 
            type: 'string', 
            description: 'DAG ID to delete' 
          }
        },
        required: ['id']
      }
    },
  ];
}
