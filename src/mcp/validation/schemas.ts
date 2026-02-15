/**
 * @fileoverview JSON Schema definitions for MCP tool inputs
 * 
 * These schemas are used by Ajv to validate all MCP input before processing.
 * All input is treated as potentially malicious and strictly validated.
 * 
 * @module mcp/validation/schemas
 */

import { JSONSchemaType } from 'ajv';

// ============================================================================
// SHARED DEFINITIONS
// ============================================================================

/**
 * Pattern for valid producer_id values.
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
  maxTurns?: number;
  /** Additional folder paths the agent is allowed to access beyond the worktree */
  allowedFolders?: string[];
  /** URLs or URL patterns the agent is allowed to access */
  allowedUrls?: string[];
  /** Whether to augment agent instructions with project context */
  augmentInstructions?: boolean;
}

/**
 * Job specification within a plan
 */
export interface JobInput {
  producer_id: string;
  name?: string;
  task: string;
  work?: string | WorkSpec;
  dependencies: string[];
  prechecks?: string | WorkSpec;
  postchecks?: string | WorkSpec;
  instructions?: string;
  baseBranch?: string;
  expects_no_changes?: boolean;
  group?: string;
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
    instructions: { type: 'string' },
    model: { type: 'string', maxLength: 100 },
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
    augmentInstructions: { type: 'boolean' }
  },
  additionalProperties: false
} as const;

/**
 * Schema for a job within the jobs array
 */
const jobSchema = {
  type: 'object',
  properties: {
    producer_id: { 
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
    expects_no_changes: { type: 'boolean' },
    group: { type: 'string', maxLength: 200 }
  },
  required: ['producer_id', 'task', 'dependencies'],
  additionalProperties: false
} as const;

/**
 * Schema for a group (recursive)
 * Note: We can't use JSONSchemaType for recursive schemas, so this is a plain object
 */
const groupSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    jobs: {
      type: 'array',
      items: jobSchema,
      maxItems: 500
    },
    groups: {
      type: 'array',
      items: { $ref: '#/$defs/group' },
      maxItems: 50
    }
  },
  required: ['name'],
  additionalProperties: false
};

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
    maxParallel: { type: 'number', minimum: 1, maximum: 32 },
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
      maxItems: 500
    },
    groups: {
      type: 'array',
      items: { $ref: '#/$defs/group' },
      maxItems: 50
    },
    startPaused: { type: 'boolean' }
  },
  required: ['name', 'jobs'],
  additionalProperties: false,
  $defs: {
    group: groupSchema
  }
} as const;

/**
 * Schema for get_copilot_plan_status input
 */
export const getPlanStatusSchema = {
  $id: 'get_copilot_plan_status',
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 100 }
  },
  required: ['id'],
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
      enum: ['all', 'running', 'completed', 'failed', 'pending'] 
    }
  },
  additionalProperties: false
} as const;

/**
 * Schema for get_copilot_node_details input
 */
export const getNodeDetailsSchema = {
  $id: 'get_copilot_node_details',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    nodeId: { type: 'string', minLength: 1, maxLength: 100 }
  },
  required: ['planId', 'nodeId'],
  additionalProperties: false
} as const;

/**
 * Schema for get_copilot_node_logs input
 */
export const getNodeLogsSchema = {
  $id: 'get_copilot_node_logs',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    nodeId: { type: 'string', minLength: 1, maxLength: 100 },
    tail: { type: 'number', minimum: 1, maximum: 10000 }
  },
  required: ['planId', 'nodeId'],
  additionalProperties: false
} as const;

/**
 * Schema for get_copilot_node_attempts input
 */
export const getNodeAttemptsSchema = {
  $id: 'get_copilot_node_attempts',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    nodeId: { type: 'string', minLength: 1, maxLength: 100 }
  },
  required: ['planId', 'nodeId'],
  additionalProperties: false
} as const;

/**
 * Schema for cancel_copilot_plan input
 */
export const cancelPlanSchema = {
  $id: 'cancel_copilot_plan',
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 100 }
  },
  required: ['id'],
  additionalProperties: false
} as const;

/**
 * Schema for delete_copilot_plan input
 */
export const deletePlanSchema = {
  $id: 'delete_copilot_plan',
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 100 }
  },
  required: ['id'],
  additionalProperties: false
} as const;

/**
 * Schema for retry_copilot_plan input
 */
export const retryPlanSchema = {
  $id: 'retry_copilot_plan',
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 100 },
    nodeIds: {
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
  required: ['id'],
  additionalProperties: false
} as const;

/**
 * Schema for retry_copilot_plan_node input
 */
