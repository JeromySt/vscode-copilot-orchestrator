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
 *    `get_copilot_job_logs`, `get_copilot_job_attempts`
 * 3. **Control** – `cancel_copilot_plan`, `delete_copilot_plan`,
 *    `retry_copilot_plan`
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

  const effortSupported = modelResult.capabilities?.effort ?? false;
  const effortChoices = modelResult.capabilities?.effortChoices ?? ['low', 'medium', 'high'];

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
4. AGENT OBJECT: { "type": "agent", "instructions": "# Task\\n\\n1. Step one", "model": "claude-sonnet-4.5" }${effortSupported ? `\n5. AGENT WITH EFFORT: { "type": "agent", "instructions": "# Complex refactor\\n\\n1. Analyze\\n2. Implement", "effort": "high" }` : ''}

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
POWERSHELL NOTE: Do NOT use '2>&1' in PowerShell commands.

RETURNS:
{
  "success": true,
  "planId": "uuid",                    // Use this ID for all subsequent operations
  "name": "Plan Name",
  "baseBranch": "main",
  "targetBranch": "feat/my-feature",   // Auto-created if targeting default branch
  "paused": true,                      // true if startPaused (default) or resumeAfterPlan set
  "message": "Human-readable summary",
  "jobMapping": {                      // Maps your producerIds to internal node UUIDs
    "my-job": "uuid-1",
    "__snapshot-validation__": "uuid-2" // Auto-injected SV node
  },
  "status": {
    "status": "pending" | "pending-start",
    "nodes": 3,    // Total job count including SV
    "roots": 2,    // Jobs with no dependencies
    "leaves": 1    // Jobs with no dependents (SV is always the sole leaf)
  },
  "warnings": ["..."]                  // Validation warnings (e.g., missing postchecks)
}

NEXT STEPS after creation:
- If paused: use resume_copilot_plan to start execution
- Monitor: use get_copilot_plan_status with the planId
- Modify: use reshape_copilot_plan to add/remove jobs on a running/paused plan`,
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
            description: 'Create the plan in paused state for review before execution (default: true). Set to false to start immediately. NOTE: If resumeAfterPlan is set, the plan always starts paused regardless of this flag.'
          },
          resumeAfterPlan: {
            type: 'string',
            description: 'Plan ID of another plan that must complete before this plan auto-resumes. Creates a plan-to-plan dependency chain. The plan starts paused and automatically resumes when the referenced plan succeeds. If the referenced plan is canceled or deleted, this plan is unblocked. Use for sequencing plans on the same target branch (e.g., a follow-up refactor after an initial implementation).'
          },
          env: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Environment variables applied to all jobs in this plan. Individual work specs (work/prechecks/postchecks) can override specific keys with their own env property. Supports variable expansion: use $VAR or ${VAR} (Unix) or %VAR% (Windows) to reference existing env vars. Example: { "PATH": "/custom/bin:$PATH" } prepends to the existing PATH.'
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
                  ...(effortSupported ? { effort: { type: 'string', enum: effortChoices, description: 'Reasoning effort level hint for the AI model. Controls depth of reasoning: low (fast/shallow), medium (balanced), high (thorough/deep).' } } : {}),
                  onFailure: { type: 'object' }
                }
              }
            ]
          },
          worktreeInit: {
            type: 'array',
            description: `Worktree initialization commands executed in the setup phase of EVERY job, after forward-integration merge and before prechecks/work. Runs sequentially; if any fails, the job is auto-healed. Each worktree gets its own isolated copy of dependencies (no shared symlinks when worktreeInit is set).

IMPORTANT: When worktreeInit is configured, node_modules is NOT symlinked from the main repo. Each worktree runs its own install. npm/yarn/pnpm use a shared global cache (~/.npm, ~/.yarn/cache) so subsequent installs are fast cache hits (~5-8s).

