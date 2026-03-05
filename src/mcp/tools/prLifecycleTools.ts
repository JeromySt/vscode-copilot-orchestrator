/**
 * @fileoverview PR Lifecycle MCP Tool Definitions
 * 
 * Defines the schema for all PR lifecycle management tools exposed via MCP.
 * PR lifecycle management enables adoption, monitoring, and autonomous feedback
 * handling for pull requests across GitHub, GitHub Enterprise, and Azure DevOps.
 * 
 * @module mcp/tools/prLifecycleTools
 */

import { McpTool } from '../types';

/**
 * Return all PR Lifecycle MCP tool definitions.
 *
 * Each tool definition follows the MCP `tools/list` response schema:
 * `{ name, description, inputSchema }`. The descriptions are intentionally
 * verbose because they are surfaced directly to LLM clients as tool
 * documentation.
 *
 * Tools are grouped into four categories:
 * 1. **Discovery** – `list_available_prs`
 * 2. **Adoption** – `adopt_pr`
 * 3. **Queries** – `get_managed_pr`, `list_managed_prs`
 * 4. **Monitoring** – `start_pr_monitoring`, `stop_pr_monitoring`
 * 5. **Lifecycle** – `promote_pr`, `demote_pr`, `abandon_pr`, `remove_pr`
 *
 * @returns Array of {@link McpTool} definitions registered with the MCP server.
 *
 * @example
 * ```ts
 * const tools = await getPRLifecycleToolDefinitions();
 * // tools[0].name === 'list_available_prs'
 * ```
 */
