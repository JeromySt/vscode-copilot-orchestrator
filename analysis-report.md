# Package.json Analysis Report

## Extension Overview
- **Name**: vscode-copilot-orchestrator
- **Display Name**: Copilot Orchestrator
- **Version**: 0.9.5
- **Publisher**: JeromyStatia

## Contributed Commands
**Total Commands**: 11

1. `orchestrator.mcp.howToConnect` - Copilot Orchestrator: MCP – How to Connect
2. `orchestrator.mcp.configure` - Copilot Orchestrator: Add MCP to GitHub Copilot
3. `orchestrator.copilotCli.check` - Copilot Orchestrator: Check Copilot CLI
4. `orchestrator.showPlanDetails` - Copilot Orchestrator: Show Plan Details
5. `orchestrator.showNodeDetails` - Copilot Orchestrator: Show Node Details
6. `orchestrator.cancelPlan` - Copilot Orchestrator: Cancel Plan
7. `orchestrator.pausePlan` - Copilot Orchestrator: Pause Plan
8. `orchestrator.resumePlan` - Copilot Orchestrator: Resume Plan
9. `orchestrator.deletePlan` - Copilot Orchestrator: Delete Plan
10. `orchestrator.refreshPlans` - Copilot Orchestrator: Refresh Plans
11. `copilotOrchestrator.refreshModels` - Copilot Orchestrator: Refresh Available Models

## Configuration Settings
**Total Configuration Properties**: 17

1. `copilotOrchestrator.mcp.enabled` - Enable MCP server for GitHub Copilot Chat integration
2. `copilotOrchestrator.worktreeRoot` - Directory name for git worktrees
3. `copilotOrchestrator.cleanupOrphanedWorktrees` - Auto cleanup orphaned worktree directories
4. `copilotOrchestrator.maxConcurrentJobs` - Maximum concurrent jobs to run in parallel
5. `copilotOrchestrator.globalMaxParallel` - Maximum concurrent jobs across all VS Code instances
6. `copilotOrchestrator.copilotCli.required` - Warn/guide install if GitHub Copilot CLI is missing
7. `copilotOrchestrator.copilotCli.preferredInstall` - Preferred installation method for Copilot CLI
8. `copilotOrchestrator.copilotCli.enforceInJobs` - Fail jobs early if Copilot CLI is missing
9. `copilotOrchestrator.merge.mode` - Git merge strategy for completed jobs
10. `copilotOrchestrator.merge.prefer` - Default conflict resolution preference
11. `copilotOrchestrator.merge.pushOnSuccess` - Auto push to remote after successful merge
12. `copilotOrchestrator.logging.debug.mcp` - Enable debug logging for MCP protocol
13. `copilotOrchestrator.logging.debug.jobs` - Enable debug logging for job runner operations
14. `copilotOrchestrator.logging.debug.plans` - Enable debug logging for plan runner operations
15. `copilotOrchestrator.logging.debug.git` - Enable debug logging for git operations
16. `copilotOrchestrator.logging.debug.ui` - Enable debug logging for UI operations
17. `copilotOrchestrator.logging.debug.extension` - Enable debug logging for extension lifecycle

Additional logging configuration properties:
- `copilotOrchestrator.logging.level` - Global log level
- `copilotOrchestrator.logging.components` - Array of component names for debug logging

## Dependencies Analysis
- **Production Dependencies**: 3
  - `ajv` (^8.17.1) - JSON schema validation
  - `micromatch` (^4.0.5) - Glob matching library
  - `uuid` (^11.1.0) - UUID generation

- **Development Dependencies**: 19
  - TypeScript and ESLint tooling
  - Testing frameworks (Mocha, Sinon, C8 for coverage)
  - Build tools (esbuild, npm-run-all2)
  - VS Code extension development tools
  - Various TypeScript type definitions

**Dependency Ratio**: 3 production : 19 development dependencies

## Test Framework
**Primary Test Framework**: **Mocha**
- Uses TDD interface (`--ui tdd`)
- Coverage testing with C8 (95% line coverage requirement)
- Unit tests in `out/test/unit/**/*.unit.test.js`
- Integration with VS Code test runner
- Sinon for mocking and stubbing

## Additional Analysis
- **Extension Category**: AI, Machine Learning, SCM Providers
- **VS Code Engine**: Requires VS Code ^1.109.0
- **License**: GPL-3.0-only
- **Build System**: Hybrid approach using both esbuild (for distribution) and TypeScript compiler (for testing)
- **Special Features**: MCP (Model Context Protocol) integration, git worktree support, DAG-based execution