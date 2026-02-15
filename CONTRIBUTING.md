# Contributing to Copilot Orchestrator

Thank you for your interest in contributing to Copilot Orchestrator! This document provides guidelines and information for contributors.

## Development Setup

### Prerequisites

- Node.js 18.x or later
- VS Code 1.85.0 or later
- Git 2.20+

### Getting Started

1. **Fork and clone the repository**
   ```bash
   git clone https://github.com/YOUR_USERNAME/vscode-copilot-orchestrator.git
   cd vscode-copilot-orchestrator
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Compile the extension**
   ```bash
   npm run compile
   ```

4. **Open in VS Code**
   ```bash
   code .
   ```

5. **Launch the Extension Development Host**
   - Press `F5` to start debugging
   - A new VS Code window will open with the extension loaded

### Development Commands

| Command | Description |
|---------|-------------|
| `npm run compile` | Compile TypeScript + esbuild bundle |
| `npm run compile:tsc` | Compile TypeScript only (for tests) |
| `npm run watch` | Compile in watch mode |
| `npm run lint` | Run ESLint |
| `npm run test:unit` | Run unit tests (headless) |
| `npm test` | Run integration tests (VS Code Electron) |
| `npm run test:coverage` | Run tests with 95% coverage enforcement |
| `npm run package` | Create VSIX package |
| `npm run deploy:local` | Build, package, and install locally (see below) |

### Local Deployment

To quickly test changes in your local VS Code instance without the F5 Extension Development Host:

```bash
npm run deploy:local
```

This single command:
1. **Bumps the patch version** (`npm version patch --no-git-tag-version`) — avoids version conflicts with the marketplace
2. **Packages a VSIX** (`npx @vscode/vsce package --no-dependencies`) — creates `vscode-copilot-orchestrator-<version>.vsix`
3. **Installs the VSIX** (`code --install-extension ... --force`) — installs into your running VS Code

After running, **reload VS Code** (Developer: Reload Window) to activate the new version.

> **Note:** The version bump is intentionally `--no-git-tag-version` so it doesn't create a git tag or commit. Remember to set the version appropriately before committing.

## Project Structure

```
src/
├── extension.ts            # Extension entry point (activation/deactivation)
├── composition.ts          # Production DI composition root
├── compositionTest.ts      # Test DI composition root
├── core/                   # Core infrastructure
│   ├── container.ts        # Symbol-based DI container
│   ├── tokens.ts           # Service registration tokens (30+)
│   ├── logger.ts           # Per-component logging with debug flags
│   ├── pulse.ts            # Single heartbeat emitter for UI subscriptions
│   ├── globalCapacity.ts   # Cross-instance job coordination (file-based)
│   ├── powerManager.ts     # Sleep prevention (platform-specific)
│   └── planInitialization.ts # Extension activation and wiring
├── interfaces/             # DI interface contracts
│   ├── IConfigProvider.ts  # Configuration abstraction
│   ├── ICopilotRunner.ts   # Copilot CLI abstraction
│   ├── IDialogService.ts   # Dialog abstraction
│   ├── IGitOperations.ts   # Git operations abstraction
│   ├── ILogger.ts          # Logger interface
│   ├── IPhaseExecutor.ts   # Phase execution interface
│   ├── IProcessSpawner.ts  # Process spawning abstraction
│   └── IPulseEmitter.ts    # UI heartbeat interface
├── vscode/                 # VS Code adapter layer
│   ├── adapters.ts         # Production VS Code API wrappers
│   └── testAdapters.ts     # Test doubles with call tracking
├── agent/                  # AI agent integration
│   ├── agentDelegator.ts   # Copilot CLI delegation
│   ├── copilotCliRunner.ts # CLI runner with security (--add-dir, --allow-url)
│   └── modelDiscovery.ts   # Model availability discovery
├── plan/                   # Plan execution engine
│   ├── executionEngine.ts  # Node-centric job execution engine
│   ├── executionPump.ts    # Async execution pump for scheduling
│   ├── executor.ts         # 7-phase executor pipeline
│   ├── nodeManager.ts      # Centralized node state management
│   ├── planEvents.ts       # Event pub/sub for plan lifecycle
│   ├── planLifecycle.ts    # Plan CRUD operations
│   ├── phases/             # Decomposed phase executors
│   │   ├── mergeFiPhase.ts #   Forward integration merge
│   │   ├── precheckPhase.ts#   Pre-execution checks
│   │   ├── workPhase.ts    #   AI/shell work execution
│   │   ├── commitPhase.ts  #   Evidence-based commit
│   │   ├── postcheckPhase.ts#  Post-execution checks
│   │   └── mergeRiPhase.ts #   Reverse integration merge
│   ├── runner.ts           # Legacy plan runner (delegating)
│   └── persistence.ts      # Plan file persistence
├── mcp/                    # Model Context Protocol (stdio IPC)
│   ├── handlers/           # MCP tool handlers
│   ├── validation/         # Input validation (Ajv schemas)
│   └── stdio/              # stdio JSON-RPC server
├── git/                    # Git operations
│   ├── DefaultGitOperations.ts # IGitOperations implementation
│   └── core/               # Low-level git commands
├── ui/                     # User interface
│   ├── panels/             # Webview panels (plan detail, node detail)
│   ├── templates/          # HTML template modules
│   ├── webview/            # Reusable webview controls
│   │   ├── controls/       # 15+ UI components
│   │   ├── eventBus.ts     # Pub/sub for webview messaging
│   │   └── subscribableControl.ts # Reactive base class
│   ├── planTreeProvider.ts # Sidebar tree view
│   └── plansViewProvider.ts# Plans management view
├── process/                # Process monitoring
│   └── processMonitor.ts   # Child process tracking
└── test/
    ├── unit/               # Unit tests (mocha + c8, headless)
    │   ├── register-vscode-mock.js # VS Code API mock registration
    │   └── ...             # Mirrors src/ structure
    └── suite/              # Integration tests (@vscode/test-electron)
