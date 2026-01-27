# Copilot Orchestrator for Visual Studio Code

<p align="center">
  <img src="media/copilot-icon.png" alt="Copilot Orchestrator" width="128" height="128">
</p>

<p align="center">
  <strong>🚀 Orchestrate parallel GitHub Copilot agents in isolated git worktrees</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#mcp-integration">MCP Integration</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#api-reference">API Reference</a>
</p>

---

## Overview

**Copilot Orchestrator** supercharges your GitHub Copilot workflow by enabling **parallel AI-powered development**. Delegate complex tasks to multiple AI agents running simultaneously in isolated git worktrees, while maintaining clean git history with automated workflows.

### Why Copilot Orchestrator?

| Feature | Benefit |
|---------|---------|
| 🚀 **Parallel Execution** | Run multiple Copilot agents on different tasks simultaneously |
| 🔀 **Git Worktree Isolation** | Each job works in its own isolated branch—no conflicts |
| ⚡ **Automated Pipelines** | Pre-checks → AI Work → Post-checks → Auto-merge |
| 🤖 **Native Copilot Integration** | Works seamlessly with GitHub Copilot Chat via MCP |
| 📊 **Real-time Monitoring** | Track all jobs in a dedicated sidebar with live progress |
| 🔄 **Smart Retries** | AI-guided retry with automatic failure analysis |

---

## Features

### 🎯 Job-Based Workflow

Create jobs that encapsulate complete development tasks:

```
┌─────────────────────────────────────────────────────────────┐
│                        JOB LIFECYCLE                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  📥 CREATE    Create worktree from base branch              │
│      ↓                                                      │
│  ✅ PRECHECKS  Run tests/linting before changes             │
│      ↓                                                      │
│  🤖 WORK       AI agent implements the task                 │
│      ↓                                                      │
│  ✅ POSTCHECKS Verify changes (tests, lint, coverage)       │
│      ↓                                                      │
│  🔀 MERGE      Squash/merge back to base branch             │
│      ↓                                                      │
│  🧹 CLEANUP    Remove worktree                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 🤖 AI Agent Delegation

Delegate work using natural language with the `@agent` prefix:

```json
{
  "work": "@agent Implement user authentication with OAuth2 support"
}
```

The orchestrator:
1. Creates an isolated git worktree
2. Runs your prechecks (tests must pass first!)
3. Creates a task file and invokes the Copilot CLI
4. Monitors progress and captures detailed logs
5. Runs postchecks to verify the implementation
6. Merges changes back when everything passes

**Examples:**
```bash
# Simple implementation
work: "@agent Add validation to the user registration form"

# Feature with context
work: "@copilot Implement dark mode support using CSS variables"

# Bug fix
work: "@agent Fix the memory leak in the WebSocket connection handler"

# Traditional command (still supported)
work: "npm run build && npm run deploy"
```

### 📊 Rich Job Details View

Each job includes:
- **Work Summary**: Commits, files added/modified/deleted with expandable details
- **Execution Attempts**: Track retries with individual logs per attempt
- **Live Process Tree**: See running processes during execution
- **Phase Navigation**: Filter logs by Prechecks, Work, Postchecks, Mergeback, or Cleanup
- **Work History**: Timeline of task iterations for retried jobs

### 🔌 MCP (Model Context Protocol) Integration

The orchestrator exposes a full MCP server that integrates directly with GitHub Copilot Chat:

**Available MCP Tools:**
| Tool | Description |
|------|-------------|
| `create_copilot_job` | Create a new orchestrator job |
| `get_copilot_job_status` | Get job progress and status |
| `get_copilot_job_details` | Get full job configuration |
| `get_copilot_job_log_section` | Retrieve specific log sections |
| `get_copilot_jobs_batch_status` | Monitor multiple jobs at once |
| `continue_copilot_job_work` | Add more work to existing job |
| `retry_copilot_job` | Retry with AI-guided analysis |
| `cancel_copilot_job` | Cancel a running job |
| `list_copilot_jobs` | List all jobs |

**Example Copilot Chat interaction:**
```
You: Use the Copilot Orchestrator to create a job that implements 
     JSON serialization for the TrustPlanPolicy class

