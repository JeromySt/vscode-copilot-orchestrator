# Changelog

All notable changes to the Copilot Orchestrator extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.14.0] - 2026-02-28

### 🚀 Major Features

#### Auto-Heal Multi-Retry System
- **Configurable retry budget**: New `copilotOrchestrator.autoHeal.maxAttempts` setting (default: 4, range: 0-1024) controls maximum auto-heal attempts per failed phase
- **Multi-attempt retry loop**: Auto-heal now retries up to the configured limit instead of giving up after the first attempt, spawning a fresh AI agent for each retry with full failure context
- **No-op detection**: Automatically detects when an auto-heal agent diagnoses the problem but makes no code changes, failing immediately instead of burning retry budget on diagnosis-only loops
- **Per-phase exhaustion tracking**: Each phase (prechecks, work, postchecks, merge-ri) has independent retry budgets
- **Attempt history preservation**: All retry attempts are tracked with trigger types, phase timing, and failure context for detailed debugging

#### Timeline Visualization (Experimental)
- **Pixel-based Gantt chart**: Interactive timeline showing plan execution history with horizontal scrolling and sticky time axis
- **Live phase updates**: Real-time colored phase segments (merge-fi, setup, prechecks, work, commit, postchecks, merge-ri) with exact timestamps
- **Clickable attempt focus**: Click any timeline bar attempt to focus that job in the node detail panel
- **Rich HTML tooltips**: Hover over timeline bars for phase breakdown with color-coded status squares and exact durations
- **Plan state markers**: Visual indicators for plan events (queued, started, paused, resumed, completed) on dedicated plan row
- **Dependency arrows**: Visual dependency lines connecting related jobs in the timeline
- **Group headers**: Collapsible group sections organizing related jobs
- **Trigger type badges**: Visual indicators showing initial runs vs auto-heal retries
- **Hidden by default**: Timeline is opt-in via `copilotOrchestrator.experimental.showTimeline` setting (default: false) to allow iterative improvement without disrupting existing workflows

#### Job & Plan Configuration Display
- **Job configuration section**: New "Job Configuration" panel in node detail showing:
  - Auto-heal settings and attempt count
  - `expectsNoChanges` flag for validation-only jobs
  - Group membership and producer ID
  - Per-job environment variables with sensitive value redaction
  - Agent specifications (model, allowed folders, allowed URLs)
  - Phase configurations (prechecks, work, postchecks) with collapsible sections
  - Instructions rendered as formatted markdown
  - Failure handling directives (noAutoHeal, resumeFromPhase, custom messages)
- **Plan configuration section**: New "Plan Configuration" panel in plan detail showing:
  - Plan-level environment variables (inheritable by all jobs)
  - Max parallelism settings
  - Auto-cleanup behavior
  - Repository and worktree root paths
  - Snapshot branch information
  - Plan ID for debugging

#### Per-Spec Environment Variables
- **Node-level env vars**: Each node can define environment variables that override plan-level values
- **Inheritance model**: Jobs inherit plan-level `env`, then overlay node-specific `env` values
- **Configuration visibility**: Both plan and job env vars displayed in configuration sections with sensitive value masking

### 🎨 UI Improvements

#### Timeline Enhancements
- **Actual time proportions**: Phase segments sized by actual wall-clock duration instead of normalized percentages
- **Absolute pixel positioning**: Timeline bars positioned using exact timestamps for accurate visual representation
- **Horizontal growth**: Timeline expands rightward as execution progresses, with smooth scroll behavior
- **Scroll preservation**: Timeline scroll position maintained during incremental updates
- **Phase coloring**: Live phase colors update during execution to reflect current job state
- **Duration counter**: Real-time elapsed time display in timeline bars for running jobs

#### Panel Layout Improvements
- **Sticky header refinement**: Action buttons (Cancel, Pause, Resume, Delete) moved into always-visible sticky header
- **Phase-colored borders**: Node detail phase tabs (Prechecks, Work, Postchecks) show left border colored by phase type
- **DAG and Timeline together**: Removed tab bar UI, now showing both DAG diagram and timeline simultaneously
- **Improved metrics bar**: Better visual hierarchy for plan statistics (nodes completed, duration, AI usage)
- **Process monitoring placement**: Running Processes section moved below both DAG and Timeline for consistent layout

