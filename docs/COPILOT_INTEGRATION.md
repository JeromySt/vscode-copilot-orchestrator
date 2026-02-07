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

### Plan Creation

| Tool | Description |
|------|-------------|
| `create_copilot_plan` | Create a DAG of work nodes with dependencies |
| `create_copilot_job` | Create a single job (convenience wrapper) |

### Status & Queries

| Tool | Description |
|------|-------------|
| `get_copilot_plan_status` | Get plan execution status and progress |
| `list_copilot_plans` | List all plans with their status |
| `get_copilot_node_details` | Get details about a specific node |
| `get_copilot_node_logs` | Get execution logs for a node |
| `get_copilot_node_attempts` | Get all retry attempts for a node |

### Control

| Tool | Description |
|------|-------------|
| `cancel_copilot_plan` | Cancel a running plan |
| `delete_copilot_plan` | Delete a plan and its history |
| `retry_copilot_plan` | Retry failed nodes in a plan |
| `retry_copilot_plan_node` | Retry a specific node |
| `get_copilot_plan_node_failure_context` | Get failure details for retry |

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
1. Call `get_copilot_plan_node_failure_context` to get logs
2. Analyze the error
3. Suggest a `retry_copilot_plan_node` call with corrected work

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
