/**
 * @fileoverview JSON Schema definitions for MCP tool inputs
 * 
 * These schemas are used by Ajv to validate all MCP input before processing.
 * All input is treated as potentially malicious and strictly validated.
 * 
 * ⚠️ MAINTENANCE: When adding new properties to WorkSpec types (ProcessSpec,
 * ShellSpec, AgentSpec) in src/plan/types/specs.ts, you MUST also:
 *   1. Add the property to `workSpecObjectSchema` below
 *   2. Add the property to the `WorkSpec` interface below
 *   3. Update the comprehensive schema test in
 *      src/test/unit/mcp/schemaCompleteness.unit.test.ts
 * 
 * When adding new plan-level fields to PlanSpec (src/plan/types/plan.ts),
 * you MUST also:
 *   1. Add the field to `createPlanSchema`
 *   2. Add the field to the `CreatePlanInput` interface
 *   3. Update the comprehensive schema test
 * 
 * The schemaCompleteness test validates a "kitchen sink" plan that uses
 * every supported property — if the schema rejects a valid property,
 * the test fails.
 * 
 * @module mcp/validation/schemas
 */

import { JSONSchemaType } from 'ajv';

// ============================================================================
// SHARED DEFINITIONS
// ============================================================================

/**
 * Pattern for valid producerId values.
 * Lowercase alphanumeric and hyphens, 3-64 characters.
 */
export const PRODUCER_ID_PATTERN = '^[a-z0-9-]{3,64}$';

/**
 * Work specification - can be string or object with type
 */
export interface WorkSpec {
  type?: 'process' | 'shell' | 'agent';
  command?: string;
  executable?: string;
  args?: string[];
  shell?: 'cmd' | 'powershell' | 'pwsh' | 'bash' | 'sh';
  instructions?: string;
  model?: string;
  maxTurns?: number;
  resumeSession?: boolean;
  /** Additional folder paths the agent is allowed to access beyond the worktree */
  allowedFolders?: string[];
  /** URLs or URL patterns the agent is allowed to access */
  allowedUrls?: string[];
  /** Additional environment variables for this work spec */
  env?: Record<string, string>;
  /** Per-phase failure behavior */
  onFailure?: {
    noAutoHeal?: boolean;
    message?: string;
    resumeFromPhase?: string;
  };
}

/**
 * Job specification within a plan
 */
export interface JobInput {
  producerId: string;
  name?: string;
  task: string;
  work?: string | WorkSpec;
  dependencies: string[];
  prechecks?: string | WorkSpec;
  postchecks?: string | WorkSpec;
  instructions?: string;
  baseBranch?: string;
  expectsNoChanges?: boolean;
  group?: string;
  /** Environment variables for this job. Overrides plan-level env. */
  env?: Record<string, string>;
}

/**
 * Group specification for hierarchical organization
 */
export interface GroupInput {
  name: string;
  jobs?: JobInput[];
  groups?: GroupInput[];
}

/**
 * Create plan input
 */
export interface CreatePlanInput {
  name: string;
  baseBranch?: string;
  targetBranch?: string;
  maxParallel?: number;
  cleanUpSuccessfulWork?: boolean;
  additionalSymlinkDirs?: string[];
  jobs: JobInput[];
  groups?: GroupInput[];
  startPaused?: boolean;
  verifyRi?: string | WorkSpec;
  /** Environment variables applied to all jobs. Individual work specs can override. */
  env?: Record<string, string>;
}

// ============================================================================
// JSON SCHEMAS
// ============================================================================

/**
 * Schema for work specification object
 */
const workSpecObjectSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['process', 'shell', 'agent'] },
    command: { type: 'string' },
    executable: { type: 'string' },
    args: { type: 'array', items: { type: 'string' } },
    shell: { type: 'string', enum: ['cmd', 'powershell', 'pwsh', 'bash', 'sh'] },
    errorAction: { type: 'string', enum: ['Continue', 'Stop', 'SilentlyContinue'], description: 'PowerShell $ErrorActionPreference. Default: Continue. Only applies to powershell/pwsh shells.' },
    instructions: { type: 'string' },
    model: { type: 'string', maxLength: 100 },
    modelTier: { type: 'string', enum: ['fast', 'standard', 'premium'], description: 'Model tier preference. When set and model is not specified, auto-selects a model matching this tier.' },
    maxTurns: { type: 'number', minimum: 1, maximum: 100 },
    resumeSession: { type: 'boolean' },
    allowedFolders: {
      type: 'array',
      items: { type: 'string', maxLength: 500 },
      maxItems: 20
    },
    allowedUrls: {
      type: 'array',
      items: { type: 'string', maxLength: 500 },
      maxItems: 50,
      description: 'URLs or URL patterns the agent is allowed to access. Default: none (no network access).'
    },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Environment variables for this work spec. Overrides plan-level env for this specific phase.'
    },
    onFailure: {
      type: 'object',
      properties: {
        noAutoHeal: { type: 'boolean', description: 'When true, skip auto-heal on failure — require manual retry.' },
        message: { type: 'string', maxLength: 1000, description: 'User-facing message displayed on failure.' },
        resumeFromPhase: { 
          type: 'string', 
          enum: ['merge-fi', 'prechecks', 'work', 'postchecks', 'commit', 'merge-ri'],
          description: 'Phase to resume from when the node is retried after this failure.'
        }
      },
      additionalProperties: false
    }
  },
  required: ['type'],
  additionalProperties: false
} as const;

/**
 * Schema for a job within the jobs array
 */
const jobSchema = {
  type: 'object',
  properties: {
    producerId: { 
      type: 'string', 
      pattern: PRODUCER_ID_PATTERN,
      minLength: 3,
      maxLength: 64
    },
    name: { type: 'string', maxLength: 200 },
    task: { type: 'string', minLength: 1, maxLength: 5000 },
    work: {
      oneOf: [
        { type: 'string', maxLength: 50000 },
        workSpecObjectSchema
      ]
    },
    dependencies: { 
      type: 'array', 
      items: { type: 'string', maxLength: 200 },
      maxItems: 100
    },
    prechecks: {
      oneOf: [
        { type: 'string', maxLength: 10000 },
        workSpecObjectSchema
      ]
    },
    postchecks: {
      oneOf: [
        { type: 'string', maxLength: 10000 },
        workSpecObjectSchema
      ]
    },
    instructions: { type: 'string', maxLength: 100000 },
    baseBranch: { type: 'string', maxLength: 200 },
    expectsNoChanges: { type: 'boolean' },
    group: { type: 'string', maxLength: 200 },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Environment variables for this job. Overrides plan-level env for this specific job.'
    }
  },
  required: ['producerId', 'task', 'work', 'dependencies'],
  additionalProperties: false
} as const;

/**
 * Schema for create_copilot_plan input
 */
export const createPlanSchema = {
  $id: 'create_copilot_plan',
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    baseBranch: { type: 'string', maxLength: 200 },
    targetBranch: { type: 'string', maxLength: 200 },
    maxParallel: { type: 'number', minimum: 0, maximum: 1024 },
    cleanUpSuccessfulWork: { type: 'boolean' },
    additionalSymlinkDirs: {
      type: 'array',
      items: { type: 'string', maxLength: 200 },
      maxItems: 20,
      description: 'Additional directories to symlink from the main repo into worktrees (e.g. .venv, vendor). Merged with built-in list (node_modules).'
    },
    jobs: {
      type: 'array',
      items: jobSchema,
      minItems: 1,
      maxItems: 500
    },
    startPaused: { type: 'boolean' },
    verifyRi: {
      oneOf: [
        { type: 'string', maxLength: 50000 },
        workSpecObjectSchema
      ]
    },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Environment variables applied to all jobs. Individual work specs can override specific keys.'
    }
  },
  required: ['name', 'jobs'],
  additionalProperties: false
} as const;

/**
 * Schema for get_copilot_plan_status input
 */
export const getPlanStatusSchema = {
  $id: 'get_copilot_plan_status',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 }
  },
  required: ['planId'],
  additionalProperties: false
} as const;

/**
 * Schema for list_copilot_plans input
 */
export const listPlansSchema = {
  $id: 'list_copilot_plans',
  type: 'object',
  properties: {
    status: { 
      type: 'string', 
      enum: ['all', 'pending', 'scaffolding', 'running', 'succeeded', 'completed', 'failed', 'partial', 'canceled'] 
    }
  },
  additionalProperties: false
} as const;

/**
 * Schema for get_copilot_job_details input
 */
export const getNodeDetailsSchema = {
  $id: 'get_copilot_job_details',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    jobId: { type: 'string', minLength: 1, maxLength: 100 }
  },
  required: ['planId', 'jobId'],
  additionalProperties: false
} as const;

/**
 * Schema for get_copilot_job_logs input
 */
