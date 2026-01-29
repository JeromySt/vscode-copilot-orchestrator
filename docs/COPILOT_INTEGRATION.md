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

### MCP Tools Integration

GitHub Copilot supports MCP (Model Context Protocol). The extension exposes an HTTP-based MCP server:

**Available Tools:**
- `create_copilot_job` - Create a new job
- `get_copilot_job_status` - Get job status
- `get_copilot_job_details` - Get full job details
- `list_copilot_jobs` - List all jobs
- `cancel_copilot_job` - Cancel a running job
- `create_copilot_plan` - Create a multi-job plan
- `get_copilot_plan_status` - Get plan status
- `cancel_copilot_plan` - Cancel a running plan

### Setting Up MCP for Copilot

Add to your VS Code settings (`settings.json`) or workspace `mcp.json`:

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

### Testing the MCP Endpoint

```powershell
# Test tools/list
$body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
Invoke-RestMethod -Uri "http://localhost:39219/mcp" -Method POST -Body $body -ContentType "application/json"
```

### Testing the REST API

```powershell
# Create a test job via REST API
Invoke-RestMethod -Uri "http://localhost:39219/copilot_job" `
  -Method POST `
  -ContentType "application/json" `
  -Body (@{
    id = "test-job-1"
    name = "Test Job"
    task = "Test task"
    inputs = @{
      repoPath = "C:/src/repos/YourProject"
      baseBranch = "main"
      targetBranch = "feature/test"
      worktreeRoot = ".worktrees"
    }
    policy = @{
      useJust = $false
      steps = @{
        prechecks = "echo precheck"
        work = "@agent Implement the test task"
        postchecks = "echo postcheck"
      }
    }
  } | ConvertTo-Json -Depth 5)

# Check job status
Invoke-RestMethod -Uri "http://localhost:39217/job/test-job-1"
```