### 🏗️ Architecture Refactoring

#### Webview Bundle Migration
- **esbuild entry points**: New bundled JavaScript for nodeDetail, planDetail, and plansList webviews
- **Template extraction**: Separated HTML/CSS/JS from inline code into modular templates:
  - `src/ui/templates/nodeDetail/` - Node detail panel templates
  - `src/ui/templates/planDetail/` - Plan detail panel templates
  - `src/ui/templates/plansView/` - Plans sidebar templates
  - `src/ui/webview/controls/` - Reusable webview controls (TimelineChart, ViewTabBar)
  - `src/ui/webview/entries/` - Webview bootstrap entry points
- **Message routing consolidation**: Extracted message routers and event handlers into dedicated modules
- **Control wiring separation**: Control initialization logic separated from HTML generation
- **Standalone diagram builder**: MermaidBuilder extracted as standalone module
- **Template testing**: Comprehensive unit test coverage for all template modules
- **Webview URI helper**: New `webviewUri.ts` for CSP-compliant script tag generation

#### Codebase Organization
- **Test infrastructure isolation**: Moved test helpers (`compositionTest.ts`, `testAdapters.ts`) from `src/` to `src/test/helpers/` to separate production from test code
- **Plan state mapping**: Extracted `planStateMapper.ts` and `planStatePersister.ts` for cleaner repository implementation
- **Documentation updates**: Comprehensive updates to `ARCHITECTURE.md` with new class diagrams and sequence flows

### 🐛 Bug Fixes

#### Timeline Fixes
- **Scroll preservation**: Fixed timeline scroll position resetting during updates
- **Marker positioning**: Timeline event markers now use exact bar pixel positions instead of approximations
- **Phase rendering**: Fixed phase display for all node types (JobNode, MergeNode, SupervisorNode) during live execution
- **Empty segment handling**: Eliminated empty or zero-width phase segments in timeline bars
- **Tooltip accuracy**: Fixed tooltips showing all phases as 'skipped' for jobs with no timing data
- **Plan row visibility**: Plan state row now always visible even when stateHistory is empty

#### Node Detail Panel Fixes
- **Duration counter drift**: Fixed duration timer drift after system sleep/resume
- **Button handler restoration**: Restored button handler functions lost during webview bundle migration
- **Phase tab icons**: Replaced emoji icons with clean Unicode symbols for better cross-platform rendering
- **Mermaid sizing**: Fixed Mermaid diagram node text clamping and duration template formatting

#### Plan Detail Panel Fixes
- **Merge-fi status reporting**: merge-fi phase now correctly reports 'success' instead of 'skipped' when no dependencies exist
- **Process monitoring**: Moved Running Processes section to correct position below DAG/Timeline
- **Sticky header z-index**: Increased sticky header z-index to 100 to stay above all content

#### MCP Integration Fixes
- **Schema validation errors**: Included valid schemas in MCP validation error responses for better debugging
- **Status update payloads**: Enriched statusUpdate events with attempt data for live timeline updates

### ⚙️ Configuration

#### New Settings
- `copilotOrchestrator.autoHeal.maxAttempts` (default: 4) - Maximum auto-heal retry attempts per phase
- `copilotOrchestrator.experimental.showTimeline` (default: false) - Show experimental timeline visualization

### 📊 Testing

- **Line coverage**: 95.22% (27,932 / 29,332 lines)
- **New test suites**:
  - Timeline chart unit tests (`timelineChart.unit.test.ts`)
  - View tab bar tests (`viewTabBar.unit.test.ts`)
  - Webview bundle integration tests (nodeDetail, planDetail, plansList entry points)
  - Template module tests (styles, scripts, body templates)
  - Control consistency tests
  - Plan state history type tests
  - Repository mapper and persister tests
