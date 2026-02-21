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
 * Regex pattern for valid `producerId` values.
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
 *    `get_copilot_job_details`, `get_copilot_job_logs`, `get_copilot_job_attempts`
 * 3. **Control** – `cancel_copilot_plan`, `delete_copilot_plan`,
 *    `retry_copilot_plan`, `retry_copilot_plan_job`,
 *    `get_copilot_plan_job_failure_context`
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
After creation, use reshape_copilot_plan to add/remove/reorder jobs in a running or paused plan.
For plans with 5+ jobs, consider using scaffold_copilot_plan + add_copilot_plan_job + finalize_copilot_plan instead to avoid large payloads.

JOBS ARRAY (required):
All jobs go in the flat 'jobs' array. Each job has: producerId, task, work, dependencies.
- producerId: unique identifier (3-64 chars, lowercase a-z, 0-9, hyphens only)
- task: description of what the job does
- work: the command or agent spec to execute
- dependencies: array of producerIds this job depends on ([] for root jobs)

VISUAL GROUPING:
Use the optional 'group' string on each job for visual hierarchy in the UI.
- Jobs with the same group value render together in a collapsible box
- Use '/' for nesting: "backend/api" nests inside "backend"
- Groups are purely visual — they do NOT affect execution order (only dependencies do)

EXAMPLE:
{
  "name": "Build Pipeline",
  "jobs": [
    { "producerId": "count-files", "task": "Count files", "dependencies": [], "group": "phase1/collection", "work": "find . -type f | wc -l" },
    { "producerId": "count-dirs", "task": "Count dirs", "dependencies": [], "group": "phase1/collection", "work": "find . -type d | wc -l" },
    { "producerId": "analyze", "task": "Analyze", "dependencies": ["count-files", "count-dirs"], "group": "phase1/analysis", "work": "@agent Analyze the counts" },
    { "producerId": "report", "task": "Generate report", "dependencies": ["analyze"], "group": "phase2/reporting", "work": "npm run report" }
  ]
}

EXECUTION CONTEXT:
- Each job gets its own git worktree for isolated work
- Dependencies chain commits — dependent jobs start from their parent's commit

WORK OPTIONS (work/prechecks/postchecks/verifyRi accept):
1. STRING: Shell command like "npm run build" or "@agent Do something" for AI
2. PROCESS OBJECT: { "type": "process", "executable": "dotnet", "args": ["build"] }
3. SHELL OBJECT: { "type": "shell", "command": "Get-ChildItem", "shell": "powershell" }
4. AGENT OBJECT: { "type": "agent", "instructions": "# Task\\n\\n1. Step one", "model": "claude-sonnet-4.5" }

ON_FAILURE CONFIG (optional on any work spec object):
- noAutoHeal: true — prevents AI retry, requires manual intervention
- message: "User-facing explanation" — shown on failure
- resumeFromPhase: "prechecks" — which phase to restart from on retry

VERIFY_RI (SNAPSHOT VALIDATION — HIGHLY RECOMMENDED):
Runs as the work phase of an auto-injected "Snapshot Validation" job after all leaf jobs complete.
Validates the accumulated snapshot before merging to targetBranch.
Example: "dotnet build --no-restore", "npm run build && npm test"

IMPORTANT: For agent work, specify 'model' INSIDE the work object (not at job level).
Agent instructions MUST be in Markdown format for proper rendering.

