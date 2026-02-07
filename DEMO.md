# Copilot Orchestrator - Demo Guide

## What is Copilot Orchestrator?

A VS Code extension that enables parallel, isolated job execution using git worktrees and background agents. Perfect for delegating multiple tasks to AI agents simultaneously.

## Quick Start Demo

### 1. Open the Copilot Jobs Panel

- Click the **Copilot** icon in the Activity Bar (left sidebar)
- You'll see the **Jobs** panel with "No jobs yet"

### 2. Create Your First Job

Press `Ctrl+Shift+P` and run:
```
Copilot Orchestrator: Start Job
```

**Example inputs:**
- Base branch: `main`
- Target branch: `feature/add-logging`

### 3. View Job Progress

- Jobs appear in the **Copilot: Jobs** panel
- Monitor status: queued → running → succeeded/failed
- Status bar shows: `Orchestrator: idle` or `MCP: running @ 127.0.0.1:39217`

### 4. Open the Dashboard

Run command:
```
Copilot Orchestrator: Open Dashboard
```

Shows detailed job information with timestamps and logs.

## Architecture Overview

### Key Components

1. **Job Runner** (`src/core/jobRunner.ts`)
   - Manages job queue and parallel execution
   - Creates isolated git worktrees for each job
   - Handles auto-merging completed work

2. **MCP Handler** (`src/mcp/mcpHandler.ts`)
   - Model Context Protocol (HTTP transport)
   - MCP endpoint at `/mcp`
   - REST API for direct integration

3. **HTTP Server** (`src/httpServer.ts`)
   - Runs on localhost:39219 by default
   - Serves both MCP and REST endpoints

4. **Git Worktrees** (`src/git/core/worktrees.ts`)
   - Isolates each job in separate working directory
   - Prevents conflicts between parallel jobs
   - Uses symlinks for submodules (fast setup)
   - Auto-cleanup after merge

5. **Views & UI**
   - Activity Bar icon for quick access
   - WebView panel for job monitoring
   - Status bar integration

## Demo Scenarios

### Scenario 1: Parallel Feature Development

Create 3 jobs simultaneously:

```bash
# Job 1: Add authentication
Branch: feature/add-auth

# Job 2: Improve error handling  
Branch: feature/error-handling

# Job 3: Add unit tests
Branch: feature/unit-tests
```

Each runs in parallel with isolated worktrees!

### Scenario 2: MCP Integration

With MCP server running, external agents can:

```bash
# Delegate work via HTTP
POST http://localhost:39217/jobs
{
  "task": "Refactor authentication module",
  "baseBranch": "main",
  "targetBranch": "refactor/auth"
}
```

### Scenario 3: Automated Workflows

Jobs follow configurable steps:
- **Prechecks**: `npm run lint`
- **Work**: Copilot CLI or custom scripts
- **Postchecks**: `npm test`
- **Auto-merge**: On success

## Commands Reference

| Command | Description |
|---------|-------------|
| `Copilot Orchestrator: Start Job` | Create new background job |
| `Copilot Orchestrator: Open Dashboard` | View detailed job status |
| `Copilot Orchestrator: Cancel Job` | Stop running job |
| `Copilot Orchestrator: Resolve Conflicts` | Handle merge conflicts |
| `Copilot Orchestrator: Check Copilot CLI` | Verify CLI installation |

## Configuration Files

### `.orchestrator/config.json`
```json
{
  "maxWorkers": 3,           // Parallel job limit
  "worktreeRoot": ".worktrees",
  "http": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 39217
  }
}
```

### `.orchestrator/merge.json`
```json
{
  "mode": "merge",           // or "rebase", "ff-only"
  "prefer": "theirs",        // or "ours"
  "autoResolve": [
    {
      "glob": ["**/*.md"],
      "prefer": "theirs"
    }
  ]
}
```

## MCP Server API

When enabled, the MCP server exposes:

- `GET /status` - Server health check
- `GET /jobs` - List all jobs
- `POST /jobs` - Create new job
- `GET /jobs/:id` - Get job details
- `DELETE /jobs/:id` - Cancel job

## Tips for Best Demo

1. **Show parallel execution**: Start 2-3 jobs at once
2. **Monitor the panel**: Watch status changes in real-time
3. **Demonstrate isolation**: Make conflicting changes in different jobs
4. **Auto-merge**: Show successful merge-back workflow
5. **MCP integration**: Use curl/Postman to hit the API

## Publishing to Marketplace

To make this available for others:

1. Update `package.json` publisher field
2. Create VS Code Marketplace account
3. Run: `vsce package`
4. Run: `vsce publish`

## Next Steps

- Add job templates for common workflows
- Implement job scheduling and priorities
- Add Slack/Teams notifications
- Create job history and analytics
- Support for non-git workflows