export async function getPRLifecycleToolDefinitions(): Promise<McpTool[]> {
  return [
    // =========================================================================
    // PR DISCOVERY
    // =========================================================================
    {
      name: 'list_available_prs',
      description: `List available pull requests from the remote provider (GitHub, GitHub Enterprise, or Azure DevOps).

Retrieves PRs that exist on the remote repository. Results include an 'isManaged' flag
indicating whether each PR is already under lifecycle management.

USE CASES:
- Discover PRs that can be adopted for autonomous monitoring
- Check which PRs are already managed
- Find PRs targeting a specific branch

INPUTS:
- repoPath: Repository path to list PRs from (required)
- baseBranch: Optional filter by target branch
- state: Optional filter by PR state ('open', 'closed', 'all', default: 'open')
- limit: Optional limit on results (default: 30)

RETURNS:
Array of available PRs with:
- prNumber, title, baseBranch, headBranch
- author, state, url
- isManaged: true if already under lifecycle management

PLATFORM SUPPORT:
- GitHub (github.com)
- GitHub Enterprise Server
- Azure DevOps (dev.azure.com)`,
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: {
            type: 'string',
            description: 'Repository path to list PRs from'
          },
          baseBranch: {
            type: 'string',
            description: 'Optional filter by target branch'
          },
          state: {
            type: 'string',
            enum: ['open', 'closed', 'all'],
            description: 'Optional filter by PR state (default: open)'
          },
          limit: {
            type: 'number',
            description: 'Optional limit on number of results (default: 30)',
            minimum: 1,
            maximum: 100
          }
        },
        required: ['repoPath']
      }
    },

    // =========================================================================
    // PR ADOPTION
    // =========================================================================
    {
      name: 'adopt_pr',
      description: `Adopt an existing pull request for lifecycle management on GitHub, GitHub Enterprise, or Azure DevOps.

Takes ownership of an existing PR, creating a managed PR record. The PR transitions to
'adopted' status and can then be monitored for autonomous feedback handling.

USE CASES:
- Adopt a PR created externally (e.g., by a developer or other tool)
- Begin managing a PR from a previous release
- Take over monitoring of PRs created manually

WORKFLOW:
1. adopt_pr → returns managedPR with ID and status 'adopted'
2. start_pr_monitoring(id) → transitions to 'monitoring' status
3. PR is autonomously monitored for checks, comments, and alerts
4. Use promote_pr/demote_pr to adjust priority

INPUTS:
- prNumber: PR number to adopt (required)
- repoPath: Repository path where the PR exists (required)
- workingDirectory: Optional working directory for PR operations (defaults to repoPath)
- releaseId: Optional associated release ID
- priority: Optional priority tier (defaults to 0, higher = more important)

RETURNS:
On success: { success: true, managedPR: { id, prNumber, status, ... } }
On failure: { success: false, error: "<message>" }

PLATFORM SUPPORT:
- GitHub (github.com)
- GitHub Enterprise Server
- Azure DevOps (dev.azure.com)`,
      inputSchema: {
        type: 'object',
        properties: {
          prNumber: {
            type: 'number',
            description: 'PR number to adopt'
          },
          repoPath: {
            type: 'string',
            description: 'Repository path where the PR exists'
          },
          workingDirectory: {
            type: 'string',
            description: 'Optional working directory for PR operations (defaults to repoPath)'
          },
          releaseId: {
            type: 'string',
            description: 'Optional associated release ID'
          },
          priority: {
            type: 'number',
            description: 'Optional priority tier (defaults to 0, higher = more important)'
          }
        },
        required: ['prNumber', 'repoPath']
      }
    },

    // =========================================================================
    // PR QUERIES
    // =========================================================================
    {
      name: 'get_managed_pr',
      description: `Get details of a managed pull request.

Retrieves full details of a PR under lifecycle management, including status,
monitoring state, unresolved feedback, and timestamps.

RETURNS:
- id: Lifecycle manager ID
- prNumber: Provider PR number
- prUrl: Full URL to PR
- title, baseBranch, headBranch
- status: 'adopted', 'monitoring', 'addressing', 'ready', 'blocked', 'abandoned'
- providerType: 'github', 'github-enterprise', 'azure-devops'
- unresolvedComments, failingChecks, unresolvedAlerts
- adoptedAt, monitoringStartedAt, completedAt timestamps

PLATFORM SUPPORT: GitHub, GitHub Enterprise, Azure DevOps`,
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Managed PR ID (from lifecycle manager)'
          }
        },
        required: ['id']
      }
    },

    {
      name: 'list_managed_prs',
      description: `List all managed pull requests, optionally filtered by status.

Returns an array of all PRs under lifecycle management with their current state.

STATUS VALUES:
- adopted: PR adopted but monitoring not started
- monitoring: Actively monitoring for feedback
- addressing: Autonomously addressing PR feedback
- ready: All checks passed, ready to merge
- blocked: Failing checks or unresolved feedback
- abandoned: Management stopped

PLATFORM SUPPORT: GitHub, GitHub Enterprise, Azure DevOps`,
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['adopted', 'monitoring', 'addressing', 'ready', 'blocked', 'abandoned'],
            description: 'Optional filter by status'
          }
        }
      }
    },

    // =========================================================================
    // PR MONITORING
    // =========================================================================
    {
      name: 'start_pr_monitoring',
      description: `Start monitoring a managed pull request for autonomous feedback handling.

Transitions the PR from 'adopted' to 'monitoring' status and begins periodic polling
for CI checks, review comments, and security alerts. Autonomous feedback handling
is enabled.

MONITORING INCLUDES:
- CI/CD check status (build, test, lint failures)
- Review comments (inline and general)
- Security alerts (CodeQL, Dependabot, etc.)
- PR status changes (draft, ready for review, etc.)

When issues are detected, the PR transitions to 'addressing' status and orchestrates
autonomous resolution via Copilot agents.

PLATFORM SUPPORT: GitHub, GitHub Enterprise, Azure DevOps`,
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Managed PR ID to start monitoring'
          }
        },
        required: ['id']
      }
    },

    {
      name: 'stop_pr_monitoring',
      description: `Stop monitoring a managed pull request.

Halts periodic polling and autonomous feedback handling without abandoning the PR.
The PR remains in the managed list but transitions back to 'adopted' status.

Use this to temporarily pause monitoring while retaining PR management.
To fully abandon a PR, use abandon_pr instead.

PLATFORM SUPPORT: GitHub, GitHub Enterprise, Azure DevOps`,
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Managed PR ID to stop monitoring'
          }
        },
        required: ['id']
      }
    },

    // =========================================================================
    // PR LIFECYCLE OPERATIONS
    // =========================================================================
    {
      name: 'promote_pr',
      description: `Promote a managed pull request to a higher priority tier.

Increases the PR's priority value, which may affect:
- Monitoring poll frequency
- Scheduling for autonomous feedback handling
- Display ordering in UI

Priority is a numeric value (higher = more important). Each promotion increments
the priority by 1.

PLATFORM SUPPORT: GitHub, GitHub Enterprise, Azure DevOps`,
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Managed PR ID to promote'
          }
        },
        required: ['id']
      }
    },

    {
      name: 'demote_pr',
      description: `Demote a managed pull request to a lower priority tier.

Decreases the PR's priority value (minimum 0), which may affect:
- Monitoring poll frequency
- Scheduling for autonomous feedback handling
- Display ordering in UI

PLATFORM SUPPORT: GitHub, GitHub Enterprise, Azure DevOps`,
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Managed PR ID to demote'
          }
        },
        required: ['id']
      }
    },

    {
      name: 'abandon_pr',
      description: `Abandon a managed pull request.

Stops all monitoring and transitions the PR to 'abandoned' status. The PR remains
in the managed list for historical records but is no longer actively managed.

The PR itself is closed on the remote provider with a comment indicating it was
abandoned by the orchestrator.

Use this when a PR should no longer be pursued. To completely remove a PR from
management (e.g., after merge), use remove_pr instead.

PLATFORM SUPPORT: GitHub, GitHub Enterprise, Azure DevOps`,
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Managed PR ID to abandon'
          }
        },
        required: ['id']
      }
    },

    {
      name: 'remove_pr',
      description: `Remove a managed pull request from lifecycle management.

Completely removes the PR from management. This is typically used for cleanup
after a PR has been merged or closed externally.

Unlike abandon_pr, this does NOT close the PR on the remote provider - it only
stops managing it. The PR record is deleted from local storage.

PLATFORM SUPPORT: GitHub, GitHub Enterprise, Azure DevOps`,
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Managed PR ID to remove from management'
          }
        },
        required: ['id']
      }
    }
  ];
}