SHELL OPTIONS: "cmd" | "powershell" | "pwsh" | "bash" | "sh"
POWERSHELL NOTE: Do NOT use '2>&1' in PowerShell commands.`,
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
            description: 'Max concurrent jobs for THIS plan. Default: 0 (unlimited — defers to global capacity). Only set this if you have a specific reason to limit concurrency for this plan.' 
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
          env: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Environment variables applied to all jobs in this plan. Individual work specs (work/prechecks/postchecks) can override specific keys with their own env property.'
          },
          verifyRi: {
            description: 'Optional (but HIGHLY recommended) verification command run as the work phase of the auto-injected Snapshot Validation node. Executes after all leaf nodes complete, validating the accumulated snapshot before merging to targetBranch. Auto-healable: on failure, Copilot CLI attempts to fix the issue. String command or object with type: process/shell/agent. Example: "dotnet build --no-restore" or "npm run build"',
            oneOf: [
              { type: 'string', maxLength: 4000 },
              {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['process', 'shell', 'agent'] },
                  command: { type: 'string' },
                  executable: { type: 'string' },
                  args: { type: 'array', items: { type: 'string' } },
                  shell: { type: 'string', enum: ['cmd', 'powershell', 'pwsh', 'bash', 'sh'] },
                  instructions: { type: 'string' },
                  model: { type: 'string' },
                  maxTurns: { type: 'number' },
                  onFailure: { type: 'object' }
                }
              }
            ]
          },
          jobs: {
            type: 'array',
            description: 'Array of job specifications',
            items: {
              type: 'object',
              properties: {
                producerId: { 
                  type: 'string', 
                  description: 'REQUIRED. Unique identifier (3-64 chars, lowercase/numbers/hyphens)',
                  pattern: '^[a-z0-9-]{3,64}$'
                },
                name: { 
                  type: 'string', 
                  description: 'Display name (defaults to producerId)' 
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
4. AGENT OBJECT: { "type": "agent", "instructions": "# Task\\n\\n1. Step one", "model": "claude-sonnet-4.5" }

For process type, args is an array - no shell quoting needed.
For shell type, shell can be: cmd, powershell, pwsh, bash, sh. Do NOT use '2>&1' in PowerShell — the orchestrator captures stderr separately.
For agent type, model goes INSIDE the work object. Available models: ${modelEnum.join(', ')}
Fast models (haiku/mini) for simple tasks, premium models (opus) for complex reasoning.

Agent instructions MUST be in Markdown format with headers, numbered lists, bullet lists.

SKILL-AWARE INSTRUCTIONS: If the project has .github/skills/ directories, read the relevant SKILL.md files and incorporate their conventions, patterns, and rules directly into each agent's instructions. Match skills by task type — e.g., test-writer for testing tasks, di-refactor for DI/interface work, security-hardener for security reviews, documentation-writer for docs updates. This gives each agent the project-specific context it needs to produce correct, convention-following code.`,
                },
                dependencies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of producerId values this job depends on. Empty [] for root jobs.'
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
                expectsNoChanges: {
                  type: 'boolean',
                  description: 'When true, this node is expected to produce no file changes. The commit phase will succeed without a commit instead of failing. Use for validation-only nodes, external-system updates, or analysis tasks.'
                },
                group: {
                  type: 'string',
                  description: 'Visual grouping tag. Jobs with the same group render together in the UI. Use / for nesting (e.g., "phase1/setup"). Purely visual — does not affect execution order.'
                }
              },
              required: ['producerId', 'task', 'work', 'dependencies']
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
          planId: { 
            type: 'string', 
            description: 'Plan ID (UUID returned from create_copilot_plan)' 
          }
        },
        required: ['planId']
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
      name: 'get_copilot_job_details',
      description: 'Get detailed information about a specific job in a Plan.',
      inputSchema: {
        type: 'object',
        properties: {
          planId: { 
            type: 'string', 
            description: 'Plan ID' 
          },
          jobId: { 
            type: 'string', 
            description: 'Job ID (UUID) or producerId' 
          }
        },
        required: ['planId', 'jobId']
      }
    },
    
    {
      name: 'get_copilot_job_logs',
      description: 'Get execution logs for a job.',
      inputSchema: {
        type: 'object',
        properties: {
          planId: { 
            type: 'string', 
            description: 'Plan ID' 
          },
          jobId: { 
            type: 'string', 
            description: 'Job ID or producerId' 
          },
          phase: {
            type: 'string',
            enum: ['merge-fi', 'setup', 'prechecks', 'work', 'commit', 'postchecks', 'merge-ri', 'all'],
            description: 'Filter by execution phase (default: all). Phases run in order: merge-fi → setup → prechecks → work → commit → postchecks → merge-ri'
          }
        },
        required: ['planId', 'jobId']
      }
    },
    
    {
      name: 'get_copilot_job_attempts',
      description: `Get all execution attempts for a job with their logs.

Returns a list of all attempts for the job, including:
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
          jobId: { 
            type: 'string', 
            description: 'Job ID or producerId' 
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
        required: ['planId', 'jobId']
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
          planId: { 
            type: 'string', 
            description: 'Plan ID to cancel' 
          }
        },
        required: ['planId']
      }
    },
    
    {
      name: 'pause_copilot_plan',
      description: 'Pause a running Plan. Running jobs will complete but no new work will be scheduled. Worktrees are preserved for resume.',
      inputSchema: {
        type: 'object',
        properties: {
          planId: { 
            type: 'string', 
            description: 'Plan ID to pause' 
          }
        },
        required: ['planId']
      }
    },
    
    {
      name: 'resume_copilot_plan',
      description: 'Resume a paused Plan. Allows new work to be scheduled again.',
      inputSchema: {
        type: 'object',
        properties: {
          planId: { 
            type: 'string', 
            description: 'Plan ID to resume' 
          }
        },
        required: ['planId']
      }
    },
    
    {
      name: 'delete_copilot_plan',
      description: 'Delete a Plan and its history.',
      inputSchema: {
        type: 'object',
        properties: {
          planId: { 
            type: 'string', 
            description: 'Plan ID to delete' 
          }
        },
        required: ['planId']
      }
    },
    
    {
      name: 'retry_copilot_plan',
      description: `Retry failed jobs in a Plan. 

This resets failed jobs back to 'ready' state and resumes execution.
Use after fixing issues that caused the failures.

RETRY WORKFLOW:
1. Use get_copilot_plan_job_failure_context to analyze why the job failed
2. Optionally provide newWork to replace or augment the original work
3. Call retry_copilot_plan with the job ID

NEW WORK OPTIONS:
- String: Shell command like "npm run build" or "@agent Do something"
- Process: { type: "process", executable: "node", args: ["script.js"] }
- Shell: { type: "shell", command: "Get-ChildItem", shell: "powershell" }
- Agent: { type: "agent", instructions: "# Fix Issue\\n\\n1. Analyze error\\n2. Apply fix", resumeSession: true }

For agent work, resumeSession (default: true) controls whether to continue
the existing Copilot session or start fresh.

IMPORTANT: Agent instructions MUST be in Markdown format (# headers, 1. numbered lists, - bullet lists).

Options:
- Retry all failed jobs (default)
- Retry specific jobs by ID
- Provide replacement work spec`,
      inputSchema: {
        type: 'object',
        properties: {
          planId: { 
            type: 'string', 
            description: 'Plan ID to retry' 
          },
          jobIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: specific job IDs to retry. If omitted, retries all failed jobs.'
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
        required: ['planId']
      }
    },
    
    {
      name: 'get_copilot_plan_job_failure_context',
      description: `Get detailed failure context for a failed job in a Plan.

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
          jobId: { 
            type: 'string', 
            description: 'Job ID to get failure context for' 
          }
        },
        required: ['planId', 'jobId']
      }
    },
    
    {
      name: 'retry_copilot_plan_job',
      description: `Retry a specific failed job in a Plan.

This is a convenience tool for retrying a single job. For retrying multiple
jobs at once, use retry_copilot_plan with jobIds array.

The job must be in 'failed' state to be retried.

NEW WORK OPTIONS:
- String: Shell command like "npm run build" or "@agent Do something"
- Process: { type: "process", executable: "node", args: ["script.js"] }
- Shell: { type: "shell", command: "Get-ChildItem", shell: "powershell" }
- Agent: { type: "agent", instructions: "# Fix Issue\\n\\n1. Analyze\\n2. Fix", resumeSession: true }

For agent work, resumeSession (default: true) controls whether to continue
the existing Copilot session or start fresh.

IMPORTANT: Agent instructions MUST be in Markdown format.

WORKFLOW:
1. Use get_copilot_plan_job_failure_context to analyze why the job failed
2. Call retry_copilot_plan_job with optional newWork
3. Monitor with get_copilot_plan_status`,
      inputSchema: {
        type: 'object',
        properties: {
          planId: { 
            type: 'string', 
            description: 'Plan ID containing the job' 
          },
          jobId: { 
            type: 'string', 
            description: 'Job ID to retry' 
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
        required: ['planId', 'jobId']
      }
    },

    // =========================================================================
    // RESHAPE (TOPOLOGY CHANGES)
    // =========================================================================
    {
      name: 'reshape_copilot_plan',
      description: `Reshape a running or paused plan's DAG topology. Supports adding, removing, and reordering jobs.

OPERATIONS (executed sequentially):
- add_job: Add a new job with spec (producerId, task, work, dependencies)
- remove_job: Remove a pending/ready job by jobId or producerId
- update_deps: Replace a job's dependency list (jobId + dependencies array)
- add_before: Insert a new job before an existing job (new job uses spec.dependencies; existing job is rewired to depend on the new job)
- add_after: Insert a new job after an existing job (takes over its dependents)

EXAMPLE:
{
  "planId": "<uuid>",
  "operations": [
    {
      "type": "add_job",
      "spec": { "producerId": "lint-fix", "task": "Fix lint errors", "dependencies": ["build"] }
    },
    {
      "type": "remove_job",
      "producerId": "obsolete-step"
    },
    {
      "type": "add_before",
      "existingJobId": "<job-uuid>",
      "spec": { "producerId": "setup-db", "task": "Initialize test DB", "dependencies": [] }
    }
  ]
}

NOTES:
- Plan must be running or paused
- Only pending/ready jobs can be removed or have dependencies updated
- Cycle detection prevents invalid dependency additions
- The "Snapshot Validation" job (producerId: __snapshot-validation__) is auto-managed — it cannot be removed, updated, or have its dependencies changed. Its dependencies sync automatically when the plan topology changes.
- Returns per-operation results and updated topology`,
      inputSchema: {
        type: 'object',
        properties: {
          planId: {
            type: 'string',
            description: 'Plan ID (UUID) to reshape'
          },
          operations: {
            type: 'array',
            description: 'Array of reshape operations to execute sequentially',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['add_job', 'remove_job', 'update_deps', 'add_before', 'add_after'],
                  description: 'Operation type'
                },
                spec: {
                  type: 'object',
                  description: 'Job spec for add_job, add_before, add_after. Must include producerId, task, dependencies.',
                  properties: {
                    producerId: { type: 'string', pattern: '^[a-z0-9-]{3,64}$' },
                    name: { type: 'string' },
                    task: { type: 'string' },
                    work: { description: 'Work spec (string or object)' },
                    dependencies: { type: 'array', items: { type: 'string' } },
                    prechecks: { description: 'Prechecks spec' },
                    postchecks: { description: 'Postchecks spec' },
                    instructions: { type: 'string' },
                    expectsNoChanges: { type: 'boolean' }
                  }
                },
                jobId: {
                  type: 'string',
                  description: 'Job ID (UUID) or producerId for remove_job / update_deps'
                },
                producerId: {
                  type: 'string',
                  description: 'Producer ID for remove_job (alternative to jobId)'
                },
                existingJobId: {
                  type: 'string',
                  description: 'Existing job ID for add_before / add_after'
                },
                dependencies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'New dependency list for update_deps (job IDs or producerIds)'
                }
              },
              required: ['type']
            }
          }
        },
        required: ['planId', 'operations']
      }
    },

    // =========================================================================
    // Plan Update Tool
    // =========================================================================
    {
      name: 'update_copilot_plan',
      description: `Update plan-level settings. Use to change environment variables or concurrency limits on an existing plan.

The plan can be in any state (scaffolding, paused, running). Changes take effect for the next job execution.

ENVIRONMENT VARIABLES:
- Set env to apply environment variables to ALL jobs in the plan
- Individual work specs can override specific keys via their own env field
- Pass {} to clear all plan-level env vars

EXAMPLES:
- Set OpenSSL path: { "planId": "<uuid>", "env": { "OPENSSL_DIR": "C:\\\\vcpkg\\\\installed\\\\x64-windows" } }
- Set multiple: { "planId": "<uuid>", "env": { "RUST_LOG": "debug", "CARGO_TARGET_DIR": "/tmp/target" } }
- Change concurrency: { "planId": "<uuid>", "maxParallel": 4 }`,
      inputSchema: {
        type: 'object',
        properties: {
          planId: { type: 'string', description: 'Plan ID to update' },
          env: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Environment variables applied to all jobs. Job-level env overrides specific keys. Pass {} to clear.'
          },
          maxParallel: {
            type: 'number',
            description: 'Max concurrent jobs (0 = unlimited, defers to global capacity)'
          }
        },
        required: ['planId']
      }
    },

    // =========================================================================
    // Scaffolding Tools
    // =========================================================================
    {
      name: 'scaffold_copilot_plan',
      description: 'Create an empty plan scaffold for incremental job building. Returns a planId. The plan appears in the UI as "Scaffolding". Use add_copilot_plan_job to add jobs one at a time, then finalize_copilot_plan to start. RECOMMENDED for plans with 5+ jobs to avoid large payloads.',
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
            minimum: 1,
            maximum: 64,
            description: 'Max concurrent jobs for THIS plan. Default: unlimited (defers to global capacity). Only set if you need to limit this specific plan.' 
          },
          startPaused: {
            type: 'boolean',
            description: 'Create the plan in paused state for review before execution (default: true)'
          },
          cleanUpSuccessfulWork: { 
            type: 'boolean', 
            description: 'Clean up worktrees after successful merges (default: true)' 
          },
          env: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Environment variables applied to all jobs in this plan. Individual work specs (work/prechecks/postchecks) can override specific keys with their own env property.'
          },
          additionalSymlinkDirs: {
            type: 'array',
            description: "Additional directories to symlink from the main repo into worktrees (e.g. '.venv', 'vendor'). Merged with built-in list (node_modules). Must be .gitignored, read-only directories.",
            items: { type: 'string' }
          },
          verifyRi: {
            description: 'Optional verification command run as the work phase of the auto-injected Snapshot Validation node. Executes after all leaf nodes complete, validating the accumulated snapshot before merging to targetBranch. Auto-healable: on failure, Copilot CLI attempts to fix the issue.'
          }
        },
        required: ['name']
      }
    },

    {
      name: 'add_copilot_plan_job',
      description: `Add a job to a scaffolding plan (before finalize). REQUIRED fields: planId, producerId, task, work.

NOTE: This tool only works on plans in 'scaffolding' status (before finalize_copilot_plan).
To add jobs to a finalized/running/paused plan, use reshape_copilot_plan with an 'add_node' operation.

- name: Short display title (max 80 chars). Do NOT put instructions here.
- task: Brief description (max 200 chars). NOT the work instructions.
- work: The actual work specification — agent instructions, shell commands, or process specs go here.

For agent work: {"type": "agent", "model": "claude-opus-4.5", "instructions": "Detailed instructions..."}`,
      inputSchema: {
        type: 'object',
        properties: {
          planId: {
            type: 'string',
            description: 'Plan unique identifier returned from scaffold_copilot_plan'
          },
          producerId: {
            type: 'string',
            pattern: PRODUCER_ID_PATTERN.source,
            description: 'Producer identifier - lowercase letters, numbers, hyphens only, 3-64 characters'
          },
          name: {
            type: 'string',
            maxLength: 80,
            description: 'Short display name (max 80 chars). Do NOT put instructions here — use the work field.'
          },
          task: {
            type: 'string',
            maxLength: 200,
            description: 'Brief task description (max 200 chars). Detailed instructions go in the work field.'
          },
          dependencies: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of producerIds this job depends on'
          },
          group: {
            type: 'string',
            description: 'Optional group path for hierarchical organization'
          },
          work: {
            description: 'Work specification - can be string, or object with type (agent/shell/process)',
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['agent', 'shell', 'process'] },
                  instructionsFile: { type: 'string', description: 'Path to .md file with instructions (agent type only, mutually exclusive with instructions)' },
                  instructions: { type: 'string', description: 'Inline instructions (agent type only, mutually exclusive with instructionsFile)' },
                  model: { type: 'string', enum: modelEnum },
                  modelTier: { type: 'string', enum: ['fast', 'balanced', 'premium'] },
                  context_files: { type: 'array', items: { type: 'string' } },
                  max_turns: { type: 'number', minimum: 1, maximum: 100 },
                  allowed_folders: { type: 'array', items: { type: 'string' } },
                  allowed_urls: { type: 'array', items: { type: 'string' } },
                  command: { type: 'string' },
                  executable: { type: 'string' },
                  args: { type: 'array', items: { type: 'string' } },
                  shell: { type: 'string', enum: ['cmd', 'powershell', 'pwsh', 'bash', 'sh'] }
                }
              }
            ]
          },
          prechecks: {
            description: 'Optional prechecks specification - runs before main work'
          },
          postchecks: {
            description: 'Optional postchecks specification - runs after main work'
          },
          autoHeal: {
            type: 'boolean',
            description: 'Enable automatic healing on failure (default: true)'
          },
          expectsNoChanges: {
            type: 'boolean',
            description: 'If true, job should not modify any files (default: false)'
          }
        },
        required: ['planId', 'producerId', 'task', 'work']
      }
    },

    {
      name: 'finalize_copilot_plan',
      description: 'Validate and start a scaffolded plan. Resolves dependencies, checks for cycles, transitions from Scaffolding to execution.',
      inputSchema: {
        type: 'object',
        properties: {
          planId: {
            type: 'string',
            description: 'Plan unique identifier returned from scaffold_copilot_plan'
          },
          startPaused: {
            type: 'boolean',
            description: 'Start the plan in paused state for review (default: false)'
          }
        },
        required: ['planId']
      }
    },
  ];
}