```

## Coding Standards

### TypeScript Guidelines

- Use TypeScript strict mode
- Prefer `async/await` over callbacks
- Use explicit return types for public functions
- Avoid `any` type when possible

### Code Style

- Use 2-space indentation
- Use single quotes for strings
- Add JSDoc comments for public APIs
- Keep functions focused and small

### Example

```typescript
/**
 * Creates a new orchestrator job.
 * @param spec - The job specification
 * @returns The created job ID
 */
export async function createJob(spec: JobSpec): Promise<string> {
  // Validate input
  if (!spec.task) {
    throw new Error('Job task is required');
  }

  // Create and return job
  const job = await jobRunner.create(spec);
  return job.id;
}
```

## Pull Request Process

### Before Submitting

1. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Write clear, focused commits
   - Add tests for new functionality
   - Update documentation as needed

3. **Run quality checks**
   ```bash
   npm run lint
   npm test
   npm run compile
   ```

4. **Test manually**
   - Press `F5` to launch the extension
   - Verify your changes work as expected

### Submitting

1. Push your branch to your fork
2. Open a Pull Request against the `main` branch
3. Fill out the PR template completely
4. Wait for review and address any feedback

### PR Guidelines

- **Title**: Use a clear, descriptive title
- **Description**: Explain what changes you made and why
- **Size**: Keep PRs focused; split large changes into multiple PRs
- **Tests**: Include tests for new functionality
- **Documentation**: Update README/docs if adding features

## Issue Reporting

### Bug Reports

When reporting bugs, please include:

1. **VS Code version** (`Help > About`)
2. **Extension version**
3. **Operating system**
4. **Steps to reproduce**
5. **Expected behavior**
6. **Actual behavior**
7. **Relevant logs** (from Output > Copilot Orchestrator)

### Feature Requests

For feature requests, please describe:

1. **The problem** you're trying to solve
2. **Your proposed solution**
3. **Alternative solutions** you've considered
4. **Additional context** (screenshots, examples)

## Testing

### Running Tests

```bash
# Unit tests (headless, fast — ~2400 tests)
npm run test:unit

# Integration tests (launches VS Code Electron)
npm test

# Coverage report (95% line threshold enforced)
npm run test:coverage
```

### Dual-Runner Architecture

| Runner | Command | Use | Coverage |
|--------|---------|-----|----------|
| **mocha** (direct) | `npm run test:unit` | Unit tests — all `src/test/unit/**/*.unit.test.ts` | ✅ c8 instrumented |
| **@vscode/test-electron** | `npm test` | Integration tests requiring VS Code runtime | ❌ No coverage |

### Writing Tests

- Place unit tests in `src/test/unit/` mirroring the `src/` structure
- Use Mocha TDD interface (`suite`, `test`, `setup`, `teardown`)
- Use Sinon for mocking/stubbing
- Tests run headless via `register-vscode-mock.js` — no VS Code required
- **Use DI interfaces**: Inject mock services instead of stubbing modules

```typescript
// ✅ Good: Use mock via DI
const mockGit = createMockGitOperations();
const engine = new JobExecutionEngine(state, nodeManager, log, mockGit);

// ❌ Avoid: Stub module internals
sinon.stub(git.worktrees, 'createOrReuseDetached');
```

### Coverage Requirements

All PRs must maintain **95% line coverage**. Coverage is enforced by c8:
```bash
c8 --check-coverage --lines 95 --all \
   --include "out/**/*.js" --exclude "out/test/**" --exclude "out/ui/**" \
   mocha --ui tdd --exit "out/test/unit/**/*.unit.test.js"
```

## Dependency Injection

New services should use the DI container:

1. **Define an interface** in `src/interfaces/`
2. **Create a token** in `src/core/tokens.ts`
3. **Register in composition root** (`src/composition.ts` for production, `src/compositionTest.ts` for tests)
4. **Inject via constructor** — avoid importing concrete implementations

See `docs/DI_GUIDE.md` for comprehensive patterns and examples.

## Release Process

Releases are automated via GitHub Actions:

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Create a git tag: `git tag v0.x.x`
4. Push the tag: `git push origin v0.x.x`
5. GitHub Actions will build and publish

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

## Questions?

- Open an issue for questions
- Check existing issues for answers
- Read the documentation in `README.md`

Thank you for contributing! 🎉
