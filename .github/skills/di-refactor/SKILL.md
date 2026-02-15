---
name: di-refactor
description: Refactoring code to use the dependency injection architecture. Use when asked to add services, create interfaces, wire DI, refactor to use abstractions, or remove direct vscode API calls from business logic.
---

# DI Refactoring Guide

## The DI Pipeline (follow every step)

### Step 1: Define the Interface

Create `src/interfaces/IMyService.ts`:
```typescript
export interface IMyService {
  doWork(input: string): Promise<Result>;
  getStatus(): ServiceStatus;
}
```

### Step 2: Create the Symbol Token

Add to `src/core/tokens.ts`:
```typescript
export const IMyService = Symbol('IMyService');
```

### Step 3: Export from Barrel

Add to `src/interfaces/index.ts`:
```typescript
export { IMyService } from './IMyService';
```

### Step 4: Implement the Concrete Class

Constructor accepts **interfaces** via DI, never concrete classes:
```typescript
export class DefaultMyService implements IMyService {
  constructor(
    private readonly logger: ILogger,
    private readonly config: IConfigProvider,
  ) {}
  
  async doWork(input: string): Promise<Result> {
    this.logger.info('Processing', { input });
    // implementation
  }
}
```

### Step 5: Register in Composition Root

Add to `src/composition.ts`:
```typescript
container.registerSingleton<IMyService>(Tokens.IMyService, (c) => {
  const logger = c.resolve<ILogger>(Tokens.ILogger);
  const config = c.resolve<IConfigProvider>(Tokens.IConfigProvider);
  return new DefaultMyService(logger, config);
});
```

### Step 6: Resolve (never `new` in business logic)

```typescript
const myService = container.resolve<IMyService>(Tokens.IMyService);
```

## VS Code API Abstraction

**Never call `vscode.*` in business logic.** Use adapter interfaces:

| Direct API | Use Instead |
|---|---|
| `vscode.workspace.getConfiguration()` | `IConfigProvider.getConfig(section, key, default)` |
| `vscode.window.showInformationMessage()` | `IDialogService.showInfo()` |
| `vscode.window.showErrorMessage()` | `IDialogService.showError()` |
| `vscode.env.clipboard.writeText()` | `IClipboardService.writeText()` |
| `process.env` / `process.platform` | `IEnvironment.env` / `IEnvironment.platform` |
| `child_process.spawn()` | `IProcessSpawner.spawn()` |

Only these files may import `vscode` directly:
- `src/vscode/adapters.ts`, `src/extension.ts`, `src/composition.ts`, `src/ui/**`

## Existing Tokens (don't duplicate)

`ILogger`, `IGitOperations`, `IProcessMonitor`, `IConfigProvider`, `IDialogService`,
`IClipboardService`, `IPulseEmitter`, `IProcessSpawner`, `ICopilotRunner`,
`IEnvironment`, `IGlobalCapacity`, `IPlanConfigManager`, `IEvidenceValidator`,
`IMcpManager`, `INodeRunner`, `INodeExecutor`, `INodeStateMachine`, `IFileSystem`

## Logger Pattern

The one acceptable service locator — static factory initialized in composition root:
```typescript
const log = Logger.for('my-component');
log.info('Started', { context });
```

## Checklist

- [ ] Interface defined in `src/interfaces/`
- [ ] Token created in `src/core/tokens.ts`
- [ ] Exported from `src/interfaces/index.ts`
- [ ] Constructor takes interfaces, not concrete classes
- [ ] Registered in `src/composition.ts`
- [ ] No `new ConcreteClass()` in business logic
- [ ] No direct `vscode.*` calls in business logic
- [ ] Unit tests mock via interfaces
