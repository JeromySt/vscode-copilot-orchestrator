# Changelog

All notable changes to the Copilot Orchestrator extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0] - Unreleased

### Added
- **LLM Model Selection**: Dynamic model discovery from Copilot CLI, per-node model override via `model` property in plan/node specs, model name displayed on agent work badge in node detail panel
- **Copilot Usage Statistics**: CopilotStatsParser for parsing Copilot CLI summary output, rich AI Usage metrics card in node detail panel, compact metrics bar replacing token summary, metrics aggregation utility with per-model breakdowns (requests, input/output/cached tokens)
- **AI Review for No-Change Commits**: When a node produces no file changes, an AI agent reviews execution logs to determine if "no changes" is legitimate before failing
- **Forward Integration on Resume**: `git fetch` before `resume()` and `retryNode()` with `clearWorktree` to ensure worktrees use latest remote refs
- **FI Chain Continuity**: `expectsNoChanges` nodes now carry forward their `baseCommit` as `completedCommit`, preventing downstream nodes from losing accumulated changes in the dependency chain

### Changed
- **Mermaid Diagram Labels**: Group labels dynamically truncated based on widest descendant node width instead of arbitrary character limit
- `resume()` and `retryNode()` are now async (callers must await)

### Fixed
- **Exit Code Null on Windows**: Handle `code=null` from nested `cmd.exe` chains when Copilot CLI makes git commits; detect "Task complete" marker to coerce to success
- **Signal Capture**: Properly capture signal name when Copilot CLI process is killed
- **FI Chain Break**: `expectsNoChanges` validation nodes (e.g., typecheck) no longer break the forward integration commit chain, which caused downstream leaf nodes to lose ancestor code changes during RI merge

## [0.6.0] - 2026-02-XX

### Added
- **Stdio MCP transport**: New process-based transport using newline-delimited JSON-RPC 2.0 over stdin/stdout — no port configuration needed. Configurable via `copilotOrchestrator.mcp.transport` setting (`stdio` or `http`)
- **Node-centric MCP tools**: New tools for direct node manipulation without requiring group/plan context:
  - `create_copilot_node` – Create standalone or grouped nodes
  - `get_copilot_node` – Get node details by ID (global lookup)
  - `list_copilot_nodes` – Filter nodes by group, status, or name
  - `get_copilot_group_status` – Group progress and node states
  - `list_copilot_groups` – List all groups with status
  - `cancel_copilot_group` / `retry_copilot_group` / `delete_copilot_group` – Group-level operations
  - `retry_copilot_node` – Retry a specific failed node
  - `get_copilot_node_failure_context` – Detailed failure diagnostics
- **Work evidence validation**: Nodes can prove work completion via evidence files (`.orchestrator/evidence/{nodeId}.json`) for tasks that don't produce file changes (external API calls, analysis, validation). Supports `expectsNoChanges` flag for validation-only nodes
- **Node builder**: New `buildNodes()` function that creates `NodeInstance[]` directly with DAG validation and dependency resolution
- **Legacy MCP adapters**: Backward-compatible wrappers that translate old plan-based tool calls to the new node-centric API
- **Pause/resume plan functionality**: Plans can be paused and resumed, allowing users to halt execution and continue later
- **Default branch protection**: Prevents orchestrated work from targeting the repository's default branch directly
- **Pan/zoom for diagrams**: Plan detail diagrams now support pan and zoom for navigating large dependency graphs

### Changed
- **Forward Integration on resume**: `resume()` and `retryNode()` now perform `git fetch --all` before unpausing or resetting worktrees, ensuring local refs reflect the latest target branch state. Prevents stale worktrees when the target branch has advanced during a pause period
- **Commands cleanup**: Removed 14 unimplemented commands from `package.json`, keeping only actually registered commands (MCP connection, plan/node details, cancel/delete/refresh)
- **Simplified node interface**: `NodeInstance` now combines node definition and runtime state into a single type (ID, task, status, attempts, dependencies, git context, step statuses)
- **Plan-to-group terminology**: Internal transition from plan-centric to group-centric node management
- **Group labels show full path**: Group labels in the UI now display the full hierarchical path for clarity
- **Node duration placeholders**: Nodes display duration placeholders while running, showing elapsed time

### Fixed
- **Worktree race conditions**: Added per-repo mutex to prevent concurrent worktree operations from conflicting
- **Phase reporting for merge failures**: Merge failure phases are now correctly reported in node status

### Removed
- Unregistered commands: `createJob`, `cancelJob`, `startJob`, `inspectStatus`, `showJobDetails`, `showJobSection`, `retryJob`, `deleteJob`, `openJobWorktree`, `mergeCompletedJob`, `resolveConflicts`, `generateTests`, `produceDocs`, `showLogs`, `cleanupOrphans`, `showDagDetails`, `cancelDag`

## [0.5.0] - 2025-01-XX

### Added
- **MCP stdio transport**: Automatic registration with VS Code Copilot via stdio protocol
- **Cancel job tool**: New `cancel_copilot_job` MCP tool for stopping running jobs
- **Expandable work summary**: Click to see per-commit details with file change counts
- **Human-readable durations**: "12m 33s" instead of raw seconds
- **Process monitoring**: Live view of running processes during job execution
- **Plans UI**: New Plans view in sidebar showing multi-job plan status
- **Plan Detail Panel**: Visual pipeline view showing job dependencies and execution flow
- **Plan persistence**: Plans now persisted to `plans.json` for extension reload survival
- **Nested plans**: Jobs can now contain full sub-plans for hierarchical orchestration
  - Click nested plan cards to drill into sub-plan details
  - Visual distinction with dashed borders and "Nested Plan" badge

### Changed
- **Architecture simplification**: Removed HTTP server layer - MCP server now handles jobs directly
- **Major refactoring**: Reorganized codebase into modular directories
  - `src/core/` - Core job runner and initialization logic
  - `src/agent/` - AI agent delegation
  - `src/git/` - Git operations and worktree management
  - `src/mcp/` - MCP server integration
  - `src/process/` - Process monitoring
  - `src/ui/` - UI components (status bar, webview, view provider)
- **Configuration consolidation**: All settings now in VS Code extension settings (removed `.orchestrator/config.json`)
- **Extension entry point**: Reduced from ~2800 lines to ~100 lines

### Removed
- **Webhook notifications**: Removed as they don't apply to stdio-only architecture
- **HTTP server**: Removed in favor of direct MCP job execution
- **HTTP configuration settings**: `copilotOrchestrator.http.*` settings removed

### Fixed
- UI jumpiness when switching log tabs (incremental updates)
- Spinning icon animation (added `display: inline-block`)
- MCP port configuration not being respected
- Status bar not updating on port changes

## [0.4.0] - 2025-01-XX

### Added
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
