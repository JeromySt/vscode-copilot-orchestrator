# Testing Guide

> Comprehensive testing strategies, tools, and patterns for Copilot Orchestrator

## Overview

Copilot Orchestrator uses a multi-layered testing approach combining unit tests, integration tests, and coverage analysis. The testing architecture supports dependency injection, mock adapters, and isolated worktree operations for reliable test execution.

---

## Table of Contents

- [Testing Infrastructure](#testing-infrastructure)
- [Running Tests](#running-tests)
- [Test Organization](#test-organization)
- [Mock Adapters](#mock-adapters)
- [Testing Patterns](#testing-patterns)
- [Coverage Analysis](#coverage-analysis)
- [Node.js Compatibility](#nodejs-compatibility)
- [Debugging Tests](#debugging-tests)

---

## Testing Infrastructure

### Test Framework Stack

| Component | Purpose | Notes |
|-----------|---------|-------|
| **Mocha** | Test runner | TDD interface (`suite`, `test`) |
| **Sinon** | Mocking/stubbing | For external dependencies |
| **C8** | Coverage analysis | Istanbul-based with V8 hooks |
| **TypeScript** | Test compilation | Uses `tsconfig.json` for `out/` |

### VS Code Mock Layer

The extension includes a comprehensive VS Code API mock in `src/test/unit/mocks/vscode.ts`:

```typescript
// Register mock before importing tested modules
require('src/test/unit/register-vscode-mock.js');
import { MyExtensionClass } from '../../../src/myModule';
```

**Key mock features:**
- Event emitters for configuration changes
- Webview and panel lifecycle simulation
- Command registration/execution tracking
- File watcher simulation with controlled events

---

## Running Tests

### Quick Commands

```bash
# Run all unit tests
npm run test:unit

# Run with coverage
npm run test:coverage

# Compile only (no tests)
npm run compile:tsc

# Watch mode for development
npm run test:watch
```

### Detailed Commands

```bash
# Compile TypeScript for testing (outputs to out/)
npx tsc -p .

# Run specific test pattern
npx mocha --ui tdd --exit "out/test/unit/**/*.unit.test.js" \
  --require src/test/unit/register-vscode-mock.js

# Run tests for specific module with coverage
npx c8 --reporter=text --include=out/core/**/*.js --exclude=out/test/** \
  npx mocha --ui tdd --exit "out/test/unit/core/*.unit.test.js" \
    --require src/test/unit/register-vscode-mock.js
```

### Module-Specific Test Commands

Based on repository memories, here are verified commands for specific modules:

#### Core Module Tests
```bash
npx c8 --reporter=text --include=out/core/**/*.js --exclude=out/test/** \
  mocha --ui tdd --exit --require src/test/unit/register-vscode-mock.js \
  "out/test/unit/core/*.unit.test.js"
```

#### Plan Module Tests  
```bash
npx c8 --reporter=text --include="out/plan/**/*.js" --exclude=out/test/** \
  mocha --ui tdd --exit --timeout 60000 \
  --require src/test/unit/register-vscode-mock.js \
  "out/test/unit/plan/**/*.test.js"
```

#### Agent Module Tests
```bash
npx c8 --reporter=text --all --include=out/agent/**/*.js --exclude=out/test/** \
  npx mocha --ui tdd --exit "out/test/unit/agent/*.unit.test.js" \
  --require src/test/unit/register-vscode-mock.js
```

---

## Test Organization

### Directory Structure

```
src/test/
├── unit/                           # Unit tests
│   ├── register-vscode-mock.js     # VS Code API mock registration
│   ├── mocks/                      # Mock implementations
│   │   └── vscode.ts               # Complete VS Code API mock
│   ├── agent/                      # Agent delegation tests
│   ├── core/                       # Core functionality tests
│   │   ├── container.unit.test.ts  # DI container tests  
│   │   ├── logger.unit.test.ts     # Logging system tests
│   │   └── tokens.unit.test.ts     # DI token tests
│   ├── plan/                       # Plan execution tests
│   │   ├── builder.unit.test.ts    # DAG building tests
│   │   ├── stateMachine.unit.test.ts # State transition tests
│   │   └── scheduler.unit.test.ts  # Job scheduling tests
│   ├── git/                        # Git operations tests
│   ├── vscode/                     # VS Code adapter tests
│   │   └── testAdapters.unit.test.ts # Mock adapter tests
│   └── process/                    # Process monitoring tests
└── integration/                    # Future integration tests
```

### Test File Naming

- **Unit tests**: `*.unit.test.ts` - Test individual classes/functions in isolation
- **Integration tests**: `*.integration.test.ts` - Test component interactions
- **Mock files**: `*.mock.ts` - Reusable mock implementations

---

## Mock Adapters

### Test Adapter Architecture

The extension provides production-ready mock implementations in `src/vscode/testAdapters.ts`:

#### MockConfigProvider

```typescript
const mockConfig = new MockConfigProvider();
mockConfig.setConfig('myExtension', 'timeout', 5000);

// Test configuration reads
assert.equal(service.getTimeout(), 5000);

// Verify calls
assert.deepEqual(mockConfig.getCalls(), [
  ['myExtension', 'timeout', 5000]
]);
```

#### MockDialogService

```typescript
const mockDialogs = new MockDialogService();
mockDialogs.setQuickPickResponse(['Option 1', 'Option 2'], 'Option 1');

const result = await service.selectOption();
assert.equal(result, 'Option 1');
```

#### MockClipboardService

```typescript
const mockClipboard = new MockClipboardService();
await service.copyData('test data');

assert.deepEqual(mockClipboard.getCalls(), [
  { method: 'writeText', args: ['test data'] }
]);
```

### Creating Test Containers

Use the test composition root for dependency injection in tests:

```typescript
import { createTestContainer } from '../../../src/compositionTest';

suite('MyService Tests', () => {
  let container: ServiceContainer;
  let mockConfig: MockConfigProvider;

  setup(() => {
    container = createTestContainer();
    mockConfig = container.resolve(Tokens.IConfigProvider) as MockConfigProvider;
  });

  test('should read configuration', () => {
    mockConfig.setConfig('copilotOrchestrator', 'maxConcurrent', 4);
    
    const service = container.resolve(Tokens.IMyService);
    assert.equal(service.getMaxConcurrent(), 4);
  });
});
```

---

## Testing Patterns

### State Machine Testing

State transition validation using controlled inputs:

```typescript
test('should transition from pending to ready when dependencies met', () => {
  const plan = createTestPlan();
  const sm = new PlanStateMachine(plan);
  
  // Set up dependencies
  sm.transition('node1', 'succeeded');
  
  // Test transition
  const result = sm.transition('node2', 'ready');
  assert.equal(result, true);
  assert.equal(sm.getNodeStatus('node2'), 'ready');
});
```

### Git Operations Testing

Use real git repositories in temp directories for git operation tests:

```typescript
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

test('should create and remove worktree', async () => {
  const tempDir = mkdtempSync(join(__dirname, 'git-test-'));
  
  try {
    // Initialize repo and test git operations
    await gitExecutor.exec(['init'], { cwd: tempDir });
    
    // Test actual git commands
    const result = await worktreeOps.create({
      repoPath: tempDir,
      branch: 'feature-test',
      worktreePath: join(tempDir, 'worktrees', 'test')
    });
    
    assert.equal(result.success, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
```

### Process Monitoring Testing

Mock child process operations when Node.js APIs are not stubbable:

```typescript
function canStubSpawn(): boolean {
  const desc = Object.getOwnPropertyDescriptor(cp, 'spawn');
  return desc?.configurable === true;
}

test('process monitoring with spawn stub', function() {
  if (!canStubSpawn()) {
    this.skip(); // Skip if spawn is not configurable
    return;
  }
  
  const spawnStub = sandbox.stub(cp, 'spawn');
  // ... test with stubbed spawn
});
```

### Error Handling Testing

Test error conditions and recovery scenarios:

```typescript
test('should handle missing worktree gracefully', async () => {
  const result = await jobExecutor.execute({
    nodeId: 'test-node',
    worktreePath: '/nonexistent/path'
  });
  
  assert.equal(result.success, false);
  assert.match(result.error, /worktree not found/i);
});
```

---

## Coverage Analysis

### Coverage Commands

```bash
# Generate text coverage report
npx c8 --reporter=text npm run test:unit

# Generate HTML coverage report  
npx c8 --reporter=html npm run test:unit

# Check coverage thresholds
npx c8 --check-coverage --lines 40 npm run test:unit

# Coverage for specific module
npx c8 --include=out/plan/**/*.js --exclude=out/test/** \
  mocha "out/test/unit/plan/**/*.test.js"
```

### Coverage Configuration

C8 configuration in `package.json`:

```json
{
  "scripts": {
    "test:coverage": "npm run compile:tsc && c8 --reporter=text --reporter=lcov --check-coverage --lines 40 --all --include=out/**/*.js --exclude=out/test/** --exclude=out/ui/** --exclude=out/extension.js mocha --ui tdd --exit \"out/test/unit/**/*.unit.test.js\" --require src/test/unit/register-vscode-mock.js"
  }
}
```

### Coverage Exclusions

- `out/test/**` - Test files themselves
- `out/ui/**` - UI template code (HTML generation)
- `out/extension.js` - VS Code activation entry point
- Non-configurable Node.js APIs (when mocking fails)

---

## Node.js Compatibility

### Non-Configurable APIs

Some Node.js built-in properties cannot be stubbed with Sinon:

| API | Issue | Workaround |
|-----|-------|------------|
| `fs.existsSync` | Non-configurable | Use real temp directories |
| `fs.readdirSync` | Non-configurable | Use real file operations |
| `child_process.spawn` | Sometimes non-configurable | Check `canStubSpawn()` first |

### Testing with Real File System

For APIs that can't be mocked, use real temporary directories:

```typescript
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

test('detector with real files', () => {
  const tempDir = mkdtempSync(join(__dirname, 'test-'));
  
  try {
    // Create real files for testing
    writeFileSync(join(tempDir, 'package.json'), '{"name":"test"}');
    
    const result = detector.detectProjectType(tempDir);
    assert.equal(result.type, 'npm');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
```

---

## Debugging Tests

### Debug Configuration

VS Code debug configuration for tests:

```json
{
  "type": "node", 
  "request": "launch",
  "name": "Debug Unit Tests",
  "program": "${workspaceFolder}/node_modules/.bin/mocha",
  "args": [
    "--ui", "tdd",
    "--require", "src/test/unit/register-vscode-mock.js",  
    "out/test/unit/**/*.unit.test.js"
  ],
  "preLaunchTask": "npm: compile:tsc",
  "console": "integratedTerminal",
  "internalConsoleOptions": "neverOpen"
}
```

### Debugging Techniques

#### Isolate Test Cases

Run single test suites for focused debugging:

```bash
npx mocha --ui tdd --grep "should handle transitions" \
  "out/test/unit/plan/stateMachine.unit.test.js" \
  --require src/test/unit/register-vscode-mock.js
```

#### Mock Verification

Use mock call tracking to verify interactions:

```typescript
test('should call config provider correctly', () => {
  const mockConfig = container.resolve(Tokens.IConfigProvider) as MockConfigProvider;
  
  service.initialize();
  
  const calls = mockConfig.getCalls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['copilotOrchestrator', 'maxConcurrent', 4]);
});
```

#### Logger Output

Enable debug logging in tests:

```typescript
test('complex operation with logging', () => {
  const logger = Logger.for('test');
  logger.setLevel('debug');
  
  // Enable debug for specific components  
  Logger.initialize({ subscriptions: { push: () => {} } })
    .setConfigProvider(mockConfig);
    
  // Test operation - logs will show debug output
});
```

---

## Best Practices

### Test Structure

1. **Use TDD interface**: `suite()` and `test()` for clear structure
2. **Setup/teardown**: Use `setup()` and `teardown()` for consistent state
3. **Descriptive names**: Test names should describe behavior, not implementation
4. **Single assertions**: Focus each test on one specific behavior

### Mocking Strategy

1. **Mock external boundaries**: File system, network, VS Code APIs
2. **Don't mock internal domain logic**: Test real implementations
3. **Verify interactions**: Use mock call tracking for important interactions
4. **Reset mocks**: Clear mock state between tests

### Error Testing

1. **Test error conditions**: Don't just test happy paths
2. **Use real errors**: Throw actual error instances, not strings
3. **Test error propagation**: Verify errors bubble up correctly
4. **Test recovery**: Verify systems handle failures gracefully

### Git Testing

1. **Use real git**: Temporary repositories for git operation tests
2. **Clean up resources**: Always remove temp directories
3. **Test isolation**: Each test gets its own repo
4. **Mock process spawning**: Only when testing command construction

---

This testing guide provides comprehensive coverage of testing strategies, tools, and patterns used throughout Copilot Orchestrator. For specific test implementations, refer to the examples in `src/test/unit/` and the mock adapters in `src/vscode/testAdapters.ts`.