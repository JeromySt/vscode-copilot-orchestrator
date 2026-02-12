# Log Filtering Bug Analysis

## Problem Summary

When viewing logs filtered by phase (e.g., "Work" tab), multi-line log messages are truncated. Only the first line appears because:

1. Log messages are stored line-by-line in the log files
2. Only the first line has the phase tag like `[WORK]` 
3. Subsequent lines of the same message don't have the tag
4. Phase filtering only shows lines matching `[PHASE_NAME]`

## Example

Input log message:
```
Agent instructions: # Task: Fix Auto-Heal

## Problem
In `src/plan/runner.ts` there is a bug...
```

Stored in log file:
```
[2026-02-12T21:08:34.713Z] [WORK] [INFO] Agent instructions: # Task: Fix Auto-Heal
[2026-02-12T21:08:34.713Z] [WORK] [INFO] 
[2026-02-12T21:08:34.713Z] [WORK] [INFO] ## Problem
[2026-02-12T21:08:34.713Z] [WORK] [INFO] In `src/plan/runner.ts` there is a bug...
```

But when phase filtering is applied, only lines containing `[WORK]` are shown, so all lines appear correctly.

**Wait - this indicates the bug may be elsewhere. Let me investigate further.**

## Code Analysis

### 1. Log Writing (`src/plan/executor.ts`)

**Method: `logInfo()` - Lines 1812-1826**
```typescript
private logInfo(executionKey: string, phase: ExecutionPhase, message: string): void {
  const entry: LogEntry = {
    timestamp: Date.now(),
    phase,
    type: 'info', 
    message,  // Single message string
  };
  
  const logs = this.executionLogs.get(executionKey);
  if (logs) {
    logs.push(entry);  // One LogEntry per call
  }
  
  this.appendToLogFile(executionKey, entry);
}
```

**Method: `appendToLogFile()` - Lines 1712-1732**
```typescript
private appendToLogFile(executionKey: string, entry: LogEntry): void {
  // ...
  const time = new Date(entry.timestamp).toISOString();
  const prefix = entry.type === 'stderr' ? '[ERR]' : 
                 entry.type === 'error' ? '[ERROR]' :
                 entry.type === 'info' ? '[INFO]' : '';
  const line = `[${time}] [${entry.phase.toUpperCase()}] ${prefix} ${entry.message}\n`;
  fs.appendFileSync(logFile, line, 'utf8');
}
```

**Key Finding**: Each call to `logInfo()` creates **one** LogEntry with **one** message string. If the message contains newlines, they are preserved as-is in the single line written to the log file.

### 2. Agent Output Processing (`src/agent/copilotCliRunner.ts`)

**Lines 580-584**: Agent stdout/stderr processing
```typescript
text.split('\n').forEach(line => {
  if (line.trim()) {
    this.logger.debug(`[${label}] ${line.trim()}`);
    statsParser.feedLine(line.trim());
    onOutput?.(line.trim());  // Called for each line individually
  }
});
```

**Key Finding**: Agent output is split into individual lines and each line calls `onOutput` separately. This means multi-line agent output results in multiple separate calls to `logInfo()`.

In `src/plan/executor.ts` line 1063:
```typescript
logOutput: (line: string) => this.logInfo(executionKey, phase, line),
```

So if an agent outputs:
```
Agent instructions: # Task: Fix Auto-Heal

## Problem  
In `src/plan/runner.ts`...
```

This becomes **4 separate calls** to `logInfo()`:
1. `logInfo(key, 'work', 'Agent instructions: # Task: Fix Auto-Heal')`
2. `logInfo(key, 'work', '')`  
3. `logInfo(key, 'work', '## Problem')`
4. `logInfo(key, 'work', 'In `src/plan/runner.ts`...')`

Each creates a separate log file line with the phase tag `[WORK]`.

### 3. Log Filtering (`src/plan/runner.ts`)

**Method: `getNodeLogs()` - Lines 724-729**
```typescript
// Filter by phase if requested
if (phase && phase !== 'all') {
  const phaseMarker = `[${phase.toUpperCase()}]`;
  const lines = fileContent.split('\n').filter((line: string) => line.includes(phaseMarker));
  return lines.length > 0 ? lines.join('\n') : `No logs for ${phase} phase.`;
}
```

