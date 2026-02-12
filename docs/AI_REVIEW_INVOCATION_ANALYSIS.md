# AI Review Invocation Analysis

## Problem Statement

1. AI review prompt returns HTML-formatted response instead of JSON
2. AI review invocation may not use the standard instructions.md pattern like other Copilot CLI invocations

## Investigation Findings

### 1. Current AI Review Invocation Location

**File:** `src/plan/executor.ts` (lines 1185-1411)
**Method:** `aiReviewNoChanges()`

```typescript
// Lines 1325-1332
const result = await this.agentDelegator.delegate({
  task: reviewPrompt,
  worktreePath,
  model: 'claude-haiku-4.5',
  configDir, // Isolate sessions from user's history
  logOutput: (line: string) => this.logInfo(executionKey, 'commit', `[ai-review] ${line}`),
  onProcess: () => {}, // No need to track this short-lived process
});
```

### 2. Invocation Pattern Comparison

| Aspect | Work Agent | AI Review Agent |
|--------|------------|------------------|
| **Entry Point** | `executor.runAgent()` → `agentDelegator.delegate()` (real class) | `executor.aiReviewNoChanges()` → `agentDelegator.delegate()` (adapter) |
| **Interface Used** | `DelegateOptions` (full interface) | Simplified adapter interface |
| **Instructions File?** | ✅ Yes - via `CopilotCliRunner.writeInstructionsFile()` | ✅ Yes - via `CopilotCliRunner.writeInstructionsFile()` |
| **CLI Invocation Method** | Standard via `AgentDelegator.delegateViaCopilot()` | Via adapter in `planInitialization.ts` |
| **Output Format Specified** | Via instructions file content | Via hardcoded prompt in `reviewPrompt` |

### 3. Key Architectural Difference

**Work Agent Invocation Path:**
```
executor.runAgent() 
→ agentDelegator.delegate(DelegateOptions) [real AgentDelegator class]
→ agentDelegator.delegateViaCopilot() 
→ copilotCliRunner.run()
→ writes .github/instructions/orchestrator-job-{id}.instructions.md
```

**AI Review Invocation Path:**
```
executor.aiReviewNoChanges() 
→ agentDelegator.delegate({simplified interface}) [adapter from planInitialization.ts]
→ copilotCliRunner.run() [direct call]
→ writes .github/instructions/orchestrator-job-{id}.instructions.md
```

### 4. Current AI Review Prompt Content

**Location:** `src/plan/executor.ts` (lines 1281-1317)

```typescript
const reviewPrompt = [
  '# No-Change Review: Was This Outcome Expected?',
  '',
  '## Context',
  `A plan node completed its work phase successfully, but produced NO file changes.`,
  `The commit phase needs to determine: is this a legitimate "no-op" or a failure?`,
  // ... node details and execution logs
  '',
  '## Your Task',
  'Analyze the execution logs and determine whether "no changes" is expected.',
  '',
  'You MUST write your answer as a single-line JSON object on the LAST LINE',
  'of your output. No markdown fences, no extra text after it.',
  '',
  'Format: {"legitimate": true|false, "reason": "brief explanation"}',
].join('\n');
```

### 5. Why Response is HTML (Markdown Rendering)

**Root Cause:** The AI review prompt is passed as a **raw prompt string** via the `task` parameter, not as instructions in a structured file. The Copilot CLI is likely treating this long prompt as markdown and rendering it to HTML in the response.

**Evidence:**
- Normal work uses: `task: 'Complete the task described in the instructions.'` + structured instructions file
- AI review uses: `task: {entire review prompt}` (no separate instructions file content)

### 6. Both Use Instructions Files - But Differently

**Surprising Finding:** Both invocation patterns DO write `.github/instructions/orchestrator-job-{id}.instructions.md` files.

**The Difference:**
- **Work Agent:** Task description goes in instructions file, CLI gets simple "Complete the task described in the instructions."
- **AI Review:** The full review prompt goes directly as the `task` parameter, and gets written to the instructions file verbatim

### 7. Proposed Changes for Consistency

#### Option 1: Make AI Review Use Standard Pattern
```typescript
// In aiReviewNoChanges(), instead of passing the full prompt as 'task':
const result = await this.agentDelegator.delegate({
  task: 'Review execution logs and determine if no-changes is legitimate', 
  instructions: reviewPrompt,  // Move full prompt to instructions
  worktreePath,
  model: 'claude-haiku-4.5',
  // ...
});
```

#### Option 2: Use skipInstructionsFile for AI Review
```typescript
// Modify the adapter to support skipInstructionsFile
const result = await runner.run({
  // ... existing parameters
  skipInstructionsFile: true,  // Add this option
});
```

#### Option 3: Enforce JSON Response Format in Instructions File Structure
Structure the prompt using the same frontmatter pattern as normal work:
```markdown
---
applyTo: '{worktree}/**'
outputFormat: 'json'
---

# No-Change Review Task
[structured content]

## Output Requirements
You MUST respond with valid JSON only.
```

## Recommended Solution

**Use Option 1** - Make AI review follow the standard pattern by moving the prompt content to the `instructions` parameter. This will:
1. Provide consistency with normal work invocation
2. Ensure proper instruction file formatting
3. Likely resolve the HTML response issue by treating the content as structured instructions rather than a raw markdown prompt
4. Maintain the existing JSON parsing logic without changes

## Implementation Impact

- **Low Risk:** Only changes the parameter structure of the delegate call
- **Maintains Compatibility:** All existing parsing logic remains unchanged
- **Improves Consistency:** Makes AI review follow the same pattern as normal work
- **Should Fix HTML Issue:** Moving content to instructions should resolve markdown rendering