export const retryNodeSchema = {
  $id: 'retry_copilot_plan_node',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    nodeId: { type: 'string', minLength: 1, maxLength: 100 },
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
  required: ['planId', 'nodeId'],
  additionalProperties: false
} as const;

/**
 * Schema for get_copilot_plan_node_failure_context input
 */
export const getFailureContextSchema = {
  $id: 'get_copilot_plan_node_failure_context',
  type: 'object',
  properties: {
    plan_id: { type: 'string', minLength: 1, maxLength: 100 },
    node_id: { type: 'string', minLength: 1, maxLength: 100 }
  },
  required: ['plan_id', 'node_id'],
  additionalProperties: false
} as const;

/**
 * Schema for add_copilot_node input
 */
export const addNodeSchema = {
  $id: 'add_copilot_node',
  type: 'object',
  properties: {
    plan_id: { type: 'string', minLength: 1, maxLength: 100 },
    nodes: {
      type: 'array',
      items: jobSchema,
      minItems: 1,
      maxItems: 100
    }
  },
  required: ['plan_id', 'nodes'],
  additionalProperties: false
} as const;

// ============================================================================
// NODE-CENTRIC TOOL SCHEMAS
// ============================================================================

/**
 * Schema for get_copilot_node input
 */
export const getNodeSchema = {
  $id: 'get_copilot_node',
  type: 'object',
  properties: {
    node_id: { type: 'string', minLength: 1, maxLength: 100 }
  },
  required: ['node_id'],
  additionalProperties: false
} as const;

/**
 * Schema for list_copilot_nodes input
 */
export const listNodesSchema = {
  $id: 'list_copilot_nodes',
  type: 'object',
  properties: {
    group_id: { type: 'string', maxLength: 100 },
    status: {
      type: 'string',
      enum: ['pending', 'ready', 'scheduled', 'running', 'succeeded', 'failed', 'blocked', 'canceled']
    },
    group_name: { type: 'string', maxLength: 200 }
  },
  additionalProperties: false
} as const;

/**
 * Schema for retry_copilot_node input (node-centric, no planId)
 */
export const retryNodeCentricSchema = {
  $id: 'retry_copilot_node',
  type: 'object',
  properties: {
    node_id: { type: 'string', minLength: 1, maxLength: 100 },
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
  required: ['node_id'],
  additionalProperties: false
} as const;

/**
 * Schema for force_fail_copilot_node input
 */
export const forceFailNodeSchema = {
  $id: 'force_fail_copilot_node',
  type: 'object',
  properties: {
    node_id: { type: 'string', minLength: 1, maxLength: 100 },
    reason: { type: 'string', maxLength: 1000 }
  },
  required: ['node_id'],
  additionalProperties: false
} as const;

/**
 * Schema for get_copilot_node_failure_context input (node-centric)
 */
export const getNodeFailureContextSchema = {
  $id: 'get_copilot_node_failure_context',
  type: 'object',
  properties: {
    node_id: { type: 'string', minLength: 1, maxLength: 100 }
  },
  required: ['node_id'],
  additionalProperties: false
} as const;

/**
 * Schema for update_copilot_plan_node input
 */
export const updateCopilotPlanNodeSchema = {
  $id: 'update_copilot_plan_node',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    nodeId: { type: 'string', minLength: 1, maxLength: 100 },
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
    }
  },
  required: ['planId', 'nodeId'],
  additionalProperties: false
} as const;

/**
 * All schemas indexed by tool name
 */
export const schemas: Record<string, object> = {
  // Existing plan tools
  create_copilot_plan: createPlanSchema,
  get_copilot_plan_status: getPlanStatusSchema,
  list_copilot_plans: listPlansSchema,
  get_copilot_node_details: getNodeDetailsSchema,
  get_copilot_node_logs: getNodeLogsSchema,
  get_copilot_node_attempts: getNodeAttemptsSchema,
  cancel_copilot_plan: cancelPlanSchema,
  delete_copilot_plan: deletePlanSchema,
  retry_copilot_plan: retryPlanSchema,
  retry_copilot_plan_node: retryNodeSchema,
  get_copilot_plan_node_failure_context: getFailureContextSchema,
  add_copilot_node: addNodeSchema,
  
  // Node-centric tools (NEW)
  get_copilot_node: getNodeSchema,
  list_copilot_nodes: listNodesSchema,
  retry_copilot_node: retryNodeCentricSchema,
  force_fail_copilot_node: forceFailNodeSchema,
  get_copilot_node_failure_context: getNodeFailureContextSchema,
  update_copilot_plan_node: updateCopilotPlanNodeSchema,
};