**Key Finding**: The filtering logic looks for lines containing the phase marker (e.g., `[WORK]`). Based on the log writing logic, **every line should have this marker**.

## Root Cause Identified

**The bug is in process output handling for shell and process commands.**

In lines 828-829 and 833-834 of `src/plan/executor.ts`:

```typescript
proc.stdout?.on('data', (data: string) => {
  stdout += data;
  this.logOutput(executionKey, phase, 'stdout', data);  // BUG: data may contain newlines
});
```

**Problem**: Process stdout/stderr data arrives in **chunks**, not lines. A single chunk might contain multiple lines separated by `\n` characters. When `logOutput()` writes this chunk to the log file via `appendToLogFile()`, the entire chunk (with embedded newlines) is written as a single log entry.

**Example**:
- Process outputs: `"Agent instructions: # Task\n\n## Problem\nDetails here"`
- This arrives as one chunk and gets written as:
  ```
  [2026-02-12T21:08:34.713Z] [WORK] Agent instructions: # Task

  ## Problem  
  Details here
  ```
- Only the first line has the timestamp and phase tag `[WORK]`
- When filtering by phase, lines 2-4 are excluded because they lack `[WORK]`

**Why Agent output works differently**: The `CopilotCliRunner` explicitly splits output by lines before calling the callback (lines 580-584), so each line gets its own log entry with phase tags.

## Investigation Required

To identify the actual root cause:

1. **Search for direct file writes** to log files bypassing `appendToLogFile()`
2. **Check for any raw fs.appendFileSync calls** in the codebase  
3. **Look for process stdout/stderr** that might be captured without proper formatting
4. **Examine shell command output** handling for missing phase tags
5. **Review any logging utilities** that might write unformatted lines

## Proposed Fix Options

### Option 1: Line-by-Line Process Output (Recommended)
**Fix the root cause** by modifying process output handling in `src/plan/executor.ts`:

```typescript
// Replace lines 827-830 and 967-970 with:
let outputBuffer = '';
proc.stdout?.on('data', (data: string) => {
  stdout += data;
  outputBuffer += data;
  const lines = outputBuffer.split('\n');
  outputBuffer = lines.pop() || ''; // Keep incomplete line for next chunk
  lines.forEach(line => {
    if (line.length > 0) { // Skip empty lines
      this.logOutput(executionKey, phase, 'stdout', line);
    }
  });
});
```

**Benefits**: 
- Fixes the root cause for all process/shell commands
- Each line gets proper phase tags
- Consistent with agent output handling

### Option 2: Smart Log Filtering  
**Work around the issue** by improving the filtering logic in `runner.ts`:

```typescript
// Enhanced version of lines 724-729:
if (phase && phase !== 'all') {
  const phaseMarker = `[${phase.toUpperCase()}]`;
  const lines = fileContent.split('\n');
  const filtered: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(phaseMarker)) {
      filtered.push(line);
      // Include subsequent lines without phase tags (likely continuations)
      for (let j = i + 1; j < lines.length && !lines[j].includes('['); j++) {
        if (lines[j].trim()) filtered.push(lines[j]);
      }
    }
  }
  
  return filtered.length > 0 ? filtered.join('\n') : `No logs for ${phase} phase.`;
}
```

### Option 3: Multi-line Log Entry Support
**Restructure logging** to handle multi-line messages as single entries:
- Modify `LogEntry` interface to support line arrays  
- Update `appendToLogFile()` to format multi-line entries properly
- Requires broader changes to logging infrastructure

### Option 4: Post-process Log Files
**Background task** to fix malformed log files by adding missing phase tags based on context.

## Summary

**Root Cause**: Process stdout/stderr chunks containing multiple lines are logged as single entries, causing only the first line to have phase tags.

**Affected Components**:
- Shell commands (`runShellSpec`) - lines 962-970
- Process commands (`runProcessSpec`) - lines 827-835  
- NOT affected: Agent commands (they split by lines first)

**Recommended Solution**: Option 1 (Line-by-Line Process Output) - fixes the root cause with minimal changes and ensures all output lines get proper phase tags for filtering.