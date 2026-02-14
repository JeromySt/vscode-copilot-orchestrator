# Refactor Plan: IGitOperations DI

## Task Overview
Refactor all consumers to use `IGitOperations` from dependency injection instead of direct git imports.

## Implementation Strategy

### Phase 1: Understand Current Structure
1. Examine the `IGitOperations` interface and `DefaultGitOperations` implementation
2. Check composition.ts to see DI registration
3. Review the `phaseDeps()` pattern in `src/plan/executor.ts`

### Phase 2: Core Files (Primary refactoring targets)
1. **src/plan/executor.ts** - Update `phaseDeps()` to include `git: IGitOperations`
2. **src/plan/executionEngine.ts** - Add git parameter to constructor
3. **src/plan/planLifecycle.ts** - Add git parameter to constructor
4. **src/plan/nodeManager.ts** - Add git parameter
5. **src/plan/workSummaryHelper.ts** - Add git parameter

### Phase 3: Phase Executors
6. **src/plan/phases/commitPhase.ts** - Update to receive git from phaseDeps
7. **src/plan/phases/mergeFiPhase.ts** - Update to receive git from phaseDeps
8. **src/plan/phases/mergeRiPhase.ts** - Update to receive git from phaseDeps
9. **src/plan/phases/mergeHelper.ts** (if applicable)

### Phase 4: Other Consumers
10. **src/core/orphanedWorktreeCleanup.ts**
11. **src/agent/agentDelegator.ts**
12. **src/core/planInitialization.ts**
13. **src/mcp/handlers/utils.ts**
14. **src/mcp/handlers/plan/createPlanHandler.ts**

### Phase 5: Update Composition and Callers
- Update `composition.ts` to pass git to all constructors
- Update `planInitialization.ts` calls

### Phase 6: Verification
- Run `npx tsc --noEmit`
- Run eslint on all modified files
- Fix any remaining issues

## Pattern for Each File Type

### Classes with Constructors
```typescript
// Remove: import * as git from '../git';
// Add: import type { IGitOperations } from '../interfaces/IGitOperations';

constructor(
  // existing params...
  private readonly git: IGitOperations
) {
  // constructor body unchanged
}

// Replace all `git.xxx` calls with `this.git.xxx`
```

### Phase Executors (receive via phaseDeps)
```typescript
// Constructor receives deps object containing git
constructor(private readonly deps: { git: IGitOperations; /* other deps */ }) {}

// Use: this.deps.git.xxx instead of git.xxx
```

### Standalone Functions
```typescript
// Add git parameter
function myFunction(
  // existing params...
  git: IGitOperations
): Promise<result> {
  // use git.xxx instead of imported git.xxx
}
```