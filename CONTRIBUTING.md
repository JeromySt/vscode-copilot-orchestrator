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
| `npm run compile` | Compile TypeScript once |
| `npm run watch` | Compile in watch mode |
| `npm run lint` | Run ESLint |
| `npm test` | Run tests |
| `npm run package` | Create VSIX package |

## Project Structure

```
src/
├── extension.ts          # Extension entry point (activation/deactivation)
├── core/                 # Core business logic
│   ├── jobRunner.ts      # Job execution engine
│   └── initialize.ts     # Extension initialization
├── agent/                # AI agent integration
│   └── AgentDelegator.ts # Copilot CLI delegation
├── commands/             # VS Code commands
│   └── index.ts          # Command handlers
├── git/                  # Git operations
│   └── GitOperations.ts  # Worktree and merge operations
├── http/                 # HTTP REST API
│   └── httpServer.ts     # Express server
├── mcp/                  # Model Context Protocol
│   └── McpServerManager.ts # MCP server management
├── process/              # Process monitoring
│   └── WebhookNotifier.ts # Webhook notifications
├── process/              # Process monitoring
│   └── ProcessMonitor.ts # Child process tracking
├── types/                # TypeScript definitions
│   └── index.ts          # Shared types
└── ui/                   # User interface
    ├── statusBar.ts      # Status bar items
    ├── viewProvider.ts   # Sidebar tree view
    └── webview.ts        # Job details webview
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
npm test
```

### Writing Tests

- Place tests in `src/test/`
- Use descriptive test names
- Test both success and error cases
- Mock external dependencies

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