Copilot: I'll create an orchestrator job for that task...
         [Calls create_copilot_job tool]
         
         Job created! ID: abc-123
         - Status: running
         - Current step: work
         - Progress: 45%
```

### 📡 HTTP REST API

Full REST API for external integrations:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/copilot_jobs` | GET | List all jobs |
| `/copilot_job` | POST | Create new job |
| `/copilot_job/:id` | GET | Get job details |
| `/copilot_job/:id/status` | GET | Get job status |
| `/copilot_job/:id/cancel` | POST | Cancel job |
| `/copilot_job/:id/retry` | POST | Retry failed job |
| `/copilot_job/:id/continue` | POST | Continue with new work |
| `/copilot_job/:id/log/:section` | GET | Get log section |

### 📋 Multi-Job Plans

Orchestrate dependent jobs with execution plans:

```json
{
  "id": "PLAN-telemetry-hardening",
  "maxParallel": 2,
  "jobs": [
    { "id": "format", "inputs": { "baseBranch": "main", "targetBranch": "job/format" } },
    { "id": "lint",   "dependsOn": ["format"], "inputs": { "targetBranch": "job/lint" } },
    { "id": "tests",  "dependsOn": ["lint"],   "inputs": { "targetBranch": "job/tests" } },
    { "id": "docs",   "dependsOn": ["tests"],  "inputs": { "targetBranch": "job/docs" } }
  ]
}
```

### 🔔 Webhook Notifications

Configure webhooks to receive job events:

```json
{
  "webhook": {
    "url": "http://localhost:8080/callback",
    "events": ["stage_complete", "job_complete", "job_failed"]
  }
}
```

---

## Installation

### From VS Code Marketplace

1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X` / `Cmd+Shift+X`)
3. Search for "Copilot Orchestrator"
4. Click **Install**

### From VSIX

1. Download the `.vsix` file from [Releases](https://github.com/JeromySt/vscode-copilot-orchestrator/releases)
2. In VS Code, go to Extensions
3. Click the `...` menu → **Install from VSIX...**
4. Select the downloaded file

### Prerequisites

- **VS Code** 1.85.0 or later
- **GitHub Copilot** extension installed and authenticated
- **GitHub Copilot CLI** (optional but recommended):
  ```bash
  # Install via GitHub CLI
  gh extension install github/gh-copilot
  
  # Or via npm
  npm install -g @githubnext/github-copilot-cli
  ```
- **Git** 2.20+ (for worktree support)

---

## Quick Start

### 1. Open the Copilot Orchestrator Panel

Click the **Copilot** icon in the Activity Bar (left sidebar) to open the Jobs panel.

### 2. Create Your First Job

**Option A: Command Palette**
1. Press `Ctrl+Shift+P` / `Cmd+Shift+P`
2. Type "Copilot Orchestrator: Start Job"
3. Enter base branch: `main`
4. Enter target branch: `feature/my-task`

**Option B: Via GitHub Copilot Chat**
```
@workspace Use the Copilot Orchestrator to create a job that adds 
input validation to the user registration form
```

**Option C: Via HTTP API**
```bash
curl -X POST http://localhost:39218/copilot_job \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Add input validation",
    "repoPath": "/path/to/repo",
    "baseBranch": "main",
    "work": "@agent Add comprehensive input validation to user registration"
  }'