Recommended patterns by language:
- Node.js: ["npm ci"] — deterministic, uses lockfile, shared cache. Or ["yarn install --frozen-lockfile"] / ["pnpm install --frozen-lockfile"]
- .NET: [{"type": "shell", "command": "dotnet restore --no-cache", "shell": "powershell"}]
- Python: [{"type": "shell", "command": "python -m venv .venv && .venv/bin/pip install -r requirements.txt", "shell": "bash"}]
- Rust: [{"type": "shell", "command": "cargo fetch", "shell": "bash"}] — downloads crates to shared cache
- Go: no init needed — Go modules cache is global by default
- Java/Gradle: [{"type": "shell", "command": "./gradlew dependencies --no-daemon", "shell": "bash"}]
- Java/Maven: [{"type": "shell", "command": "mvn dependency:resolve -q", "shell": "bash"}]

Also auto-detects .github/instructions/worktree-init.instructions.md if present.`,
            items: {
              oneOf: [
                { type: 'string' },
                { type: 'object', properties: { type: { type: 'string', enum: ['process', 'shell', 'agent'] }, command: { type: 'string' }, executable: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, shell: { type: 'string' }, instructions: { type: 'string' } } }
              ]
            }
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
IMPORTANT: For security-sensitive work (cryptography, authentication, authorization, input validation, secret handling, encryption, certificate management, or any code that handles sensitive data), ALWAYS use modelTier: 'premium' to ensure the most capable model reviews the code.
IMPORTANT: For security-sensitive work (cryptography, authentication, authorization, input validation, secret handling, encryption, certificate management, or any code that handles sensitive data), ALWAYS use modelTier: 'premium' to ensure the most capable model reviews the code. Security bugs from weaker models are far more costly than the premium request overhead.
${effortSupported ? `\nEFFORT HINT: For agent work, set 'effort' inside the work object to control how deeply the model reasons about the task. Valid values: ${effortChoices.map(c => `'${c}'`).join(', ')}.
- 'low': Simple, well-defined tasks (formatting, renaming, boilerplate generation, straightforward test additions). Fastest execution, lowest token cost.
- 'medium': Standard development tasks (implementing a feature from a spec, writing tests for existing code, refactoring with clear patterns). Good balance of quality and speed. This is the default behavior when effort is omitted.
- 'high': Complex, nuanced, or security-critical tasks (cryptographic implementations, multi-file architectural refactors, debugging subtle race conditions, security reviews, protocol implementations). Deep reasoning for high quality output.
- 'xhigh': Maximum reasoning depth. Use for the most challenging problems that require exhaustive analysis. Highest latency and token cost — reserve for tasks where absolute correctness is critical.
Example: { "type": "agent", "instructions": "# Implement AES-256-GCM encryption", "effort": "high", "modelTier": "premium" }
RULE: When modelTier is 'premium' for security-sensitive work, also consider setting effort to 'high' or 'xhigh' for maximum reasoning depth.` : ''}
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
            enum: ['all', 'pending', 'scaffolding', 'running', 'succeeded', 'completed', 'failed', 'partial', 'canceled'],
            description: 'Filter by status (optional)'
          }
        }
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
            description: 'Job UUID, producerId, or job name. Use the UUID from the jobMapping field in the create/finalize response for best results. ProducerId and name are also accepted.' 
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
            description: 'Job UUID, producerId, or job name. Use the UUID from the jobMapping field in the create/finalize response for best results. ProducerId and name are also accepted.' 
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
      description: 'Resume (or start) a paused or pending-start Plan. Allows new work to be scheduled.',
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
      name: 'archive_copilot_plan',
      description: 'Archive a completed or canceled plan. Preserves plan state and logs while cleaning up git worktrees and target branches to reduce repository clutter. Only plans in succeeded, partial, failed, or canceled status can be archived.',
      inputSchema: {
        type: 'object',
        properties: {
          planId: { 
            type: 'string', 
            description: 'The ID of the plan to archive' 
          },
          force: { 
            type: 'boolean', 
            description: 'Force-delete worktrees even with uncommitted changes', 
            default: false 
          },
          deleteRemoteBranches: { 
            type: 'boolean', 
            description: 'Also delete remote tracking branches', 
            default: false 
          }
        },
        required: ['planId']
      }
    },
    
    {
      name: 'recover_copilot_plan',
      description: 'Recover a canceled or failed plan. Recreates the target branch at the base commit and recovers worktree states from the deepest successfully-completed jobs. Uses git rev-parse with DAG work result status. The plan will be placed in paused state. For canceled plans, Copilot CLI agent verifies recovered worktree integrity.',
      inputSchema: {
        type: 'object',
        properties: {
          planId: { type: 'string', description: 'The ID of the plan to recover' },
          useCopilotAgent: { type: 'boolean', description: 'Use Copilot CLI agent to verify recovery integrity', default: true }
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
1. Use get_copilot_job_failure_context to analyze why the job failed
2. Optionally provide newWork to replace or augment the original work
3. Call retry_copilot_plan with the job ID

NEW WORK OPTIONS:
- String: Shell command like "npm run build" or "@agent Do something"
- Process: { type: "process", executable: "node", args: ["script.js"] }
- Shell: { type: "shell", command: "Get-ChildItem", shell: "powershell" }
- Agent: { type: "agent", instructions: "# Fix Issue\\n\\n1. Analyze error\\n2. Apply fix", resumeSession: true }${effortSupported ? `\n- Agent with effort: { type: "agent", instructions: "# Deep analysis needed\\n\\n1. Root cause\\n2. Fix", effort: "high" }` : ''}

For agent work, resumeSession (default: true) controls whether to continue
the existing Copilot session or start fresh.
${effortSupported ? `For complex retry logic (debugging subtle issues), consider setting effort: 'high' to give the agent more reasoning depth.` : ''}
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
            description: 'Optional: specific job UUIDs, producerIds, or names to retry. If omitted, retries all failed jobs.'
          },
          newWork: {
            description: `Optional replacement work for the retry. Can be:
