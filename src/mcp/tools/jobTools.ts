/**
 * @fileoverview Job-related MCP tool definitions.
 * 
 * Defines the schema for all job-related tools exposed via MCP.
 * 
 * @module mcp/tools/jobTools
 */

import { McpTool } from '../types';

/**
 * Get all job-related tool definitions.
 */
export function getJobToolDefinitions(): McpTool[] {
  return [
    {
      name: 'create_copilot_job',
      description: 'Create a new orchestrator job in an isolated git worktree. The job will run prechecks, execute AI-assisted work, run postchecks, and merge changes back.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job ID (optional, auto-generated if not provided)' },
          name: { type: 'string', description: 'Human-readable job name' },
          task: { type: 'string', description: 'Task description for the AI agent' },
          repoPath: { type: 'string', description: 'Repository path (defaults to workspace)' },
          baseBranch: { type: 'string', description: 'Branch to start from (default: main)' },
          prechecks: { type: 'string', description: 'Pre-check command (e.g., "npm test")' },
          work: { type: 'string', description: 'Work command - use natural language for @agent delegation' },
          postchecks: { type: 'string', description: 'Post-check command (e.g., "npm run lint")' },
          instructions: { type: 'string', description: 'Additional AI instructions' }
        },
        required: ['task']
      }
    },
    {
      name: 'get_copilot_job_status',
      description: 'Get status of a job including progress, current step, and completion state.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job ID' }
        },
        required: ['id']
      }
    },
    {
      name: 'get_copilot_jobs_batch_status',
      description: 'Get status of multiple jobs at once. Efficient for monitoring parallel jobs.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'Array of job IDs' }
        },
        required: ['ids']
      }
    },
    {
      name: 'get_copilot_job_details',
      description: 'Get full job details including configuration, attempts, and work history.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job ID' }
        },
        required: ['id']
      }
    },
    {
      name: 'get_copilot_job_log_section',
      description: 'Get logs for a specific phase of a job (prechecks, work, commit, postchecks, mergeback, cleanup).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job ID' },
          section: { 
            type: 'string', 
            enum: ['prechecks', 'work', 'commit', 'postchecks', 'mergeback', 'cleanup', 'full'],
            description: 'Log section to retrieve' 
          }
        },
        required: ['id', 'section']
      }
    },
    {
      name: 'list_copilot_jobs',
      description: 'List all orchestrator jobs with their basic status.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['all', 'running', 'completed', 'failed'], description: 'Filter by status' }
        }
      }
    },
    {
      name: 'cancel_copilot_job',
      description: 'Cancel a running job. Kills any running processes and marks the job as canceled.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job ID to cancel' }
        },
        required: ['id']
      }
    },
    {
      name: 'retry_copilot_job',
      description: 'Retry a failed job, optionally with new instructions.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job ID to retry' },
          instructions: { type: 'string', description: 'New/updated instructions for the retry' }
        },
        required: ['id']
      }
    },
    {
      name: 'continue_copilot_job_work',
      description: 'Add more work to an existing job and re-run it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job ID' },
          work: { type: 'string', description: 'Additional work to perform' }
        },
        required: ['id', 'work']
      }
    },
    {
      name: 'delete_copilot_job',
      description: 'Delete a job and its logs. Cancels the job first if running.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job ID to delete' }
        },
        required: ['id']
      }
    },
    {
      name: 'delete_copilot_jobs',
      description: 'Delete multiple jobs at once.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { 
            type: 'array', 
            items: { type: 'string' },
            description: 'Array of job IDs to delete' 
          }
        },
        required: ['ids']
      }
    }
  ];
}
