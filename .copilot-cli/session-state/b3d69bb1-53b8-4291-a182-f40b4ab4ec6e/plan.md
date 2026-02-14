# Refactor executor.ts and executionEngine.ts for DI

## Changes

### executor.ts
1. Replace `import type { ChildProcess } from 'child_process'` with `ChildProcessLike` from IProcessSpawner
2. Remove `import { ProcessMonitor } from '../process'` and `import { DefaultEvidenceValidator }`
3. Add `import type { IProcessMonitor }` 
4. Update constructor to accept `evidenceValidator` and `processMonitor`
5. Update `ActiveExecution.process` type to `ChildProcessLike`

### executionEngine.ts
1. Add `import * as fs from 'fs'` at top, remove inline `require('fs')` and `require('path')`
2. Replace `import { CopilotCliRunner, CopilotCliLogger }` with `import type { ICopilotRunner }`
3. Add `copilotRunner?` to `ExecutionEngineState`
4. Replace `new CopilotCliRunner(cliLogger)` with `this.state.copilotRunner`

### Supporting files
- composition.ts: Pass evidenceValidator + processMonitor to DefaultJobExecutor
- planInitialization.ts: Same + resolve copilotRunner from DI, pass to PlanRunner
- planLifecycle.ts: Add `copilotRunner?` to PlanRunnerState
- runner.ts: Add setCopilotRunner method
- eslint.config.js: Remove executor.ts and executionEngine.ts from TODO list
