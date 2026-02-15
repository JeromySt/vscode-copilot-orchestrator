# Changelog

All notable changes to the Copilot Orchestrator extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.0] - 2026-02-15

### Architecture
- **Dependency Injection Container**: New `ServiceContainer` (`core/container.ts`) with Symbol-based type-safe registration, singleton/transient lifecycle, lazy initialization, and scoped child containers for per-plan overrides
- **Service Tokens**: 20 DI tokens (`core/tokens.ts`) covering all major subsystems — `ILogger`, `IGitOperations`, `INodeExecutor`, `IConfigProvider`, `IDialogService`, `IClipboardService`, `IPulseEmitter`, `IProcessSpawner`, `ICopilotRunner`, `IEnvironment`, `IGlobalCapacity`, `IPlanConfigManager`, and more
- **VS Code Adapter Pattern**: Business logic fully decoupled from VS Code APIs via thin adapter wrappers (`vscode/adapters.ts`) — `VsCodeConfigProvider`, `VsCodeDialogService`, `VsCodeClipboardService` implement framework-agnostic interfaces (`IConfigProvider`, `IDialogService`, `IClipboardService`, `IEnvironment`)
- **Composition Root**: Separate production (`composition.ts`) and test (`compositionTest.ts`) composition roots — `createContainer()` wires all production bindings in one place; test root substitutes controllable doubles
- **Event-Driven Architecture**: `PulseEmitter` (`core/pulse.ts`) provides a single 1 s heartbeat replacing per-component `setInterval` timers with auto-start/stop based on subscriber count; `PlanEventEmitter` (`plan/planEvents.ts`) provides typed events for plan/node lifecycle (`planCreated`, `planStarted`, `planCompleted`, `planDeleted`, `nodeTransition`, `nodeStarted`, `nodeCompleted`, `nodeRetry`, `nodeUpdated`)
- **Decomposed Phase Executors**: Monolithic executor split into 6 dedicated phase modules (`plan/phases/`): `MergeFiPhaseExecutor`, `PrecheckPhaseExecutor`, `WorkPhaseExecutor`, `CommitPhaseExecutor`, `PostcheckPhaseExecutor`, `MergeRiPhaseExecutor`, plus shared `resolveMergeConflictWithCopilot` helper

### Execution Engine
- **JobExecutionEngine** (`plan/executionEngine.ts`): New node-centric engine handling end-to-end node execution — FI merges from dependencies, executor invocation, auto-heal, RI merges to target branch, worktree cleanup, and work summary accumulation. RI merges serialized via async mutex to prevent index.lock conflicts
- **NodeManager** (`plan/nodeManager.ts`): Centralized node state management — retry, force-fail, spec update, log queries, process stats, and failure context extraction
- **ExecutionPump** (`plan/executionPump.ts`): Async pump loop that checks for ready nodes and dispatches work, managing wake locks and node scheduling
- **PlanLifecycleManager** (`plan/planLifecycle.ts`): Plan CRUD operations and lifecycle transitions — create, cancel, pause, resume, delete with file watcher integration and progress computation

### UI
- **Webview Controls**: 15 reusable UI components (`ui/webview/controls/`): `StatusBadge`, `ProgressBar`, `NodeCard`, `GroupContainer`, `MermaidNodeStyle`, `LayoutManager`, `ProcessTree`, `LogViewer`, `PhaseTabBar`, `AttemptCard`, `AiUsageStats`, `WorkSummary`, `ConfigDisplay`, `PlanListCard`, `DurationCounter`
- **EventBus** (`ui/webview/eventBus.ts`): Lightweight zero-dependency pub/sub event bus for webview communication with `on`/`once`/`emit`/`clear` API, snapshot-safe iteration, and automatic cleanup on unsubscribe
- **SubscribableControl** (`ui/webview/subscribableControl.ts`): Base class for controls that auto-subscribe to EventBus topics and re-render on data changes
- **Template Decomposition**: Plan detail templates split into `headerTemplate`, `controlsTemplate`, `dagTemplate`, `summaryTemplate`, `nodeCardTemplate`, `scriptsTemplate`; node detail templates split into `headerTemplate`, `actionButtonsTemplate`, `configTemplate`, `attemptsTemplate`, `metricsTemplate`, `logViewerTemplate`, `processTreeTemplate`, `scriptsTemplate`

