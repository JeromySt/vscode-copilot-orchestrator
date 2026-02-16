/**
 * @fileoverview Plan MCP Tool Definitions
 * 
 * Defines the schema for all Plan-related tools exposed via MCP.
 * All work is now a Plan - even single jobs.
 * 
 * @module mcp/tools/planTools
 */

import { McpTool } from '../types';
import { discoverAvailableModelsLegacy } from '../../agent/modelDiscovery';

/**
 * Regex pattern for valid `producer_id` values.
 *
 * Enforces lowercase alphanumeric characters and hyphens, 3–64 characters long.
 * Used both for schema validation in tool definitions and server-side input validation
 * in {@link handleCreatePlan}.
 *
 * @example
 * ```ts
 * PRODUCER_ID_PATTERN.test('build-step');   // true
 * PRODUCER_ID_PATTERN.test('AB');           // false – uppercase / too short
 * ```
 */
export const PRODUCER_ID_PATTERN = /^[a-z0-9-]{3,64}$/;

/**
 * Return all Plan-related MCP tool definitions.
 *
 * Each tool definition follows the MCP `tools/list` response schema:
 * `{ name, description, inputSchema }`.  The descriptions are intentionally
 * verbose because they are surfaced directly to LLM clients as tool
 * documentation.
 *
 * Tools are grouped into three categories:
 * 1. **Creation** – `create_copilot_plan`
 * 2. **Status & Queries** – `get_copilot_plan_status`, `list_copilot_plans`,
 *    `get_copilot_node_details`, `get_copilot_node_logs`, `get_copilot_node_attempts`
 * 3. **Control** – `cancel_copilot_plan`, `delete_copilot_plan`,
 *    `retry_copilot_plan`, `retry_copilot_plan_node`,
 *    `get_copilot_plan_node_failure_context`
 *
 * @returns Array of {@link McpTool} definitions registered with the MCP server.
 *
 * @example
 * ```ts
 * const tools = await getPlanToolDefinitions();
 * // tools[0].name === 'create_copilot_plan'
 * ```
 */
