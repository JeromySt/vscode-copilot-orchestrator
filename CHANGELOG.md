# Changelog

All notable changes to the Copilot Orchestrator extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2025-01-XX

### Added
- **MCP stdio transport**: Automatic registration with VS Code Copilot via stdio protocol
- **Cancel job tool**: New `cancel_copilot_job` MCP tool for stopping running jobs
- **Expandable work summary**: Click to see per-commit details with file change counts
- **Human-readable durations**: "12m 33s" instead of raw seconds
- **Process monitoring**: Live view of running processes during job execution

### Changed
- **Major refactoring**: Reorganized codebase into modular directories
  - `src/core/` - Core job runner and initialization logic
  - `src/agent/` - AI agent delegation
  - `src/git/` - Git operations and worktree management
  - `src/http/` - HTTP REST API server
  - `src/mcp/` - MCP server integration
  - `src/notifications/` - Webhook notifications
  - `src/process/` - Process monitoring
  - `src/ui/` - UI components (status bar, webview, view provider)
- **Configuration consolidation**: All settings now in VS Code extension settings (removed `.orchestrator/config.json`)
- **Extension entry point**: Reduced from ~2800 lines to ~100 lines

### Fixed
- UI jumpiness when switching log tabs (incremental updates)
- Spinning icon animation (added `display: inline-block`)
- MCP port configuration not being respected
- Status bar not updating on port changes

## [0.4.0] - 2025-01-XX

### Added
- Webhook notification support for job events
- Multi-job plan execution with dependency management
- Retry functionality with AI-guided failure analysis
- Continue work on existing jobs

### Changed
- Improved job status tracking with step-level granularity
- Enhanced error messages and logging

### Fixed
- Git worktree cleanup on job cancellation
- Memory leaks in long-running jobs

## [0.3.0] - 2024-12-XX

### Added
- MCP (Model Context Protocol) server integration
- HTTP REST API for external integrations
- Real-time job monitoring in sidebar

### Changed
- Improved git worktree isolation
- Better handling of concurrent jobs

## [0.2.0] - 2024-11-XX

### Added
- `@agent` and `@copilot` prefix support for AI delegation
- Pre-checks and post-checks workflow stages
- Automatic merge back to base branch

## [0.1.0] - 2024-10-XX

### Added
- Initial release
- Basic job creation and execution
- Git worktree support
- VS Code sidebar integration
