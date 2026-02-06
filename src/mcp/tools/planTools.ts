/**
 * @fileoverview Plan MCP Tool Definitions
 * 
 * Defines the schema for all Plan-related tools exposed via MCP.
 * All work is now a Plan - even single jobs.
 * 
 * @module mcp/tools/planTools
 */

import { McpTool } from '../types';

/** Regex pattern for valid producer_id values */
export const PRODUCER_ID_PATTERN = /^[a-z0-9-]{3,64}$/;

/**
 * Get all Plan-related tool definitions.
 */
export function getPlanToolDefinitions(): McpTool[] {
  return [
    // =========================================================================
    // Plan CREATION
    // =========================================================================
    {
      name: 'create_copilot_plan',
      description: `Create a Plan (Directed Acyclic Graph) of work units. Everything is a Plan - even a single job.

PRODUCER_ID IS REQUIRED:
- Every job MUST have a 'producer_id' field
- Format: lowercase letters (a-z), numbers (0-9), and hyphens (-) only, 3-64 characters
- Used in 'dependencies' arrays to establish execution order
- Jobs with dependencies: [] are root jobs that start immediately

NESTED sub-planS ("OUT AND BACK" PATTERN):
- sub-plans can contain nested sub-plans for hierarchical work decomposition
- Pattern: init → sub-plan → finish (work fans out, then converges back)
- Each nesting level has its own scope for dependencies
- Example 3-level nesting: main-init → sub-plan A → main-finish
                            └→ a-init → sub-plan B → a-finish
                                └→ b-init → sub-plan C → b-finish

EXECUTION CONTEXT:
- Each job gets its own git worktree for isolated work
- Dependencies chain commits - dependent jobs start from their parent's commit

WORK OPTIONS (work/prechecks/postchecks accept):
1. String: "npm run build" (runs in default shell) or "@agent Implement feature" 
2. Process spec: { type: "process", executable: "dotnet", args: ["build", "-c", "Release"] }
3. Shell spec: { type: "shell", command: "Get-ChildItem", shell: "powershell" }
4. Agent spec: { type: "agent", instructions: "Implement the feature", maxTurns: 10 }

SHELL OPTIONS: "cmd" | "powershell" | "pwsh" | "bash" | "sh"

EXAMPLES:
// Simple string command
{ "work": "npm run build" }

// Direct process (no shell quoting issues)
{ "work": { "type": "process", "executable": "node", "args": ["--version"] }}

// PowerShell with explicit shell
{ "work": { "type": "shell", "command": "Get-ChildItem -Recurse", "shell": "powershell" }}

// AI Agent with rich config
{ "work": { "type": "agent", "instructions": "Add error handling to api.ts", "contextFiles": ["src/api.ts"] }}`,
      inputSchema: {
        type: 'object',
        properties: {
          name: { 
            type: 'string', 
            description: 'Human-readable name for the Plan' 
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
                  description: `Work to perform. Can be:
1. STRING: Shell command like "npm run build" or "@agent Do something" for AI
2. PROCESS OBJECT: { "type": "process", "executable": "node", "args": ["script.js"] }
3. SHELL OBJECT: { "type": "shell", "command": "Get-ChildItem", "shell": "powershell" }
4. AGENT OBJECT: { "type": "agent", "instructions": "Implement feature X" }

For process type, args is an array - no shell quoting needed.
For shell type, shell can be: cmd, powershell, pwsh, bash, sh`,
                },
                dependencies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of producer_id values this job depends on. Empty [] for root jobs.'
                },
                prechecks: { 
                  description: 'Validation before work. String command or object with type: process/shell' 
                },
                postchecks: { 
                  description: 'Validation after work. String command or object with type: process/shell' 
                },
                instructions: { 
                  type: 'string', 
                  description: 'Additional context for @agent tasks' 
                }
              },
              required: ['producer_id', 'task', 'dependencies']
            }
          },
          subPlans: {
            type: 'array',
            description: 'Optional nested Plans that run as a unit. Supports recursive nesting for "out and back" patterns.',
            items: {
              type: 'object',
              properties: {
                producer_id: { 
                  type: 'string', 
                  description: 'Unique identifier for the sub-plan',
                  pattern: '^[a-z0-9-]{3,64}$'
                },
                name: { 
                  type: 'string', 
                  description: 'Display name' 
                },
                dependencies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Producer IDs this sub-plan depends on (parent scope jobs or sibling sub-plans)'
                },
                maxParallel: { 
                  type: 'number', 
                  description: 'Max concurrent jobs in this sub-plan' 
                },
                jobs: {
                  type: 'array',
                  description: 'Jobs within this sub-plan (same schema as top-level jobs). Dependencies reference other jobs/sub-plans in this scope.',
                  items: { type: 'object' }
                },
                subPlans: {
                  type: 'array',
                  description: 'Nested sub-plans within this sub-plan (recursive). Forms "out and back" pattern: init → sub-plan → finish',
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
      description: `Create a single job (internally becomes a Plan with one node). 
Use this for simple one-off tasks. For multiple related tasks, use create_copilot_plan instead.

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
      name: 'get_copilot_plan_status',
      description: 'Get status of a Plan including progress and node states.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { 
            type: 'string', 
            description: 'Plan ID (UUID returned from create_copilot_plan)' 
          }
        },
        required: ['id']
      }
    },
    
    {
      name: 'list_copilot_plans',
      description: 'List all Plans with their status.',
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
      description: 'Get detailed information about a specific node in a Plan.',
      inputSchema: {
        type: 'object',
        properties: {
          planId: { 
            type: 'string', 
            description: 'Plan ID' 
          },
          nodeId: { 
            type: 'string', 
            description: 'Node ID (UUID) or producer_id' 
          }
        },
        required: ['planId', 'nodeId']
      }
    },
    
    {
      name: 'get_copilot_node_logs',
      description: 'Get execution logs for a node.',
      inputSchema: {
        type: 'object',
        properties: {
          planId: { 
            type: 'string', 
            description: 'Plan ID' 
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
        required: ['planId', 'nodeId']
      }
    },
    
    // =========================================================================
    // CONTROL
    // =========================================================================
    {
      name: 'cancel_copilot_plan',
      description: 'Cancel a running Plan and all its jobs.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { 
            type: 'string', 
            description: 'Plan ID to cancel' 
          }
        },
        required: ['id']
      }
    },
    
    {
      name: 'delete_copilot_plan',
      description: 'Delete a Plan and its history.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { 
            type: 'string', 
            description: 'Plan ID to delete' 
          }
        },
        required: ['id']
      }
    },
    
    {
      name: 'retry_copilot_plan',
      description: `Retry failed nodes in a Plan. 

This resets failed nodes back to 'ready' state and resumes execution.
Use after fixing issues that caused the failures.

SESSION RESUMPTION:
- By default, retries resume the existing Copilot session if one exists
- Set resumeSession: false to start a fresh session
- Existing session context is preserved for debugging context

RETRY WORKFLOW:
1. Use get_node_failure_context to analyze why the node failed
2. Optionally provide newInstructions to guide the retry
3. Call retry_copilot_plan with the node ID

Options:
- Retry all failed nodes (default)
- Retry specific nodes by ID
- Resume or reset Copilot session
- Provide new instructions for the retry`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { 
            type: 'string', 
            description: 'Plan ID to retry' 
          },
          nodeIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: specific node IDs to retry. If omitted, retries all failed nodes.'
          },
          resumeSession: {
            type: 'boolean',
            description: 'Resume existing Copilot session for agent work (default: true)'
          },
          newInstructions: {
            type: 'string',
            description: 'New/additional instructions to append for the retry attempt'
          },
          clearWorktree: {
            type: 'boolean',
            description: 'Reset worktree to base commit before retry (default: false)'
          }
        },
        required: ['id']
      }
    },
    
    {
      name: 'get_node_failure_context',
      description: `Get detailed failure context for a failed node.

Returns:
- Execution logs from the failed attempt
- Which phase failed (prechecks, work, commit, postchecks, merge-fi, merge-ri)
- Error message
- Copilot session ID (if agent work was involved)
- Worktree path (for manual inspection)

Use this to analyze failures before deciding how to retry.`,
      inputSchema: {
        type: 'object',
        properties: {
          planId: { 
            type: 'string', 
            description: 'Plan ID' 
          },
          nodeId: { 
            type: 'string', 
            description: 'Node ID to get failure context for' 
          }
        },
        required: ['planId', 'nodeId']
      }
    },
  ];
}