- **Test infrastructure improvements**: All tests migrated to dedicated test helpers directory

### 🔧 Internal Changes

- **Auto-heal execution engine refactor**: Converted single-shot auto-heal into while-loop with continue/break flow control for exhaustion handling
- **Timeline data optimization**: Timeline data only computed when experimental flag is enabled
- **CSS conditional loading**: Timeline styles only injected when feature is enabled
- **Logger enhancements**: Added component-level logging (`copilotOrchestrator.logging.components`) for focused debugging

### 📦 Migration Notes

No breaking changes. All changes are backward-compatible with existing plans and configurations.

**To enable the experimental timeline:**
1. Open VS Code Settings (Ctrl+,)
2. Search for "copilot orchestrator experimental"
3. Check "Experimental: Show Timeline"

## [0.13.0] - 2026-02-21

### Added
- **IPlanRepository architecture with file-backed lazy plan storage**: New abstraction layer for plan storage supporting lazy loading of large specs from disk. Includes `IPlanRepository`, `IPlanRepositoryStore`, `IPlanDefinition` interfaces and `DefaultPlanRepository`, `FileSystemPlanStore`, `FilePlanDefinition` implementations.
- **Scaffold MCP tools for incremental plan building**: New tools `scaffold_copilot_plan`, `add_copilot_plan_job`, and `finalize_copilot_plan` for building plans incrementally instead of all-at-once.
- **Plan chaining via `resumeAfterPlan`**: Plans can declare a dependency on another plan. The dependent plan starts paused and auto-resumes when its dependency succeeds. Canceled/deleted dependencies unblock waiting plans. UI shows chain reason when paused for dependency and hides the Resume button.
- **Plan-level environment variables**: New `env` field on plans propagated to all jobs. Per-job `env` overrides plan-level values for that job.
- **Scaffolding plans UI support**: Plans sidebar now shows scaffolding plans with distinct state and controls.
- **Copilot CLI setup/login command**: New command `copilotOrchestrator.setupCopilotCli` guides users through CLI installation and authentication.
- **Duration helpers for attempt history**: Helper functions to compute node/plan duration from attempt history for accurate timing across retries.

### Fixed
- **CLI detection cache bug**: Fixed silent no-op when CLI became unavailable. Added TTL-based cache invalidation and `Refresh Copilot CLI` command.
- **Node/plan duration spanning all attempts**: Duration now correctly spans all attempts instead of just the current attempt.
- **NodeDetailPanel duration counter after sleep/resume**: Fixed drift detection in PulseEmitter and state re-initialization on wake.
- **EventEmitter listener leak on extension reload**: Process event listeners (exit, SIGINT, SIGTERM) are now properly cleaned up on deactivate.
- **Eliminated @vscode/test-electron**: Migrated all tests to pure unit test runner with Mocha, removing VS Code host dependency.
- **CRITICAL: Merge-FI data loss on node resume**: Fixed bug where merge-fi phase was skipped when resuming a node, causing dependency commits to be dropped from the final merge. The executor's `skip()` function now never skips merge-fi, and merge-fi is idempotent (checks if commits are already ancestors before merging).
- **CRITICAL: updateNodeHandler sets resumeFromPhase for never-executed nodes**: When updating a node via `update_copilot_plan_job` that had never been executed (attempts=0), the handler incorrectly set `resumeFromPhase`, causing the executor to skip merge-fi/setup/prechecks/work phases on first execution. The fix checks if the node has executed before setting resumeFromPhase.
- **MCP phase enum missing phases**: The `get_copilot_job_logs` tool's phase enum was missing phases. Updated from `['prechecks', 'work', 'postchecks', 'commit', 'all']` to include all phases: `['merge-fi', 'setup', 'prechecks', 'work', 'commit', 'postchecks', 'merge-ri', 'cleanup', 'all']`.
- **Schema: require `type` field on work spec objects**: Work spec objects now require an explicit `type` field for correct routing.
- **`normalizeWorkSpec` parses JSON string work specs**: Work specs that arrive as JSON-encoded strings are now correctly parsed before validation.
- **Comprehensive disk fallback for all spec reads on finalized plans**: Auto-heal and execution now load specs from disk when in-memory definition is not available for finalized plans.
- **Group state reset on retry + duration restart**: Group status now resets correctly when retrying failed jobs, and duration timers restart properly.
- **Plan chaining: only canceled plans unblock chained dependents**: Failed and partial plans no longer auto-unblock chained dependents — only canceled/deleted plans do.
- **groupId set on nodes loaded from repository metadata**: Nodes loaded from persisted plan metadata now correctly have their `groupId` populated.

