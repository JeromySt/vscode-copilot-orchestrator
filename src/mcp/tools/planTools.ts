/**
 * @fileoverview Plan-related MCP tool definitions.
 * 
 * Defines the schema for all plan-related tools exposed via MCP.
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

/**
 * Get all plan-related tool definitions.
 */
export function getPlanToolDefinitions(): McpTool[] {
  return [
    {
      name: 'create_copilot_plan',
      description: 'Create a plan with multiple work units (jobs and optional sub-plans). Dependencies use a simple producer→consumer model: each work unit lists the IDs of other work units it consumes from (consumesFrom). Jobs run in parallel up to maxParallel, respecting consumesFrom order.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Plan ID (optional, auto-generated)' },
          name: { type: 'string', description: 'Human-readable plan name' },
          baseBranch: { type: 'string', description: 'Starting branch for the plan (default: main). Root jobs branch from here.' },
          targetBranch: { type: 'string', description: 'Optional branch to merge final results into' },
          maxParallel: { type: 'number', description: 'Max concurrent jobs (default: auto based on CPU)' },
          cleanUpSuccessfulWork: { type: 'boolean', description: 'Whether to clean up worktrees/branches after successful merges (default: true). When true, worktrees/branches are deleted immediately after a leaf merges to targetBranch, keeping local git state minimal.' },
          jobs: {
            type: 'array',
            description: 'Array of job specifications. Use consumesFrom to specify dependencies (producer→consumer model).',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique job ID within the plan' },
                name: { type: 'string', description: 'Job display name' },
                task: { type: 'string', description: 'Task description' },
                work: { type: 'string', description: 'Work command (use @agent for AI tasks)' },
                consumesFrom: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'IDs of work units (jobs or sub-plans) whose output is consumed by this job. Jobs with no consumesFrom are root jobs.'
                },
                baseBranch: { type: 'string', description: 'Override base branch (only for root jobs with no consumesFrom)' },
                prechecks: { type: 'string', description: 'Pre-check command' },
                postchecks: { type: 'string', description: 'Post-check command' },
                instructions: { type: 'string', description: 'Additional AI instructions' }
              },
              required: ['id', 'task']
            }
          },
          subPlans: {
            type: 'array',
            description: 'Optional sub-plans. A sub-plan is another work unit that can consume from jobs/sub-plans and can be consumed by other jobs/sub-plans.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique sub-plan ID within the parent plan' },
                name: { type: 'string', description: 'Sub-plan display name' },
                consumesFrom: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'IDs of work units (jobs or sub-plans) that must complete before this sub-plan starts.'
                },
                maxParallel: { type: 'number', description: 'Max concurrent jobs in sub-plan' },
                jobs: {
                  type: 'array',
                  description: 'Jobs within this sub-plan',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', description: 'Unique job ID within the sub-plan' },
                      name: { type: 'string', description: 'Job display name' },
                      task: { type: 'string', description: 'Task description' },
                      work: { type: 'string', description: 'Work command' },
                      consumesFrom: { type: 'array', items: { type: 'string' }, description: 'IDs of jobs within the sub-plan this job consumes from.' },
                      prechecks: { type: 'string' },
                      postchecks: { type: 'string' },
                      instructions: { type: 'string' }
                    },
                    required: ['id', 'task']
                  }
                },
                subPlans: {
                  type: 'array',
                  description: 'Nested sub-plans (recursive)',
                  items: { type: 'object' }
                }
              },
              required: ['id', 'jobs']
            }
          }
        },
        required: ['jobs']
      }
    },
    {
      name: 'get_copilot_plan_status',
      description: 'Get status of a plan including progress and individual job statuses.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Plan ID' }
        },
        required: ['id']
      }
    },
    {
      name: 'list_copilot_plans',
      description: 'List all plans with their status.',
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
          id: { type: 'string', description: 'Plan ID to cancel' }
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
          id: { type: 'string', description: 'Plan ID to delete' },
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