export const getNodeLogsSchema = {
  $id: 'get_copilot_job_logs',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    jobId: { type: 'string', minLength: 1, maxLength: 100 },
    phase: {
      type: 'string',
      enum: ['merge-fi', 'setup', 'prechecks', 'work', 'commit', 'postchecks', 'merge-ri', 'all']
    },
    tail: { type: 'number', minimum: 1, maximum: 10000 }
  },
  required: ['planId', 'jobId'],
  additionalProperties: false
} as const;

/**
 * Schema for get_copilot_job_attempts input
 */
export const getNodeAttemptsSchema = {
  $id: 'get_copilot_job_attempts',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    jobId: { type: 'string', minLength: 1, maxLength: 100 },
    attemptNumber: { type: 'number', minimum: 1, maximum: 1000 },
    includeLogs: { type: 'boolean' }
  },
  required: ['planId', 'jobId'],
  additionalProperties: false
} as const;

/**
 * Schema for cancel_copilot_plan input
 */
export const cancelPlanSchema = {
  $id: 'cancel_copilot_plan',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 }
  },
  required: ['planId'],
  additionalProperties: false
} as const;

/**
 * Schema for delete_copilot_plan input
 */
export const deletePlanSchema = {
  $id: 'delete_copilot_plan',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 }
  },
  required: ['planId'],
  additionalProperties: false
} as const;

/**
 * Schema for retry_copilot_plan input
 */
export const retryPlanSchema = {
  $id: 'retry_copilot_plan',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    jobIds: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 100 },
      maxItems: 100
    },
    newWork: {
      oneOf: [
        { type: 'string', maxLength: 50000 },
        workSpecObjectSchema
      ]
    },
    newPrechecks: {
      oneOf: [
        { type: 'string', maxLength: 10000 },
        { type: 'null' },
        workSpecObjectSchema
      ]
    },
    newPostchecks: {
      oneOf: [
        { type: 'string', maxLength: 10000 },
        { type: 'null' },
        workSpecObjectSchema
      ]
    },
    clearWorktree: { type: 'boolean' }
  },
  required: ['planId'],
  additionalProperties: false
} as const;

/**
 * Schema for retry_copilot_plan_job input
 */
export const retryNodeSchema = {
  $id: 'retry_copilot_plan_job',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    jobId: { type: 'string', minLength: 1, maxLength: 100 },
    newWork: {
      oneOf: [
        { type: 'string', maxLength: 50000 },
        workSpecObjectSchema
      ]
    },
    newPrechecks: {
      oneOf: [
        { type: 'string', maxLength: 10000 },
        { type: 'null' },
        workSpecObjectSchema
      ]
    },
    newPostchecks: {
      oneOf: [
        { type: 'string', maxLength: 10000 },
        { type: 'null' },
        workSpecObjectSchema
      ]
    },
    clearWorktree: { type: 'boolean' }
  },
  required: ['planId', 'jobId'],
  additionalProperties: false
} as const;

/**
 * Schema for get_copilot_plan_job_failure_context input
 */
export const getFailureContextSchema = {
  $id: 'get_copilot_plan_job_failure_context',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    jobId: { type: 'string', minLength: 1, maxLength: 100 }
  },
  required: ['planId', 'jobId'],
  additionalProperties: false
} as const;

/**
 * Schema for add_copilot_job input
 */
export const addNodeSchema = {
  $id: 'add_copilot_job',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    nodes: {
      type: 'array',
      items: jobSchema,
      minItems: 1,
      maxItems: 100
    }
  },
  required: ['planId', 'nodes'],
  additionalProperties: false
} as const;

/**
 * Schema for reshape_copilot_plan input
 */
