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
work: "@agent Implement dark mode support using CSS variables"

# Bug fix
work: "@agent Fix the memory leak in the WebSocket connection handler"

# Traditional shell command (still supported)
work: "npm run build && npm run deploy"
```

### 📊 Rich Job Details View

Each job includes:
- **Work Summary**: Commits, files added/modified/deleted with expandable details
- **Execution Attempts**: Track retries with individual logs per attempt
- **Live Process Tree**: See running processes during execution
- **Phase Navigation**: Filter logs by Prechecks, Work, Postchecks, Mergeback, or Cleanup
- **Work History**: Timeline of task iterations for retried jobs

### 📋 Plans UI

The sidebar includes two views:

**Jobs View** - Shows individual job status:
- Quick status overview with progress indicators
- Click any job to open detailed logs and information
- Real-time updates as jobs progress

**Plans View** - Shows multi-job plan status:
- Visual progress bars showing completion percentage
- Job counts by status (completed/running/failed)
- Click to open the **Plan Detail Panel**

**Plan Detail Panel** - Visual execution pipeline:
- Stage-based layout showing job dependencies
- Color-coded status indicators (✓ completed, ◐ running, ✗ failed)
- Click individual job cards to view their detailed logs
- Real-time updates as plan executes

### 🔌 MCP (Model Context Protocol) Integration

The orchestrator exposes a full MCP server that integrates directly with GitHub Copilot Chat:

**Plan Tools (Multi-Job Workflows):**
| Tool | Description |
|------|-------------|
| `create_copilot_plan` | Create a plan with multiple dependent jobs |
| `create_copilot_job` | Create a single job (wrapped in a plan) |
| `get_copilot_plan_status` | Get plan progress and job statuses |
| `list_copilot_plans` | List all plans |
| `cancel_copilot_plan` | Cancel a plan and all its jobs |
| `delete_copilot_plan` | Delete a plan and all its state |
| `retry_copilot_plan` | Retry failed nodes in a plan |
| `retry_copilot_plan_node` | Retry a specific failed node |
| `get_copilot_plan_node_failure_context` | Get failure details for a node |
| `get_copilot_node_details` | Get details for a specific node |
| `get_copilot_node_logs` | Get execution logs for a node |

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

### 📋 Multi-Job Plans

Orchestrate dependent jobs with execution plans:

Plans allow you to run multiple jobs with dependencies. Jobs execute in parallel up to `maxParallel`, but respect dependency ordering.

**Example: Code Quality Pipeline**
```json
{
  "name": "Code Quality Pipeline",
  "maxParallel": 2,
  "jobs": [
    { 
      "id": "format", 
      "task": "Format all TypeScript files",
      "work": "@agent Run prettier on all .ts files and fix formatting issues"
    },
    { 
      "id": "lint", 
      "task": "Fix lint errors",
      "dependsOn": ["format"],
      "work": "@agent Fix all ESLint errors, don't just disable rules"
    },
    { 
      "id": "tests", 
      "task": "Add missing tests",
      "dependsOn": ["lint"],
      "work": "@agent Add unit tests for any untested functions",
      "postchecks": "npm test"
    },
    { 
      "id": "docs", 
      "task": "Update documentation",
      "dependsOn": ["tests"],
      "work": "@agent Update JSDoc comments and README for any changed APIs"
    }
  ]
}
```

**Execution order:**
```
        ┌─────────┐
        │ format  │  ← Starts immediately
        └────┬────┘
             │
        ┌────▼────┐
        │  lint   │  ← Waits for format
        └────┬────┘
             │
        ┌────▼────┐
        │  tests  │  ← Waits for lint
        └────┬────┘
             │
        ┌────▼────┐
        │  docs   │  ← Waits for tests
        └─────────┘
