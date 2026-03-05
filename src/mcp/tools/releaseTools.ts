/**
 * @fileoverview Release MCP Tool Definitions
 * 
 * Defines the schema for all Release-related tools exposed via MCP.
 * Releases aggregate multiple plan commits into a single PR for review and merge.
 * 
 * @module mcp/tools/releaseTools
 */

import { McpTool } from '../types';

/**
 * Return all Release-related MCP tool definitions.
 *
 * Each tool definition follows the MCP `tools/list` response schema:
 * `{ name, description, inputSchema }`.  The descriptions are intentionally
 * verbose because they are surfaced directly to LLM clients as tool
 * documentation.
 *
 * Tools are grouped into three categories:
 * 1. **Creation** – `create_copilot_release`
 * 2. **Control** – `start_copilot_release`, `cancel_copilot_release`
 * 3. **Status & Queries** – `get_copilot_release_status`, `list_copilot_releases`
 *
 * @returns Array of {@link McpTool} definitions registered with the MCP server.
 *
 * @example
 * ```ts
 * const tools = await getReleaseToolDefinitions();
 * // tools[0].name === 'create_copilot_release'
 * ```
 */
export async function getReleaseToolDefinitions(): Promise<McpTool[]> {
  return [
    // =========================================================================
    // Release CREATION
    // =========================================================================
    {
      name: 'create_copilot_release',
      description: `Create a multi-plan release for GitHub, GitHub Enterprise, or Azure DevOps.

A release merges commits from multiple successful plans into a single release branch,
creates a pull request, monitors it for feedback (CI failures, review comments, security alerts),
and autonomously addresses issues until the PR is merged.

USE CASES:
- Combine multiple related feature plans into a single PR
- Aggregate bug fixes from separate plans
- Create a version release from multiple improvement plans

WORKFLOW:
1. create_copilot_release → returns releaseId
2. start_copilot_release(releaseId) → begins execution
3. get_copilot_release_status(releaseId) → monitor progress
4. Release autonomously addresses PR feedback until merged

INPUTS:
- name: Human-friendly release name (e.g., "v1.2.0 Release")
- planIds: Array of plan IDs to include (all must be succeeded/partial status)
- releaseBranch: Branch name for the release (e.g., "release/v1.2.0")
- targetBranch: Target branch for the PR (defaults to "main")
- autoStart: If true, starts release execution immediately (defaults to false)

EXAMPLE:
{
  "name": "v1.2.0 Release",
  "planIds": ["plan-abc-123", "plan-def-456", "plan-ghi-789"],
  "releaseBranch": "release/v1.2.0",
  "targetBranch": "main",
  "autoStart": true
}

PLATFORM SUPPORT:
- GitHub (github.com)
- GitHub Enterprise Server
- Azure DevOps (dev.azure.com)

The release will automatically detect the platform and use the appropriate PR service.`,
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Human-friendly name for the release (e.g., "v1.2.0 Release")'
          },
          planIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Plan IDs to include in the release (all must be succeeded or partial)',
            minItems: 1
          },
          releaseBranch: {
            type: 'string',
            description: 'Branch name for the release (e.g., "release/v1.2.0")'
          },
          targetBranch: {
            type: 'string',
            description: 'Target branch for the PR (defaults to "main")'
          },
          autoStart: {
            type: 'boolean',
            description: 'If true, starts release execution immediately (defaults to false)'
          }
        },
        required: ['name', 'planIds', 'releaseBranch']
      }
    },

    // =========================================================================
    // Release CONTROL
    // =========================================================================
    {
      name: 'start_copilot_release',
      description: `Start executing a release.

Transitions the release through:
1. merging - Merge all plan commits into the release branch
2. creating-pr - Create pull request
3. monitoring - Monitor PR for CI checks, reviews, security alerts
4. addressing - Autonomously address feedback until PR is merged
5. succeeded - PR merged successfully

The release runs autonomously until the PR is merged or an unrecoverable error occurs.

PLATFORM SUPPORT: GitHub, GitHub Enterprise, Azure DevOps`,
      inputSchema: {
        type: 'object',
        properties: {
          releaseId: {
            type: 'string',
            description: 'Release ID to start'
          }
        },
        required: ['releaseId']
      }
    },

    {
      name: 'cancel_copilot_release',
      description: `Cancel an in-progress release.

Stops release execution and transitions to 'canceled' status.
The release branch and any created PR are preserved.

Only releases in non-terminal status can be canceled.

PLATFORM SUPPORT: GitHub, GitHub Enterprise, Azure DevOps`,
      inputSchema: {
        type: 'object',
        properties: {
          releaseId: {
            type: 'string',
            description: 'Release ID to cancel'
          }
        },
        required: ['releaseId']
      }
    },

    // =========================================================================
    // Release STATUS & QUERIES
    // =========================================================================
    {
      name: 'get_copilot_release_status',
      description: `Get detailed status and progress for a release.

Returns:
- Release definition (id, name, planIds, branches, status)
- Progress information (merge results, PR details, monitoring state)
- Timestamps (created, started, ended)
- Error messages if failed

STATUS VALUES:
- drafting: Release is being configured
- merging: Merging plan commits into release branch
- creating-pr: Creating pull request
- monitoring: Monitoring PR for feedback
- addressing: Addressing PR feedback
- succeeded: Release PR merged successfully
- failed: Release process failed
- canceled: Release was canceled

PLATFORM SUPPORT: GitHub, GitHub Enterprise, Azure DevOps`,
      inputSchema: {
        type: 'object',
        properties: {
          releaseId: {
            type: 'string',
            description: 'Release ID to query'
          }
        },
        required: ['releaseId']
      }
    },

    {
      name: 'list_copilot_releases',
      description: `List all releases.

Returns an array of all release definitions with their current status.
Results can be filtered by status if needed.

Useful for:
- Finding a release by name
- Checking active releases
- Viewing release history

PLATFORM SUPPORT: GitHub, GitHub Enterprise, Azure DevOps`,
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['drafting', 'merging', 'creating-pr', 'monitoring', 'addressing', 'succeeded', 'failed', 'canceled'],
            description: 'Filter releases by status (optional)'
          }
        }
      }
    }
  ];
}
