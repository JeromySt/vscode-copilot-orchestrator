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
      description: `Create a new orchestrator job in an isolated git worktree. The job will run prechecks, execute work, run postchecks, and merge changes back.

WORKTREE ISOLATION:
- The job runs in its own ISOLATED git worktree branched from baseBranch
- The worktree only contains committed state from the base branch
- The job must create any directories it needs - do not assume they exist
- After completion, changes are committed and merged back to the target branch

EXECUTION CONTEXT:
- All commands (prechecks, work, postchecks) execute in a SHELL PROCESS (cmd.exe on Windows, /bin/sh on Unix)
- Commands run in the worktree directory, NOT PowerShell - use shell syntax accordingly
- For AI-assisted work, prefix with "@agent" to delegate to GitHub Copilot CLI

WORK FIELD OPTIONS:
1. Shell command: Runs directly in shell (e.g., "npm run build", "python script.py")
2. @agent <task>: Delegates to GitHub Copilot CLI with natural language instructions

EXAMPLES:
- work: "npm run fix-lint" → Runs shell command directly
- work: "@agent Implement the login feature following the spec in docs/login.md" → Copilot handles it
- prechecks: "npm ci && npm run typecheck" → Shell commands for validation`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job ID (optional, auto-generated if not provided)' },
          name: { type: 'string', description: 'Human-readable job name' },
          task: { type: 'string', description: 'Task description (used as default work if work not specified)' },
          repoPath: { type: 'string', description: 'Repository path (defaults to workspace)' },
          baseBranch: { type: 'string', description: 'Branch to start from (default: main)' },
          prechecks: { 
            type: 'string', 
            description: 'Shell command to run before work (e.g., "npm ci && npm test"). Runs in cmd/sh, not PowerShell.' 
          },
          work: { 
            type: 'string', 
            description: 'Either a shell command OR "@agent <natural language task>" for Copilot delegation. Shell commands run in cmd.exe (Windows) or /bin/sh (Unix), NOT PowerShell.' 
          },
          postchecks: { 
            type: 'string', 
            description: 'Shell command to run after work (e.g., "npm run lint && npm test"). Runs in cmd/sh, not PowerShell.' 
          },
          instructions: { type: 'string', description: 'Additional context for @agent tasks (ignored for shell commands)' }
        },
        required: ['task']
      }
    },
    {
      name: 'get_copilot_job_status',
      description: 'Get status of a job. IMPORTANT: Use the job UUID, not the producer_id. ' +
                   'For plan jobs, get the UUID from create_copilot_plan response (jobIdMapping field) or list_copilot_jobs.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job UUID (not producer_id). Get from jobIdMapping in create_copilot_plan response or list_copilot_jobs.' }
        },
        required: ['id']
      }
    },
    {
      name: 'get_copilot_jobs_batch_status',
      description: 'Get status of multiple jobs at once. Efficient for monitoring parallel jobs. Use job UUIDs, not producer_ids.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'Array of job UUIDs (not producer_ids)' }
        },
        required: ['ids']
      }
    },
    {
      name: 'get_copilot_job_details',
      description: 'Get full job details including configuration, attempts, and work history. Use job UUID, not producer_id.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job UUID (not producer_id)' }
        },
        required: ['id']
      }
    },
    {
      name: 'get_copilot_job_log_section',
      description: 'Get logs for a specific phase of a job. Use job UUID, not producer_id.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job UUID (not producer_id)' },
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
      description: 'List all orchestrator jobs with their basic status. Returns job UUIDs that can be used with other job tools.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['all', 'running', 'completed', 'failed'], description: 'Filter by status' }
        }
      }
    },
    {
      name: 'cancel_copilot_job',
      description: 'Cancel a running job. Use job UUID, not producer_id.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job UUID to cancel' }
        },
        required: ['id']
      }
    },
    {
      name: 'retry_copilot_job',
      description: 'Retry a failed job. By default, analyzes previous logs to fix issues. Optionally provide new instructions for @agent tasks.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job ID to retry' },
          instructions: { 
            type: 'string', 
            description: 'New instructions for retry. For @agent work, use natural language. For shell commands, provide the updated shell command.' 
          }
        },
        required: ['id']
      }
    },
    {
      name: 'continue_copilot_job_work',
      description: 'Add more work to an existing job and re-run it. The new work is prepended to work history.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job ID' },
          work: { 
            type: 'string', 
            description: 'Additional work: shell command (runs in cmd/sh) OR "@agent <task>" for Copilot. Commands auto-prefix with @agent if no prefix given.' 
          }
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