### Changed
- **Node → Job terminology in user-visible strings**: All MCP tool names, UI labels, and user-facing messages now use "job" instead of "node" (e.g., `retry_copilot_plan_node` → `retry_copilot_plan_job`, `get_copilot_node_details` → `get_copilot_job`)
- **MCP tool consolidation (24 → 21 tools)**: Removed 3 redundant tools. Added `planId` to all job-centric tool schemas for consistency.
- **configDir reverted to worktree-local path**: Copilot CLI config directory is now `.orchestrator/.copilot-cli` within the worktree (not derived from cwd).
- Test runner simplified to pure Mocha (`npm test` now runs unit tests directly)
- Updated architecture documentation for new plan repository system

## [0.12.1] - 2026-02-18

### Fixed
- **CRITICAL: baseCommitAtStart not persisted across restarts**: Plan's `baseCommitAtStart` field (capturing the target branch HEAD at plan creation) was missing from the serialization round-trip, causing RI merge parent graphs to break after VS Code restart.
- **RI-only resume path now executes merge phase**: When resuming a node from `merge-ri` phase (e.g., after RI merge failure), the executor is now called with `resumeFromPhase: 'merge-ri'` instead of bypassing the executor entirely. This ensures the merge phase actually runs on retry.
- **Model validation resilient to discovery failures**: When model discovery returns no models or throws, validation now warns and skips instead of blocking plan creation. Added `copilotOrchestrator.copilotCli.validateModels` setting (default: true) and reduced failure cache TTL from 5 minutes to 30 seconds.
- **Copilot CLI auto-update disabled**: Added `--no-auto-update` flag to all Copilot CLI invocations to prevent automatic updates during plan execution that could cause timing inconsistencies.
- **Git executor test timeout on Windows**: Increased timeout for git core executor tests to handle slower git init operations on Windows.

## [0.12.0] - 2026-02-17

### Added
- **Live plan reshaping**: Add, remove, or reorder nodes in a running plan with dependency validation and DAG integrity checks.
- **Post-merge verification phase (`verify-ri`)**: New optional (but highly recommended) plan-level `verifyRiSpec` that runs after every successful RI merge. Validates the merged target branch in a temporary worktree (e.g. compile, test). Auto-healable — on failure, Copilot CLI attempts to fix the issue. Catches merge conflict resolution mistakes before the next leaf merges.
- **8-phase execution pipeline**: Added `verify-ri` as the 8th phase after `merge-ri`. Phase order: merge-fi → setup → prechecks → work → commit → postchecks → merge-ri → verify-ri.
- **Fully in-memory RI merge conflict resolution**: Conflicts are now resolved by extracting files from the merge tree to a temp directory, running Copilot CLI there, then hashing resolved files back into git objects and rebuilding the tree — no worktree or checkout needed.
- **Working tree sync after RI merge**: After updating the target branch ref, the orchestrator syncs the user's working tree if they have that branch checked out. Clean trees get `reset --hard`; dirty trees are left untouched with a user notification.
- **Post-merge tree validation**: After every RI merge, file counts are compared between the result and both parents. If the result has <80% of the richer parent's files, the merge is aborted as destructive.
- **New git helpers**: `catFileFromTree`, `hashObjectFromFile`, `replaceTreeBlobs` for in-memory tree manipulation. `execAsync` now supports `env` option for `GIT_INDEX_FILE`.