### Testing
- **95% Line Coverage Target**: Enforced via `c8 --check-coverage --lines 95` in `test:coverage` script with dual-runner architecture (mocha for unit tests)
- **Test Adapter Mocks** (`vscode/testAdapters.ts`): Controllable VS Code API doubles for `IConfigProvider`, `IDialogService`, `IClipboardService`, `IProcessSpawner`, and `IEnvironment` — used by `compositionTest.ts` to create fully isolated test containers
- **Phase-Level Tests**: Dedicated unit tests for each decomposed phase executor (`precheckPhase`, `workPhase`, `postcheckPhase`, `commitPhase`, `mergeFiPhase`, `mergeRiPhase`)

### Infrastructure
- **ESLint Flat Config**: Migrated from `.eslintrc.js` to `eslint.config.js` flat config format
- **Removed `.copilot-cli` session artifacts**: Cleaned up committed session state files from repository
- **Updated `.gitignore`**: Added `.copilot-cli/` and auto-generated healing instruction exclusions

### Bug Fixes
- Fixed 78 test failures from DI migration (model discovery spawner injection, execution engine git mock, template assertions)
- Fixed executor cancel to use `killProcessTree` abstraction instead of direct process signals
- Fixed log file header creation on first access to avoid empty log files

## [0.9.5] - 2026-02-13

### Fixed
- **Force Fail**: Use VS Code native confirmation dialog, properly kill processes on Windows, only show button for running nodes
- **Node Update**: Reject `update_copilot_plan_node` on running or completed nodes to prevent corrupting in-progress work
- **GlobalCapacity Registry**: Fix EPERM error spam when registry file is locked or inaccessible

## [0.9.4] - 2026-02-13

### Changed
- **Dependencies**: Bump `qs` from 6.14.1 to 6.14.2 (bug fixes for `arrayLimit` handling in parse/combine/merge)

## [0.9.3] - 2026-02-13

### Added
- **Activity Bar Badge**: Shows running plan count on the sidebar icon for at-a-glance status
- **Filesystem Watcher**: Monitors `.orchestrator/plans/` directory for external file changes (deletions/creations)
- **Auto-Fail Crashed Nodes**: Nodes left in `running` state after extension restart are automatically failed so they can be retried
- **Node Spec Update & Reset**: `update_copilot_plan_node` MCP tool can modify work specs and reset execution to updated stages

### Fixed
- **Force-Fail Button**: Fixed non-functional force-fail button in node detail panel — now works regardless of attempt index or node state
- **Multi-Line Log Filtering**: Phase log filtering no longer truncates multi-line messages (e.g., stack traces)
- **AI Review Standardization**: AI review now uses instructions file and JSON-only response format, matching standard Copilot CLI invocation pattern
- **AI Review JSON Parsing**: Handles HTML-encoded output and residual formatting in AI review responses
- **Plan Tree Duration Timers**: All duration timers (plan and node level) now refresh every second while running
- **Plan Status Reconciliation**: Plan status is correctly reconciled after crash recovery on extension reload
- **Copilot CLI `NODE_OPTIONS`**: Cleared `NODE_OPTIONS` env var before spawning Copilot CLI to prevent `--no-warnings` flag rejection
- **Agent AllowedFolders**: Agent work always includes worktree in allowed directories; prechecks/postchecks auto-heal inherits correct folders
- **Filesystem Resilience**: `.orchestrator` directory operations handle missing/corrupt files gracefully
- **Schema Validation**: Added missing schema validation for node-centric MCP tools (`create_copilot_node`, `retry_copilot_node`)
- **`.gitignore` Consolidation**: Unified `.gitignore` functions and added branch change detection; handles stash conflicts during RI merge
- **Test Infrastructure**: Added `--exit` to mocha scripts to prevent hang from open async handles; fixed file watcher test filenames

### Refactored
- **Git Operations Consolidation**: All git operations now route through the core git module for consistency and error handling

### Security
- **Strict `allowedFolders`/`allowedUrls` Validation**: MCP input validation enforces path existence checks and URL format/scheme validation at the handler level
- **Model Name Validation**: MCP schema validates agent model names in work specs before plan creation

### Removed
- Cleaned up 20 agent investigation/analysis artifacts from `docs/`

## [0.9.2] - 2026-02-12

