/**
 * @fileoverview Job MCP Tool Definitions
 *
 * Defines the schema for all job-centric MCP tools.
 * These are the new simplified API alongside the legacy plan tools.
 *
 * @module mcp/tools/jobTools
 */

import { McpTool } from '../types';
import { discoverAvailableModelsLegacy } from '../../agent/modelDiscovery';

/**
 * Return all job-centric MCP tool definitions.
 *
 * Tools are grouped into three categories:
 * 1. **Status & Queries** – `get_copilot_job`, `list_copilot_jobs`
 * 2. **Control** – `retry_copilot_job`, `get_copilot_job_failure_context`
 *
 * @returns Array of {@link McpTool} definitions.
 */
export async function getJobToolDefinitions(): Promise<McpTool[]> {
  const modelResult = await discoverAvailableModelsLegacy();
  const modelEnum = modelResult.rawChoices.length > 0
    ? modelResult.rawChoices
    : ['gpt-5', 'claude-sonnet-4.5'];

  return [
    // =========================================================================
    // STATUS & QUERIES
    // =========================================================================
    {
      name: 'get_copilot_job',
      description: 'Get detailed information about a specific job. No group/plan ID required — jobs are looked up globally.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: {
            type: 'string',
            description: 'Job UUID or producerId'
          }
        },
        required: ['jobId']
      }
    },

    {
      name: 'list_copilot_jobs',
      description: 'List jobs with optional filters by group or status.',
      inputSchema: {
        type: 'object',
        properties: {
          groupId: {
            type: 'string',
            description: 'Filter by group ID'
          },
          status: {
            type: 'string',
            enum: ['pending', 'ready', 'scheduled', 'running', 'succeeded', 'failed', 'blocked', 'canceled'],
            description: 'Filter by job status'
          },
          groupName: {
            type: 'string',
            description: 'Filter by group name (partial match)'
          }
        }
      }
    },

    // =========================================================================
    // CONTROL
    // =========================================================================
    {
      name: 'retry_copilot_job',
      description: `Retry a specific failed job. No group/plan ID required.

The job must be in 'failed' state to be retried.

WORKFLOW:
1. Use get_copilot_job_failure_context to analyze the failure
2. Call retry_copilot_job with optional newWork
3. Monitor with get_copilot_job`,
      inputSchema: {
        type: 'object',
        properties: {
          jobId: {
            type: 'string',
            description: 'Job ID to retry'
          },
          newWork: {
            description: 'Optional replacement work for the retry'
          },
          clearWorktree: {
            type: 'boolean',
            description: 'Reset worktree to base commit before retry (default: false)'
          }
        },
        required: ['jobId']
      }
    },

    {
      name: 'force_fail_copilot_job',
      description: `Force a stuck running job to failed state.

Use this when a job's process has crashed or hung but the job is still 
showing as "running" or "scheduled". This allows the job to be retried.

Only works on jobs in 'running' or 'scheduled' state.`,
      inputSchema: {
        type: 'object',
        properties: {
          jobId: {
            type: 'string',
            description: 'Job ID to force fail'
          },
          reason: {
            type: 'string',
            description: 'Optional reason for the forced failure (for logging)'
          }
        },
        required: ['jobId']
      }
    },

    {
      name: 'get_copilot_job_failure_context',
      description: `Get detailed failure context for a failed job. No group/plan ID required.

Returns:
- Execution logs from the failed attempt
- Which phase failed
- Error message
- Copilot session ID (if agent work was involved)
- Worktree path (for manual inspection)`,
      inputSchema: {
        type: 'object',
        properties: {
          jobId: {
            type: 'string',
            description: 'Job ID to get failure context for'
          }
        },
        required: ['jobId']
      }
    },

    {
      name: 'update_copilot_plan_job',
      description: `Update a job's job specification. Any provided stage (prechecks, work, postchecks) will replace the existing definition and reset execution to re-run from that stage.
For topology changes (add/remove jobs, change dependencies), use reshape_copilot_plan instead.

RESTRICTIONS:
- Cannot update a job that is currently running (wait for completion or force-fail first)
- Cannot update dependencies/consumesFrom (use a new plan for structural changes)
- The "Snapshot Validation" job (producerId: __snapshot-validation__) is auto-managed and cannot be updated

WORKFLOW:
1. Provide planId and jobId to identify the job
2. Specify which stages to update (prechecks, work, postchecks)
3. Optionally set resetToStage to control execution restart point
4. Updated stages will replace existing definitions completely
5. Execution resets to the earliest updated stage (or resetToStage if specified)

STAGE DEFINITIONS:
Each stage (prechecks/work/postchecks) can be:
1. String: "npm run test" or "@agent Check implementation"
2. Process spec: { "type": "process", "executable": "node", "args": ["test.js"] }
3. Shell spec: { "type": "shell", "command": "Get-ChildItem", "shell": "powershell" }
4. Agent spec: { "type": "agent", "instructions": "# Task\\n1. Validate code", "model": "${modelEnum[0]}" }`,
      inputSchema: {
        type: 'object',
        properties: {
          planId: {
            type: 'string',
            description: 'The plan ID'
          },
          jobId: {
            type: 'string',
            description: 'The job ID to update'
          },
          prechecks: {
            description: `New prechecks definition. If provided, prechecks will be re-run.
Can be string or object with type (process/shell/agent).`
          },
          work: {
            description: `New work definition. If provided, work stage will be re-run.
Can be string or object with type (process/shell/agent).`
          },
          postchecks: {
            description: `New postchecks definition. If provided, postchecks will be re-run.
Can be string or object with type (process/shell/agent).`
          },
          resetToStage: {
            type: 'string',
            enum: ['prechecks', 'work', 'postchecks'],
            description: 'Explicitly reset execution to start from this stage. If not provided, resets to the earliest updated stage.'
          }
        },
        required: ['planId', 'jobId']
      }
    },
  ];
}
