# GitHub Copilot Integration Guide

## Using Copilot Chat to Create Jobs

GitHub Copilot can create orchestrator jobs by making HTTP requests to the MCP server running at `http://localhost:39217`.

### API Endpoints

#### Create a Job
```http
POST http://localhost:39217/job
Content-Type: application/json

{
  "id": "unique-job-id",
  "task": "description of the task",
  "inputs": {
    "repoPath": "C:/src/repos/YourProject",
    "baseBranch": "main",
    "targetBranch": "feature/branch-name",
    "worktreeRoot": ".worktrees",
    "instructions": "Optional detailed instructions"
  },
  "policy": {
    "useJust": true,
    "steps": {
      "prechecks": "npm run lint",
      "work": "echo 'Do the work here' && npm run build",
      "postchecks": "npm test"
    }
  }
}
```

#### Get Job Status
```http
GET http://localhost:39217/job/{job-id}
```

#### Cancel a Job
```http
POST http://localhost:39217/job/{job-id}/cancel
```

#### List All Jobs (currently not implemented, would need to add)
```http
GET http://localhost:39217/jobs
```

### Example: GitHub Copilot Creating a Job

**User Prompt to Copilot:**
```
Create a job to add JSON serialization to TrustPlan classes. 
Branch: feature/trustplan-json
Base: main
Repo: C:/src/repos/CoseSignTool3
```

**Copilot Should Execute (via tool/function calling):**
```bash
curl -X POST http://localhost:39217/job \
  -H "Content-Type: application/json" \
  -d '{
    "id": "trustplan-json-2026-01-24",
    "task": "Add JSON serialization to TrustPlan",
    "inputs": {
      "repoPath": "C:/src/repos/CoseSignTool3",
      "baseBranch": "main", 
      "targetBranch": "feature/trustplan-json",
      "worktreeRoot": ".worktrees"
    },
    "policy": {
      "useJust": true,
      "steps": {
        "prechecks": "dotnet build",
        "work": "echo Work would be done by Copilot CLI or agents",
        "postchecks": "dotnet test"
      }
    }
  }'
```

### For GitHub Copilot to Use This:

1. **Copilot needs function/tool calling capability** to make HTTP requests
2. **User must tell Copilot** about the MCP server: 
   - "The Copilot Orchestrator MCP server is running on localhost:39217"
   - "Use the HTTP API to create jobs"
3. **Copilot must construct the JobSpec** from the user's natural language description

### Current Limitations:

- GitHub Copilot Chat may not have direct HTTP request capabilities
- May need a VS Code extension or Language Server Protocol integration
- Alternative: Use the MCP stdio interface (server/mcp-server.js)

### Alternative: MCP Tools Integration

If GitHub Copilot supports MCP (Model Context Protocol), it can use the tools exposed by `server/mcp-server.js`:

- `orchestrator_job_create` - Create a new job
- `orchestrator_job_status` - Get job status
- `orchestrator_plan_create` - Create a multi-job plan
- `orchestrator_plan_status` - Get plan status

### Setting Up MCP for Copilot

Add to your Copilot configuration (if supported):

```json
{
  "mcpServers": {
    "copilot-orchestrator": {
      "command": "node",
      "args": ["C:/src/repos/vscode-copilot-orchestrator/server/mcp-server.js"],
      "env": {
        "ORCH_HOST": "127.0.0.1",
        "ORCH_PORT": "39217"
      }
    }
  }
}
```

### Testing the API Manually

```powershell
# Create a test job
Invoke-RestMethod -Uri "http://localhost:39217/job" `
  -Method POST `
  -ContentType "application/json" `
  -Body (@{
    id = "test-job-1"
    task = "Test task"
    inputs = @{
      repoPath = "C:/src/repos/YourProject"
      baseBranch = "main"
      targetBranch = "feature/test"
      worktreeRoot = ".worktrees"
    }
    policy = @{
      useJust = $true
      steps = @{
        prechecks = "echo precheck"
        work = "echo work"
        postchecks = "echo postcheck"
      }
    }
  } | ConvertTo-Json -Depth 5)

# Check job status
Invoke-RestMethod -Uri "http://localhost:39217/job/test-job-1"
```