### Added
- **Aggregated Work Summary**: Leaf nodes now track cumulative work across the entire DAG chain via `aggregatedWorkSummary`, capturing the total diff from base branch through all upstream FI merges — shows the complete picture of what will be reverse-integrated to the target branch
- **URL Security (`allowedUrls`)**: Agents are now blocked from all network access by default. Explicit URL allowlisting via `allowedUrls` in the agent work spec grants access to specific domains/endpoints (passed via `--allow-url` flags), applying the principle of least privilege
- **Aggregated Work Summary UI**: Node detail panel displays aggregated work summary for leaf nodes, showing total files added/modified/deleted across the full dependency chain

### Changed
- **Default Network Policy**: Replaced `--allow-all-urls` with explicit URL allowlisting — agents must declare required URLs in their work spec
- **Node Detail Panel**: Enhanced work summary display to differentiate between node-level and aggregated (chain-level) work summaries

## [0.9.1] - 2026-02-12

### Added
- **Sleep Prevention**: Automatically prevents system sleep/hibernate during active plan execution on Windows (`SetThreadExecutionState`), macOS (`caffeinate`), and Linux (`systemd-inhibit`)
- **Global Job Capacity Coordination**: Enforces a global maximum of concurrent jobs across all VS Code instances using a file-based registry with heartbeat monitoring — prevents system overload when running multiple workspaces
- **Orphaned Worktree Cleanup**: Automatically detects and removes stale worktree directories on extension startup that are no longer tracked by git or active plans
- **Worktree-Local Session Storage**: Copilot CLI sessions are now stored per-worktree in `.orchestrator/.copilot/`, preventing session history pollution and enabling clean multi-job concurrency
- **Gitignore Auto-Management**: Automatically ensures `.gitignore` includes `.worktrees` and `.orchestrator` entries when worktrees are created
- **Agent Folder Security (`allowedFolders`)**: New `allowedFolders` option restricts Copilot CLI agent access to specified directories via `--allow-paths`, following the principle of least privilege
- **Merged Leaf Work Summary**: Plan detail view now shows only work from merged leaf nodes — providing an accurate summary of work actually integrated into the target branch
- **Schema Validation Enhancements**: Added `allowedFolders` validation (max 20 items, 500-char paths) and `startPaused` boolean to MCP tool schemas

### Fixed
- **Metrics Double-Counting**: Fixed `metricsAggregator` to use `attemptHistory` as authoritative source, avoiding inflated metrics when plans are loaded from JSON persistence
- **Process Stats Key Mismatch**: Fixed executor process stats tracking to use consistent keys across start/update/cleanup lifecycle
- **Group Name Display in Mermaid**: Fixed group name rendering in Mermaid DAG diagrams to properly display user-defined group labels instead of internal IDs

### Changed
- **Plan Detail Panel Rendering**: Uses state hashing to skip redundant full re-renders; preserves zoom/scroll position on incremental updates
- **Plans View**: Shows global job count and active instance count when multi-instance coordination is active
- **Status Bar**: Updated to reflect global capacity information

## [0.9.0] - 2026-02-11

### Added
- **Per-Attempt Log Files**: Each execution attempt now writes to a separate log file (`{planId}_{nodeId}_{attemptNumber}.log`), with `AttemptRecord.logFilePath` tracking the file path per attempt
- **Log File Path in UI**: Node detail panel displays a clickable log file path above the log viewer, opening the file directly in VS Code
- **SIGTERM Diagnostic Tracing**: Detailed tracing logs at executor entry/exit and runner failure paths to diagnose where execution blocks on SIGTERM
- **Auto-Retry Diagnostic Logging**: Debug/info-level log messages showing why auto-retry is or isn't triggered for failed phases

### Changed
- **Work Spec Display**: Enhanced work spec formatting in the node detail panel with bordered code blocks, shell type badges, and long commands formatted with line breaks at semicolons and pipes
- **Model Schema**: Removed `model` from job-level schema — model selection is only valid inside `AgentSpec` work objects, not at the job level where it was silently ignored

### Fixed
- **Log Viewer Reliability**: `_sendLog` now always posts a `logContent` message to the webview, preventing the viewer from getting stuck on missing responses
- **setTimeout Overflow**: Capped timer values to safe maximum (2,147,483,647 ms) to prevent Node.js overflow errors
- **Auto-Retry Persistence**: Plan state is now persisted BEFORE auto-retry execution to ensure failure state is captured even if SIGTERM occurs during retry
- **Attempt Log Isolation**: Attempt history phase tabs now correctly read logs from per-attempt files instead of accumulating all previous attempts

## [0.8.5] - 2026-02-10

