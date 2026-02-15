---
applyTo: "src/**/*.ts,!src/test/**"
---

# Source Code Conventions

> **Detailed guides**: See `.github/skills/di-refactor/SKILL.md` for the full DI pipeline and `.github/skills/security-hardener/SKILL.md` for security patterns.

## TypeScript Patterns

- **Strict mode**: `tsconfig.json` has strict checks enabled
- **Module system**: CommonJS (`module: "commonjs"`)
- **Target**: ES2022
- **Imports**: Use `import type` for type-only imports to reduce bundle size
- **No default exports**: Use named exports exclusively

## Dependency Injection — Every New Service

When creating or modifying source files outside of tests:

1. **Accept dependencies via interfaces**, not concrete classes
2. **Constructor injection** for class-based services
3. **Function parameter injection** for standalone functions
4. **Never call `new ConcreteService()`** outside `composition.ts`

```typescript
// ✅ Correct: Accept interface, resolve from container
export class MyService {
  constructor(
    private readonly logger: ILogger,
    private readonly config: IConfigProvider,
  ) {}
}

// ❌ Wrong: Direct instantiation in business logic
import { Logger } from '../core/logger';
const logger = new Logger();
```

### Exception: Logger.for() static factory
The logger uses a static factory pattern for component-scoped logging:
```typescript
const log = Logger.for('my-component');
```
This is the one acceptable "service locator" pattern because Logger is initialized once in the composition root.

## Error Handling

- Wrap external calls (fs, child_process, git) in try/catch
- Log errors with context: `log.error('Operation failed', { planId, nodeId, error: err.message })`
- Return typed results: `{ success: boolean; error?: string }` — don't throw for expected failures
- Use `try { ... } catch { /* ignore */ }` only for truly non-critical operations (e.g., cleanup)

## Event Emission

When emitting plan events, use the typed helper methods on `PlanEventEmitter`:
```typescript
this._events.emitNodeTransition({ planId, nodeId, from, to, timestamp });
this._events.emitPlanCreated(plan);
```

For webview communication, use the `EventBus`:
```typescript
eventBus.emit('node:selected', { nodeId });
eventBus.on('plan:refresh', () => updateView());
```

## Phase Execution (Plan Engine)

Node lifecycle follows strict phase ordering:
```
merge-fi → prechecks → work → commit → postchecks → merge-ri → cleanup
```

Each phase is a separate file in `src/plan/phases/`. When adding a new phase:
1. Create `src/plan/phases/myPhase.ts`
2. Export a function matching the `PhaseExecutor` signature
3. Register in the phase dispatch in `executionEngine.ts`
4. Add unit tests covering success, failure, and skip paths

## Git Worktree Patterns

- **Detached HEAD**: Worktrees created with `--detach` (no branch tracking)
- **Forward Integration (FI)**: Merge dependency commits into worktree before work
- **Reverse Integration (RI)**: Squash-merge final commit to target branch after work only if the node is a leafNode (no downstream dependencies)
- **Never modify user's working directory**: All agent work happens in isolated worktrees

## Security

- **Path traversal**: Always validate user-provided paths with `path.resolve()` + `startsWith(repoPath + path.sep)`
- **Reject dangerous names**: `.git`, `..`, `.`, empty strings
- **Sandbox**: Agent processes get `--add-dir` for allowed directories only
- **No default network**: `--allow-url` must be explicitly specified per URL

## MCP Handler Pattern

MCP tool handlers in `src/mcp/handlers/` follow this structure:
```typescript
export async function handleMyTool(
  args: MyToolArgs,
  ctx: McpContext,
): Promise<McpResult> {
  // 1. Validate inputs
  if (!args.planId) return { content: [{ type: 'text', text: 'Error: planId required' }] };

  // 2. Delegate to PlanRunner (via ctx)
  const result = await ctx.PlanRunner.doSomething(args.planId);

  // 3. Return structured response
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}
```

### MCP Schema Validation (create_* tools)

All `create_copilot_plan` and `create_copilot_job` inputs are validated through a single schema validation framework:

1. **JSON Schema** in `src/mcp/validation/schemas.ts` — Ajv validates structure, types, required fields, patterns
2. **Semantic validation** in handler (`validatePlanInput()`) — dependency resolution, duplicate producer_ids, group flattening
3. **Security validation** — `validateAllowedFolders()`, `validateAllowedUrls()`, `validateAgentModels()`, `validateAdditionalSymlinkDirs()`

When adding new fields to `create_*` APIs:
1. Add the field to the TypeScript interface in `schemas.ts`
2. Add the JSON schema property in the corresponding schema object
3. Add the field to the MCP tool `inputSchema` in `planTools.ts`
4. Add validation in the handler if the field requires semantic/security checks
5. Wire through to `PlanSpec` in `src/plan/types/plan.ts`
6. Add to `_buildPlanData()` / handler response if it needs to flow to the client

## Code Organization Rules

- One interface per file in `src/interfaces/`
- Barrel export from `src/interfaces/index.ts`
- One token per service in `src/core/tokens.ts`
- Registration in `src/composition.ts` only
- UI components never import plan engine internals directly — communicate via events
