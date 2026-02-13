# .gitignore Handling Analysis

## Problem Summary

1. .gitignore is only applied on initial extension load, not when VS Code changes branches
2. Multiple functions managing .gitignore are scattered across the codebase with some duplication

## Investigation Results

### 1. All .gitignore Functions Found

#### Primary Functions (Active)

1. **`git/core/gitignore.ts` - `ensureGitignoreEntries()`**
   - **Location**: `src/git/core/gitignore.ts:27-75`
   - **Purpose**: Canonical function to ensure .gitignore contains orchestrator entries
   - **Features**: 
     - Handles both `.worktrees` and `.orchestrator` entries
     - Cross-platform line ending support
     - Smart comment injection
     - Returns boolean indicating if file was modified
   - **Called from**: 
     - `src/plan/runner.ts:472` (main repo gitignore)
     - `src/plan/runner.ts:1682` (worktree gitignore)
     - `src/core/planInitialization.ts:219` (extension activation)

2. **`git/orchestrator.ts` - `ensureGitignorePatterns()`**
   - **Location**: `src/git/orchestrator.ts:268-303`
   - **Purpose**: Ensure specified patterns are in .gitignore
   - **Features**:
     - Generic pattern handling
     - Slash normalization
     - Logger integration
   - **Called from**: 
     - `src/git/orchestrator.ts:114` (during worktree setup)

3. **`git/core/repository.ts` - `ensureGitignore()`** 
   - **Location**: `src/git/core/repository.ts:232-266`
   - **Purpose**: Ensure orchestrator directories are in .gitignore
   - **Features**:
     - Pattern-based approach
     - Slash handling
     - Logger integration
   - **Called from**: Test files only (appears to be legacy)

4. **`core/planInitialization.ts` - Local `ensureGitignoreEntries()`**
   - **Location**: `src/core/planInitialization.ts:64-101`
   - **Purpose**: Synchronous version for extension activation
   - **Features**:
     - Synchronous fs operations
     - Local function scope
     - Similar logic to git/core/gitignore.ts
   - **Called from**: `src/core/planInitialization.ts:219` (extension activation)

### 2. Function Usage Analysis

#### Canonical Function (Recommended)
**`git/core/gitignore.ts:ensureGitignoreEntries()`** should be the canonical function because:
- It's in the proper git module location
- Most comprehensive implementation with robust error handling
- Async/await pattern
- Returns modification status
- Proper cross-platform support
- Already exported via `src/git/index.ts:47` and `src/git/core/index.ts:47`

#### Duplicate/Legacy Functions
- **`git/orchestrator.ts:ensureGitignorePatterns()`**: Similar functionality, could be consolidated
- **`git/core/repository.ts:ensureGitignore()`**: Legacy implementation, only used in tests
- **`core/planInitialization.ts:ensureGitignoreEntries()`**: Local duplicate for sync operation

### 3. Current Branch Change Handling

**No branch change detection found**. Search results show:
- No `vscode.workspace.onDidChangeConfiguration` usage for git monitoring
- No `git.onDidChangeState` listeners
- No `vscode.extensions.getExtension('vscode.git')` usage for branch detection
- Only configuration change listeners found:
  - `src/core/logger.ts:106` - Logger configuration changes
  - `src/mcp/mcpDefinitionProvider.ts:146` - MCP configuration changes

### 4. VS Code Git API for Branch Change Detection

Available VS Code Git API patterns:
```typescript
// Option 1: Direct Git extension API
const gitExtension = vscode.extensions.getExtension('vscode.git');
const git = gitExtension?.exports.getAPI(1);
git?.repositories[0]?.state.onDidChange(() => {
  // Branch changed, update .gitignore
});

// Option 2: Workspace change monitoring  
vscode.workspace.onDidChangeWorkspaceFolders(() => {
  // Workspace changed, may need .gitignore update
});

// Option 3: File system watcher on .git/HEAD
const watcher = vscode.workspace.createFileSystemWatcher('**/.git/HEAD');
watcher.onDidChange(() => {
  // Branch changed, update .gitignore
});
```

### 5. .gitignore Requirements

Based on codebase analysis, these entries are required:

1. **`.worktrees/`** - Root directory containing all job worktrees
2. **`.orchestrator/`** - Per-worktree orchestrator state including:
   - `.orchestrator/plans/` - Plan persistence files
   - `.orchestrator/logs/` - Execution logs  
   - `.orchestrator/evidence/` - Evidence files
   - `.orchestrator/.copilot/` - Copilot session cache

### 6. Current Call Sites Analysis

#### Extension Activation (Working)
- `src/core/planInitialization.ts:219` - Called during extension activation
- Uses local sync function instead of canonical async version

#### Plan Execution (Working)  
- `src/plan/runner.ts:472` - Main repo gitignore during plan setup
- `src/plan/runner.ts:1682` - Worktree gitignore during job execution
- Both use canonical `git.gitignore.ensureGitignoreEntries()`

#### Missing: Branch Change Events
- No automatic .gitignore updates when user changes branches in VS Code
- This is the core problem identified in the task

## Proposed Consolidation Plan

### Phase 1: Consolidate Functions
1. **Keep**: `git/core/gitignore.ts:ensureGitignoreEntries()` as canonical
2. **Replace**: `core/planInitialization.ts:ensureGitignoreEntries()` with async canonical version
3. **Evaluate**: Whether `git/orchestrator.ts:ensureGitignorePatterns()` can use canonical function
4. **Deprecate**: `git/core/repository.ts:ensureGitignore()` (test-only usage)

### Phase 2: Add Branch Change Detection
1. **Add Git API integration** to monitor branch changes
2. **Add automatic .gitignore update** on branch change events
3. **Test with common workflows**:
   - Branch switching via VS Code Git UI
   - Branch switching via integrated terminal
   - Branch switching via external git commands

### Phase 3: Verification
1. **Unit tests** for branch change detection
2. **Integration tests** for .gitignore updates across branch changes
3. **Manual testing** with common user workflows

## Implementation Priority

1. **HIGH**: Add branch change detection (core issue)
2. **MEDIUM**: Consolidate duplicate functions 
3. **LOW**: Clean up legacy functions in tests

## Files Requiring Changes

### Core Implementation
- `src/extension.ts` - Add branch change monitoring during activation
- `src/git/core/gitignore.ts` - Potential enhancements for branch-aware updates
- `src/core/planInitialization.ts` - Replace local function with canonical version

### Testing
- Add tests for branch change detection
- Update tests that use legacy gitignore functions

### Documentation  
- Update function documentation to clarify canonical vs legacy status
- Document branch change behavior in user-facing docs