export async function getPlanToolDefinitions(): Promise<McpTool[]> {
  const modelResult = await discoverAvailableModelsLegacy();
  const modelEnum = modelResult.rawChoices.length > 0
    ? modelResult.rawChoices
    : ['gpt-5', 'claude-sonnet-4.5'];

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

JOBS vs GROUPS (CRITICAL):
- The 'jobs' array is for flat job definitions only. Jobs have: producer_id, task, work, dependencies.
- The 'groups' array is for hierarchical organization. Groups have: name, jobs, groups.
- DO NOT put groups in the 'jobs' array. DO NOT set type: "group" on jobs.
- DO NOT put nested 'jobs' arrays inside items in the 'jobs' array.

GROUPS (VISUAL HIERARCHY + NAMESPACE):
- Groups organize jobs visually and provide namespace isolation for producer_ids
- Groups do NOT have dependencies - only jobs have dependencies
- Groups do NOT have: task, work, producer_id, expects_no_changes, type
- Jobs within a group can reference siblings by local producer_id (e.g., "sibling-job")
- Cross-group references use qualified paths (e.g., "other-group/job-id" or "phase1/collection/count-files")
- Nested groups form hierarchical paths: "phase1/collection/count-files"
- Groups render as nested boxes in the UI with aggregate status

DEPENDENCY RESOLUTION:
- Local refs (no '/') are qualified with current group path: "sibling" → "mygroup/sibling"
- Qualified refs (contain '/') are used as-is: "phase1/analysis/done" stays "phase1/analysis/done"
- All dependencies must resolve to valid job producer_ids

EXAMPLE WITH GROUPS:
{
  "name": "Build Pipeline",
  "jobs": [],  // Can be empty if all jobs are in groups
  "groups": [{
    "name": "phase1",
    "groups": [
      {
        "name": "collection",
        "jobs": [
          { "producer_id": "count-files", "task": "Count files", "dependencies": [] },
          { "producer_id": "count-dirs", "task": "Count dirs", "dependencies": [] }
        ]
      },
      {
        "name": "analysis",
        "jobs": [{
          "producer_id": "analyze",
          "task": "Analyze",
          "dependencies": ["collection/count-files", "collection/count-dirs"]  // Cross-group refs
        }]
      }
    ]
  }, {
    "name": "phase2",
    "groups": [{
      "name": "reporting",
      "jobs": [{
        "producer_id": "report",
        "task": "Generate report",
        "dependencies": ["phase1/analysis/analyze"]  // Fully qualified cross-phase ref
      }]
    }]
  }]
}

EXECUTION CONTEXT:
- Each job gets its own git worktree for isolated work
- Dependencies chain commits - dependent jobs start from their parent's commit

WORK OPTIONS (work/prechecks/postchecks accept):
1. String: "npm run build" (runs in default shell) or "@agent Implement feature" 
2. Process spec: { type: "process", executable: "dotnet", args: ["build", "-c", "Release"] }
3. Shell spec: { type: "shell", command: "Get-ChildItem", shell: "powershell" }
4. Agent spec: { type: "agent", instructions: "# Task\\n\\n1. Step one", model: "claude-sonnet-4.5" }

IMPORTANT: For agent work, specify 'model' INSIDE the work object (not at job level).
Agent instructions MUST be in Markdown format for proper rendering.

SHELL OPTIONS: "cmd" | "powershell" | "pwsh" | "bash" | "sh"`,
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
          additionalSymlinkDirs: {
            type: 'array',
            description: "Additional directories to symlink from the main repo into worktrees (e.g. '.venv', 'vendor'). Merged with built-in list (node_modules). Must be .gitignored, read-only directories.",
            items: { type: 'string' }
          },
          startPaused: {
            type: 'boolean',
            description: 'Create the plan in paused state for review before execution (default: true). Set to false to start immediately.'
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
4. AGENT OBJECT: { "type": "agent", "instructions": "# Task\\n\\n1. Step one", "model": "claude-sonnet-4.5", "augmentInstructions": true }

For process type, args is an array - no shell quoting needed.
For shell type, shell can be: cmd, powershell, pwsh, bash, sh
For agent type, model goes INSIDE the work object. Available models: ${modelEnum.join(', ')}
Fast models (haiku/mini) for simple tasks, premium models (opus) for complex reasoning.
augmentInstructions (optional, boolean) enriches agent instructions with project context before execution.

Agent instructions MUST be in Markdown format with headers, numbered lists, bullet lists.`,
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
                  description: 'Additional context for @agent tasks. MUST be in Markdown format (# headers, 1. numbered lists, - bullet lists).' 
                },
                expects_no_changes: {
                  type: 'boolean',
                  description: 'When true, this node is expected to produce no file changes. The commit phase will succeed without a commit instead of failing. Use for validation-only nodes, external-system updates, or analysis tasks.'
                },
                group: {
                  type: 'string',
                  description: 'Visual grouping tag. Jobs with the same group are rendered together in a box. Use / for nested groups (e.g., "backend/api" nests inside "backend"). Groups are purely visual and do not affect execution order.'
                }
              },
              required: ['producer_id', 'task', 'dependencies']
            }
          },
          groups: {
            type: 'array',
            description: `Visual groups for organizing jobs with namespace isolation.
Jobs within a group can reference each other by local producer_id.
Cross-group references use qualified paths: "group_name/producer_id".
Nested groups form paths like "backend/api/auth".
Groups do NOT have dependencies - jobs describe the full dependency graph.`,
            items: {
              type: 'object',
              properties: {
                name: { 
                  type: 'string', 
                  description: 'Group name (forms part of qualified path for nested refs)'
                },
                jobs: {
                  type: 'array',
                  description: 'Jobs within this group. Producer IDs are scoped to this group.',
                  items: { type: 'object' }
                },
                groups: {
                  type: 'array',
                  description: 'Nested groups (recursive). Forms hierarchical paths like "parent/child".',
                  items: { type: 'object' }
                }
              },
              required: ['name'],
              additionalProperties: false
            }
          }
        },
        required: ['name', 'jobs']
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
    
    {
      name: 'get_copilot_node_attempts',
      description: `Get all execution attempts for a node with their logs.

Returns a list of all attempts for the node, including:
- Attempt number and status
- Start/end timestamps  
- Which phase failed (if applicable)
- Error message and exit code
- Copilot session ID used
- Per-phase step statuses
- Work spec used for that attempt
- Full execution logs for that attempt

Use this to analyze the history of retries and their outcomes.`,
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
          attemptNumber: { 
            type: 'number', 
            description: 'Optional: specific attempt number (1-based). If omitted, returns all attempts.' 
          },
          includeLogs: {
            type: 'boolean',
            description: 'Include full logs in response (default: false to keep response compact)'
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
      name: 'pause_copilot_plan',
      description: 'Pause a running Plan. Running jobs will complete but no new work will be scheduled. Worktrees are preserved for resume.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { 
            type: 'string', 
            description: 'Plan ID to pause' 
          }
        },
        required: ['id']
      }
    },
    
    {
      name: 'resume_copilot_plan',
      description: 'Resume a paused Plan. Allows new work to be scheduled again.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { 
            type: 'string', 
            description: 'Plan ID to resume' 
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

RETRY WORKFLOW:
1. Use get_copilot_plan_node_failure_context to analyze why the node failed
2. Optionally provide newWork to replace or augment the original work
3. Call retry_copilot_plan with the node ID

NEW WORK OPTIONS:
- String: Shell command like "npm run build" or "@agent Do something"
- Process: { type: "process", executable: "node", args: ["script.js"] }
- Shell: { type: "shell", command: "Get-ChildItem", shell: "powershell" }
- Agent: { type: "agent", instructions: "# Fix Issue\\n\\n1. Analyze error\\n2. Apply fix", resumeSession: true }

For agent work, resumeSession (default: true) controls whether to continue
the existing Copilot session or start fresh.

IMPORTANT: Agent instructions MUST be in Markdown format (# headers, 1. numbered lists, - bullet lists).

Options:
- Retry all failed nodes (default)
- Retry specific nodes by ID
- Provide replacement work spec`,
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
          newWork: {
            description: `Optional replacement work for the retry. Can be:
1. STRING: Shell command like "npm run build" or "@agent Do something"
2. PROCESS: { "type": "process", "executable": "node", "args": ["script.js"] }
3. SHELL: { "type": "shell", "command": "Get-ChildItem", "shell": "powershell" }
4. AGENT: { "type": "agent", "instructions": "# Fix X\\n\\n1. Analyze\\n2. Fix", "resumeSession": true }

For agent type, resumeSession (default: true) continues existing Copilot session.
Agent instructions MUST be in Markdown format.`
          },
          newPrechecks: {
            description: 'Optional replacement prechecks for the retry. Same format as work specs. Use null to remove prechecks.'
          },
          newPostchecks: {
            description: 'Optional replacement postchecks for the retry. Same format as work specs. Use null to remove postchecks.'
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
      name: 'get_copilot_plan_node_failure_context',
      description: `Get detailed failure context for a failed node in a Plan.

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
    
    {
      name: 'retry_copilot_plan_node',
      description: `Retry a specific failed node in a Plan.

This is a convenience tool for retrying a single node. For retrying multiple
nodes at once, use retry_copilot_plan with nodeIds array.

The node must be in 'failed' state to be retried.

NEW WORK OPTIONS:
- String: Shell command like "npm run build" or "@agent Do something"
- Process: { type: "process", executable: "node", args: ["script.js"] }
- Shell: { type: "shell", command: "Get-ChildItem", shell: "powershell" }
- Agent: { type: "agent", instructions: "# Fix Issue\\n\\n1. Analyze\\n2. Fix", resumeSession: true }

For agent work, resumeSession (default: true) controls whether to continue
the existing Copilot session or start fresh.

IMPORTANT: Agent instructions MUST be in Markdown format.

WORKFLOW:
1. Use get_copilot_plan_node_failure_context to analyze why the node failed
2. Call retry_copilot_plan_node with optional newWork
3. Monitor with get_copilot_plan_status`,
      inputSchema: {
        type: 'object',
        properties: {
          planId: { 
            type: 'string', 
            description: 'Plan ID containing the node' 
          },
          nodeId: { 
            type: 'string', 
            description: 'Node ID to retry' 
          },
          newWork: {
            description: `Optional replacement work for the retry. Can be:
1. STRING: Shell command like "npm run build" or "@agent Do something"
2. PROCESS: { "type": "process", "executable": "node", "args": ["script.js"] }
3. SHELL: { "type": "shell", "command": "Get-ChildItem", "shell": "powershell" }
4. AGENT: { "type": "agent", "instructions": "# Fix X\\n\\n1. Analyze\\n2. Fix", "resumeSession": true }

For agent type, resumeSession (default: true) continues existing Copilot session.
Agent instructions MUST be in Markdown format.`
          },
          newPrechecks: {
            description: 'Optional replacement prechecks for the retry. Same format as work specs. Use null to remove prechecks.'
          },
          newPostchecks: {
            description: 'Optional replacement postchecks for the retry. Same format as work specs. Use null to remove postchecks.'
          },
          clearWorktree: {
            type: 'boolean',
            description: 'Reset worktree to base commit before retry (default: false)'
          }
        },
        required: ['planId', 'nodeId']
      }
    },
  ];
}