### Added
- **Auto-Retry for SIGTERM-Killed Agents**: Agent work interrupted by external signals (SIGTERM, SIGKILL) is now automatically retried with the same agent spec, resuming from the failed phase
- **Per-Attempt Log Isolation**: Execution logs are now captured per-attempt using memory and file offsets, so retry attempt records contain only their own logs instead of accumulating all previous attempts
- **Logical CPU Count for maxParallel**: Default `maxParallel` now uses `os.cpus().length` (logical CPU count) instead of a hardcoded value of 4

### Fixed
- **SIGTERM Diagnostic Logging**: Enhanced error messages include PID, exit code, signal, and task-complete marker status for easier debugging of externally killed processes
- **Cancel Stack Tracing**: `Executor.cancel()` and `PlanRunner.cancel()` now capture and log call stacks for diagnosing unexpected cancellations
- **Step Status Callback**: `onStepStatusChange` is now called for all phase terminal states (success, failed, skipped) in the executor, ensuring the runner has accurate real-time phase status
- **jobId Passed from Executor to Delegator**: The executor now forwards `node.id` as `jobId` when invoking the agent delegator
- **Agent Timeout Disabled**: Agent delegator adapter now explicitly sets `timeout: 0` to prevent premature timeouts on long-running agent work

## [0.8.1] - 2026-02-10

### Fixed
- **jobId Propagation**: Fixed missing `jobId` parameter in `createAgentDelegatorAdapter`, ensuring the job identifier is correctly passed through to Copilot CLI agent invocations

## [0.8.0] - 2026-02-10

### Added
- **LLM Model Selection**: Dynamic model discovery from Copilot CLI, per-node model override via `model` property in plan/node specs, model name displayed on agent work badge in node detail panel
- **Copilot Usage Statistics**: CopilotStatsParser for parsing Copilot CLI summary output, rich AI Usage metrics card in node detail panel, compact metrics bar replacing token summary, metrics aggregation utility with per-model breakdowns (requests, input/output/cached tokens)
- **Per-Phase Metrics Capture**: AI usage metrics (tokens, session, code changes) captured independently for prechecks, work, postchecks, merge-fi, and merge-ri phases — displayed in a Phase Breakdown section within the AI Usage card
- **Auto-Heal**: Automatic AI-assisted retry for process/shell failures on prechecks, work, and postchecks phases — per-phase replacement strategy preserves completed phases
- **AI Review for No-Change Commits**: When a node produces no file changes, an AI agent reviews execution logs to determine if "no changes" is legitimate before failing
- **Forward Integration on Resume**: `git fetch` before `resume()` and `retryNode()` with `clearWorktree` to ensure worktrees use latest remote refs
- **FI Chain Continuity**: `expectsNoChanges` nodes now carry forward their `baseCommit` as `completedCommit`, preventing downstream nodes from losing accumulated changes in the dependency chain
- **Local Deployment Script**: `npm run deploy:local` command for quick local testing — bumps patch version, packages VSIX, and installs into VS Code

### Changed
- **Mermaid Diagram Labels**: Group and job node labels dynamically truncated based on widest descendant node width instead of arbitrary character limit
- `resume()` and `retryNode()` are now async (callers must await)
- **RI Merge Serialization**: Reverse-integration merges now execute through an async mutex, preventing concurrent `index.lock` conflicts and silent commit overwrites when parallel leaf nodes complete simultaneously
- **Full Phase Tracking**: Step statuses now include `merge-fi` and `merge-ri` phases in addition to prechecks, work, commit, and postchecks

### Fixed
- **Exit Code Null on Windows**: Handle `code=null` from nested `cmd.exe` chains when Copilot CLI makes git commits; detect "Task complete" marker to coerce to success
- **Signal Capture**: Properly capture signal name when Copilot CLI process is killed
- **FI Chain Break**: `expectsNoChanges` validation nodes (e.g., typecheck) no longer break the forward integration commit chain, which caused downstream leaf nodes to lose ancestor code changes during RI merge
- **AI Review Parser**: Strips HTML/markdown formatting before matching JSON responses, preventing parse failures on Copilot CLI output with embedded formatting
- **RI Merge Index Lock Retry**: Transient `index.lock` errors from VS Code's built-in git extension are retried with backoff
- **AI Review Metrics Loss**: `reviewMetrics` no longer lost in the commit-phase error path when AI review determines no legitimate changes
- **Auto-Heal Metrics Propagation**: Metrics from auto-heal phases are properly aggregated and displayed in the node detail panel

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
