# Dependency Injection Guide

> Adding services, registration patterns, and mocking strategies for Copilot Orchestrator

## Overview

Copilot Orchestrator uses a Symbol-based dependency injection container to manage service lifecycle, enable testability, and provide clean separation of concerns. This guide covers adding new services, registration patterns, mocking strategies, and best practices.

---

## Table of Contents

- [Container Architecture](#container-architecture)
- [Service Registration](#service-registration)
- [Interface Design](#interface-design)
- [Adding New Services](#adding-new-services)
- [Testing with DI](#testing-with-di)
- [Composition Roots](#composition-roots)
- [Advanced Patterns](#advanced-patterns)
- [Best Practices](#best-practices)

---

## Container Architecture

### Core Components

| Component | File | Purpose |
|-----------|------|---------|
| **ServiceContainer** | `src/core/container.ts` | Type-safe DI container with Symbol tokens |
| **Tokens** | `src/core/tokens.ts` | Symbol-based service registration keys |
| **Production Root** | `src/composition.ts` | Wires real implementations for production |
| **Test Root** | `src/compositionTest.ts` | Wires mock implementations for testing |

### Container Features

```typescript
// Symbol-based type safety
const container = new ServiceContainer();

// Singleton registration (cached after first resolve)
container.registerSingleton(Tokens.ILogger, (c) => new Logger());

// Transient registration (new instance each time)
container.register(Tokens.IValidator, (c) => new DataValidator());

// Scoped containers (inherit parent registrations)
const childScope = container.createScope();

// Dependency resolution with automatic injection
const logger = container.resolve<ILogger>(Tokens.ILogger);
```

---

## Service Registration

### Registration Types

#### Singleton Services
Use for stateful services that should be shared across the application:

```typescript
// Logger - maintains state and OutputChannel
container.registerSingleton<ILogger>(Tokens.ILogger, (c) => {
  const logger = Logger.initialize(context);
  const configProvider = c.resolve<IConfigProvider>(Tokens.IConfigProvider);
  logger.setConfigProvider(configProvider);
  return logger;
});

// Process Monitor - caches process snapshots
container.registerSingleton<IProcessMonitor>(
  Tokens.IProcessMonitor,
  () => new ProcessMonitor()
);
```

#### Transient Services
Use for stateless services or when you need fresh instances:

```typescript
// Evidence Validator - stateless validation logic
container.register<IEvidenceValidator>(
  Tokens.IEvidenceValidator,
  () => new DefaultEvidenceValidator()
);
```

### Service Factory Patterns

#### Simple Factory
For services with no dependencies:

```typescript
container.register<IFileSystem>(
  Tokens.IFileSystem,
  () => new NodeFileSystem()
);
```

#### Container-based Factory
For services that depend on other services:

```typescript
container.register<IGitOperations>(Tokens.IGitOperations, (c) => {
  const logger = c.resolve<ILogger>(Tokens.ILogger);
  const processMonitor = c.resolve<IProcessMonitor>(Tokens.IProcessMonitor);
  
  return new GitOperationsImpl(logger, processMonitor);
});
```

#### Configuration-based Factory
For services that need VS Code context or configuration:

```typescript
container.registerSingleton<IConfigProvider>(
  Tokens.IConfigProvider,
  () => new VsCodeConfigProvider()
);

container.registerSingleton<IDialogService>(
  Tokens.IDialogService,
  () => new VsCodeDialogService()
);
```

---

## Interface Design

### Interface Conventions

#### Naming
- Prefix interfaces with `I`: `ILogger`, `IConfigProvider`
- Use descriptive names that indicate capability: `IProcessMonitor`, `IEvidenceValidator`
- Group related operations: `IGitOperations` contains `branches`, `worktrees`, `merge`

#### Structure
```typescript
/**
 * @fileoverview Interface for [capability description].
 * 
 * [Brief description of what this abstraction provides and why it exists]
 * 
 * @module interfaces/IMyService
 */

/**
 * Interface for [specific capability].
 * 
 * [More detailed description, usage patterns, and examples]
 * 
 * @example
 * ```typescript
 * class MyComponent {
 *   constructor(private readonly service: IMyService) {}
 *   
 *   async doWork(): Promise<void> {
 *     await this.service.performOperation();
 *   }
 * }
 * ```
 */
export interface IMyService {
  /**
   * [Method description].
   * 
   * @param param - Parameter description
   * @returns Description of return value
   */
  performOperation(param: string): Promise<boolean>;
}
```

### Granularity Guidelines

#### Fine-grained Interfaces
For specific capabilities that can be mocked independently:

```typescript
interface IConfigProvider {
  getConfig<T>(section: string, key: string, defaultValue: T): T;
}

interface IDialogService {
  showInfo(message: string): Promise<void>;
  showError(message: string): Promise<void>;
  showWarning(message: string, options?: any, ...actions: string[]): Promise<string | undefined>;
}
```

#### Composed Interfaces
For complex operations that logically belong together:

```typescript
interface IGitOperations {
  readonly branches: IGitBranches;
  readonly worktrees: IGitWorktrees; 
  readonly merge: IGitMerge;
  readonly repository: IGitRepository;
  readonly executor: IGitExecutor;
}
```

---

## Adding New Services

### Step 1: Define the Interface

Create the interface file in `src/interfaces/`:

```typescript
// src/interfaces/IMyNewService.ts
/**
 * @fileoverview Interface for my new service capability.
 */

export interface IMyNewService {
  /**
   * Primary service operation.
   */
  processData(input: string): Promise<ProcessResult>;
  
  /**
   * Service configuration.
   */
  configure(options: ServiceOptions): void;
  
  /**
   * Health check for monitoring.
   */
  isHealthy(): boolean;
}

export interface ProcessResult {
  success: boolean;
  data?: any;
  error?: string;
}

export interface ServiceOptions {
  timeout: number;
  retryCount: number;
}
```

### Step 2: Add Token

Register a Symbol token in `src/core/tokens.ts`:

```typescript
/**
 * Token for IMyNewService service.
 * Provides [description of capability].
 */
export const IMyNewService = Symbol('IMyNewService');
```

### Step 3: Create Implementation

Implement the interface in the appropriate module:

```typescript
// src/myModule/myNewService.ts
import type { IMyNewService, ProcessResult, ServiceOptions } from '../interfaces';
import type { ILogger, IConfigProvider } from '../interfaces';
import { Logger } from '../core/logger';

export class MyNewServiceImpl implements IMyNewService {
  private readonly logger: ILogger;
  private options: ServiceOptions;

  constructor(
    private readonly configProvider: IConfigProvider,
    logger?: ILogger
  ) {
    this.logger = logger || Logger.for('my-service');
    this.options = this.loadDefaultOptions();
  }

  async processData(input: string): Promise<ProcessResult> {
    this.logger.info('Processing data', { inputLength: input.length });
    
    try {
      // Implementation logic here
      const result = await this.performProcessing(input);
      
      this.logger.debug('Processing completed', result);
      return { success: true, data: result };
    } catch (error) {
      this.logger.error('Processing failed', error);
      return { success: false, error: error.message };
    }
  }

  configure(options: ServiceOptions): void {
    this.options = { ...this.options, ...options };
    this.logger.info('Service configured', options);
  }

  isHealthy(): boolean {
    // Health check logic
    return true;
  }

  private loadDefaultOptions(): ServiceOptions {
    return {
      timeout: this.configProvider.getConfig('myExtension', 'timeout', 5000),
      retryCount: this.configProvider.getConfig('myExtension', 'retries', 3)
    };
  }

  private async performProcessing(input: string): Promise<any> {
    // Core processing logic
    return { processed: input.toUpperCase() };
  }
}
```

### Step 4: Register in Production

Add registration in `src/composition.ts`:

```typescript
// Add import
import { MyNewServiceImpl } from './myModule/myNewService';

export function createContainer(context: vscode.ExtensionContext): ServiceContainer {
  const container = new ServiceContainer();

  // ... existing registrations ...

  // Register new service
  container.registerSingleton<IMyNewService>(
    Tokens.IMyNewService,
    (c) => {
      const configProvider = c.resolve<IConfigProvider>(Tokens.IConfigProvider);
      const logger = c.resolve<Logger>(Tokens.ILogger);
      return new MyNewServiceImpl(configProvider, logger.for('my-service'));
    }
  );

  return container;
}
```

### Step 5: Create Mock for Testing

Add mock implementation in `src/vscode/testAdapters.ts`:

```typescript
export class MockMyNewService implements IMyNewService {
  private calls: Array<{ method: string; args: any[] }> = [];
  private responses: Map<string, any> = new Map();
  private health = true;

  async processData(input: string): Promise<ProcessResult> {
    this.calls.push({ method: 'processData', args: [input] });
    
    const response = this.responses.get('processData') || { success: true, data: { processed: input } };
    return response;
  }

  configure(options: ServiceOptions): void {
    this.calls.push({ method: 'configure', args: [options] });
  }

  isHealthy(): boolean {
    this.calls.push({ method: 'isHealthy', args: [] });
    return this.health;
  }

  // Test helper methods
  setProcessDataResponse(response: ProcessResult): void {
    this.responses.set('processData', response);
  }

  setHealth(healthy: boolean): void {
    this.health = healthy;
  }

  getCalls(): Array<{ method: string; args: any[] }> {
    return [...this.calls];
  }

  reset(): void {
    this.calls = [];
    this.responses.clear();
    this.health = true;
  }
}
```

### Step 6: Register Mock in Test Root

Add to `src/compositionTest.ts`:

```typescript
import { MockMyNewService } from './vscode/testAdapters';

export function createTestContainer(): ServiceContainer {
  const container = new ServiceContainer();

  // ... existing mock registrations ...

  // Register mock service
  container.registerSingleton<IMyNewService>(
    Tokens.IMyNewService,
    () => new MockMyNewService()
  );

  return container;
}
```

---

## Testing with DI

### Test Setup Pattern

```typescript
import { createTestContainer } from '../../../src/compositionTest';
import * as Tokens from '../../../src/core/tokens';
import type { MockMyNewService } from '../../../src/vscode/testAdapters';

suite('MyComponent Tests', () => {
  let container: ServiceContainer;
  let mockService: MockMyNewService;
  let component: MyComponent;

  setup(() => {
    container = createTestContainer();
    mockService = container.resolve(Tokens.IMyNewService) as MockMyNewService;
    
    // Additional setup if needed
    mockService.reset();
    
    component = new MyComponent(
      container.resolve(Tokens.IMyNewService),
      container.resolve(Tokens.ILogger)
    );
  });

  test('should process data successfully', async () => {
    // Arrange
    const input = 'test data';
    const expectedResult = { success: true, data: { processed: 'TEST DATA' } };
    mockService.setProcessDataResponse(expectedResult);

    // Act
    const result = await component.handleInput(input);

    // Assert
    assert.equal(result.success, true);
    
    const calls = mockService.getCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'processData');
    assert.deepEqual(calls[0].args, [input]);
  });
});
```

### Mock Verification Patterns

#### Call Tracking
```typescript
test('should call service with correct parameters', () => {
  component.initialize({ timeout: 1000 });
  
  const calls = mockService.getCalls();
  const configCall = calls.find(c => c.method === 'configure');
  
  assert(configCall, 'Should call configure');
  assert.equal(configCall.args[0].timeout, 1000);
});
```

#### Response Mocking
```typescript
test('should handle service errors gracefully', async () => {
  mockService.setProcessDataResponse({
    success: false,
    error: 'Processing failed'
  });

  const result = await component.handleInput('test');
  
  assert.equal(result.success, false);
  assert.match(result.error, /processing failed/i);
});
```

#### State Verification
```typescript
test('should check service health', () => {
  mockService.setHealth(false);
  
  const status = component.getStatus();
  
  assert.equal(status.healthy, false);
});
```

---

## Composition Roots

### Production Composition (`src/composition.ts`)

The production composition root wires real implementations:

```typescript
export function createContainer(context: vscode.ExtensionContext): ServiceContainer {
  const container = new ServiceContainer();

  // ── VS Code Adapter Services ──
  // Abstracts VS Code APIs for testability
  container.registerSingleton<IConfigProvider>(/*...*/);
  container.registerSingleton<IDialogService>(/*...*/);
  container.registerSingleton<IClipboardService>(/*...*/);

  // ── Infrastructure Services ──
  // Core system capabilities
  container.registerSingleton<IProcessMonitor>(/*...*/);
  container.registerSingleton<ILogger>(/*...*/);

  // ── Domain Services ──
  // Business logic implementations
  container.register<IEvidenceValidator>(/*...*/);
  container.register<IGitOperations>(/*...*/);

  return container;
}
```

### Test Composition (`src/compositionTest.ts`)

The test composition root wires mock implementations:

```typescript
export function createTestContainer(): ServiceContainer {
  const container = new ServiceContainer();

  // ── Mock Adapters ──
  // Controllable test doubles
  container.registerSingleton<IConfigProvider>(
    Tokens.IConfigProvider,
    () => new MockConfigProvider()
  );

  container.registerSingleton<IDialogService>(
    Tokens.IDialogService,
    () => new MockDialogService()
  );

  // ── Test Helpers ──
  // Special test-only services
  container.registerSingleton<ILogger>(
    Tokens.ILogger,
    () => new TestLogger()
  );

  return container;
}
```

### Composition Guidelines

1. **Single Responsibility**: Each composition root handles one environment
2. **Complete Coverage**: Every interface must be registered
3. **Consistent Patterns**: Use similar registration patterns across services
4. **Documentation**: Comment complex factory functions
5. **Validation**: Verify all dependencies can be resolved

---

## Advanced Patterns

### Scoped Containers

Use child containers for isolated subsystems:

```typescript
class PlanRunner {
  private planContainers = new Map<string, ServiceContainer>();

  private createPlanScope(planId: string): ServiceContainer {
    const planContainer = this.container.createScope();
    
    // Register plan-specific services
    planContainer.register<IPlanContext>(
      Tokens.IPlanContext,
      () => new PlanContext(planId)
    );
    
    this.planContainers.set(planId, planContainer);
    return planContainer;
  }

  private cleanupPlanScope(planId: string): void {
    this.planContainers.delete(planId);
  }
}
```

### Conditional Registration

Register different implementations based on environment:

```typescript
export function createContainer(context: vscode.ExtensionContext): ServiceContainer {
  const container = new ServiceContainer();

  // Use different git implementation based on availability
  if (isGitAvailable()) {
    container.register<IGitOperations>(
      Tokens.IGitOperations,
      () => new RealGitOperations()
    );
  } else {
    container.register<IGitOperations>(
      Tokens.IGitOperations,
      () => new FallbackGitOperations()
    );
  }

  return container;
}
```

### Lazy Initialization

Defer expensive service creation until needed:

```typescript
container.registerSingleton<IExpensiveService>(
  Tokens.IExpensiveService,
  (c) => {
    return new LazyWrapper(() => {
      const config = c.resolve<IConfigProvider>(Tokens.IConfigProvider);
      return new ExpensiveServiceImpl(config);
    });
  }
);
```

### Service Decorators

Wrap services with additional behavior:

```typescript
container.register<ILogger>(
  Tokens.ILogger,
  (c) => {
    const baseLogger = new BaseLogger();
    const configProvider = c.resolve<IConfigProvider>(Tokens.IConfigProvider);
    
    if (configProvider.getConfig('app', 'enableMetrics', false)) {
      return new MetricsLoggingDecorator(baseLogger);
    }
    
    return baseLogger;
  }
);
```

---

## Best Practices

### Interface Design

1. **Single Purpose**: Each interface should have one clear responsibility
2. **Stable Contracts**: Interfaces should change infrequently
3. **Async by Default**: Use Promise returns for IO operations
4. **Error Handling**: Define clear error handling patterns
5. **Documentation**: Every public method needs JSDoc

### Registration Patterns

1. **Consistent Lifecycle**: Be deliberate about singleton vs transient
2. **Minimal Dependencies**: Keep factory functions simple
3. **Fail Fast**: Register dependencies that can't be resolved
4. **Test Coverage**: Every service should be mockable
5. **Performance**: Avoid expensive operations in factories

### Testing Strategy

1. **Mock External Boundaries**: File system, network, VS Code APIs
2. **Test Real Logic**: Don't mock your own domain objects
3. **Verify Interactions**: Use call tracking for important collaborations
4. **Reset State**: Clean up mocks between tests
5. **Integration Points**: Test composition roots separately

### Error Handling

1. **Graceful Degradation**: Services should handle missing dependencies
2. **Clear Messages**: Error messages should indicate the service and issue
3. **Logging**: Log service registration and resolution failures
4. **Recovery**: Provide fallback implementations when possible
5. **Validation**: Validate service contracts at registration time

### Performance Considerations

1. **Lazy Registration**: Defer expensive services until needed
2. **Singleton Sharing**: Share expensive resources across components
3. **Memory Management**: Clean up resources in long-running services
4. **Circular Dependencies**: Design interfaces to avoid circular references
5. **Container Overhead**: Minimize container traversal in hot paths

---

This guide provides comprehensive coverage of dependency injection patterns, service registration, and testing strategies used throughout Copilot Orchestrator. For specific implementations, refer to the examples in `src/composition.ts`, `src/compositionTest.ts`, and the mock adapters in `src/vscode/testAdapters.ts`.