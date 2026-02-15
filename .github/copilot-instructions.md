# Copilot Instructions — Copilot Orchestrator

This VS Code extension orchestrates parallel GitHub Copilot agents via DAG-based plans executed in isolated git worktrees. Follow these patterns strictly.

## Architecture Overview

```
Extension.ts → createContainer() → DI Container (ServiceContainer)
  ├─ PlanRunner (orchestrator, delegates to sub-modules)
  │   ├─ JobExecutionEngine (7-phase node lifecycle)
  │   ├─ ExecutionPump (scheduling loop, concurrency)
  │   ├─ PlanEventEmitter (typed pub/sub for UI)
  │   └─ PlanPersistence (state save/load)
  ├─ MCP Server (stdio JSON-RPC → IPC bridge → tool handlers)
  ├─ AgentDelegator (spawns Copilot CLI in worktrees)
  └─ UI Layer (TreeView, Webview panels, status bar)
```

## Dependency Injection (MANDATORY)

Every new service **must** follow the DI pattern. Never use `new ConcreteClass()` directly outside of `composition.ts`.

### Adding a new service (checklist):
1. **Define interface** in `src/interfaces/IMyService.ts` with `export interface IMyService { ... }`
2. **Create Symbol token** in `src/core/tokens.ts`: `export const IMyService = Symbol('IMyService');`
3. **Export from barrel** in `src/interfaces/index.ts`
4. **Implement** the concrete class (constructor takes DI dependencies as interfaces)
5. **Register** in `src/composition.ts` via `container.registerSingleton()` or `container.register()`
6. **Resolve** via `container.resolve<IMyService>(Tokens.IMyService)` — never import concrete class

### Pattern:
```typescript
// src/interfaces/IMyService.ts
export interface IMyService {
  doWork(input: string): Promise<Result>;
}

// src/core/tokens.ts
export const IMyService = Symbol('IMyService');

// src/myModule/myService.ts
export class DefaultMyService implements IMyService {
  constructor(
    private readonly logger: ILogger,
    private readonly config: IConfigProvider,
  ) {}
  async doWork(input: string): Promise<Result> { ... }
}

// src/composition.ts
container.registerSingleton<IMyService>(Tokens.IMyService, (c) => {
  const logger = c.resolve<ILogger>(Tokens.ILogger);
  const config = c.resolve<IConfigProvider>(Tokens.IConfigProvider);
  return new DefaultMyService(logger, config);
});
```

### Existing DI Tokens (use these, don't create duplicates):
`ILogger`, `IGitOperations`, `IProcessMonitor`, `IConfigProvider`, `IDialogService`,
`IClipboardService`, `IPulseEmitter`, `IProcessSpawner`, `ICopilotRunner`,
`IEnvironment`, `IGlobalCapacity`, `IPlanConfigManager`, `IEvidenceValidator`,
`IMcpManager`, `INodeRunner`, `INodeExecutor`, `INodeStateMachine`, `IFileSystem`

## VS Code API Abstraction (MANDATORY)

**Never call `vscode.*` APIs directly** in business logic. Use the adapter interfaces:

| VS Code API | Use Instead |
|---|---|
| `vscode.workspace.getConfiguration()` | `IConfigProvider.getConfig(section, key, default)` |
| `vscode.window.showInformationMessage()` | `IDialogService.showInfo()` |
| `vscode.window.showErrorMessage()` | `IDialogService.showError()` |
| `vscode.window.showQuickPick()` | `IDialogService.showQuickPick()` |
| `vscode.env.clipboard.writeText()` | `IClipboardService.writeText()` |
| `process.env`, `process.platform` | `IEnvironment.env`, `IEnvironment.platform` |
| `child_process.spawn()` | `IProcessSpawner.spawn()` |

Only `src/vscode/adapters.ts`, `src/extension.ts`, and `src/composition.ts` may import `vscode` directly.

## Logging

Use the component-scoped logger pattern:
```typescript
const log = Logger.for('my-component');  // component names: see Logger COMPONENTS list
log.info('Started processing', { planId });
log.debug('Details', data);
log.warn('Retrying', { attempt });
log.error('Failed', { error: err.message });
```

Component names: `mcp`, `http`, `jobs`, `plans`, `git`, `ui`, `extension`, `scheduler`,
`plan`, `plan-runner`, `plan-state`, `plan-persistence`, `job-executor`, `init`, `global-capacity`

Config: `copilotOrchestrator.logging.level` (global), `copilotOrchestrator.logging.debug.<component>` (per-component)

## Event System

Two event patterns exist — use the correct one:

1. **PlanEventEmitter** (typed, Node EventEmitter) — for plan lifecycle: `planCreated`, `planStarted`, `nodeTransition`, `nodeCompleted`, etc.
2. **EventBus** (lightweight pub/sub) — for webview UI communication, zero-dependency

Both use typed overloads. Always emit/subscribe via typed helpers, never raw strings.

## Code Coverage

- **95% line coverage enforced** via c8 (`.c8rc.json`)
- Every new source file in `src/` (except `src/test/`) must have corresponding unit tests
- Run: `npm run test:coverage` to verify locally before pushing
- Coverage is checked on PR CI only (not push CI)

## Build & Test Commands

```bash
npm run compile:tsc    # TypeScript compilation (tsc → out/)
npm run compile        # Full build (compile:tsc)
npm run test:unit      # Mocha TDD unit tests (headless, no VS Code)
npm run test:coverage  # Unit tests + c8 coverage check (95% threshold)
npm run package        # esbuild production bundle (dist/extension.js)
```

## Security Patterns

- **Agent sandbox**: Agents run in worktrees with `--add-dir` for allowed directories only
- **Network**: No default URL access; explicit `--allow-url` per allowlisted URL
- **Path validation**: All user-provided paths must be validated against traversal (resolve + startsWith check)
- **Nonce auth**: MCP stdio↔IPC uses nonce-based 1:1 pairing

## File Organization

```
src/
├── core/         # DI container, tokens, logger, config, pulse, power mgmt
├── interfaces/   # All DI interface definitions (one per file)
├── vscode/       # VS Code API adapters (thin wrappers)
├── plan/         # Execution engine, phases, state machine, persistence
├── agent/        # Copilot CLI runner, model discovery, delegation
├── mcp/          # MCP server, handlers, tools, validation
├── git/          # Worktree management, branch ops, merge helpers
├── ui/           # TreeView, Webview panels, status bar
├── process/      # OS process monitoring
├── commands/     # VS Code command registrations
└── test/         # unit/ (headless), suite/ (VS Code host)
```

## Agent Skills

This repository includes specialized skills in `.github/skills/` for detailed task-specific guidance.
Load the relevant skill when performing these tasks:

| Task | Skill |
|---|---|
| Writing or fixing tests | `.github/skills/test-writer/SKILL.md` |
| Adding services, interfaces, or DI wiring | `.github/skills/di-refactor/SKILL.md` |
| Security review, path validation, sandboxing | `.github/skills/security-hardener/SKILL.md` |
| Fixing failed build/test/phase errors | `.github/skills/auto-heal/SKILL.md` |
| Writing or updating documentation | `.github/skills/documentation-writer/SKILL.md` |
