/**
 * @fileoverview Plan-related MCP tool definitions.
 * 
 * Defines the schema for all plan-related tools exposed via MCP.
 * 
 * Producer ID Pattern:
 * - Each job and sub-plan has a required 'producer_id' field
 * - producer_id is user-controlled and used for dependency references (consumesFrom)
 * - producer_id must match pattern: [a-z0-9-]{5,64} (lowercase, numbers, hyphens, 5-64 chars)
 * - producer_id must be unique within its scope (plan-level jobs/subplans, or within a sub-plan)
 * - Internal UUID 'id' is auto-generated for worktrees/branches
 * - 'name' is optional human-friendly display name
 * 
 * Branch Chaining:
 * - Plan has a baseBranch (starting point, default: main)
 * - Root jobs (no dependencies) branch from plan's baseBranch
 * - Dependent jobs automatically branch from their parent's completed branch
 * - This creates proper code flow: main -> job1 -> job2 -> job3
 * 
 * @module mcp/tools/planTools
 */

import { McpTool } from '../types';

/** Regex pattern for valid producer_id values */
export const PRODUCER_ID_PATTERN = /^[a-z0-9-]{5,64}$/;

/**
 * Get all plan-related tool definitions.
 */
export function getPlanToolDefinitions(): McpTool[] {
  return [
    {
      name: 'create_copilot_plan',
      description: `Create a plan with multiple work units (jobs and optional sub-plans). Dependencies use a simple producer→consumer model.

IMPORTANT - PRODUCER_ID IS REQUIRED:
- Every job and sub-plan MUST have a 'producer_id' field (not 'id')
- producer_id is the key used in 'consumesFrom' arrays to establish dependencies
- Format: lowercase letters (a-z), numbers (0-9), and hyphens (-) only, 5-64 characters
- Examples: "build-step", "run-tests-01", "deploy-stage"
- Must be unique within the plan (or within a sub-plan for nested jobs)
- Jobs with consumesFrom: [] are root jobs that start immediately

EXAMPLE PLAN STRUCTURE:
{
  "name": "Build and Test",
  "jobs": [
    { "producer_id": "build-app", "task": "Build application", "consumesFrom": [], "work": "npm run build" },
    { "producer_id": "run-tests", "task": "Run tests", "consumesFrom": ["build-app"], "work": "npm test" }
  ]
}

Jobs run in parallel up to maxParallel, respecting consumesFrom order.

EXECUTION CONTEXT FOR JOBS:
- All commands (prechecks, work, postchecks) execute in a SHELL PROCESS (cmd.exe on Windows, /bin/sh on Unix)
- Commands run in the job's worktree directory, NOT PowerShell - use shell syntax accordingly
- For AI-assisted work, prefix with "@agent" to delegate to GitHub Copilot CLI

WORK FIELD OPTIONS:
1. Shell command: Runs directly in shell (e.g., "npm run build", "make test")
2. @agent <task>: Delegates to GitHub Copilot CLI with natural language instructions`,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Human-readable plan name for display' },
          baseBranch: { type: 'string', description: 'Starting branch for the plan (default: main). Root jobs branch from here.' },
          targetBranch: { type: 'string', description: 'Optional branch to merge final results into' },
          maxParallel: { type: 'number', description: 'Max concurrent jobs (default: auto based on CPU). Note: Global maxConcurrentJobs setting takes precedence.' },
          cleanUpSuccessfulWork: { type: 'boolean', description: 'Whether to clean up worktrees/branches after successful merges (default: true). When true, worktrees/branches are deleted immediately after a leaf merges to targetBranch, keeping local git state minimal.' },
          jobs: {
            type: 'array',
            description: 'Array of job specifications. Each job MUST have producer_id. Use consumesFrom to specify dependencies by referencing other jobs/sub-plans by their producer_id.',
            items: {
              type: 'object',
              properties: {
                producer_id: { 
                  type: 'string', 
                  description: 'REQUIRED. Unique identifier for this job within the plan. Used in consumesFrom arrays to establish dependencies. Format: lowercase letters, numbers, hyphens only (a-z, 0-9, -), 5-64 characters. Examples: "build-step", "run-tests", "deploy-app"',
                  pattern: '^[a-z0-9-]{5,64}$'
                },
                name: { type: 'string', description: 'Optional human-friendly display name (defaults to producer_id if not provided)' },
                task: { type: 'string', description: 'Task description (required)' },
                work: { 
                  type: 'string', 
                  description: 'Shell command (runs in cmd/sh, NOT PowerShell) OR "@agent <task>" for Copilot delegation' 
                },
                consumesFrom: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of producer_id values of jobs or sub-plans this job depends on. Must match producer_id exactly. Jobs with empty consumesFrom [] are root jobs that start immediately.'
                },
                baseBranch: { type: 'string', description: 'Override base branch (only for root jobs with no consumesFrom)' },
                prechecks: { 
                  type: 'string', 
                  description: 'Shell command to run before work (runs in cmd/sh, NOT PowerShell)' 
                },
                postchecks: { 
                  type: 'string', 
                  description: 'Shell command to run after work (runs in cmd/sh, NOT PowerShell)' 
                },
                instructions: { type: 'string', description: 'Additional context for @agent tasks (ignored for shell commands)' }
              },
              required: ['producer_id', 'task']
            }
          },
          subPlans: {
            type: 'array',
            description: 'Optional sub-plans. A sub-plan groups related jobs that run as a unit. Jobs in the parent plan can depend on a sub-plan by referencing its producer_id in consumesFrom.',
            items: {
              type: 'object',
              properties: {
                producer_id: { 
                  type: 'string', 
                  description: 'REQUIRED. Unique identifier for this sub-plan. Jobs that depend on this sub-plan use this value in their consumesFrom array. Format: lowercase letters, numbers, hyphens only, 5-64 characters.',
                  pattern: '^[a-z0-9-]{5,64}$'
                },
                name: { type: 'string', description: 'Optional human-friendly display name (defaults to producer_id if not provided)' },
                consumesFrom: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of producer_id values of jobs or sub-plans that must complete before this sub-plan starts.'
                },
                maxParallel: { type: 'number', description: 'Max concurrent jobs in sub-plan' },
                jobs: {
                  type: 'array',
                  description: 'Jobs within this sub-plan. Their consumesFrom references are scoped to other jobs within the same sub-plan.',
                  items: {
                    type: 'object',
                    properties: {
                      producer_id: { 
                        type: 'string', 
                        description: 'REQUIRED. Unique identifier for this job within the sub-plan. Format: lowercase letters, numbers, hyphens only, 5-64 characters.',
                        pattern: '^[a-z0-9-]{5,64}$'
                      },
                      name: { type: 'string', description: 'Optional display name' },
                      task: { type: 'string', description: 'Task description' },
                      work: { 
                        type: 'string', 
                        description: 'Shell command (runs in cmd/sh, NOT PowerShell) OR "@agent <task>" for Copilot' 
                      },
                      consumesFrom: { type: 'array', items: { type: 'string' }, description: 'Array of producer_id values of other jobs WITHIN THIS SUB-PLAN that this job depends on.' },
                      prechecks: { type: 'string', description: 'Shell command (runs in cmd/sh, NOT PowerShell)' },
                      postchecks: { type: 'string', description: 'Shell command (runs in cmd/sh, NOT PowerShell)' },
                      instructions: { type: 'string' }
                    },
                    required: ['producer_id', 'task']
                  }
                },
                subPlans: {
                  type: 'array',
                  description: 'Nested sub-plans (recursive)',
                  items: { type: 'object' }
                }
              },
              required: ['producer_id', 'jobs']
            }
          }
        },
        required: ['jobs']
      }
    },
    {
      name: 'get_copilot_plan_status',
      description: 'Get status of a plan including progress and individual job statuses. ' +
                   'IMPORTANT: Use the plan UUID returned from create_copilot_plan (planId field), not the plan name.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Plan UUID (the planId returned from create_copilot_plan, not the plan name or producer_id)' }
        },
        required: ['id']
      }
    },
    {
      name: 'list_copilot_plans',
      description: 'List all plans with their status. Returns plan UUIDs that can be used with get_copilot_plan_status.',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'cancel_copilot_plan',
      description: 'Cancel a running plan and all its jobs.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Plan UUID to cancel' }
        },
        required: ['id']
      }
    },
    {
      name: 'delete_copilot_plan',
      description: 'Delete a plan and optionally all its associated jobs.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Plan UUID to delete' },
          deleteJobs: { type: 'boolean', description: 'Whether to delete associated jobs (default: true)' }
        },
        required: ['id']
      }
    },
    {
      name: 'retry_copilot_plan',
      description: 'Retry a failed or partially completed plan. Re-queues failed jobs for execution while keeping completed work.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Plan ID to retry' }
        },
        required: ['id']
      }
    }
  ];
}
