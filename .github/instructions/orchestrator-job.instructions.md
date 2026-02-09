---
applyTo: '.worktrees/decae586/**'
---

# Current Task

# Wire CopilotStatsParser into AgentDelegator

## Context
The `CopilotStatsParser` (created by dependency node) can parse Copilot CLI stdout lines. Now we need to wire it into `src/agent/agentDelegator.ts` so it captures metrics during agent delegation.

## Files to Modify
- `src/agent/agentDelegator.ts`

## Implementation

### 1. Import the parser
```typescript
import { CopilotStatsParser } from './copilotStatsParser';
```

### 2. Create parser instance in `delegateViaCopilot`
In the `delegateViaCopilot` method, before the `proc.stdout` handler:
```typescript
const statsParser = new CopilotStatsParser();
```

### 3. Feed lines to parser
In the `logLine` helper function, after logging and session ID extraction, add:
```typescript
statsParser.feedLine(line);
```

### 4. Use parsed metrics in result
After the process exits (in the `close` handler), instead of calling `this.extractTokenUsage(copilotLogDir, model)`, use:
```typescript
const parsedMetrics = statsParser.getMetrics();
```

Set the `durationMs` on the parsed metrics if present. If `parsedMetrics` is undefined, fall back to the existing `extractTokenUsage` method for backward compat.

### 5. Update DelegateResult
Change `tokenUsage?: TokenUsage` to `metrics?: CopilotUsageMetrics` in the `DelegateResult` interface.
Keep `tokenUsage` for backward compatibility but mark as `@deprecated`.

Update the resolve calls to include `metrics` instead of (or in addition to) `tokenUsage`.

### 6. Update executor to use new metrics
In `src/plan/executor.ts`, in the `runAgent` method:
- Update the metrics capture from `result.tokenUsage` to `result.metrics`
- Build `CopilotUsageMetrics` using the parsed metrics, falling back to legacy `tokenUsage` if needed
- Set `durationMs` from wall-clock time

Import `CopilotUsageMetrics` from the types.

### 7. Update runner to store metrics on AttemptRecord
In `src/plan/runner.ts`, when creating `AttemptRecord` objects (there are ~6 places), include `metrics: nodeState.metrics` so each attempt records its metrics.

Also, update the `nodeState.metrics` assignment from the executor result to use the new `CopilotUsageMetrics` type.

Make sure to run `npx tsc --noEmit` to verify everything compiles.



## Guidelines

- Focus only on the task described above
- Make minimal, targeted changes
- Follow existing code patterns and conventions in this repository
- Commit your changes when complete