### Fixed
- **CRITICAL: RI merge now fully in-memory via `git merge-tree --write-tree`**: Both conflict-free and conflict paths operate entirely on git objects — no checkout, no worktree, no stash. Eliminates the stash/pop pattern that caused catastrophic file deletion (190 files lost in production).
- **Auto-derive configDir from cwd**: Removed explicit `configDir` plumbing from `DelegateOptions`, `CopilotRunOptions`, `BuildCommandOptions`, and `ICopilotRunner`. Config dir is now auto-derived as `path.join(cwd, '.orchestrator', '.copilot-cli')` inside `buildCommand()`.
- **Plan detail panel overflow**: Fixed layout overflow in plan detail panel.
- **Node detail auto-heal attempts**: Fixed auto-heal attempt history display in the Attempts section.
- **AI stats display**: Fixed AI stats rendering in node detail panel.
- **Runtime JS errors**: Fixed runtime JavaScript errors in webview panels.
- **Sticky buttons and capacity**: Fixed sticky button positioning and global capacity stats display.
- **Force fail button restyle**: Restyled Force Fail button and moved to sticky header.
- **Node duration timer**: Fixed live duration timer for running nodes.
- **Job count listener**: Added `planStarted` listener to plan detail panel.
- **Mermaid text clamp**: Clamped Mermaid node text to rendered box width.
- **Mermaid sizing template**: Updated duration template to hours format.
- **Duration display logic**: Updated duration display for running nodes with data-attribute-driven rendering.

### Removed
- `mergeWithConflictResolution` method (stash/checkout/merge/pop pattern)
- `mergeInEphemeralWorktree` method (replaced by fully in-memory approach)
- `isStashOrchestratorOnly` helper
- All `stashPush`/`stashPop`/`stashDrop` usage in RI merge path
- `configDir` parameter from all interfaces and phase executors

## [0.11.21] - 2026-02-17

### Fixed
- **CRITICAL: RI merge no longer touches user's working directory**: Conflict resolution now runs in an ephemeral detached worktree instead of stashing/checking out on the user's main repo. This eliminates the stash/pop pattern that caused catastrophic file deletion (190 files lost in production) when stash pop conflicts were resolved by favoring the pre-plan state.
- **Removed all stash operations from RI merge**: The `mergeWithConflictResolution` method was replaced by `mergeInEphemeralWorktree` which creates a temporary worktree, performs the merge, uses Copilot CLI for conflict resolution, then updates the branch ref — all without touching the user's checkout.
- **Post-merge tree validation**: After every RI merge (both conflict-free and conflict-resolved), the file count of the merged tree is validated against both parent commits. If the result has <80% of the richer parent's files, the merge is aborted and flagged as destructive.

### Removed
- `mergeWithConflictResolution` method (stash/checkout/merge/pop pattern)
- `isStashOrchestratorOnly` helper
- All `stashPush`/`stashPop`/`stashDrop` usage in RI merge path

## [0.11.16] - 2026-02-16

### Fixed
- **Centralized target branch setup in execution pump**: Branch creation and `.gitignore` commit now happen in the pump before any nodes execute, ensuring the same codepath runs for both paused-then-resumed and immediately-started (`startPaused: false`) plans. Previously, branch setup only ran in `resume()`, so non-paused plans would proceed to RI merge with a missing local ref.
- **`branchReady` flag**: Plans now track whether target branch setup is complete. The pump skips plans whose branch hasn't been created yet, and persists the flag across restarts so setup isn't repeated.

## [0.11.15] - 2026-02-16

### Fixed
- **Model validation crash when no DI spawner**: `getCachedModels()` and `refreshModelCache()` now fall back to `DefaultProcessSpawner` when called without DI deps, preventing "ModelDiscoveryDeps.spawner is required" errors.