```

### 3. Monitor Progress

- Watch the job in the **Copilot: Jobs** sidebar
- Click on a job to see detailed logs and status
- Use the phase tabs to filter logs (Prechecks, Work, Postchecks, etc.)

### 4. Review and Merge

When the job completes:
- Review the **Work Summary** (commits, files changed)
- Click the expandable summary to see per-commit details
- Changes are automatically merged back to your base branch

---

## MCP Integration

### Automatic Registration

The extension automatically registers the MCP server with VS Code:
- **Status Bar**: Shows MCP connection state
- **Copilot Chat**: Tools appear automatically in tool selection

### Manual Configuration

If needed, add to your Copilot settings:

```json
{
  "mcpServers": {
    "copilot-orchestrator": {
      "command": "node",
      "args": ["<extension-path>/server/mcp-server.js"],
      "env": {
        "ORCH_HOST": "localhost",
        "ORCH_PORT": "39218"
      }
    }
  }
}
```

---

## Configuration

### Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `copilotOrchestrator.http.enabled` | `true` | Enable HTTP REST API |
| `copilotOrchestrator.http.port` | `39218` | HTTP API port |
| `copilotOrchestrator.mcp.enabled` | `true` | Enable MCP server |
| `copilotOrchestrator.mcp.port` | `39219` | MCP server port |
| `copilotOrchestrator.worktreeRoot` | `.worktrees` | Worktree directory |
| `copilotOrchestrator.maxWorkers` | `0` (auto) | Max concurrent jobs |
| `copilotOrchestrator.merge.mode` | `squash` | Merge strategy |
| `copilotOrchestrator.merge.pushOnSuccess` | `false` | Auto-push after merge |
| `copilotOrchestrator.copilotCli.required` | `true` | Require Copilot CLI |
| `copilotOrchestrator.copilotCli.enforceInJobs` | `true` | Fail fast without CLI |

### Merge Strategies

| Mode | Description |
|------|-------------|
| `squash` | Combines all commits into one (default) |
| `merge` | Standard merge commit |
| `rebase` | Rebase onto base branch |

---

## API Reference

### Job Specification

```typescript
interface JobSpec {
  id?: string;              // Auto-generated if not provided
  name?: string;            // Display name
  task: string;             // Task description
  inputs: {
    repoPath: string;       // Repository path
    baseBranch: string;     // Branch to fork from
    targetBranch?: string;  // Branch to create
    worktreeRoot?: string;  // Worktree directory
    instructions?: string;  // Additional AI instructions
  };
  policy: {
    steps: {
      prechecks?: string;   // Pre-check command
      work: string;         // Work command (@agent for AI)
      postchecks?: string;  // Post-check command
    };
  };
  webhook?: {
    url: string;            // Callback URL (localhost only)
    events?: string[];      // Events to subscribe to
  };
}
```

### Job Status Response

```typescript
interface JobStatus {
  id: string;
  name: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  isComplete: boolean;
  progress: number;         // 0-100%
  currentStep: string;
  stepStatuses: Record<string, 'success' | 'failed' | 'skipped'>;
  workSummary?: {
    commits: number;
    filesAdded: number;
    filesModified: number;
    filesDeleted: number;
    description: string;
  };
}
```

---

## Troubleshooting

### MCP Server Not Appearing
1. Check status bar for "MCP: registered"
2. Reload VS Code (`Ctrl+Shift+P` → "Developer: Reload Window")
3. Verify extension is enabled in Tools configuration

### Jobs Stuck in "Running"
1. Check Copilot CLI: `gh copilot --version`
2. View job logs for errors
3. Cancel and retry the job

### Git Worktree Errors
1. Ensure Git 2.20+: `git --version`
2. Check `.worktrees` directory permissions
3. Clean stale worktrees: `git worktree prune`

### Port Conflicts
Configure alternative ports:
```json
{
  "copilotOrchestrator.http.port": 39220,
  "copilotOrchestrator.mcp.port": 39221
}
```

---

## Development

### Building from Source

```bash
git clone https://github.com/JeromySt/vscode-copilot-orchestrator.git
cd vscode-copilot-orchestrator
npm install
npm run compile
npm run package
```

### Project Structure

```
vscode-copilot-orchestrator/
├── src/
│   ├── extension.ts          # Extension entry point
│   ├── core/                  # Core logic
│   ├── agent/                 # AI agent delegation
│   ├── commands/              # VS Code commands
│   ├── git/                   # Git operations
│   ├── http/                  # HTTP REST API
│   ├── mcp/                   # MCP server integration
│   ├── notifications/         # Webhook notifications
│   ├── process/               # Process monitoring
│   ├── types/                 # TypeScript types
│   └── ui/                    # UI components
├── server/
│   └── mcp-server.js          # MCP server (stdio/HTTP)
└── out/                       # Compiled JavaScript
```

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

<p align="center">
  Made with ❤️ for the GitHub Copilot community
</p>
