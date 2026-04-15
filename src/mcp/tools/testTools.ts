/**
 * @fileoverview Integration test MCP tool definitions.
 *
 * Defines the schema for the integration test tool that creates a comprehensive
 * plan exercising all orchestrator behaviors with scripted process output.
 *
 * @module mcp/tools/testTools
 */

import { McpTool } from '../types';

/**
 * Return integration-test MCP tool definitions.
 *
 * @returns Array of {@link McpTool} definitions.
 */
export function getTestToolDefinitions(): McpTool[] {
  return [
    {
      name: 'run_copilot_integration_test',
      description: `Create and optionally start a comprehensive integration test plan that exercises ALL orchestrator behaviors with scripted (fake) process output. No real agent/CLI processes are spawned — all output is pre-recorded and deterministic.

WHAT GETS TESTED:
- Shell execution (ShellSpec) — success path
- Agent execution (AgentSpec) — full handler coverage: SessionIdHandler, StatsHandler, TaskCompleteHandler
- Process execution (ProcessSpec) — direct executable invocation
- Context pressure — rising token usage triggers ContextPressureHandler
- Auto-heal — job fails on attempt 1, succeeds on retry with fresh session
- Permanent failure — job always fails, downstream jobs become blocked
- Postcheck failure + recovery — work succeeds but tests fail, auto-heal fixes it
- No-changes path — expectsNoChanges=true, commit phase skips
- Fan-in dependency merge — final job waits for all parallel jobs
- State transitions — pending → ready → scheduled → running → succeeded/failed/blocked/canceled

The plan is created paused by default. Use resume_copilot_plan to start execution and observe all behaviors in the plan panel UI.`,
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Custom name for the test plan (default: "Full Integration Test Plan")',
          },
          baseBranch: {
            type: 'string',
            description: 'Base branch to create worktrees from (default: current branch or "main")',
          },
          targetBranch: {
            type: 'string',
            description: 'Target branch for RI merges (auto-generated if not specified)',
          },
          maxParallel: {
            type: 'number',
            description: 'Maximum parallel jobs (default: 4)',
            minimum: 1,
            maximum: 8,
          },
          startPaused: {
            type: 'boolean',
            description: 'Whether to start the plan paused (default: true). Set false to start immediately.',
          },
        },
        required: [],
      },
    },
  ];
}
