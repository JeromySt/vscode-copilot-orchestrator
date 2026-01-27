
# Copilot Orchestrator (VS Code Extension)

**Parallel AI-Powered Development**: Use GitHub Copilot to orchestrate multiple background jobs running simultaneously in isolated git worktrees. Perfect for delegating complex tasks to AI agents while maintaining clean git history.

## 🚀 What Does It Do?

- **Parallel Execution**: Run multiple Copilot agents on different tasks simultaneously
- **Git Worktree Isolation**: Each job works in its own isolated directory - no conflicts
- **Automated Workflows**: Pre-checks → Work → Post-checks → Auto-merge
- **AI Agent Delegation**: Use `@agent` or `@copilot` prefix for natural language task descriptions
- **MCP Integration**: Model Context Protocol server for external agent delegation
- **Real-time Monitoring**: Track all jobs in the dedicated Copilot: Jobs panel

## 🤖 AI Agent Delegation

The orchestrator supports delegating work to AI agents using special command syntax:

### Using `@agent` or `@copilot` Prefix

In your job's `work` step, use the `@agent` or `@copilot` prefix followed by a natural language task description:

```json
{
  "steps": {
    "prechecks": "npm test",
    "work": "@agent Implement user authentication with OAuth2",
    "postchecks": "npm run lint && npm test"
  }
}
```

**What happens:**
1. The orchestrator creates a dedicated git worktree for the job
2. Runs prechecks (tests, linting, etc.)  
3. Creates a `.copilot-task.md` file with the task description
4. If GitHub Copilot CLI is available, attempts automated delegation
5. Otherwise, marks the task for manual AI agent intervention
6. You can open the worktree and use GitHub Copilot to complete the task
7. After completion, the orchestrator merges changes back

### Examples

**Simple implementation task:**
```bash
work: "@agent Add validation to the user registration form"
```

**Feature with context:**
```bash
work: "@copilot Implement dark mode support using CSS variables"
```

**Bug fix:**
```bash
work: "@agent Fix the memory leak in the WebSocket connection handler"
```

**Traditional shell command (still supported):**
```bash
work: "npm run build && npm run deploy"
```

## 📦 Quick Start

### Installation (Development)
1. Clone this repo
2. `npm install`
3. Press **F5** to launch Extension Development Host
4. Open a git repository in the new VS Code window

### Your First Job
1. Click the **Copilot icon** in the Activity Bar (left sidebar)
2. Press `Ctrl+Shift+P` → `Copilot Orchestrator: Start Job`
3. Enter base branch: `main`
4. Enter target branch: `feature/my-task`
5. Watch it work in the Jobs panel!

See [DEMO.md](DEMO.md) for detailed demo scenarios and examples.

## 🎯 Key Features

### Option 4 — Copilot CLI pre‑flight enforcement
- On activation, the extension checks for GitHub Copilot CLI and offers guided install via **gh** or **npm**.
- Before each job, if `copilotOrchestrator.copilotCli.enforceInJobs = true`, the job **fails fast** with a helpful prompt rather than half-running and failing later.

**Settings**
```jsonc
{
  "copilotOrchestrator.copilotCli.required": true,
  "copilotOrchestrator.copilotCli.preferredInstall": "auto", // gh | npm | auto
  "copilotOrchestrator.copilotCli.enforceInJobs": true
}
```
**Manual check**: `Copilot Orchestrator: Check Copilot CLI`

## MCP auto-start (Option A)
```jsonc
{
  "copilotOrchestrator.mcp.enabled": true,
  "copilotOrchestrator.mcp.host": "127.0.0.1",
  "copilotOrchestrator.mcp.port": 39217
}
```
- Status bar shows MCP state; `MCP – How to Connect` command copies Agent-mode connection details.

## Plan example
```json
{
  "id": "PLAN-telemetry-hardening",
  "maxParallel": 2,
  "jobs": [
    { "id": "format", "inputs": { "baseBranch": "main", "targetBranch": "job/format" } },
    { "id": "lint",   "dependsOn": ["format"], "inputs": { "baseBranch": "main", "targetBranch": "job/lint" } },
    { "id": "tests",  "dependsOn": ["lint"],   "inputs": { "baseBranch": "main", "targetBranch": "job/tests" } },
    { "id": "docs",   "dependsOn": ["tests"],  "inputs": { "baseBranch": "main", "targetBranch": "job/docs" } }
  ]
}
```