1. STRING: Shell command like "npm run build" or "@agent Do something"
2. PROCESS: { "type": "process", "executable": "node", "args": ["script.js"] }
3. SHELL: { "type": "shell", "command": "Get-ChildItem", "shell": "powershell" }
4. AGENT: { "type": "agent", "instructions": "# Fix X\\n\\n1. Analyze\\n2. Fix", "resumeSession": true }

For agent type, resumeSession (default: true) continues existing Copilot session.
${effortSupported ? `For agent type, set effort (${effortChoices.join('/')}) to control reasoning depth. Use 'high' for retrying complex failures that need deeper analysis.` : ''}Agent instructions MUST be in Markdown format.`
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
      description: `Update plan-level settings. Use to change environment variables, concurrency limits, or plan chaining on an existing plan.

The plan can be in any state (scaffolding, paused, running). Changes take effect for the next job execution.

PLAN CHAINING (resumeAfterPlan):
- Set resumeAfterPlan to a plan ID to make this plan wait for that plan to complete
- The plan will auto-pause and auto-resume when the dependency succeeds
- Set to empty string or null to remove the dependency

ENVIRONMENT VARIABLES:
- Set env to apply environment variables to ALL jobs in the plan
- Individual work specs can override specific keys via their own env field
- Pass {} to clear all plan-level env vars

