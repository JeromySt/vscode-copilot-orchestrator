---
applyTo: '.worktrees/852a7b3a/**'
---

# Current Task

# Task: Standardize AI Review Invocation Pattern

## Context
Review `docs/AI_REVIEW_INVOCATION_ANALYSIS.md` for analysis.

## Goal
Make AI review invocation identical to work/precheck/postcheck agent invocations.

## Implementation

### Step 1: Create AI Review Instructions Template
The AI review should write an instructions.md file just like work agents:

```typescript
// In executor or wherever AI review is triggered
private async writeAiReviewInstructions(
  worktreeDir: string,
  nodeId: string,
  executionLogs: string,
  taskDescription: string
): Promise<string> {
  const instructionsPath = path.join(
    worktreeDir, 
    '.github', 
    'instructions', 
    `orchestrator-ai-review-${nodeId}.instructions.md`
  );
  
  const content = `# AI Review: No-Change Assessment

## Task
You are reviewing the execution logs of an agent that completed without making file changes.
Determine if this is a legitimate outcome or if the agent failed to do its work.

## Original Task Description
${taskDescription}

## Execution Logs
\`\`\`
${executionLogs}
\`\`\`

## Your Response
**IMPORTANT: Respond ONLY with a JSON object. No markdown, no explanation, no HTML.**

Analyze the logs and respond with exactly this format:
\`\`\`json
{"legitimate": true, "reason": "Brief explanation why no changes were needed"}
\`\`\`
OR
\`\`\`json
{"legitimate": false, "reason": "Brief explanation of what went wrong"}
\`\`\`

### Legitimate No-Change Scenarios
- Work was already completed in a prior commit/dependency
- Task was verification/analysis only (no changes expected)
- Agent correctly determined no changes were needed

### NOT Legitimate (should return false)
- Agent encountered errors and gave up
- Agent misunderstood the task
- Agent claimed success without evidence
- Logs show the agent didn't attempt the work

**YOUR RESPONSE (JSON ONLY):**
`;
  
  await fs.promises.writeFile(instructionsPath, content, 'utf-8');
  return instructionsPath;
}
```

### Step 2: Use Standard Agent Invocation
Call AI review using the same `agentDelegator.runAgent()` or `copilotCliRunner` as work agents:

```typescript
private async runAiReview(
  worktreeDir: string,
  nodeId: string,
  executionLogs: string,
  taskDescription: string
): Promise<{ legitimate: boolean; reason: string } | null> {
  // Write instructions file (same as work agents)
  const instructionsPath = await this.writeAiReviewInstructions(
    worktreeDir, nodeId, executionLogs, taskDescription
  );
  
  // Use standard agent invocation
  const result = await this.agentDelegator.runAgent({
    worktreeDir,
    instructionsPath,
    model: 'claude-haiku-4.5',  // Use cheap model for review
    allowedFolders: [worktreeDir],
    // Other standard options
  });
  
  // Parse JSON response
  return this.parseAiReviewResult(result.output);
}
```

### Step 3: Enforce JSON-Only Response
The key is in the instructions file - explicitly state:
- "Respond ONLY with a JSON object"
- "No markdown, no explanation, no HTML"
- Show exact expected format

Also consider using `--output-format json` if Copilot CLI supports it.

### Step 4: Clean Up Instructions File After
Like other agent invocations, clean up the instructions file after completion.



## Guidelines

- Focus only on the task described above
- Make minimal, targeted changes
- Follow existing code patterns and conventions in this repository
- Commit your changes when complete
