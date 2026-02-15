# ESLint Error Fixes

## 13 Errors to Fix

1. **src/agent/modelDiscovery.ts:249** - `new DefaultProcessSpawner()` - Accept IProcessSpawner via constructor
2. **src/core/planInitialization.ts:177** - `new PlanConfigManager()` - Add to ESLint exemption alongside composition.ts  
3. **src/core/planInitialization.ts:178** - `new PlanPersistence()` - Add to ESLint exemption alongside composition.ts
4. **src/core/planInitialization.ts:180** - `new PlanStateMachine()` - Add to ESLint exemption alongside composition.ts
5. **src/core/planInitialization.ts:256** - `new McpHandler()` - Add to ESLint exemption alongside composition.ts
6. **src/extension.ts:29** - `import './git/branchWatcher'` - Add to git import exemption or refactor
7. **src/extension.ts:30** - `import './git/core/gitignore'` - Add to git import exemption or refactor
8. **src/git/core/executor.ts:14** - `import 'child_process'` - Add child_process exemption to git/core block
9. **src/interfaces/IGitOperations.ts:11** - `import '../git'` - Change to `import type` or add to exemption
10. **src/interfaces/IGitOperations.ts:22** - `import '../git/core/worktrees'` - Change to `import type` or add to exemption
11. **src/interfaces/IPhaseExecutor.ts:18** - `import 'child_process'` - Change to `import type { ChildProcess }`
12. **src/plan/phases/mergeHelper.ts:95** - `new CopilotCliRunner()` - Accept ICopilotRunner via parameter
13. **src/ui/plansViewProvider.ts:141** - `setInterval()` - Replace with IPulseEmitter subscription

## Approach

Follow the instruction file guidance:
- Items 2-5: Add planInitialization.ts to ESLint exemption (composition root equivalent)
- Items 6-7: Add extension.ts to git import exemption (entry point)
- Item 8: Modify git/core exemption to include child_process
- Items 9-11: Use `import type` syntax to avoid runtime imports
- Items 1,12,13: Code refactoring to use DI/proper patterns