EXAMPLES:
- Chain plans: { "planId": "<uuid>", "resumeAfterPlan": "<other-plan-id>" }
- Set OpenSSL path: { "planId": "<uuid>", "env": { "OPENSSL_DIR": "C:\\\\vcpkg\\\\installed\\\\x64-windows" } }
- Change concurrency: { "planId": "<uuid>", "maxParallel": 4 }`,
      inputSchema: {
        type: 'object',
        properties: {
          planId: { type: 'string', description: 'Plan ID to update' },
          env: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Environment variables applied to all jobs. Job-level env overrides specific keys. Pass {} to clear. Supports variable expansion: use $VAR or ${VAR} (Unix) or %VAR% (Windows) to reference existing host env vars. Example: { "PATH": "/custom/bin:$PATH" } prepends to PATH.'
          },
          maxParallel: {
            type: 'number',
            description: 'Max concurrent jobs (0 = unlimited, defers to global capacity)'
          },
          resumeAfterPlan: {
            type: 'string',
            description: 'Plan ID of another plan that must complete before this plan auto-resumes. Set to empty string to remove the dependency.'
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
      description: 'Create an empty plan scaffold for incremental job building. Returns a planId. The plan appears in the UI as "Scaffolding". Use add_copilot_plan_job to add jobs one at a time, then finalize_copilot_plan to start. RECOMMENDED for plans with 5+ jobs to avoid large payloads.\\n\\nRETURNS:\\n{ \"success\": true, \"planId\": \"uuid\", \"specsDir\": \"/path/to/specs\", \"message\": \"...\" }\\n\\nWORKFLOW:\\n1. scaffold_copilot_plan → get planId\\n2. add_copilot_plan_job (repeat for each job) → get jobId confirmation\\n3. finalize_copilot_plan → validates DAG, injects SV node, starts execution\\n\\nThe plan is visible in the UI sidebar during scaffolding with an \"Under Construction\" badge.',
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
            description: 'Create the plan in paused state for review before execution (default: true). NOTE: If resumeAfterPlan is set, the plan always starts paused regardless of this flag.'
          },
          resumeAfterPlan: {
            type: 'string',
            description: 'Plan ID of another plan that must complete before this plan auto-resumes. Creates a plan-to-plan dependency chain. The plan starts paused and automatically resumes when the referenced plan succeeds. If the referenced plan is canceled or deleted, this plan is unblocked.'
          },
          cleanUpSuccessfulWork: { 
            type: 'boolean', 
            description: 'Clean up worktrees after successful merges (default: true)' 
          },
          env: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Environment variables applied to all jobs in this plan. Individual work specs (work/prechecks/postchecks) can override specific keys with their own env property. Supports variable expansion: use $VAR or ${VAR} (Unix) or %VAR% (Windows) to reference existing env vars. Example: { "PATH": "/custom/bin:$PATH" } prepends to the existing PATH.'
          },
          additionalSymlinkDirs: {
            type: 'array',
            description: "Additional directories to symlink from the main repo into worktrees (e.g. '.venv', 'vendor'). Merged with built-in list (node_modules). Must be .gitignored, read-only directories.",
            items: { type: 'string' }
          },
          verifyRi: {
            description: 'Optional verification command run as the work phase of the auto-injected Snapshot Validation node. Executes after all leaf nodes complete, validating the accumulated snapshot before merging to targetBranch. Auto-healable: on failure, Copilot CLI attempts to fix the issue.'
          },
          worktreeInit: {
            type: 'array',
            description: `Worktree initialization commands executed in the setup phase of EVERY job. Runs after FI merge, before prechecks/work. When set, node_modules is NOT symlinked — each worktree installs its own deps (npm global cache makes this fast).

