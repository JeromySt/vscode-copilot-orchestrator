# GitHub Copilot Integration Guide

## Overview

The Copilot Orchestrator integrates with GitHub Copilot via the Model Context Protocol (MCP).
The MCP server auto-registers with VS Code and provides tools that Copilot can use to create
and manage parallel work plans.

## Getting Started

### 1. Start the MCP Server

The MCP server must be running for Copilot to use orchestrator tools:

1. Open the Command Palette (`Ctrl+Shift+P`)
2. Run **MCP: List Servers**
3. Find "Copilot Orchestrator" and click **Start**

Alternatively:
- Run command **Copilot Orchestrator: MCP – How to Connect**
- Select **Start Server**

### 2. Verify Connection

Once started, the orchestrator tools appear in Copilot Chat's tool selection.
Ask Copilot to list plans to verify:

```
@workspace Use list_copilot_plans to show all plans
```

## Available MCP Tools

The orchestrator exposes two API surfaces: the **plan-based API** (legacy, full-featured)
and the **node-centric API** (simplified, no plan/group ID required for lookups).

### Plan-Based API (Legacy)

#### Plan Creation

| Tool | Description |
|------|-------------|
| `create_copilot_plan` | Create a DAG of work nodes with dependencies and optional groups |
| `create_copilot_job` | Create a single job (convenience wrapper — internally becomes a one-node plan) |

#### Status & Queries

| Tool | Description |
|------|-------------|
| `get_copilot_plan_status` | Get plan execution status, progress, and per-node states |
| `list_copilot_plans` | List all plans with their status (optionally filter by status) |
| `get_copilot_node_details` | Get details about a specific node by plan ID + node ID |
| `get_copilot_node_logs` | Get execution logs for a node, filterable by phase (`prechecks`, `work`, `postchecks`, `commit`, `all`) |
| `get_copilot_node_attempts` | Get all retry attempts for a node with timestamps, errors, and per-phase step statuses |

#### Control

| Tool | Description |
|------|-------------|
| `cancel_copilot_plan` | Cancel a running plan and all its jobs |
| `delete_copilot_plan` | Delete a plan and its history |
| `retry_copilot_plan` | Retry all failed nodes (or specific nodes) in a plan, with optional replacement work |
| `retry_copilot_plan_node` | Retry a single failed node with optional replacement work |
| `get_copilot_plan_node_failure_context` | Get failure details including logs, failed phase, error message, and worktree path |

### Node-Centric API

These tools provide a simplified interface where nodes are looked up globally — no
plan or group ID is required for queries and control operations.

#### Node Creation

| Tool | Description |
|------|-------------|
| `create_copilot_node` | Create one or more work nodes with dependencies and optional visual grouping |

#### Status & Queries

| Tool | Description |
|------|-------------|
| `get_copilot_node` | Get detailed information about a node (global lookup by UUID or producer_id) |
| `list_copilot_nodes` | List nodes with optional filters by group ID, group name, or status |

#### Control

| Tool | Description |
|------|-------------|
| `retry_copilot_node` | Retry a specific failed node (global lookup, no plan ID needed) |
| `get_copilot_node_failure_context` | Get failure context for a node (global lookup, no plan ID needed) |

### Model Selection

Both `create_copilot_plan` and `create_copilot_node` support a `model` property on each node, allowing you to choose which LLM runs the agent work. Models are dynamically discovered from the installed Copilot CLI and organized into three tiers:

| Tier | Keywords | Use Case |
|------|----------|----------|
| **Fast** | `mini`, `haiku` | Simple tasks: lint checks, formatting, quick fixes |
| **Standard** | `sonnet`, `gpt-5` | General-purpose work: feature implementation, tests |
| **Premium** | `opus`, `max` | Complex reasoning: large refactors, architecture changes |

The `model` property can be set at the node level or inside an agent work object:

```json
{
  "nodes": [
    {
      "producer_id": "lint",
      "task": "Run lint",
      "work": "npm run lint",
      "model": "claude-haiku-4.5"
    },
    {
      "producer_id": "refactor",
      "task": "Refactor auth module",
      "work": {
        "type": "agent",
        "instructions": "# Refactor auth\n\n1. Extract token logic\n2. Add refresh support",
        "model": "claude-opus-4.6"
      },
      "dependencies": ["lint"]
    }
  ]
}
```

> **Note:** Available models are discovered at runtime via `copilot --help` and cached for one hour. The enum in the MCP tool schema always reflects the currently installed models.

## Default Branch Protection

When the `baseBranch` is a **default branch** (e.g., `main` or `master`), the orchestrator
automatically creates a feature branch instead of committing directly to it. This prevents
accidental modifications to your primary branch.

**How it works:**

1. The orchestrator detects the repository's default branch via `origin/HEAD`, then
   `init.defaultBranch` git config, and finally falls back to `main` / `master`.
2. If `baseBranch` matches the default branch, a new feature branch is created under
   the `copilot_plan/<uuid>` namespace.
3. If `baseBranch` is a non-default branch (e.g., `feature/my-work`), it is used as-is.

**Example:**

