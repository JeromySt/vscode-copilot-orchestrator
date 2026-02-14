# Expand IGitOperations Interface and Create Implementation

## Task Summary
Expand `IGitOperations` interface by adding missing methods and sub-interfaces, then create `DefaultGitOperations` implementation and register it in DI.

## Step-by-Step Plan

1. **Add IGitGitignore sub-interface** to `src/interfaces/IGitOperations.ts`
   - Add 4 methods: `ensureGitignoreEntries`, `isIgnored`, `isOrchestratorGitIgnoreConfigured`, `ensureOrchestratorGitIgnore`

2. **Add missing worktree methods** to `IGitWorktrees`
   - Add `createOrReuseDetached`, `createDetachedWithTiming`, `createWithTiming`
   - Import needed types like `CreateTiming`

3. **Add missing merge methods** to `IGitMerge`
   - Add `commitTree`, `continueAfterResolve`

4. **Update IGitOperations** to include `gitignore` property

5. **Create DefaultGitOperations implementation**
   - Create new file `src/git/DefaultGitOperations.ts`
   - Implement all methods by delegating to corresponding module functions

6. **Register in DI container**
   - Update `src/composition.ts` to register `DefaultGitOperations`

7. **Export from git module**
   - Update `src/git/index.ts` to export `DefaultGitOperations`

8. **Verify compilation**
   - Run `npx tsc --noEmit` to ensure everything compiles

## Discovered Method Signatures

### Worktree Methods
- `createWithTiming(options: CreateOptions): Promise<CreateTiming>`
- `createDetachedWithTiming(repoPath: string, worktreePath: string, commitish: string, log?: GitLogger, additionalSymlinkDirs?: string[]): Promise<CreateTiming & { baseCommit: string }>`
- `createOrReuseDetached(repoPath: string, worktreePath: string, commitish: string, log?: GitLogger, additionalSymlinkDirs?: string[]): Promise<CreateTiming & { baseCommit: string; reused: boolean }>`

### Merge Methods
- `commitTree(treeSha: string, parents: string[], message: string, repoPath: string, log?: GitLogger): Promise<string>`
- `continueAfterResolve(cwd: string, message: string, log?: GitLogger): Promise<boolean>`

### Gitignore Methods
- `ensureGitignoreEntries(repoPath: string, entries?: string[], logger?: GitLogger): Promise<boolean>`
- `isIgnored(repoPath: string, relativePath: string): Promise<boolean>`
- `isOrchestratorGitIgnoreConfigured(workspaceRoot: string): Promise<boolean>`
- `ensureOrchestratorGitIgnore(workspaceRoot: string): Promise<boolean>`