Recommended: ["npm ci"] for Node.js, ["dotnet restore"] for .NET, ["pip install -r requirements.txt"] for Python, ["cargo fetch"] for Rust. Also auto-detects .github/instructions/worktree-init.instructions.md if present.`,
            items: {
              oneOf: [
                { type: 'string' },
                { type: 'object', properties: { type: { type: 'string', enum: ['process', 'shell', 'agent'] }, command: { type: 'string' }, shell: { type: 'string' }, instructions: { type: 'string' } } }
              ]
            }
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

FIELD GUIDE:
- name: Short display title (max 80 chars). Do NOT put instructions here.
- task: Brief description (max 200 chars). NOT the work instructions.
- work: The actual work specification — agent instructions, shell commands, or process specs.
- instructions: Supports FULL MARKDOWN (headers, code blocks, lists, bold, links).

EXAMPLES:
  Shell:  {"type": "shell", "command": "dotnet build", "shell": "powershell"}
  Agent:  {"type": "agent", "instructions": "# Task\\nImplement the feature..."}
  Agent file: {"type": "agent", "instructionsFile": ".github/prompts/task.md"}
  Process: {"type": "process", "executable": "node", "args": ["build.js"]}${effortSupported ? `\n  Agent with effort: {"type": "agent", "instructions": "# Complex refactor\\n1. Analyze patterns\\n2. Restructure", "effort": "high"}` : ''}

LIMITS: name ≤80, task ≤200, instructions ≤100KB, work string ≤50KB.
Use camelCase for properties: maxTurns, modelTier, allowedFolders, allowedUrls${effortSupported ? ', effort' : ''}.
${effortSupported ? `\nEFFORT (agent work only): Controls reasoning depth. Values: ${effortChoices.map(c => `'${c}'`).join(', ')}.\n- 'low': Simple/boilerplate tasks. Fast, low cost.\n- 'medium': Standard development (default when omitted).\n- 'high': Complex/security-critical tasks requiring deep reasoning.` : ''}
RETURNS:
{ "success": true, "jobId": "producerId", "message": "Job 'producerId' added to plan 'planId'. Task: ..." }

NEXT: Continue adding jobs, then call finalize_copilot_plan when all jobs are added.`,
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
            description: `Work specification. String shorthand OR object with type field.
Object properties: type (required: agent|shell|process), command, instructions (markdown), instructionsFile, model, modelTier (fast|standard|premium), maxTurns, shell (cmd|powershell|pwsh|bash|sh), allowedFolders, allowedUrls, executable, args, env${effortSupported ? `, effort (${effortChoices.join('|')})` : ''}.${effortSupported ? `\nFor agent work, set effort to control reasoning depth: 'low' for simple tasks, 'medium' for standard work (default), 'high' for complex/security-critical tasks.` : ''}`,
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['agent', 'shell', 'process'] },
                  instructions: { type: 'string', description: 'Inline Markdown instructions for agent work. Supports headers, code blocks, lists, bold, links.' },
                  instructionsFile: { type: 'string', description: 'Path to .md file with instructions (agent type only, mutually exclusive with instructions)' },
                  model: { type: 'string', enum: modelEnum },
                  modelTier: { type: 'string', enum: ['fast', 'standard', 'premium'] },
                  maxTurns: { type: 'number', minimum: 1, maximum: 100 },
                  ...(effortSupported ? { effort: { type: 'string', enum: effortChoices, description: 'Reasoning effort level: low (simple/fast), medium (standard, default), high (complex/thorough). Set high for security-critical, architectural, or complex multi-file tasks.' } } : {}),
                  allowedFolders: { type: 'array', items: { type: 'string' } },
                  allowedUrls: { type: 'array', items: { type: 'string' } },
                  command: { type: 'string' },
                  executable: { type: 'string' },
                  args: { type: 'array', items: { type: 'string' } },
                  shell: { type: 'string', enum: ['cmd', 'powershell', 'pwsh', 'bash', 'sh'] },
                  env: { type: 'object', additionalProperties: { type: 'string' } }
                }
              }
            ]
          },
          prechecks: {
            description: 'Optional prechecks specification - runs before main work. Same format as work.'
          },
          postchecks: {
            description: 'Optional postchecks specification - runs after main work. Same format as work.'
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
      description: `Validate and start a scaffolded plan. Resolves dependencies, checks for cycles, injects Snapshot Validation node, transitions from Scaffolding to execution.

RETURNS:
{
  "success": true,
  "planId": "uuid",
  "name": "Plan Name",
  "baseBranch": "main",
  "targetBranch": "feat/my-feature",
  "paused": false,
  "message": "Plan finalized with N jobs.",
  "jobMapping": { "my-job": "uuid-1", "__snapshot-validation__": "uuid-2" },
  "status": { "status": "pending", "nodes": 3, "roots": 2, "leaves": 1 },
  "warnings": ["..."]
}

NEXT STEPS:
- If paused: use resume_copilot_plan to start
- Monitor: use get_copilot_plan_status with the planId
- The plan begins executing immediately unless startPaused is true`,
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

    {
      name: 'add_copilot_plan_jobs',
      description: `Batch-add multiple jobs to a scaffolding plan in a single call. Much faster than calling add_copilot_plan_job repeatedly.

Each job in the array uses the same format as add_copilot_plan_job (producerId, task, work, etc.).
Jobs can reference each other's producerIds in their dependencies arrays.
${effortSupported ? `\nFor agent work, set effort inside the work object to control reasoning depth: ${effortChoices.map(c => `'${c}'`).join(', ')}. Use 'high' for complex/security-critical tasks, 'low' for simple/fast tasks.` : ''}
EXAMPLE:
{
  "planId": "abc123",
  "jobs": [
    {"producerId": "setup", "task": "Create project scaffold", "work": {"type": "agent", "instructions": "..."${effortSupported ? ', "effort": "low"' : ''}}, "dependencies": []},
    {"producerId": "impl", "task": "Implement feature", "work": {"type": "agent", "instructions": "..."${effortSupported ? ', "effort": "high"' : ''}}, "dependencies": ["setup"]},
    {"producerId": "test", "task": "Write tests", "work": {"type": "agent", "instructions": "..."}, "dependencies": ["impl"]}
  ]
}`,
      inputSchema: {
        type: 'object',
        properties: {
          planId: {
            type: 'string',
            description: 'Plan unique identifier returned from scaffold_copilot_plan'
          },
          jobs: {
            type: 'array',
            description: 'Array of job definitions to add (max 100)',
            items: {
              type: 'object',
              properties: {
                producerId: { type: 'string', pattern: PRODUCER_ID_PATTERN.source, description: 'Unique job identifier (lowercase, hyphens, 3-64 chars)' },
                name: { type: 'string', maxLength: 80, description: 'Short display name' },
                task: { type: 'string', maxLength: 200, description: 'Brief task description' },
                work: { description: 'Work specification (string or {type, ...} object)' },
                dependencies: { type: 'array', items: { type: 'string' }, description: 'producerIds this job depends on' },
                group: { type: 'string', description: 'Optional group path' },
                prechecks: { description: 'Optional prechecks (same format as work)' },
                postchecks: { description: 'Optional postchecks (same format as work)' },
                autoHeal: { type: 'boolean' },
                expectsNoChanges: { type: 'boolean' }
              },
              required: ['producerId', 'task', 'work']
            },
            minItems: 1,
            maxItems: 100
          }
        },
        required: ['planId', 'jobs']
      }
    },

    {
      name: 'get_copilot_plan_graph',
      description: `Get the dependency graph of a plan as a Mermaid flowchart diagram and structured adjacency list.

Returns:
- mermaid: A complete Mermaid flowchart LR diagram with status icons, group subgraphs, and dependency edges
- nodes: Per-node adjacency list showing dependsOn and dependedOnBy (using producerIds)

Use this to verify the dependency graph is correct after adding jobs, or to visualize plan structure.`,
      inputSchema: {
        type: 'object',
        properties: {
          planId: {
            type: 'string',
            description: 'Plan unique identifier'
          }
        },
        required: ['planId']
      }
    },

    {
      name: 'clone_copilot_plan',
      description: `Duplicate an existing plan (any status, including canceled/failed) as a new scaffolding plan.

Clones all job definitions including: producerIds, names, tasks, work specs, dependencies, groups, prechecks, postchecks, autoHeal, and expectsNoChanges.

Does NOT clone: execution state, commits, worktrees, or timing. Auto-injected SV nodes are skipped (finalize will re-create them).

The cloned plan starts in 'scaffolding' status. Use add_copilot_plan_job to modify, then finalize_copilot_plan to start.`,
      inputSchema: {
        type: 'object',
        properties: {
          sourcePlanId: {
            type: 'string',
            description: 'ID of the plan to clone (can be in any status)'
          },
          name: {
            type: 'string',
            description: 'Name for the cloned plan (default: "<source name> (clone)")'
          },
          targetBranch: {
            type: 'string',
            description: 'Override target branch for the clone (default: auto-generated)'
          }
        },
        required: ['sourcePlanId']
      }
    },
  ];
}