```

### 🔗 Nested Plans (Plans within Plans)

For complex workflows, a job can itself be a complete plan. This enables hierarchical orchestration where one step triggers an entire sub-pipeline:

**Example: Full Release Pipeline with Nested Testing Plan**
```json
{
  "name": "Release Pipeline",
  "maxParallel": 3,
  "jobs": [
    {
      "id": "prepare",
      "name": "Prepare Release",
      "task": "Bump version and update changelog",
      "work": "@agent Update version in package.json and add changelog entry"
    },
    {
      "id": "api-service",
      "name": "API Service",
      "task": "Implement API changes",
      "dependsOn": ["prepare"],
      "work": "@agent Implement the new REST endpoints per the API spec"
    },
    {
      "id": "web-client",
      "name": "Web Client",
      "task": "Update web frontend",
      "dependsOn": ["prepare"],
      "work": "@agent Update React components to use new API endpoints"
    },
    {
      "id": "mobile-client",
      "name": "Mobile Client", 
      "task": "Update mobile app",
      "dependsOn": ["prepare"],
      "work": "@agent Update React Native screens for new features"
    },
    {
      "id": "docs-update",
      "name": "Documentation",
      "task": "Update all documentation",
      "dependsOn": ["prepare"],
      "work": "@agent Update API docs, README, and user guide"
    },
    {
      "id": "testing-suite",
      "name": "Comprehensive Testing",
      "task": "Run full test suite across all components",
      "dependsOn": ["api-service", "web-client", "mobile-client", "docs-update"],
      "plan": {
        "name": "Testing Sub-Plan",
        "maxParallel": 4,
        "jobs": [
          { "id": "unit-tests", "task": "Run unit tests", "work": "npm run test:unit" },
          { "id": "integration-tests", "task": "Run integration tests", "work": "npm run test:integration" },
          { "id": "e2e-tests", "task": "Run E2E tests", "work": "npm run test:e2e" },
          { "id": "perf-tests", "task": "Run performance tests", "work": "npm run test:perf" }
        ]
      }
    },
    {
      "id": "deploy",
      "name": "Deploy Release",
      "task": "Deploy to production",
      "dependsOn": ["testing-suite"],
      "work": "@agent Create release tag and trigger deployment workflow",
      "postchecks": "npm run smoke-test"
    }
  ]
}
```

**Execution visualization:**
```
                              ┌───────────┐
                              │  prepare  │  ← Stage 1: Single pre-step
                              └─────┬─────┘
            ┌─────────────┬─────────┴────┬───────────┐
            │             │              │           │
      ┌─────▼─────┐ ┌─────▼────┐ ┌───────▼───┐ ┌─────▼──────┐
      │api-service│ │web-client│ │mobile-cli │ │docs-update │  ← Stage 2: 4 parallel
      └─────┬─────┘ └─────┬────┘ └─────┬─────┘ └──────┬─────┘
            │             │            │              │
            └─────────────┴──────┬─────┴──────────────┘
                                 │
                   ┌─────────────▼─────────────┐
                   │      testing-suite        │  ← Stage 3: Nested plan!
                   │  ┌─────────────────────┐  │
                   │  │   Testing Sub-Plan  │  │
                   │  │  ┌────┐ ┌────┐      │  │
                   │  │  │unit│ │intg│ ...  │  │   (4 parallel test jobs)
                   │  │  └────┘ └────┘      │  │
                   │  └─────────────────────┘  │
                   └─────────────┬─────────────┘
                                 │
                   ┌─────────────▼─────────────┐
                   │         deploy            │  ← Stage 4: Single post-step
                   └───────────────────────────┘
```

This pattern enables:
- **Modular pipelines**: Reuse testing plans across different parent plans
- **Deep orchestration**: Nest plans to any depth for complex workflows
- **Parallel efficiency**: Each level runs at its own `maxParallel` setting
- **Unified monitoring**: Track nested plan progress in the Plan Detail Panel

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
- **HTTP Transport**: MCP endpoint at `http://localhost:39219/mcp`

### Manual Configuration

If needed, add to your VS Code settings or `mcp.json`:

```json
{
  "mcpServers": {
    "copilot-orchestrator": {
      "type": "http",
      "url": "http://localhost:39219/mcp"
    }
  }
}
```

---

## Configuration

### Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `copilotOrchestrator.mcp.enabled` | `true` | Enable MCP server |
| `copilotOrchestrator.worktreeRoot` | `.worktrees` | Worktree directory |
| `copilotOrchestrator.maxWorkers` | `0` (auto) | Max concurrent jobs |
| `copilotOrchestrator.merge.mode` | `squash` | Merge strategy |
| `copilotOrchestrator.merge.prefer` | `theirs` | Conflict resolution preference |
| `copilotOrchestrator.merge.pushOnSuccess` | `false` | Auto-push after merge |
| `copilotOrchestrator.copilotCli.required` | `true` | Require Copilot CLI |
| `copilotOrchestrator.copilotCli.preferredInstall` | `auto` | Install method (gh/npm/auto) |
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
│   ├── httpServer.ts         # HTTP server with MCP endpoint
│   ├── core/                  # Core logic (JobRunner, PlanRunner)
│   ├── agent/                 # AI agent delegation
│   ├── commands/              # VS Code commands
│   ├── git/                   # Git operations & worktrees
│   ├── mcp/                   # MCP protocol handler & registration
│   ├── process/               # Process monitoring
│   ├── types/                 # TypeScript types
│   └── ui/                    # UI components (sidebar, webview)
└── out/                       # Compiled JavaScript
```

---

## Architecture

The extension runs an **HTTP-based MCP server**:

```
┌─────────────────────────────────────────────────────────────┐
│                    GitHub Copilot Chat                      │
└───────────────────────────┬─────────────────────────────────┘
                            │ MCP (HTTP POST)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                VS Code Extension (TypeScript)               │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              HTTP Server (:39219)                    │   │
│  │  • /mcp - MCP JSON-RPC endpoint                     │   │
│  │  • REST API for direct integration                   │   │
│  └───────────────────────────┬─────────────────────────┘   │
│                              │                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  JobRunner / PlanRunner                              │   │
│  │  • Job lifecycle management                          │   │
│  │  • Git worktree operations                           │   │
│  │  • Copilot CLI execution                             │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  UI: Sidebar views, webview panels, status bar              │
└─────────────────────────────────────────────────────────────┘
```

No Node.js runtime dependency - everything runs inside the extension!

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

<p align="center">
  Made with ❤️ for the GitHub Copilot community
</p>