| `baseBranch` | Behavior |
|---|---|
| `main` (default) | Auto-creates `copilot_plan/<uuid>` branch |
| `master` (default) | Auto-creates `copilot_plan/<uuid>` branch |
| `feature/auth` | Uses `feature/auth` directly |

This means you can safely pass `baseBranch: "main"` — the orchestrator will never commit
directly to your default branch.

## Example Usage

### Creating a Simple Plan

Ask Copilot to create a two-step build and test plan:

```
@workspace Create a plan called "Build & Test" with two jobs:
1. "build" that runs "npm run build" with no dependencies
2. "test" that runs "npm test" and depends on "build"
```

Copilot will call `create_copilot_plan` with:
```json
{
  "name": "Build & Test",
  "jobs": [
    { "producer_id": "build", "task": "Build", "work": "npm run build", "dependencies": [] },
    { "producer_id": "test", "task": "Test", "work": "npm test", "dependencies": ["build"] }
  ]
}
```

### Using the Node-Centric API

The same plan can be created with the node-centric API:

```
@workspace Create nodes for a build and test pipeline
```

Copilot will call `create_copilot_node` with:
```json
{
  "nodes": [
    { "producer_id": "build", "task": "Build the project", "work": "npm run build", "dependencies": [] },
    { "producer_id": "test", "task": "Run tests", "work": "npm test", "dependencies": ["build"] }
  ]
}
```

With the node-centric API, subsequent queries are simpler — no plan ID needed:

```
@workspace What's the status of the "build" node?
```

Copilot calls `get_copilot_node` with `{ "node_id": "build" }`.

### Checking Plan Status

```
@workspace What's the status of the "Build & Test" plan?
```

Copilot will call `get_copilot_plan_status` to show progress.

### Handling Failures

When a job fails, ask Copilot to investigate:

```
@workspace The build job failed. Get the failure context and suggest a fix.
```

Copilot will:
1. Call `get_copilot_plan_node_failure_context` (or `get_copilot_node_failure_context`) to get logs
2. Analyze the error
3. Suggest a `retry_copilot_plan_node` (or `retry_copilot_node`) call with corrected work

### Retrying with Replacement Work

You can retry a failed node with new work instructions:

```
@workspace Retry the build node with "npm run build -- --verbose" instead
```

Copilot will call `retry_copilot_node` with:
```json
{
  "node_id": "build",
  "newWork": "npm run build -- --verbose"
}
```

For agent work, you can resume the existing Copilot session or start fresh:
```json
{
  "node_id": "refactor-auth",
  "newWork": {
    "type": "agent",
    "instructions": "# Fix Build\n\n1. Check the error in tsconfig.json\n2. Fix the missing import",
    "resumeSession": true
  }
}
```

## Using Agent Work

Jobs can delegate complex work to Copilot CLI agents:

```
@workspace Create a job that uses an agent to implement error handling in auth.ts
```

Copilot creates a job with agent work:
```json
{
  "name": "Add Error Handling",
  "task": "Implement error handling in auth.ts",
  "work": "@agent Implement comprehensive error handling in src/auth.ts"
}
```

The agent runs in an isolated git worktree and commits its changes.

## Commit Validation

### No-Change Commits and AI Review

Some nodes legitimately produce no file changes — for example, a lint check that passes or a test suite that succeeds. The orchestrator handles this through two complementary mechanisms:

1. **`expectsNoChanges: true`** — Explicitly declares that a node is not expected to produce file changes. When the node completes without modifications, it succeeds immediately without requiring a commit.

2. **AI review** — When a node produces no changes and `expectsNoChanges` is not set, the orchestrator invokes an AI agent to review the execution logs and determine whether the absence of changes is legitimate (e.g., "all tests passed") or indicates a failure (e.g., the agent forgot to save files).

These are evaluated in priority order: evidence files first, then `expectsNoChanges`, then AI review. This ensures validation nodes like type-checking or linting can be modeled naturally in a plan without false failures.

### Usage Statistics

Node execution captures AI usage metrics, which are visible in the node detail panel:

- **Timing:** total duration, API time, session time
- **Token usage:** input, output, and cached tokens per model
- **Activity:** premium requests, agent turns, tool calls
- **Code changes:** lines added and removed

Metrics are aggregated across all phases (prechecks, work, postchecks) and broken down by model in the `modelBreakdown` array.

## Configuration

### Disable MCP Server

If you don't want the MCP server to auto-register:

```json
{
  "copilotOrchestrator.mcp.enabled": false
}
```

## Troubleshooting

### MCP Server Not Appearing

1. Ensure VS Code 1.99+ is installed
2. Check that GitHub Copilot extension is enabled
3. Verify `copilotOrchestrator.mcp.enabled` is `true`
4. Check the Output panel for errors (select "Copilot Orchestrator")

### Tools Not Available in Copilot

1. Verify the MCP server is started (MCP: List Servers)
2. Restart the MCP server from the list
3. Check for errors in the Output panel

### Server Start Fails

1. Ensure a workspace folder is open
2. Check that the folder is a git repository
3. Look for error messages in the Output panel