export const reshapePlanSchema = {
  $id: 'reshape_copilot_plan',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['add_node', 'remove_node', 'update_deps', 'add_before', 'add_after']
          },
          spec: {
            type: 'object',
            properties: {
              producerId: { type: 'string', pattern: PRODUCER_ID_PATTERN, minLength: 3, maxLength: 64 },
              name: { type: 'string', maxLength: 200 },
              task: { type: 'string', minLength: 1, maxLength: 5000 },
              work: {
                oneOf: [
                  { type: 'string', maxLength: 50000 },
                  workSpecObjectSchema
                ]
              },
              dependencies: {
                type: 'array',
                items: { type: 'string', maxLength: 200 },
                maxItems: 100
              },
              prechecks: {
                oneOf: [
                  { type: 'string', maxLength: 10000 },
                  workSpecObjectSchema
                ]
              },
              postchecks: {
                oneOf: [
                  { type: 'string', maxLength: 10000 },
                  workSpecObjectSchema
                ]
              },
              instructions: { type: 'string', maxLength: 100000 },
              expectsNoChanges: { type: 'boolean' }
            },
            additionalProperties: false
          },
          jobId: { type: 'string', maxLength: 100 },
          producerId: { type: 'string', maxLength: 100 },
          existingJobId: { type: 'string', maxLength: 100 },
          dependencies: {
            type: 'array',
            items: { type: 'string', maxLength: 200 },
            maxItems: 100
          }
        },
        required: ['type'],
        additionalProperties: false
      },
      minItems: 1,
      maxItems: 100
    }
  },
  required: ['planId', 'operations'],
  additionalProperties: false
} as const;

// ============================================================================
// JOB-CENTRIC TOOL SCHEMAS
// ============================================================================

/**
 * Schema for get_copilot_job input
 */
export const getNodeSchema = {
  $id: 'get_copilot_job',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    jobId: { type: 'string', minLength: 1, maxLength: 100 }
  },
  required: ['planId', 'jobId'],
  additionalProperties: false
} as const;

/**
 * Schema for list_copilot_jobs input
 */
export const listNodesSchema = {
  $id: 'list_copilot_jobs',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    groupId: { type: 'string', maxLength: 100 },
    status: {
      type: 'string',
      enum: ['pending', 'ready', 'scheduled', 'running', 'succeeded', 'failed', 'blocked', 'canceled']
    },
    groupName: { type: 'string', maxLength: 200 }
  },
  required: ['planId'],
  additionalProperties: false
} as const;

/**
 * Schema for retry_copilot_job input
 */
export const retryNodeCentricSchema = {
  $id: 'retry_copilot_job',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    jobId: { type: 'string', minLength: 1, maxLength: 100 },
    newWork: {
      oneOf: [
        { type: 'string', maxLength: 50000 },
        workSpecObjectSchema
      ]
    },
    newPrechecks: {
      oneOf: [
        { type: 'string', maxLength: 10000 },
        { type: 'null' },
        workSpecObjectSchema
      ]
    },
    newPostchecks: {
      oneOf: [
        { type: 'string', maxLength: 10000 },
        { type: 'null' },
        workSpecObjectSchema
      ]
    },
    clearWorktree: { type: 'boolean' }
  },
  required: ['planId', 'jobId'],
  additionalProperties: false
} as const;

/**
 * Schema for force_fail_copilot_job input
 */
export const forceFailNodeSchema = {
  $id: 'force_fail_copilot_job',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    jobId: { type: 'string', minLength: 1, maxLength: 100 },
    reason: { type: 'string', maxLength: 1000 }
  },
  required: ['planId', 'jobId'],
  additionalProperties: false
} as const;

/**
 * Schema for get_copilot_job_failure_context input
 */
export const getNodeFailureContextSchema = {
  $id: 'get_copilot_job_failure_context',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    jobId: { type: 'string', minLength: 1, maxLength: 100 }
  },
  required: ['planId', 'jobId'],
  additionalProperties: false
} as const;

/**
 * Schema for update_copilot_plan_job input
 */
export const updateCopilotPlanNodeSchema = {
  $id: 'update_copilot_plan_job',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    jobId: { type: 'string', minLength: 1, maxLength: 100 },
    prechecks: {
      oneOf: [
        { type: 'string', maxLength: 10000 },
        workSpecObjectSchema
      ]
    },
    work: {
      oneOf: [
        { type: 'string', maxLength: 50000 },
        workSpecObjectSchema
      ]
    },
    postchecks: {
      oneOf: [
        { type: 'string', maxLength: 10000 },
        workSpecObjectSchema
      ]
    },
    resetToStage: {
      type: 'string',
      enum: ['prechecks', 'work', 'postchecks']
    },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Environment variables for this job. Overrides plan-level env.'
    }
  },
  required: ['planId', 'jobId'],
  additionalProperties: false
} as const;

/**
 * Schema for pause_copilot_plan input
 */
export const pausePlanSchema = {
  $id: 'pause_copilot_plan',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 }
  },
  required: ['planId'],
  additionalProperties: false
} as const;

/**
 * Schema for resume_copilot_plan input
 */
export const resumePlanSchema = {
  $id: 'resume_copilot_plan',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 }
  },
  required: ['planId'],
  additionalProperties: false
} as const;