### Changed
- **Deferred branch creation**: Target branch is no longer created at plan creation time. Instead, the branch is created when the plan is first started/resumed. This avoids creating orphan branches for plans that are never started.
- **Auto-adopt current branch**: When no `targetBranch` is specified, `resolveTargetBranch` now checks the current branch first. If the repo is already on a non-default feature branch, that branch is adopted as the target instead of generating a new one.
- **Gitignore auto-commit**: When the target branch is created on resume, orchestrator `.gitignore` entries are committed as the first commit on that branch. This prevents `.gitignore` changes from appearing as dirty files in every worktree.

## [0.11.14] - 2026-02-16

### Fixed
- **Double-slash in auto-generated branch names**: When `git.branchPrefix` ends with `/` (e.g. `users/jstatia/`), `resolveTargetBranch` produced `users/jstatia//plan_name`. Now strips trailing slashes from the prefix before composing the branch name.

### Removed
- **Instruction Enrichment / Augmentation**: Removed the `augmentInstructions` feature, `instructionAugmenter`, and related MCP schema fields. Agents use native Copilot CLI skill discovery instead.

## [0.11.0] - 2026-02-15

### Added
- **Setup phase**: New `setup` phase in executor (runs after merge-FI) projects orchestrator skill files into worktrees
- **Mermaid text clamp**: Mermaid diagram node text clamped to rendered box width
- **Plan detail `planStarted` listener**: Ensures job count updates when plans start

### Fixed
- **Critical: RI merge lost after auto-heal/retry** — Auto-heal and auto-retry execution contexts were missing `targetBranch`, `repoPath`, `baseCommitAtStart`, and `dependencyCommits`, causing RI merge to be silently skipped for leaf nodes after successful auto-heal
- **Critical: RI merge `updateRef` argument order** — `updateRef(repoPath, refName, commit)` parameters were swapped, preventing branch ref updates
- **RI merge skipped status treated as failure** — Leaf nodes with `'skipped'` RI merge status now correctly detected and reported as failures instead of silent success
- **FI merge blocked by per-worktree `.gitignore`** — Removed per-worktree gitignore management (now handled at repo level in `planInitialization.ts`)
- **RI stash pop failures** — Stash pop conflicts now use AI-assisted resolution via Copilot CLI before falling back to manual instructions
- **FI merge dirty worktree** — FI merge no longer blocked by dirty worktree; uses stash + AI conflict resolution

### Changed
- **Force Fail button** restyled and moved to sticky header in node detail panel
- **Removed simplified MCP APIs**: `create_copilot_job` and `create_copilot_node` tools removed in favor of full plan-based workflows

## [0.10.3] - 2026-02-15

### Added
- **Copilot Agent Instructions**: Repo-wide instructions (`.github/copilot-instructions.md`), path-scoped instruction files for source code, testing, and code review
- **Agent Skills**: 5 agent skills (`.github/skills/`): `test-writer`, `di-refactor`, `security-hardener`, `auto-heal`, `documentation-writer` — auto-loaded by Copilot CLI based on task relevance
- **Instruction Enrichment Spec**: Design spec for skill-aware instruction augmentation at plan creation time (removed in v0.11.14)
- **Gitignore Single Source of Truth**: `ORCHESTRATOR_GITIGNORE_ENTRIES` constant and `isDiffOnlyOrchestratorChanges()` centralized in `git/core/gitignore.ts`, eliminating duplicated pattern lists

### Fixed
- **`.copilot-cli` directory placement**: Moved Copilot CLI config from `{worktree}/.copilot-cli` to `{worktree}/.orchestrator/.copilot-cli` — prevents CLI session artifacts from appearing as uncommitted changes in worktrees
- **`.gitignore` diff detection**: Added `.worktrees/` and instruction file glob patterns to orchestrator diff detection, preventing false positives during RI merge stash handling
- **IGitOperations interface**: Exposed `isDiffOnlyOrchestratorChanges` on `IGitGitignore` interface, routing through DI instead of private method duplication in `executionEngine.ts`

### Changed
- **CI Optimization**: Push CI triggers only on `main` (was `main, develop, users/**`); PR CI triggers only targeting `main` (was `main, develop`). Eliminates duplicate 6-job matrix runs on feature branch pushes

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
