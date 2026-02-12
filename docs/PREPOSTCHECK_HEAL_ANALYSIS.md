# Pre/Postchecks Auto-Heal AllowedFolders Analysis

## Problem Summary
When a precheck or postcheck (usually a shell command) fails and auto-heal kicks in with an agent, the agent gets "Permission denied" because:
1. The worktree directory is not in allowedFolders
2. The agent from the work spec's allowedFolders are not inherited

Error from logs:
```
[POSTCHECKS] [INFO] [copilot] ✗ Read c:\src\repos\CoseSignTool\.github\instructions\orchestrator-job-7b0f71b7.instructions.md
[POSTCHECKS] [INFO] [copilot] Permission denied and could not request permission from user
```

## Investigation Results

### 1. Precheck/Postcheck Execution Location
**File:** `src/plan/executor.ts`
- **Method:** `runWorkSpec()` (lines 748-779)
- **Prechecks:** Lines 211-218 - calls `runWorkSpec()` with `phase: 'prechecks'`
- **Postchecks:** Lines 334-341 - calls `runWorkSpec()` with `phase: 'postchecks'`

Both prechecks and postchecks use the same execution path as regular work phases.

### 2. Auto-Heal Spec Construction Location
**File:** `src/plan/runner.ts`
- **Method:** Lines 1940-2250 (auto-heal logic)
- **Heal Spec Creation:** Lines 2155-2191

#### Current Auto-Heal Logic:
```typescript
// Get security settings from the original failed spec (line 2152-2153)
const originalAgentSpec = normalizedFailedSpec?.type === 'agent' ? normalizedFailedSpec : null;

const healSpec: WorkSpec = {
  type: 'agent',
  instructions: [...].join('\n'),
  // ISSUE: Only inherits from agent specs, not shell/process specs
  allowedFolders: originalAgentSpec?.allowedFolders,  // line 2189
  allowedUrls: originalAgentSpec?.allowedUrls,        // line 2190
};
```

### 3. Root Cause Analysis

#### The Problem:
When shell or process commands fail in prechecks/postchecks:
- `originalAgentSpec` is `null` (because failed spec was shell/process, not agent)
- `healSpec.allowedFolders` becomes `undefined`
- Auto-heal agent gets NO allowedFolders
- Copilot CLI runner only receives `cwd` (worktree path)

#### Where Worktree Should Be Added:
**File:** `src/agent/copilotCliRunner.ts` (lines 408-419)
- The worktree IS correctly added via `cwd` parameter
- This code normalizes and adds `cwd` to `allowedPaths`

```typescript
if (cwd) {
  const normalizedCwd = path.resolve(cwd);
  if (fs.existsSync(normalizedCwd)) {
    allowedPaths.push(normalizedCwd);  // Worktree gets added here
  }
}
```

### 4. Comparison with Work Auto-Heal

The work auto-heal follows **exactly the same pattern**:
- Work spec auto-heal: Lines 2119-2239 (same logic)
- Same heal spec creation with same allowedFolders inheritance
- Same `originalAgentSpec?.allowedFolders` pattern

This means **work phase auto-heal would have the same issue** if a shell/process work spec failed.

### 5. Security Model Analysis

#### Current Behavior (By Design):
According to the test file `autoHealAllowedFolders.unit.test.ts`:
- **Lines 84-96:** Shell specs should NOT inherit allowedFolders (test expects `undefined`)
- **Lines 127-137:** Worktree is always included via the `buildAllowedPaths()` mechanism

#### Expected Security Model:
1. **Agent specs:** Inherit `allowedFolders` from original spec
2. **Shell/process specs:** Get worktree-only access (no additional folders)
3. **Worktree path:** Always included via `cwd` parameter in CopilotCliRunner

## Verification of Implementation

### Test Validation
The unit tests in `src/test/unit/plan/autoHealAllowedFolders.unit.test.ts` confirm the intended behavior:
- ✅ **Test 66-82:** Agent specs properly inherit `allowedFolders`
- ✅ **Test 84-96:** Shell specs have NO `allowedFolders` (by design)  
- ✅ **Test 128-137:** Worktree is always added to allowed paths

### CopilotCliRunner Security Check
**File:** `src/agent/copilotCliRunner.ts` (lines 408-419)
- ✅ Worktree path (`cwd`) is properly normalized and added to `allowedPaths`
- ✅ Additional `allowedFolders` are added if present
- ✅ Security logging shows all allowed directories

## Conclusion

**The current implementation appears to be WORKING CORRECTLY** based on the designed security model:

1. **Shell/process auto-heal:** Gets worktree-only access (no allowedFolders inheritance)
2. **Agent auto-heal:** Inherits allowedFolders from original agent spec
3. **Worktree access:** Always granted via `cwd` parameter normalization

### Possible Causes of Permission Denied Error

If the error persists, the root cause is likely:

1. **Path normalization issue:** Worktree path not being normalized correctly
2. **File system permissions:** Process lacking read access to the worktree
3. **Different execution context:** Auto-heal agent running with different privileges
4. **Copilot CLI bug:** CLI not properly applying the `--add-dir` arguments

### Recommended Next Steps

1. **Add debug logging** to `CopilotCliRunner.buildCommand()` to verify:
   - `cwd` parameter value
   - Final `allowedPaths` array content
   - Generated CLI arguments

2. **Check file system permissions** on the worktree directory

3. **Verify Copilot CLI version** - may be a CLI-specific bug with `--add-dir`

The auto-heal allowedFolders inheritance is working as designed. The permission denied error likely stems from a different issue in the execution environment or CLI integration.