/**
 * Schema for update_copilot_plan input (plan-level settings)
 */
export const updatePlanSchema = {
  $id: 'update_copilot_plan',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Replace plan-level environment variables. Pass {} to clear.'
    },
    maxParallel: { type: 'number', minimum: 0, maximum: 1024, description: 'Update max concurrent jobs (0 = unlimited)' },
  },
  required: ['planId'],
  additionalProperties: false
} as const;

/**
 * Schema for scaffold_copilot_plan input
 */
export const scaffoldPlanSchema = {
  $id: 'scaffold_copilot_plan',
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    baseBranch: { type: 'string', maxLength: 200 },
    targetBranch: { type: 'string', maxLength: 200 },
    maxParallel: { type: 'number', minimum: 0, maximum: 1024 },
    startPaused: { type: 'boolean' },
    cleanUpSuccessfulWork: { type: 'boolean' },
    additionalSymlinkDirs: {
      type: 'array',
      items: { type: 'string', maxLength: 200 },
      maxItems: 20
    },
    verifyRi: {
      oneOf: [
        { type: 'string', maxLength: 10000 },
        workSpecObjectSchema
      ]
    },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Environment variables applied to all jobs. Individual work specs can override specific keys.'
    }
  },
  required: ['name'],
  additionalProperties: false
} as const;

/**
 * Schema for add_copilot_plan_job input
 */
export const addPlanNodeSchema = {
  $id: 'add_copilot_plan_job',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    producerId: {
      type: 'string',
      pattern: PRODUCER_ID_PATTERN,
      minLength: 3,
      maxLength: 64
    },
    name: { type: 'string', maxLength: 80, description: 'Short display name for the job (max 80 chars). Do NOT put instructions here.' },
    task: { type: 'string', minLength: 1, maxLength: 200, description: 'Brief task description (max 200 chars). Detailed instructions go in the work field.' },
    dependencies: {
      type: 'array',
      items: { type: 'string', pattern: '^[a-z0-9-/]{3,64}$' },
      maxItems: 100
    },
    group: { type: 'string', maxLength: 200 },
    work: {
      oneOf: [
        { type: 'string', maxLength: 50000 },
        workSpecObjectSchema
      ]
    },
    prechecks: {
      oneOf: [
        { type: 'string', maxLength: 10000 },
        workSpecObjectSchema
      ]
    },
    postchecks: {
      oneOf: [
        { type: 'string', maxLength: 10000 },
        workSpecObjectSchema
      ]
    },
    autoHeal: { type: 'boolean' },
    expectsNoChanges: { type: 'boolean' },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Environment variables for this job. Overrides plan-level env for this specific job.'
    }
  },
  required: ['planId', 'producerId', 'task', 'work'],
  additionalProperties: false
} as const;

/**
 * Schema for finalize_copilot_plan input
 */
export const finalizePlanSchema = {
  $id: 'finalize_copilot_plan',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    startPaused: { type: 'boolean' }
  },
  required: ['planId'],
  additionalProperties: false
} as const;

/**
 * All schemas indexed by tool name
 */
export const schemas: Record<string, object> = {
  // Plan lifecycle tools
  create_copilot_plan: createPlanSchema,
  get_copilot_plan_status: getPlanStatusSchema,
  list_copilot_plans: listPlansSchema,
  cancel_copilot_plan: cancelPlanSchema,
  pause_copilot_plan: pausePlanSchema,
  resume_copilot_plan: resumePlanSchema,
  delete_copilot_plan: deletePlanSchema,
  update_copilot_plan: updatePlanSchema,
  retry_copilot_plan: retryPlanSchema,
  reshape_copilot_plan: reshapePlanSchema,

  // Job tools (all require planId + jobId)
  get_copilot_job: getNodeSchema,
  get_copilot_job_logs: getNodeLogsSchema,
  get_copilot_job_attempts: getNodeAttemptsSchema,
  list_copilot_jobs: listNodesSchema,
  retry_copilot_job: retryNodeCentricSchema,
  force_fail_copilot_job: forceFailNodeSchema,
  get_copilot_job_failure_context: getNodeFailureContextSchema,
  update_copilot_plan_job: updateCopilotPlanNodeSchema,

  // Scaffolding tools
  scaffold_copilot_plan: scaffoldPlanSchema,
  add_copilot_plan_job: addPlanNodeSchema,
  finalize_copilot_plan: finalizePlanSchema,
};
