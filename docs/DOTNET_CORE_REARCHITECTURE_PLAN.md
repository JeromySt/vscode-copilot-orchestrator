# .NET Core Re-Architecture Plan — Decoupling DAG/Agent Orchestration from VS Code UI

> **Status:** Pre-release baseline (`pre-release/1.0.0`) — Design Review v1.2 (post-remediation; supersedes v1.1)
> **Scope:** Extract the plan/DAG engine, agent execution, and worktree orchestration out of the VS Code extension's TypeScript runtime and into a set of cross-platform .NET libraries hosted by multiple front ends (CLI, named-pipe daemon, VS Code extension, GitHub Copilot CLI plugin).
> **Non-goals:** Redesigning any VS Code UI (Plan Sidebar, Plan Detail Panel, Job Detail Panel, Status Bar). Those continue to render exactly as today, but consume the new core via a thin transport adapter.
> **Sign-off:** Architecture (Jeromy), Security (Jeromy/AssumeBreach review), Reliability (Jeromy) — all `pre-release/1.0.0` PRs require sign-off in all three columns of the PR template before merge to `main`.

## 0. Glossary — canonical terms used throughout

This section is the **normative glossary** for the rest of the document. When the same concept appears under multiple names elsewhere in this doc (legacy or in-flight rename), it is cross-listed below; the **canonical** column wins.

| Canonical term | Aliases (informal / legacy) | Definition |
|---|---|---|
| **plan** | DAG, workflow | The whole user-authored unit of work — a directed acyclic graph of jobs with dependencies, persisted under `.aio/p/<plan8>/`. Identified by `PlanId`. |
| **job** | node *(legacy term, now fully removed from this doc)*, task | One atomic unit of work in a plan. Has its own worktree, lifecycle, attempts, logs. Identified by `JobId`. **Historical note:** This doc previously used "node" interchangeably with "job" because the term originated in DAG graph theory and the TS codebase still uses it (`svNodeBuilder.ts`, `dagUtils.ts`). The .NET re-architecture standardized on "job" — the §3.30 state machine, §3.30.5 events (`Job*` prefix), and every public RPC use "job" exclusively. The legacy TS RPC surface accepts "node"-prefixed input fields as aliases for backward compatibility during the v1 GA migration window. |
| **phase** | (none) | One of the eight pipeline stages a job moves through: MergeFi, Setup, Prechecks, Work, Commit, Postchecks, MergeRi, Finalize. |
| **attempt** | retry, run | One execution of one phase of one job. Numbered from 1; retries increment. Each attempt has its own log file. |
| **run** | (often confused with attempt) | A single end-to-end invocation of a plan from a particular triggering event (CLI/UI/MCP call). One run can span many job attempts. Logged via `RunId`. |
| **lease** | lock | An exclusive holding of a resource (worktree, plan store, vendor quota slot). Always represented as an `IAsyncDisposable` / `IResourceHandle` in code (D9). |
| **handle** | (none) | A non-disposable value record returned by a stateless coordinator (D8) that represents a single in-flight operation (e.g., `ProcessHandle`). Distinct from a lease — handles are values, leases are disposables. |
| **group** | bucket, swimlane | A visual/organizational subset of jobs within a plan. Has no execution semantics — pure rendering hint. Persisted in `plan.json`. |
| **daemon** | host, server | The long-running `ai-orchestratord` process that owns plan execution. One daemon per machine is typical; multi-daemon coordination via `quota.mmf` (§3.9) is supported. |
| **front end** | client, UI | Any process consuming the daemon's RPC surface: VS Code extension, CLI, MCP host, GH Copilot CLI plugin. |
| **vendor / runner** | agent | A pluggable AI CLI integration (`gh copilot`/`copilot`, `claude`, scripted). Always behind `IAgentRunner`. |

**Renaming policy.** The full Node→Job rename across this doc was completed in branch `chore/node-to-job-rename`. External references that legitimately use the term "Node" — Node.js, the N-API native binding (`AiOrchestrator.Bindings.Node`, "Node binding"), `node_modules`, `NODE_OPTIONS`, mermaid-diagram label variables — are preserved verbatim. The TS codebase retains "node"-prefixed identifiers in its public RPC surface as backward-compat aliases (see the "job" row above). New text written into this doc MUST use "job".

---

## 1. Motivation & Goals

### 1.1 Problems with the current architecture

The repository today is a single TypeScript codebase that:

- Hosts the DAG engine, scheduler, executor, git worktree manager, MCP server, agent runner, and webview UI **all inside the VS Code extension host**.
- Couples Copilot Chat / MCP / UI lifecycle to plan execution lifecycle (e.g., closing the window can pause executions, reload-window flows hit subtle persistence races).
- Forces non-VS Code consumers (CLI users, headless CI, Copilot CLI users, GitHub Copilot agent itself) to re-implement orchestration if they want the same DAG/worktree semantics.
- Makes it hard to substitute the agent executor — `copilotCliRunner.ts` is wired through DI but the rest of the engine is shaped around its specific lifecycle and stdio handlers.
- Mixes ~80 KLOC of plan/git/agent logic with extension-lifecycle code, making testability and per-component release independent of VS Code difficult.

### 1.2 Goals

| # | Goal |
|---|------|
| G1 | A **single source of truth** for DAG/plan semantics, written in C# on **.NET 10 LTS**, published as NuGet packages and as a `dotnet tool` (`ai-orchestrator`). All shipped binaries are **self-contained** with the .NET runtime trimmed/embedded so end users do **not** need any .NET install. The `ai-` prefix keeps the command name vendor-neutral and avoids collision with the many other tools that already squat on the bare `orchestrator` name. |
| G2 | A **headless CLI experience** (`ai-orchestrator …`) with first-class command surface and JSON output, distributed via `dotnet tool install -g AiOrchestrator.Cli` (which installs the `ai-orchestrator` command) and as platform-native single-file binaries (linux-x64, linux-arm64, osx-x64, osx-arm64, win-x64, win-arm64). |
| G3 | A **secure named-pipe daemon** (`ai-orchestratord`) that mirrors today's MCP nonce-auth IPC pattern. |
| G4 | A **dedicated stdio MCP server** (`ai-orchestrator-mcp`) — a first-class shipping artifact, **not** an internal detail of the VS Code extension or the daemon. Any stdio-MCP host (Copilot Chat, Claude Desktop, custom agents, CI) can spawn it directly. The MCP surface lives **outside** the AiOrchestrator API and re-projects it. |
| G5 | A **GitHub Copilot CLI plugin** front end that exposes the same DAG operations as Copilot CLI commands. |
| G6 | **Pluggable agent runners** — `IAgentRunner` with first-class implementations for `gh copilot`, `claude`, and a scripted/test runner; each one carries the lessons learned in this repo (process deadlock detection, log file discovery, token-usage telemetry, context-pressure signals, session resume, hook installation, CLI-version-gated capabilities). |
| G7 | The VS Code extension keeps its UI but becomes a **thin transport client** of the daemon (or in-proc host). UI/UX behavior is preserved. |
| G8 | Strong test boundaries — every layer is unit-testable without spawning real processes, real git, or real agents. |
| G9 | Security parity or better with today's MCP IPC: nonce-auth, single-client, per-session pipe, no command-line secrets. |
| G10 | **Multi-UX coexistence** — the daemon's eventing system is projected into multiple front-end languages simultaneously (Node.js native binding for VS Code, .NET in-proc, JSON-RPC pipe, MCP). Several can be live at once (e.g., VS Code Node binding **and** Copilot Chat MCP both subscribed to the same plan). |

### 1.3 Non-goals

- Rewriting the VS Code UI (webviews, sidebar, status bar) in C#/Blazor/etc.
- Replacing MCP tooling that VS Code Chat already consumes — the same MCP surface is preserved, just relocated behind the daemon.
- Removing TypeScript from the repo entirely. The extension host stays TS for VS Code API integration.

---

## 2. Target Architecture — Layered View

```mermaid
graph TB
    subgraph Frontends["Front Ends"]
        VSC[VS Code Extension Host - TypeScript]
        CLI[ai-orchestrator CLI - .NET]
        GHCP[GitHub Copilot CLI Plugin - .NET]
        MCPC[Copilot Chat / MCP Client]
    end

    subgraph Transport["Transport / Hosting"]
        NPD[AiOrchestratorHost - Named Pipe Daemon]
        IPROC[In-Proc Host - Library Embed]
        MCPADAPT[MCP Adapter - JSON-RPC over stdio/IPC]
    end

    subgraph Core["Core Libraries .NET"]
        ORCH[AiOrchestrator.Core]
        GIT[AiOrchestrator.Git]
        AGENT[AiOrchestrator.Agents]
        STORE[AiOrchestrator.Storage]
        EVENTS[AiOrchestrator.Events]
        SECCRED[AiOrchestrator.Security]
    end

    subgraph External["External Systems"]
        REPO[Git Repository / Worktrees]
        GHCLI[gh copilot CLI]
        CLAUDE[claude CLI]
        FS[Filesystem / Logs]
    end

    VSC -->|JSON-RPC over named pipe nonce-auth| NPD
    CLI -->|in-proc or pipe| IPROC
    CLI -.->|optional| NPD
    GHCP -->|in-proc| IPROC
    MCPC -->|stdio JSON-RPC| MCPADAPT
    MCPADAPT --> NPD

    NPD --> ORCH
    IPROC --> ORCH
    ORCH --> GIT
    ORCH --> AGENT
    ORCH --> STORE
    ORCH --> EVENTS
    NPD --> SECCRED

    GIT --> REPO
    AGENT -->|spawn| GHCLI
    AGENT -->|spawn| CLAUDE
    STORE --> FS
```

### 2.1 Project / package layout

```
src/dotnet/
├── AiOrchestrator.Core/                 # DAG, scheduler, lifecycle, state machine
├── AiOrchestrator.Models/               # Public DTOs, records, enums (NuGet) — versioned independently of Abstractions
├── AiOrchestrator.Abstractions/         # Public extension points: interfaces + abstract base classes (NuGet) — versioned independently of Models
├── AiOrchestrator.Storage/              # Plan persistence (file system + abstractions)
├── AiOrchestrator.Git/                  # Worktree manager, FI/RI merge helpers
├── AiOrchestrator.Agents/               # IAgentExecutor + Copilot/Claude/scripted impls
├── AiOrchestrator.Agents.Copilot/       # gh copilot integration
├── AiOrchestrator.Agents.Claude/        # claude CLI integration
├── AiOrchestrator.Events/               # Typed event bus + emitter abstractions
├── AiOrchestrator.Security/             # Nonce auth, pipe ACLs, secret redaction
├── AiOrchestrator.Hosting/              # Generic host wrapper, DI bootstrap (Microsoft.Extensions.Hosting)
├── AiOrchestrator.Hosting.NamedPipe/    # The AiOrchestratorHost daemon (ai-orchestratord)
├── AiOrchestrator.Hosting.InProc/       # In-process library host (CLI / extension)
├── AiOrchestrator.Mcp/                  # MCP protocol implementation (tools, schemas, dispatcher)
├── AiOrchestrator.Mcp.Stdio/            # `ai-orchestrator-mcp` — standalone stdio MCP server binary
├── AiOrchestrator.Cli/                  # `ai-orchestrator` command (System.CommandLine), packaged as dotnet tool
├── AiOrchestrator.Cli.Copilot/          # `gh copilot ai-orchestrator` plugin entry point
├── AiOrchestrator.Bindings.Node/        # Native Node.js binding (N-API) projecting events/RPC to JS
├── AiOrchestrator.TestHarness/          # Scripted process output, fakes for tests
└── AiOrchestrator.IntegrationTests/     # End-to-end suite

src/typescript/                        # Existing TS extension, slimmed
├── extension.ts
├── ui/                                # Webviews (unchanged behavior)
├── transport/                         # NEW: dual-mode client (Node binding preferred, pipe fallback)
└── composition.ts                     # Wires transport into existing UI surfaces
```

### 2.2 Distribution model (.NET 10 LTS, self-contained, zero-install)

All shipped artifacts are produced with:

```xml
<TargetFramework>net10.0</TargetFramework>
<PublishSingleFile>true</PublishSingleFile>
<SelfContained>true</SelfContained>
<PublishTrimmed>true</PublishTrimmed>
<PublishReadyToRun>true</PublishReadyToRun>
<InvariantGlobalization>true</InvariantGlobalization>
```

| Artifact | Form | Channel |
|----------|------|---------|
| `AiOrchestrator.Cli` (installs as `ai-orchestrator`) | `dotnet tool` global tool **and** self-contained single-file binary per RID | NuGet, GitHub Releases |
| `ai-orchestratord` (daemon) | Self-contained single-file per RID | GitHub Releases, embedded in VS Code VSIX |
| `ai-orchestrator-mcp` (stdio MCP) | Self-contained single-file per RID | NuGet (`dotnet tool install -g AiOrchestrator.Mcp.Stdio`), GitHub Releases, embedded in VSIX |
| `AiOrchestrator.*` libraries | NuGet packages (target `net10.0`) | NuGet |
| `AiOrchestrator.Bindings.Node` | Prebuilt N-API native module (`.node`) per RID | npm (`@ai-orchestrator/native`) |

Users without .NET installed can still run any binary. Each RID-specific binary is ~25–35 MB after trimming. The VS Code VSIX bundles only the host's RID by default and falls back to a download-on-first-use flow for other RIDs (with SHA-256 verification).

Each `AiOrchestrator.*` library is independently versioned. Internal preview libraries are tagged `preview-N`. The two contract packages — **`AiOrchestrator.Models`** and **`AiOrchestrator.Abstractions`** — are the only ones that carry strict semver guarantees, and they are versioned **independently of each other** (see §3.1.0). `Models` typically rolls minors more frequently than `Abstractions`; the version-skew matrix in §3.1.0 documents which combinations are supported.

### 2.3 NuGet packaging — `.csproj`-driven, metadata-complete, build-reproducible

Every shippable assembly is packaged from its own `.csproj` using SDK-style packaging (`<IsPackable>true</IsPackable>` + `dotnet pack`). There are **no hand-edited `.nuspec` files** anywhere in the repo — `.csproj` is the single source of truth for assembly identity, namespace, package metadata, dependencies, and build/pack settings. A `Directory.Build.props` and `Directory.Packages.props` pair at `src/dotnet/` enforces the policies below across every project; per-project `.csproj` files override only when there is a documented per-package reason.

#### 2.3.1 Required metadata on every packable project

The repo-wide `Directory.Build.props` sets the defaults; projects must not silently drop any of these. Missing required metadata fails the build (custom MSBuild target `_AssertPackageMetadata` runs in `BeforeTargets="GenerateNuspec"`):

| `.csproj` property | Value / rule |
|---|---|
| `<PackageId>` | Equals the assembly name (e.g., `AiOrchestrator.Abstractions`) — no aliasing. |
| `<RootNamespace>` | Equals `<PackageId>`. Code in the assembly lives under that root namespace; sub-namespaces follow folder structure. Enforced by analyzer `OE0020` (any `namespace` declaration that does not start with `<RootNamespace>` is an error). |
| `<AssemblyName>` | Equals `<PackageId>`. |
| `<Authors>` | `Jeromy Statia`. |
| `<Company>` | *(empty — this is a personal extension; no company affiliation)*. Set explicitly to the empty string in `Directory.Build.props` so the build asserts it was deliberately omitted rather than forgotten. |
| `<Product>` | `AI Orchestrator`. |
| `<Description>` | One-paragraph description sourced from `Description.md` adjacent to the `.csproj` (kept in sync with the README section for that package). Empty descriptions fail the build. |
| `<PackageTags>` | Space-delimited, includes `ai-orchestrator` plus per-package tags (e.g., `dag plan worktree agent mcp`). |
| `<PackageProjectUrl>` | The GitHub repo URL. |
| `<RepositoryUrl>` + `<RepositoryType>git` + `<RepositoryCommit>` | `RepositoryCommit` populated from the build's commit SHA so the consumer can trace any installed package back to its exact source. |
| `<PackageLicenseExpression>` | `MIT` (or whatever the repo license becomes). Never `<PackageLicenseFile>` — SPDX expression only. |
| `<PackageReadmeFile>` | `README.md` packed at the package root via `<None Include="README.md" Pack="true" PackagePath="\" />`. Each package has its own `README.md`; copying a single repo-wide README is forbidden. |
| `<PackageIcon>` | `icon.png` packed at root. The repo ships one shared icon under `src/dotnet/build/`. |
| `<PackageReleaseNotes>` | Auto-generated from `CHANGELOG.md` slice for the version being packed (build target `_ExtractReleaseNotes`). |
| `<Copyright>` | `© Jeromy Statia. Licensed under the MIT License.` (year derived from the build's commit date so reproducibility holds). |
| `<Version>` / `<PackageVersion>` | Computed by the versioning tool (`Nerdbank.GitVersioning`); never hard-coded. The two contract packages (§3.1.0) compute independent versions from independent baselines. |
| `<NeutralLanguage>` | `en-US`. See §2.4 for satellite-assembly handling. |
| `<TargetFramework>` | `net10.0` (libraries). Tools may add `<RuntimeIdentifiers>` for self-contained packs. |
| `<LangVersion>` | `latest`. |
| `<Nullable>` | `enable`. Build warnings as errors for nullable diagnostics. |
| `<TreatWarningsAsErrors>` | `true`. |
| `<EnforceCodeStyleInBuild>` | `true`. |
| `<GenerateDocumentationFile>` | `true`. The XML doc file ships in the package and powers IntelliSense for consumers. |
| `<IncludeSymbols>` + `<SymbolPackageFormat>` | `true` + `snupkg`. Source Link populates the symbols. |
| `<PublishRepositoryUrl>` + `<EmbedUntrackedSources>` + `<ContinuousIntegrationBuild>` | `true` (set by the CI MSBuild prop file) — required for **deterministic/reproducible builds**. |
| `<Deterministic>` | `true`. |
| `<MinClientVersion>` | `5.4.0` (matches our minimum NuGet client floor; bumped in lockstep with consumer toolchain). |
| `<EnablePackageValidation>` + `<PackageValidationBaselineVersion>` | `true` + the previous shipped version of this package. `dotnet pack` runs `Microsoft.DotNet.PackageValidation` to fail the build on **any** binary-breaking surface change that wasn't a deliberate major bump. |
| `<PackageReference Include="Microsoft.SourceLink.GitHub" PrivateAssets="All" />` | Mandatory on every package — gives consumers click-through to source from any frame. |

Tools (`AiOrchestrator.Cli`, `AiOrchestrator.Mcp.Stdio`) additionally set `<PackAsTool>true</PackAsTool>` plus `<ToolCommandName>` (`ai-orchestrator`, `ai-orchestrator-mcp`).

#### 2.3.2 Dependency hygiene

- **Central package management** is mandatory: every transitive version is pinned in `Directory.Packages.props` (`<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>`). Per-project `<PackageReference>` elements never carry a `Version` attribute.
- **No `*` floating versions** except for the documented Models-floor in `AiOrchestrator.Abstractions` (§3.1.0.4), which uses a **floating patch only** (`Version="1.0.*"`).
- **No transitive dependency exposure across the public API surface** — `AiOrchestrator.Abstractions` and `AiOrchestrator.Models` carry only `System.*` types and types defined in the same assembly on their public surface. `Microsoft.Extensions.*` may be referenced internally for implementation but never appears in a public signature in the contract packages. Analyzer `OE0021` enforces this for the two contract assemblies.
- **`PrivateAssets="All"`** on every analyzer/source-generator/SourceLink reference so they don't leak into the consumer's transitive graph.

#### 2.3.3 Reproducibility and signing

- All packages built in CI are **byte-for-byte reproducible**: identical commit SHA + identical SDK version produces identical `.nupkg` SHA-256. Verified in CI by a second build on a different machine and a hash compare.
- `dotnet nuget sign` produces an Authenticode-signed `.nupkg` using the org's NuGet author cert; signed packages are the only ones pushed to nuget.org.
- The single-file binaries (`ai-orchestratord`, `ai-orchestrator`, `ai-orchestrator-mcp`) are Authenticode-signed on Windows and codesigned + notarized on macOS as part of the release pipeline.

#### 2.3.4 Public-API baseline

Every contract project (`AiOrchestrator.Models`, `AiOrchestrator.Abstractions`) and every project whose public surface is consumed by third parties (`AiOrchestrator.Hosting`, `AiOrchestrator.Events`, `AiOrchestrator.Mcp`, `AiOrchestrator.TestHarness`) references `Microsoft.CodeAnalysis.PublicApiAnalyzers` and ships `PublicAPI.Shipped.txt` + `PublicAPI.Unshipped.txt` files. Any addition to the public surface requires moving a line from `Unshipped` to `Shipped` in the version bump PR, providing a paper trail for every API change.

### 2.4 Localization — designed in from day one

Every shipped artifact is **localizable from v1**. We do not retrofit i18n later — retrofitting always misses CLI argument descriptions, exception messages, and JSON-RPC error payloads, which then leak English into every consumer's UX. The design rules below apply to every project under `src/dotnet/`.

#### 2.4.1 What is and is not localized

| Surface | Localized? | Mechanism |
|---|---|---|
| **CLI command help, argument descriptions, prompts** (`AiOrchestrator.Cli`, `AiOrchestrator.Mcp.Stdio`) | ✅ Yes | `.resx` strings; `System.CommandLine` localization hooks. |
| **CLI human-readable output text** (status lines, progress, error summaries) | ✅ Yes | `.resx` via `IStringLocalizer<T>`. |
| **Exception messages thrown across a public API** (anything a third-party plugin or VS Code UI may surface) | ✅ Yes | `.resx`; thrown via a small `Throw.Localized(…)` helper that loads the string from the assembly's resource set. |
| **VS Code UI strings** (sidebar, panels, status bar) | ✅ Yes | Existing VS Code `package.nls.json` mechanism; no .NET strings cross into the UI verbatim. |
| **MCP `tools/list` `description` fields** | ✅ Yes (negotiated) | The MCP client advertises preferred locale; `AiOrchestrator.Mcp` returns the matching `.resx` string with English fallback. |
| **JSON-RPC error `message`** (named-pipe, MCP) | ✅ Yes | Localized human string in `error.message`; **machine-readable `code` and `data.errorKind` always English/invariant** so programmatic consumers never have to parse localized text. |
| **Log records, telemetry events, OpenTelemetry attributes** | ❌ No | Always invariant English. Logs are for operators/SREs and machine ingest; localization there breaks log search and correlation across regions. Codified as rule **L1**. |
| **Identifiers, tokens, enum names, JSON property names, file paths, branch names, package ids** | ❌ No | Invariant. Codified as rule **L2**. |
| **Event-bus `AiOrchestratorEvent.Source` / category strings, `error.code` values** | ❌ No | Invariant. Localization happens in the UX projection layer (e.g., the VS Code panel maps codes to `package.nls.json` strings). |
| **Date/time/number/percentage formatting** in human-rendered output | ✅ Yes | `CultureInfo.CurrentCulture` for human surfaces; `CultureInfo.InvariantCulture` for log lines, file names, and on-disk JSON. Codified as rule **L3** with Roslyn analyzer `OE0022` flagging any `ToString()` / interpolation in `IEventBus.Publish` paths that lacks an explicit culture. |

#### 2.4.2 How we structure resources

- Every project that emits user-visible strings has a `Strings.resx` (neutral / `en-US`) plus per-locale satellites (`Strings.fr.resx`, `Strings.ja.resx`, …).
- Strongly-typed accessors are generated by Roslyn source generator (`Microsoft.Extensions.Localization.SourceGenerator` or equivalent) — **never** the legacy `ResXFileCodeGenerator` `.Designer.cs` files, which hard-code culture lookup and don't compose with DI.
- Strings are accessed through `IStringLocalizer<T>` (DI-injected), not through static accessors. This makes localization mockable in unit tests and lets the host swap the resource provider for testing or pseudo-localization (§2.4.4).
- Every string key uses `kebab-case` matching its semantic role (`worktree.acquire.failed.permission-denied`), not the English text. Renaming the English wording does not require a key change.

#### 2.4.3 Process-wide and per-request culture

- The daemon runs in `InvariantGlobalization` mode (§2.2) for performance and trimming, with the **specific** cultures we ship as satellites whitelisted via `<InvariantGlobalization>true</InvariantGlobalization>` + `<PredefinedCulturesOnly>false</PredefinedCulturesOnly>` + an `appsettings.json` `Cultures` allow-list. This keeps trimmed binary size small while still permitting our shipped locales.
- Each incoming request (named-pipe RPC, MCP call, CLI invocation) carries an optional `locale` field; if absent we fall back to `CultureInfo.CurrentUICulture` of the daemon process. The request handler sets `CultureInfo.CurrentUICulture` for its async scope using `AsyncLocal<CultureInfo>` so localized string lookups inside the handler resolve to the caller's locale. Codified as rule **L4**: never read `CultureInfo.CurrentUICulture` directly outside the request-scope helper — use `IRequestCulture.Current` (a thin `AsyncLocal` wrapper) so that VS Code (extension locale), CLI (`--locale` flag or `LANG`), and MCP (negotiated) all flow through the same channel.

#### 2.4.4 Pseudo-localization in CI

A `pseudo` pseudo-locale is auto-generated at build time (every English string wrapped: `[!!Hello, world!!]`) and shipped as a hidden satellite. CI runs the integration test suite (§11.3 G-Acceptance) under `LANG=qps-Ploc`, which catches:

- Strings that bypass the localization layer (they appear without `[!! !!]` in the test output).
- String concatenation that breaks when words expand (pseudo-localized strings are deliberately ~30% longer).
- Format strings that crash on RTL-mark insertion.

This is the cheapest possible insurance against shipping a non-localizable string.

#### 2.4.5 Localization rules summary

| Rule | Statement |
|---|---|
| **L1** | All log records, telemetry events, and `AiOrchestratorEvent` payloads are emitted in invariant English. UX layers translate at the edge. |
| **L2** | Identifiers (enum names, JSON property names, file paths, branch refs, package ids, event codes) are invariant English. Never localize them. |
| **L3** | Any `ToString()` on a date/number/percentage in a UX-bound string uses `CultureInfo.CurrentCulture` explicitly. Any `ToString()` going to logs/JSON/files uses `CultureInfo.InvariantCulture` explicitly. Implicit culture is forbidden — analyzer `OE0022` enforces. |
| **L4** | Per-request culture flows through `IRequestCulture.Current` (`AsyncLocal<CultureInfo>`); never read `CurrentUICulture` directly. |
| **L5** | Every public exception message and every `error.message` on the wire is sourced from a `.resx` key. No string-literal user-facing messages outside resource files. |
| **L6** | Every shipped UI/CLI/RPC surface is exercised under the `qps-Ploc` pseudo-locale in CI before tagging a release. |

These six rules are the design-time gate; the analyzers, central resource gen, and CI pseudo-locale run are the enforcement gate.

---

## 3. Core Domain — Abstractions

These mirror the current TypeScript interfaces (`IPlanRunner`, `IGitOperations`, `IPlanRepository`, etc.) but flattened to stable C# contracts. Note: today's `ICopilotRunner` is **replaced** by the vendor-agnostic `IAgentRunner` (see §3.2) — there is no Copilot-specific runner contract in the .NET design; `gh copilot` is just one implementation alongside `claude` and `scripted`.

### 3.1.0 Two contract packages: `AiOrchestrator.Models` and `AiOrchestrator.Abstractions`

The public surface is split into **two independently-versioned NuGet packages** so that data shapes can evolve at one cadence and extension points evolve at another. This is the single most important packaging decision in the .NET design — it determines who can break whom and how often.

#### 3.1.0.1 What lives where

| Package | Contents | Cadence | Who depends on it |
|---|---|---|---|
| **`AiOrchestrator.Models`** | All `sealed record` DTOs (`PlanScaffoldRequest`, `RetryJobResult`, `JobLogsResult`, …), all `readonly record struct` ids (`PlanId`, `JobId`, `RunId`, `ByteRange`, …), all closed enums (`ExecutionPhase`, `EffortLevel`, `ResourceOutcome`, `LibGit2BreakerState`, …), all event records (`AiOrchestratorEvent` hierarchy), all options classes (`AgentRunnerOptions`, `LibGit2HealthOptions`, …), and the JSON `[JsonSerializable(…)]` source-generator context. **No interfaces. No abstract classes. No methods other than compiler-generated record members and trivial `static` factory constants.** | Frequent minor bumps (additive fields, new event subtypes, new enum members on documented-additive enums). | Everyone — Core, Abstractions, hosts, vendor agents, third-party plugins, MCP/N-API projections. |
| **`AiOrchestrator.Abstractions`** | All public interfaces (`IAiOrchestrator`, `IAgentRunner`, `IGitOperations`, `IPlanRepository`, `IEventBus`, `IProcessLifecycle`, `IWorktreeManager`, `IRemoteIdentityResolver`, `ILibGit2HealthMonitor`, `IResourceHandle` + family, `IAgentArgvBuilder`/`IAgentStdoutParser`/…), all abstract base classes that carry shared logic (`AgentRunnerBase`, `ResourceHandleBase`, `EventDispatcherBase`), open-set wrapper structs that must stay co-located with their consumer interface (`AgentRunnerId`, `LibGit2OpKind`), and the analyzer-allowlist attributes (`[ExcludeFromCodeCoverage(…)]` justifications, `[ProcessLifecycleEntryPoint]`). | Rare minor bumps (new interface, new optional method via default-implementation). Major bumps roughly annually. | Core, hosts, every first-party agent runner, every third-party plugin or vendor extension. |

#### 3.1.0.2 Why split them — the asymmetry of change

DTOs and extension points have **fundamentally different rates of change** and **fundamentally different breakage costs**:

- A new optional field on `RetryJobRequest` (DTO change) is a non-event for every consumer — they keep compiling, they keep running, the field defaults to its initializer. We ship dozens of these per quarter.
- A new method on `IAgentRunner` (extension-point change) is a **breaking change for every third-party implementor** — every `IAgentRunner` they wrote stops compiling until they implement the new method. We ship one or two of these per year, deliberately, with a default-implementation runway.

Keeping them in one package forces both to share the slower cadence (or you ship a major bump every time a DTO grows a field, training consumers to ignore version bumps — worse than slow). Splitting them lets each package use the cadence appropriate to its breakage profile.

A second asymmetry is the **direction of dependency**. `Abstractions` references `Models` (every interface method takes/returns a record from `Models`). `Models` does **not** reference `Abstractions` — records hold pure data, never service references. So the dependency graph is acyclic and one-way:

```
   AiOrchestrator.Models  (no project deps)
             ↑
   AiOrchestrator.Abstractions  (depends on Models only)
             ↑
   AiOrchestrator.Core / .Git / .Agents.* / .Hosting.* / 3rd-party plugins
```

A consumer that only deserializes events and renders them in a UI (Spectre CLI watcher, OpenTelemetry exporter, future audit-log reader) needs `Models` only — zero Abstractions footprint.

#### 3.1.0.3 Version-first evolution rules

Both packages start at `1.0.0` at GA and evolve by these rules. Breaking these rules is rejected at PR review by a `dotnet api-compat` baseline check and the `Microsoft.CodeAnalysis.PublicApiAnalyzers` package (`PublicAPI.Shipped.txt` per project).

**`AiOrchestrator.Models` rules:**

| Change | Version impact | Rule reference |
|---|---|---|
| Add a new record type | minor | M2 |
| Add a new optional field with a default value to an existing record | minor | M2 |
| Add a new event subtype derived from `AiOrchestratorEvent` | minor | M7, EV1 |
| Add a new enum member to a documented-additive enum (`ExecutionPhase`, `EffortLevel`) | minor | M9 |
| Add a new well-known static to an open-set wrapper struct (e.g., `AgentRunnerId.GitHubCopilot`) | minor | M9 |
| Bump `SchemaVersion` on an existing event subtype | minor | EV2 |
| Add a new required field to an existing record | **major** (forbidden in practice; use a sibling type instead) | M3 / EV3 |
| Rename a field | **major** (forbidden in practice; add new + obsolete old over one minor window) | M6 / EV4 |
| Change the semantics of an existing field | **major** (forbidden in practice; introduce `RecordV2`) | M6 / EV5 |
| Remove an `[Obsolete]` field after its sunset window | **major** | M6 |

**`AiOrchestrator.Abstractions` rules:**

| Change | Version impact |
|---|---|
| Add a new interface | minor |
| Add a new abstract base class | minor |
| Add a new method to an interface **with a C# default implementation** | minor (consumers compile unchanged) |
| Add a new method to an interface **without** a default implementation | **major** (breaks every implementor) |
| Add a new abstract member to an existing abstract class | **major** |
| Add a new virtual member to an existing abstract class | minor |
| Rename or remove any public member | **major** |
| Tighten a parameter type or loosen a return type | **major** |
| Add a new optional ctor parameter to a non-sealed class | **major** (subclasses break) — add a new ctor overload instead |

**No interface ever exposes a primitive sequence parameter.** Every method on every public interface follows M1: at most one positional value parameter (commonly an id from `Models`) plus `CancellationToken`; everything else goes through a request record from `Models`. This is what lets `Models` ship an additive field without forcing an `Abstractions` revision.

#### 3.1.0.4 Supported version-skew matrix

The two packages can be consumed at different versions in the same process. The supported matrix:

| Abstractions → / Models ↓ | A 1.x | A 2.x |
|---|---|---|
| **M 1.x** | ✅ supported (every Abstractions 1.x is built against Models 1.0; later Models minors are forward-compatible by M1–M10) | ✅ supported (Abstractions 2.x is built against Models 1.minimum and tested against Models 2.x) |
| **M 2.x** | ⚠️ best-effort (a Models 2.x record may carry fields Abstractions 1.x DTO consumers ignore; behavior preserved) | ✅ supported |
| **M 3.x** | ❌ unsupported (skip a major) | ✅ supported once Abstractions 2.x's tested-Models ceiling rolls forward |

**Rule:** Abstractions specifies a **minimum** Models version in its `<PackageReference Include="AiOrchestrator.Models" Version="1.0.*" />` (floating patch). Hosts choose the actual Models version. CI runs the acceptance suite (§11.3 G-Broad) against the floor and the ceiling for every supported skew cell so the matrix is empirically true, not aspirational.

#### 3.1.0.5 Dependency-injection consequence

Third-party plugins and vendor extensions take a dependency on `AiOrchestrator.Abstractions` (and transitively on `Models` at whatever floor it specifies) and ship as separate NuGet packages that the host registers via DI:

```csharp
// In a vendor's third-party agent package, e.g. Contoso.AiOrchestrator.Agents.SuperLLM
public sealed class SuperLlmAgentRunner : AgentRunnerBase  // from Abstractions
{
    public SuperLlmAgentRunner(IProcessLifecycle p, IOptions<AgentRunnerOptions> o, ILogger<SuperLlmAgentRunner> log)
        : base(p, o, log) { }

    /// <summary>
    /// Wire-facing identity for non-.NET clients (MCP, JSON-RPC, Node binding). Derived from
    /// nameof so it cannot drift from the type name. Inside the .NET process, the runner's
    /// Type itself is the DI key (see below) — no string allocation, refactor-safe.
    /// </summary>
    public override AgentRunnerId Id => new(nameof(SuperLlmAgentRunner));
    // ... overrides for vendor-specific argv, parser, hooks
}

// In the host's composition root — keyed DI uses the runner's Type, not a string.
// IOptions keys must be strings, so nameof(...) is used there: compiler-checked,
// refactor-safe, and the same interned string at every call site.
services.AddKeyedSingleton<IAgentRunner, SuperLlmAgentRunner>(typeof(SuperLlmAgentRunner));
services.Configure<AgentRunnerOptions>(nameof(SuperLlmAgentRunner), o => { /* … */ });
```

The vendor's package depends only on `AiOrchestrator.Abstractions` (and transitively `Models`) — it does **not** depend on `AiOrchestrator.Core`, `AiOrchestrator.Hosting.*`, or any host. This is what makes "first-party and third-party plugins are equal citizens" structurally true: they consume the same surface as the in-tree `CopilotAgentRunner` does.

#### 3.1.0.6 What forbids leakage in either direction

The analyzer set:

- **`OE0017` (Models package purity):** any type defined in `AiOrchestrator.Models` that contains a method body other than compiler-generated record members or `static readonly` initializers is a compile error. The package is records, structs, enums, and JSON source-generator context only.
- **`OE0018` (Abstractions package purity):** any type defined in `AiOrchestrator.Abstractions` that is `sealed` and not abstract / not an interface / not an attribute / not an open-set wrapper struct is a compile error. The package contains extension points only.
- **`OE0019` (no upward dependency):** `AiOrchestrator.Models.csproj` must not contain a `<ProjectReference>` to `AiOrchestrator.Abstractions` (and the analyzer checks the assembly metadata in CI for the published artifacts as a backstop against `<PackageReference>` workarounds).

Between the analyzers, the public-API baseline check, and the supported-skew CI matrix, a contributor cannot accidentally couple a DTO change to an extension-point change — the build won't let them.

### 3.1 Public contracts (`AiOrchestrator.Abstractions` + `AiOrchestrator.Models`)

Every method follows §3.5: at most one positional value parameter plus `CancellationToken`, all other inputs in a `sealed record` request, all results in a `sealed record` (with an `Extensions` bag), no overloads, no tuples, no naked primitives.

```csharp
namespace AiOrchestrator.Abstractions;
// (Records referenced below — PlanScaffoldRequest, RetryJobRequest, etc. — live in AiOrchestrator.Models;
// the interface itself is the extension point and lives in Abstractions.)

public interface IAiOrchestrator
{
    // Plan creation / mutation
    Task<PlanScaffoldResult> ScaffoldAsync(PlanScaffoldRequest request, CancellationToken ct);
    Task<AddJobResult>       AddJobAsync   (AddJobRequest       request, CancellationToken ct);
    Task<FinalizeResult>     FinalizeAsync (FinalizeRequest     request, CancellationToken ct);
    Task<PlanCreateResult>   CreateAsync   (PlanCreateRequest   request, CancellationToken ct); // shorthand

    // Plan queries (single PlanId is the natural positional value — M1 compliant)
    Task<PlanInstance?>   GetAsync     (PlanId      planId, CancellationToken ct);
    Task<ListPlansResult> ListAsync    (PlanFilter  filter, CancellationToken ct);
    Task<PlanGraph>       GetGraphAsync(PlanId      planId, CancellationToken ct);

    // Plan control
    Task PauseAsync (PlanId planId, CancellationToken ct);
    Task ResumeAsync(PlanId planId, CancellationToken ct);
    Task CancelAsync(PlanId planId, CancellationToken ct);
    Task DeleteAsync(PlanId planId, CancellationToken ct);

    // Job control
    Task<RetryJobResult>     RetryJobAsync             (RetryJobRequest      request, CancellationToken ct);
    Task<ForceFailJobResult> ForceFailJobAsync         (ForceFailJobRequest  request, CancellationToken ct);
    Task<JobFailureContext>  GetJobFailureContextAsync (JobRef               job,    CancellationToken ct);
    Task<JobLogsResult>      GetJobLogsAsync           (JobLogsRequest       request, CancellationToken ct);

    // Reshape
    Task<ReshapeResult> ReshapeAsync(ReshapeRequest request, CancellationToken ct);

    // Streaming — IAsyncEnumerable<TBase>; new event subtypes are pure additions (M7)
    IAsyncEnumerable<AiOrchestratorEvent> SubscribeAsync(SubscribeRequest request, CancellationToken ct);
}
```

Representative request/result records (the rest follow the same pattern — `sealed record` + `init`-only + `required` + `Extensions`):

```csharp
public sealed record JobRef
{
    public required PlanId PlanId { get; init; }
    public required JobId JobId { get; init; }
}

public sealed record RetryJobRequest
{
    public required PlanId  PlanId        { get; init; }
    public required JobId  JobId        { get; init; }
    public WorkSpec?        NewWork       { get; init; }
    public WorkSpec?        NewPrechecks  { get; init; }
    public WorkSpec?        NewPostchecks { get; init; }
    public bool             ClearWorktree { get; init; }
    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}

public sealed record JobLogsRequest
{
    public required PlanId  PlanId  { get; init; }
    public required JobId  JobId  { get; init; }
    public ExecutionPhase?  Phase   { get; init; }
    public int?             Attempt { get; init; }
    /// <summary>
    /// Optional byte-range. When omitted, the result is a descriptor only — the caller
    /// reads the file directly. When provided, the result includes a small inline slice
    /// (capped at 64 KiB to stay off the LOH) for cases where the caller cannot open
    /// the file itself (cross-host MCP clients).
    /// </summary>
    public ByteRange?       Range   { get; init; }
    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}

/// <summary>
/// Path-and-range descriptor — never carries log content over the wire by default.
/// The UX layer reads from <see cref="FilePath"/> directly (mmap, FileStream + ArrayPool buffer,
/// PipeReader, etc.). See §3.6 Memory Efficiency.
/// </summary>
public sealed record JobLogsResult
{
    public required string         FilePath  { get; init; } // absolute path under .aio/.ps/log/<planId>/<jobId>/<phase>/<attempt>.log
    public required long           SizeBytes { get; init; }
    public required int            Attempt   { get; init; }
    public required ExecutionPhase Phase     { get; init; }
    public required Encoding       Encoding  { get; init; } = Encoding.UTF8;
    /// <summary>Set only if the request asked for an inline slice; capped at 64 KiB.</summary>
    public ReadOnlyMemory<byte>?   InlineSlice { get; init; }
    public ByteRange?              SliceRange  { get; init; }
    public IReadOnlyList<string>   Warnings    { get; init; } = [];
    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}

public readonly record struct ByteRange(long Offset, int Length);

public sealed record ListPlansResult
{
    public required IReadOnlyList<PlanSummary> Items { get; init; }
    public string? ContinuationToken { get; init; }
    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}
```

### 3.2 Pluggable agent runners (`AiOrchestrator.Agents`)

`IAgentRunner` is the **only** way the orchestrator talks to an AI CLI. It must encapsulate every behavior we have learned the hard way in this repo and project it uniformly across vendors. The current TS implementation surfaces these concerns scattered across `copilotCliRunner.ts`, `agent/handlers/*`, `process/managedProcess.ts`, `process/processOutputBus.ts`, `process/processMonitor.ts`, `process/logFileTailer.ts`, `agent/cliCheck*.ts`, and `agent/hookInstaller.ts`. The .NET design pulls all of them behind `IAgentRunner` + a small set of supporting interfaces, so each vendor (Copilot, Claude, future agents) implements them with vendor-specific knowledge while the engine stays vendor-agnostic.

#### 3.2.1 The contract

```csharp
public interface IAgentRunner
{
    /// <summary>Stable identifier; open set — use the AgentRunnerId wrapper, not a closed enum (M9).</summary>
    AgentRunnerId Id { get; }

    /// <summary>Static, declarative description of what this runner can do.</summary>
    AgentCapabilities Capabilities { get; }

    /// <summary>
    /// Probe the installed CLI (version, login state, plan tier, supported models, hook compatibility).
    /// Result is cached per-process and gates which AgentRunRequest fields are honored.
    /// </summary>
    Task<AgentProbeResult> ProbeAsync(CancellationToken ct);

    /// <summary>
    /// Execute an agent task. Lifecycle (spawn, watch, parse, redact, deadlock-detect, kill, surface metrics)
    /// is owned by the runner; events are reported via the IProgress&lt;AgentEvent&gt; carried on the request (M10).
    /// </summary>
    Task<AgentRunResult> RunAsync(AgentRunRequest request, CancellationToken ct);

    /// <summary>Best-effort interruption that escalates SIGINT → SIGTERM → SIGKILL with timeouts.</summary>
    Task<InterruptResult> InterruptAsync(InterruptRequest request, CancellationToken ct);
}

/// <summary>Open-set wrapper (M9) — well-known statics + opaque future values.</summary>
public readonly record struct AgentRunnerId(string Value)
{
    public static readonly AgentRunnerId GitHubCopilot = new("github-copilot");
    public static readonly AgentRunnerId Claude        = new("claude");
    public static readonly AgentRunnerId Scripted      = new("scripted");
}

public sealed record AgentRunRequest
{
    public required string RunId { get; init; }                     // unique per attempt; log/correlation id
    public required string Cwd   { get; init; }                     // worktree path
    public required string Task  { get; init; }

    public string?               Instructions         { get; init; }
    public string?               InstructionsFilePath { get; init; } // pre-written file path if caller manages it
    public string?               Model                { get; init; }
    public EffortLevel?          Effort               { get; init; }
    public int?                  MaxTurns             { get; init; }
    public string?               SessionId            { get; init; } // resume an existing session
    public IReadOnlyList<string> AllowedFolders       { get; init; } = [];
    public IReadOnlyList<string> AllowedUrls          { get; init; } = [];
    public IReadOnlyDictionary<string, string> Env   { get; init; } = ImmutableDictionary<string, string>.Empty;

    public AgentTimeouts Timeouts  { get; init; } = AgentTimeouts.Standard;
    public string?       LogDir    { get; init; }                     // where the runner places its native log file
    public string?       ConfigDir { get; init; }                     // CLI config dir override (per-worktree isolation)

    /// <summary>Event sink; M10 — progress via IProgress&lt;T&gt; on the request, not a side-channel parameter.</summary>
    public IProgress<AgentEvent>? Observer { get; init; }

    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}

public sealed record AgentTimeouts
{
    public required TimeSpan Overall         { get; init; } // hard cap end-to-end
    public required TimeSpan IdleStdout      { get; init; } // no output for N ⇒ suspect deadlock
    public required TimeSpan PostExitDrain   { get; init; } // grace period after exit to flush log file tail
    public required TimeSpan KillEscalation  { get; init; } // SIGINT → SIGTERM → SIGKILL spacing

    public static AgentTimeouts Standard => new()
    {
        Overall = TimeSpan.FromMinutes(30), IdleStdout = TimeSpan.FromMinutes(5),
        PostExitDrain = TimeSpan.FromSeconds(2), KillEscalation = TimeSpan.FromSeconds(5),
    };
}

public sealed record InterruptRequest
{
    public required string          RunId  { get; init; }
    public required InterruptReason Reason { get; init; }
    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}
```

Every signal the runner discovers about the agent flows through `IProgress<AgentEvent>` as a closed hierarchy of records — `AgentEvent` is the base type (M7), so adding a new subtype is non-breaking:

```csharp
// Replaces the old IAgentObserver callback interface.
// Concrete subtypes: AgentSpawned, AgentLineWritten (carries log-file path + ByteRange of the
// just-written line, NOT the line bytes — see E1/E3 in §3.5.4), AgentSessionId,
// AgentLogFileDiscovered, AgentStats, AgentContextPressure, AgentHook, AgentTaskComplete,
// AgentDeadlock, AgentHealth, AgentExited, AgentCapabilityDowngraded.
public abstract record AgentEvent
{
    public required string         RunId    { get; init; }
    public required DateTimeOffset At       { get; init; }
    public required long           Sequence { get; init; }
}
```

#### 3.2.2 What every runner gets for free

All runners are constructed against the shared infrastructure so that vendor implementations stay focused on parsing and policy, not plumbing. The base class takes **two** dependencies plus an options object:

```csharp
public abstract class AgentRunnerBase : IAgentRunner
{
    protected AgentRunnerBase(
        IProcessLifecycle processes,             // stateless coordinator; see §3.2.2.1
        IOptions<AgentRunnerOptions> options,    // tunables + DI-resolved vendor-specific surfaces
        ILogger<AgentRunnerBase> log) { … }
}

public sealed class AgentRunnerOptions
{
    // Vendor-specific surfaces (resolved per-runner via keyed DI registrations)
    public required IAgentArgvBuilder ArgvBuilder { get; init; }
    public required IAgentStdoutParser StdoutParser { get; init; }
    public required ILogFileDiscovery LogFileDiscovery { get; init; }
    public required IAgentHookInstaller HookInstaller { get; init; }
    public required IAgentSessionResolver SessionResolver { get; init; }

    // Tunables (configurable via Microsoft.Extensions.Configuration)
    public AgentTimeouts DefaultTimeouts { get; init; } = AgentTimeouts.Standard;
    public int HealthSnapshotIntervalMs { get; init; } = 5_000;
    public int LogFileTailBufferBytes { get; init; } = 64 * 1024;
    public bool EnableProcessTreeKill { get; init; } = true;
}
```

Vendor runners register their options block with keyed DI. **The DI key is the runner's `Type`, not a string** — keyed DI in `Microsoft.Extensions.DependencyInjection` accepts `object?`, so passing `typeof(CopilotAgentRunner)` is strictly better than a string literal: zero allocation per resolve, compile-time-checked at every call site, no "magic-string-drift" failure mode where a typo in the host silently routes to the wrong runner, and refactor-safe (renaming the runner updates every keyed lookup automatically). The `AgentRunnerId.Value` (the open-set wrapper from §3.2.1) is still a string because it has to round-trip across the wire to non-.NET clients (MCP, JSON-RPC, Node binding) — but inside the .NET process the type itself is the canonical identity:

```csharp
services.AddKeyedSingleton<IAgentRunner, CopilotAgentRunner>(typeof(CopilotAgentRunner));
services.Configure<AgentRunnerOptions>(nameof(CopilotAgentRunner), o => {
    // IOptions keys MUST be strings, so we use nameof(...) — compiler-checked, refactor-safe,
    // and produces the same interned string at every call site.
    o.ArgvBuilder      = new CopilotArgvBuilder();
    o.StdoutParser     = new CopilotStdoutParser();
    o.LogFileDiscovery = new CopilotLogFileDiscovery();
    o.HookInstaller    = new CopilotHookInstaller();
    o.SessionResolver  = new CopilotSessionResolver();
});

// Resolve sites use the same compile-time-checked references:
var runner  = sp.GetRequiredKeyedService<IAgentRunner>(typeof(CopilotAgentRunner));
var options = sp.GetRequiredService<IOptionsMonitor<AgentRunnerOptions>>().Get(nameof(CopilotAgentRunner));
```

The vendor third-party plugin pattern in §3.1.0.5 follows the same rule: the public surface of every `IAgentRunner` exposes its own `Type` as the canonical DI key, and `nameof(SuperLlmAgentRunner)` is the matching `IOptions` name. The wire-facing `AgentRunnerId` is still derived once (`AgentRunnerId Id => new(nameof(SuperLlmAgentRunner));`) so the same identity flows out to MCP/RPC consumers without anyone hand-typing a string literal.

#### 3.2.2.1 No `IManagedProcessFactory` — coordinator + handle, not factory + product

An earlier draft of this design proposed an `IManagedProcessFactory` whose only job was to hold six singleton dependencies (`IProcessSpawner`, `IProcessOutputBus`, `IProcessMonitor`, `ISecretRedactor`, `IClock`, `IEventBus`) and produce an `IManagedProcess`. We rejected that pattern: a factory that exists *only* to capture singleton dependencies and hand back a value is a workaround for conflating two distinct concerns. DI handles each of them natively — separately:

1. **A stateless lifecycle coordinator** (`IProcessLifecycle`) — knows *how* to spawn, watch, redact, kill. It has the six dependencies, registered as a normal singleton. There is exactly one of these in the process; nothing else ever needs to see those six interfaces.
2. **A per-spawn handle** (`ProcessHandle`) — pure data: `pid`, monotonic `Sequence`, a `ChannelReader<ProcessOutputLine>` to consume output, and an opaque token the coordinator uses to look up internal state (cts, watchdog timer, completion task, log-file tail). **No injected services. No behavior of its own.**

Operations on the handle live on the coordinator and take the handle as a value parameter. This keeps the handle trivially constructible in tests (no DI graph required) and keeps every "active" concern in exactly one place.

```csharp
public interface IProcessLifecycle
{
    /// <summary>
    /// Begin a managed process. Returns a handle representing this single execution.
    /// All lifecycle behavior — buffered stdout/stderr (redacted), idle-stdout watchdog,
    /// SIGINT→SIGTERM→SIGKILL escalation, periodic health snapshots, process-tree
    /// tracking, optional native-log-file tail merging — is owned by this stateless
    /// singleton and published to IProcessOutputBus / IEventBus internally.
    /// </summary>
    ProcessHandle Begin(ProcessLifecycleSpec spec, CancellationToken ct);

    /// <summary>Request shutdown; escalates SIGINT → SIGTERM → SIGKILL per the handle's spec.</summary>
    Task<StopResult> StopAsync(ProcessHandle handle, StopRequest request, CancellationToken ct);

    /// <summary>Await terminal exit and return the result.</summary>
    Task<ProcessExitResult> WaitAsync(ProcessHandle handle, CancellationToken ct);
}

public sealed record ProcessHandle
{
    public required string                          RunId    { get; init; }
    public required int                             Pid      { get; init; }
    public required long                            Sequence { get; init; } // monotonic per coordinator
    public required ChannelReader<ProcessOutputLine> Output  { get; init; }
    // Opaque cookie the coordinator uses to find internal state for this handle.
    // Not interpreted by callers; not serialized across the wire.
    public required ProcessHandleToken Token { get; init; }
}

public sealed record ProcessLifecycleSpec
{
    public required ProcessStartInfo StartInfo         { get; init; } // built by IAgentArgvBuilder
    public required string           CorrelationId     { get; init; } // RunId — log naming + bus tagging
    public AgentTimeouts             Timeouts          { get; init; } = AgentTimeouts.Standard;
    public string?                   NativeLogFilePath { get; init; } // resolved by ILogFileDiscovery
    public PlanId?                   PlanId            { get; init; } // for bus tagging
    public JobId?                   JobId            { get; init; }
    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}

public sealed record StopRequest    { public required InterruptReason Reason { get; init; } public TimeSpan? GraceOverride { get; init; } }
public sealed record StopResult     { public required ExitDisposition Disposition { get; init; } public TimeSpan Elapsed { get; init; } }
public sealed record ProcessExitResult
{
    public required int             ExitCode { get; init; }
    public required ExitDisposition Disposition { get; init; } // Exited | Killed | Crashed | TimedOut
    public required TimeSpan        WallClock   { get; init; }
    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}
```

The runner's job shrinks to: build argv (`IAgentArgvBuilder`), call `IProcessLifecycle.Begin`, drain `handle.Output` through `IAgentStdoutParser`, push parsed `AgentEvent` records to the request's `IProgress<AgentEvent>`, await `WaitAsync`. Everything else — buffering, deadlock detection, kill escalation, log tailing, process-tree teardown, secret redaction, health snapshots — is owned by `IProcessLifecycle` (and the handful of interfaces it composes, which the runner never sees).

**Why this is strictly better than a factory:**

| Concern | Factory pattern (rejected) | Coordinator + handle (chosen) |
|---|---|---|
| DI graph | Factory holds 6 singletons; product holds same 6 singletons via the factory; tests must mock both. | One singleton (`IProcessLifecycle`) holds 6 deps; handle is a value record — no mocking needed in unit tests. |
| Object lifetime | "Factory creates product" is ambiguous about who owns disposal. | Coordinator owns all per-handle state (cts, watchdog, log tail); `StopAsync`/`WaitAsync` semantics are explicit. |
| Testability | Mocking `IManagedProcessFactory` requires a fake `IManagedProcess` with the same 12-method surface. | Tests construct `ProcessHandle` records directly with a stub `ChannelReader`; no behavior to mock. |
| API evolution | Adding a field requires changing both factory return type and product surface. | Adding a field on `ProcessLifecycleSpec` or `ProcessHandle` is M2-additive; coordinator interface is unchanged. |
| Cross-process | Factory + product cannot cross the wire (active object). | `ProcessHandle` (minus its `ChannelReader`) is serializable; cross-process clients reattach by handle id (future). |

This pattern is codified as **D8** in §3.5.1 — *prefer "stateless coordinator + value handle" over "factory + product" whenever the only purpose of the factory is to capture singleton dependencies.*

#### 3.2.3 Vendor-specific projections

Each vendor implements a small surface; the rest is inherited:

| Capability surface | `CopilotAgentRunner` | `ClaudeAgentRunner` | `ScriptedAgentRunner` |
|---|---|---|---|
| CLI binary | `copilot` (the standalone GitHub Copilot CLI — **not** `gh copilot`; see §3.2.6.1 A1) | `claude` | (none — replays a script) |
| Argv builder | Maps `AgentRunRequest` → `copilot -p <task> --stream off --add-dir … --model … --resume …` flags per the §3.2.6.1 argv contract | Maps to `claude --session … --model …` | n/a |
| Stdout parser | Recognizes Copilot's session-id banner (P-SID-1..3), stats footer (P-ST-1..6), debug-log context-pressure markers (P-CP-1..7) | Recognizes Claude's `[session=…]`, `tokens=…`, `<tool_use>` markers | Replays canned lines |
| Hook installer | Writes `<cwd>/.github/hooks/orchestrator-*` files per §3.2.6.6 HK-FILES; gates checkpoint-required state via the daemon-mediated RPC in HK-GATE | Installs Claude's MCP/hook config equivalent (vendor-specific shape) | no-op |
| Log file discovery | `<configDir>/logs/<date>.log` when `--log-dir` is set (A11); fallback `~/.config/github-copilot/logs/<date>.log` (Linux) / `%LOCALAPPDATA%\github-copilot\logs\…` (Windows) | `~/.claude/logs/…` | in-memory ring buffer |
| Session resume | `copilot --resume <uuid>` (A13); UUID validated before spawn (SR-5) | `claude --session <id>` | id is opaque |
| Context-pressure detection | Reads debug-log JSON markers P-CP-1..7 (input/output/cache tokens, max prompt/window, `truncateBasedOn`); thresholds Normal/Elevated/Critical/Compacting per THR-* | Reads context-window utilization line | scripted |
| Token / cost stats | Parses stats footer P-ST-1..6 + per-model breakdown; reads sidecar JSON when hook-v2 enabled | Parses sidecar JSON written by hook | scripted |
| Auth / login probe | CP-4 `gh auth status` (ecosystem hint) + CP-8 `copilot auth status` (canonical) | `claude auth status` | always ok |
| Deadlock signature | Heuristics: spinner present + 0 tokens for >L2 IdleStdout | Heuristics: `[thinking]` for >IdleStdout | n/a |

> **Front-end clarification.** The vendor `CopilotAgentRunner` always invokes the standalone `copilot` binary directly (§3.2.6.1 A1). The `gh copilot ai-orchestrator` plugin entry point (§2.1, §3.21) is a **front-end distribution channel** — it lets users invoke our CLI through `gh`, but the orchestrator daemon it talks to still spawns `copilot`, never `gh copilot`. These are separate concerns and both are correct as written elsewhere in this doc.

Vendor-specific behaviors live behind small interfaces. Each follows §3.5 — single request record, no positional explosion, results as records (not raw primitives) where evolution is likely:

```csharp
public interface IAgentArgvBuilder    { ProcessStartInfo  Build (BuildArgvRequest    request); }
// OnLine receives a ReadOnlyMemory<byte> view into a refcounted RecyclableSegment
// (§3.6.9). Implementations use IByteMatcher (§3.6.9.3) for marker recognition and
// MUST NOT retain the memory past return. No Regex-on-string allowed (E14).
public interface IAgentStdoutParser   { void              OnLine(ParseLineRequest    request); }
public interface ILogFileDiscovery    { Task<LogFileDiscoveryResult> FindAsync(LogFileDiscoveryRequest request, CancellationToken ct); }
public interface IAgentHookInstaller  { Task<HookInstallResult>      EnsureInstalledAsync(HookInstallRequest request, CancellationToken ct); }
public interface IAgentSessionResolver{ SessionResolveResult         Resolve(SessionResolveRequest request); }

public sealed record BuildArgvRequest
{
    public required AgentRunRequest   Run   { get; init; }
    public required AgentProbeResult  Probe { get; init; }
}

public sealed record ParseLineRequest
{
    /// <summary>
    /// Raw UTF-8 bytes for one line. Pooled/owned by the coordinator; the parser
    /// MUST copy out only what it needs (typically session-id / token-count fragments,
    /// not the whole line) before returning. See §3.6 Memory Efficiency.
    /// </summary>
    public required ReadOnlyMemory<byte>   LineUtf8 { get; init; }
    public required AgentLineStream        Stream   { get; init; } // Stdout | Stderr
    public required IProgress<AgentEvent>  Sink     { get; init; } // M10: progress channel, not callback param
}

public sealed record LogFileDiscoveryRequest { public required int Pid { get; init; } public required string Cwd { get; init; } }
public sealed record LogFileDiscoveryResult  { public string? Path { get; init; } public IReadOnlyList<string> Probed { get; init; } = []; }
public sealed record HookInstallRequest      { public required string ConfigDir { get; init; } public bool Force { get; init; } }
public sealed record HookInstallResult       { public required bool Installed { get; init; } public string? PreviousVersion { get; init; } public string? InstalledVersion { get; init; } }
public sealed record SessionResolveRequest   { public string? RequestedSessionId { get; init; } public required AgentProbeResult Probe { get; init; } }
public sealed record SessionResolveResult    { public string? SessionId { get; init; } public bool Resumed { get; init; } }
```

#### 3.2.4 Capability gating by CLI version

`AgentProbeResult` carries a `Version` and a `FeatureSet` (e.g., `SupportsEffort`, `SupportsAllowedUrls`, `SupportsHookV2`, `SupportsModel("claude-opus-4.7")`). The runner base class **filters every `AgentRunRequest` field against the capability set**:

- Unsupported `Effort` → emit `AgentCapabilityDowngraded` event and drop the flag.
- Unsupported `Model` → fail fast with a typed error rather than letting the CLI surface a confusing message.
- Missing `Hook v2` → fall back to stdout-only telemetry and warn once.

This is the same gating today's `agent/cliCheck*.ts` does ad-hoc, lifted into a first-class contract.

#### 3.2.5 Implementations shipped

- `AiOrchestrator.Agents.Copilot.CopilotAgentRunner` — port of `copilotCliRunner.ts` + `agent/handlers/*` + `agent/hookInstaller.ts`.
- `AiOrchestrator.Agents.Claude.ClaudeAgentRunner` — new; same shape, vendor-specific parsers and arg builder.
- `AiOrchestrator.Agents.ScriptedAgentRunner` — replays pre-recorded output for tests/integration plans (matches today's `run_copilot_integration_test`).

#### 3.2.6 Copilot CLI behavioral contract — TS↔.NET parity matrix

This subsection is the **normative behavioral contract** between the existing TypeScript `CopilotCliRunner` (today's production code under `src/agent/copilotCliRunner.ts`, `src/agent/handlers/*`, `src/agent/cliCheckCore.ts`, `src/agent/modelDiscovery.ts`, `src/agent/hookInstaller.ts`, `src/process/managedProcess.ts`, `src/process/processOutputBus.ts`, `src/process/logFileTailer.ts`) and the future C# `CopilotAgentRunner` (§3.2.5). Every row below is a **conformance requirement**: both implementations must exhibit the documented stimulus-response behavior, and both must pass the same recorded-fixture test pack (§3.2.6.10).

The matrix is the source of truth. If a behavior here disagrees with code on either side, the code is wrong, not the matrix. Pull requests that change Copilot CLI interaction in either codebase MUST update this matrix in the same PR; the analyzer in §3.2.6.11 enforces this in CI by hashing the section content and pinning the hash in `agent/copilotCliRunner.ts` (TS) and `CopilotAgentRunner.cs` (C#). Drift forces a doc bump.

##### 3.2.6.1 Argv assembly

The runner spawns the binary directly with `shell: false` (TS) / no shell wrapper (C#). The argv is constructed by TS `buildCommand()` and the C# equivalent `IAgentArgvBuilder.Build(BuildArgvRequest)` implementation. The two MUST produce byte-identical argv arrays for any given `AgentRunRequest` + `AgentProbeResult` pair.

| # | Argv element | Stimulus | TS source | C# owner | Conformance |
|---|---|---|---|---|---|
| A1 | Binary name `copilot` | Always — never `gh copilot` (we invoke the standalone CLI directly) | `buildCommand()` `executable = 'copilot'` | `IAgentArgvBuilder` | Fixture: any-spawn |
| A2 | `-p <task>` | `AgentRunRequest.Task` is required and always passed positionally with `-p` | `cmdArgs.push('-p', task)` | `IAgentArgvBuilder` | Fixture: any-spawn |
| A3 | `--stream off` | Always set; we parse output line-by-line, streaming JSON would break the parser | `cmdArgs.push('--stream', 'off')` | `IAgentArgvBuilder` | Fixture: any-spawn |
| A4 | `--add-dir <path>` (one entry per allowed path) | One per worktree root + one per `AllowedFolders[]` entry. Order: worktree root first, then `AllowedFolders` in input order. If the resolved set is empty, fallback is the spawn `cwd`. | `for (const p of allowedPaths) cmdArgs.push('--add-dir', p)` | `IAgentArgvBuilder` | Fixture: multi-add-dir |
| A5 | `--allow-all-tools` | Always set — orchestrator pre-validates via worktree isolation; no per-tool gating | `cmdArgs.push('--allow-all-tools')` | `IAgentArgvBuilder` | Fixture: any-spawn |
| A6 | `--no-auto-update` | Always set — orchestrator owns CLI updates (§3.28.3); CLI must not self-update mid-plan | `cmdArgs.push('--no-auto-update')` | `IAgentArgvBuilder` | Fixture: any-spawn |
| A7 | `--no-ask-user` | Always set — non-interactive headless invocation | `cmdArgs.push('--no-ask-user')` | `IAgentArgvBuilder` | Fixture: any-spawn |
| A8 | `--allow-url <url>` (one entry per URL) | One per `AllowedUrls[]` entry, in input order. **Each URL MUST pass `sanitizeUrl()` (TS) / `IUrlSanitizer.Validate()` (C#) before append**; rejected URLs are dropped silently with a warning event (`AgentSecurityWarning`). | `for (const url of sanitizedUrls) cmdArgs.push('--allow-url', url)` | `IAgentArgvBuilder` + `IUrlSanitizer` | Fixture: url-sanitization |
| A9 | `--config-dir <path>` | If `Request.ConfigDir` set, use as-is. Otherwise compute as `<cwd>/.aio/.ps/.copilot-cli` (TS today writes `.orchestrator/.copilot-cli`; C# uses the new `.aio/.ps/` root per §3.28). Per-job isolation is mandatory — concurrent jobs MUST NOT share a config dir. | `cmdArgs.push('--config-dir', resolvedConfigDir)` | `IAgentArgvBuilder` | Fixture: config-dir-isolation |
| A10 | `--model <id>` | Append iff `Request.Model != null`. **No client-side allow-list check** — the CLI is authoritative. Capability downgrade (§3.2.4) only fires if `AgentProbeResult.AvailableModels` is populated AND the requested model is absent. | `if (model) cmdArgs.push('--model', model)` | `IAgentArgvBuilder` (consults `AgentProbeResult`) | Fixture: model-flag |
| A11 | `--log-dir <path> --log-level debug` | Append as a pair iff a log dir was resolved (either `Request.LogDir` or `<configDir>/logs`). `--log-level debug` is mandatory when log-dir is set; debug log is the source for `ContextPressureHandler`. | `cmdArgs.push('--log-dir', dir, '--log-level', 'debug')` | `IAgentArgvBuilder` + `ILogFileDiscovery` | Fixture: debug-log-spawn |
| A12 | `--share <path>` | Append iff `Request.Extensions["sharePath"]` set | `if (sharePath) cmdArgs.push('--share', sharePath)` | `IAgentArgvBuilder` | Fixture: share-path |
| A13 | `--resume <sessionId>` | Append iff `Request.SessionId != null`. The id is always a 36-char UUID (validated; non-UUID inputs are rejected with `ArgumentException`). | `if (sessionId) cmdArgs.push('--resume', sessionId)` | `IAgentArgvBuilder` + `IAgentSessionResolver` | Fixture: session-resume |
| A14 | `--effort <level>` | Append iff `Request.Effort != null` AND `AgentProbeResult.Capabilities.SupportsEffort == true` AND the level is in `AgentProbeResult.Capabilities.EffortChoices`. If the level is unsupported, emit `AgentCapabilityDowngraded { capability: "effort", requested, supported }` and drop the flag. | `if (effort) cmdArgs.push('--effort', effort)` | `IAgentArgvBuilder` (consults `AgentProbeResult`) | Fixture: effort-downgrade |
| A15 | `--max-turns` | **Never appended** — deprecated in CLI ≥ 1.0.31. If `Request.MaxTurns != null`, emit `AgentCapabilityDowngraded { capability: "max-turns", reason: "deprecated" }` once per run. | TS logs warning, drops flag | `IAgentArgvBuilder` | Fixture: max-turns-deprecation |

**Argv ordering rule (A-ORDER):** Argv is emitted in the table order above (A1, A2, A3, …). The C# builder must use the same order so fixtures captured against TS replay verbatim against C#.

##### 3.2.6.2 Spawned-process environment

| # | Behavior | TS source | C# owner | Conformance |
|---|---|---|---|---|
| ENV1 | Base env = parent process env (the daemon's env); `Request.Env` overlays per-key. | `cleanEnv = { ...this.environment.env, ...options.env }` | `IProcessLifecycle` (consumes `ProcessLifecycleSpec.StartInfo.Environment`) | Fixture: env-overlay |
| ENV2 | **`NODE_OPTIONS` is unconditionally deleted** before spawn — VS Code's extension host injects flags here that break the CLI's bundled Node runtime. | `delete cleanEnv.NODE_OPTIONS` | `IAgentArgvBuilder` (or `IProcessLifecycle` post-merge hook) | Fixture: node-options-scrub |
| ENV3 | No env var is set on the command line; secret material (tokens, PATs) is delivered exclusively through env block (never argv). | `shell: false`, env arg only | `IProcessLifecycle` + `IRemoteIdentityResolver.ToProcessEnv()` | Fixture: no-secret-in-argv |
| ENV4 | Env-keys matching `/token\|key\|secret\|password\|auth/i` are redacted to `***` in any log/event output. | `secretRedactor` regex | `ISecretRedactor` (used by `IProcessLifecycle`) | Fixture: secret-redaction |
| ENV5 | Per-worktree `GIT_CONFIG_GLOBAL` override is set when the runner spawns a `git` subprocess for credential-helper invocation (not the `copilot` binary itself; see §3.3.1). | n/a (TS does not isolate yet) | `IProcessLifecycle` (when `Spec.IsolateGitConfig == true`) | Fixture: git-config-isolation |

##### 3.2.6.3 Process lifecycle constants

These constants govern timeouts, retries, and kill escalation. The C# defaults live in `AgentRunnerOptions` / `AgentTimeouts` (§3.2.1) and MUST match the TS constants below at v1 GA. Either side changing a constant is a behavior change requiring a matrix update.

| # | Constant | Value | Purpose | TS source | C# location |
|---|---|---|---|---|---|
| L1 | Overall run timeout | 300_000 ms (5 min) | Hard cap on a single agent invocation; on expiry → `InterruptAsync(Reason.Timeout)` | `CopilotRunOptions.timeout` default | `AgentTimeouts.Overall` |
| L2 | Idle-stdout deadlock window | 300_000 ms (5 min) when no specific override | No bytes from stdout/stderr/log-file for this duration ⇒ `AgentDeadlock` event then escalate to kill | `processMonitor.ts` heuristic | `AgentTimeouts.IdleStdout` |
| L3 | Stats-hang grace window | 30_000 ms (30 s) | After `StatsHandler` sees the final stats footer, the process MUST exit within this window or be force-killed (CLI sometimes hangs in cleanup) | `copilotCliRunner.ts` post-stats timer | `AgentTimeouts.PostStatsHang` (new field, additive M2) |
| L4 | Context-pressure kill grace | 30_000 ms (30 s) | After `ContextPressureHandler` flags critical pressure, agent has 30 s to write the checkpoint manifest before force-kill | `copilotCliRunner.ts` post-pressure timer | `AgentTimeouts.PostPressureGrace` (new field, additive M2) |
| L5 | Hook timeout (CLI-enforced) | 5 s per hook | Embedded in hook config JSON; CLI enforces, not us | `hookInstaller.ts` `timeoutSec: 5` | `IAgentHookInstaller` template |
| L6 | CLI capability probe timeout | 15_000 ms (15 s) | Each `copilot --version` / `copilot --help` probe | `cliCheckCore.ts` line 110 | `AgentRunnerOptions.ProbeTimeout` |
| L7 | Model discovery timeout | 10_000 ms (10 s) | `copilot help config` probe | `modelDiscovery.ts` line 545 | `AgentRunnerOptions.ModelDiscoveryTimeout` |
| L8 | CLI-available cache TTL (positive) | ∞ | Once we've seen the CLI exists, we don't re-check for the daemon's lifetime | `cliCheckCore.ts` line 23 | `AgentRunnerOptions.PositiveProbeTtl` (default `TimeSpan.MaxValue`) |
| L9 | CLI-available cache TTL (negative) | 30_000 ms (30 s) | Re-probe every 30 s if the CLI was missing — handles fresh installs without a daemon restart | `cliCheckCore.ts` line 7 | `AgentRunnerOptions.NegativeProbeTtl` |
| L10 | Model discovery cache TTL | 1_800_000 ms (30 min) | Cache discovered model list to avoid spawning `copilot help config` per run | `modelDiscovery.ts` line 37 | `AgentRunnerOptions.ModelCacheTtl` |
| L11 | Transient-failure base backoff | 30_000 ms (30 s), doubles per attempt | 429 / 5xx / connection-reset / socket-error patterns within 30 s of spawn ⇒ retry | `copilotCliRunner.ts` line 130 | `AgentRunnerOptions.TransientBackoff` |
| L12 | Max transient retries | 3 | After 3 transient failures, return `AgentRunResult.Failed { reason: TransientExhausted }` | `copilotCliRunner.ts` line 125 | `AgentRunnerOptions.MaxTransientRetries` |
| L13 | Kill escalation: Windows | `taskkill /PID <pid> /T /F` (single call, tree-kill, force) | All Windows kills are tree-kill+force; no SIGTERM equivalent attempted first | `managedProcess.ts` line 145–160 | `IProcessLifecycle.StopAsync` (Windows branch) |
| L14 | Kill escalation: POSIX | SIGINT → wait 5 s → SIGTERM → wait 5 s → SIGKILL | Three-stage escalation; each step has a 5 s grace window | `managedProcess.ts` POSIX branch | `AgentTimeouts.KillEscalation` (governs spacing) |
| L15 | Post-exit log-tail drain | 2_000 ms (2 s) | After process exits, keep tailing the native debug log for 2 s to capture late writes | implicit in `logFileTailer.ts` final flush | `AgentTimeouts.PostExitDrain` |
| L16 | Final flush delay (Windows tailer) | 100 ms | Windows file-buffer settlement after exit | `logFileTailer.ts` constant | `ILogFileDiscovery` impl |
| L17 | Default log poll interval | 500 ms | fs.watch fallback poll cadence | `logFileTailer.ts` default | `ILogFileDiscovery` impl |
| L18 | fs.watch debounce | 50 ms | Coalesce rapid fs.watch events | `logFileTailer.ts` default | `ILogFileDiscovery` impl |
| L19 | Max line length before forced break | 65_536 bytes (64 KiB) | Long-running progress spinners that never emit `\n` are force-broken to keep the parser flowing | `processOutputBus.ts` `MAX_LINE_LENGTH` | `IProcessLifecycle` line-splitter |
| L20 | OS process snapshot cache | 2_000 ms (2 s) | `processMonitor.ts` caches `ps`/`Get-CimInstance` output | `processMonitor.ts` default | (C# uses `System.Diagnostics.Process` directly; no equivalent needed unless we add tree-walk) |

##### 3.2.6.4 Stdout / stderr / debug-log line patterns

These are the literal patterns the parser MUST recognize. Each row pairs the stimulus (a line written by `copilot`) with the resulting `AgentEvent` published by `IAgentStdoutParser`. The patterns are part of the contract — TS regexes and C# regexes MUST be string-equivalent (both as `IsMatch` and as capture-group extraction). The conformance fixtures (§3.2.6.10) replay recorded transcripts and assert event-stream parity.

###### Session id (`SessionIdHandler`)

Source: `stdout`. Tried in order; first match wins; subsequent lines after a successful match are no-ops.

| # | Pattern | Capture group → field |
|---|---|---|
| P-SID-1 | `/(?:^|\s)Session ID[:\s]+([a-f0-9-]{36})(?=\b)/i` | `$1 → AgentSessionId.SessionId` |
| P-SID-2 | `/(?:^|\s)session[:\s]+([a-f0-9-]{36})(?=\b)/i` (anchored to word/line boundary so a stray `--no-session: <uuid>` or substring like `subsession:` does not false-match; only triggered if P-SID-1 and P-SID-3 did not match) | `$1 → AgentSessionId.SessionId` |
| P-SID-3 | `/(?:^|\s)Starting session[:\s]+([a-f0-9-]{36})(?=\b)/i` | `$1 → AgentSessionId.SessionId` |

**SID match precedence (P-SID-PREC):** Patterns are tried P-SID-1 → P-SID-3 → P-SID-2 in that order on each line. P-SID-2 is the loosest pattern and is consulted last so that a more specific banner is preferred when both could match. The captured UUID is validated as RFC 4122 v4-compatible via `Guid.TryParseExact(_, "D")` before publishing `AgentSessionId`; rejected captures emit `AgentParseWarning { reason: "invalid-session-uuid" }` and continue scanning.

Emitted event: `AgentSessionId { runId, sessionId, sequence, at }`. Exactly one per run (idempotent thereafter).

###### Task complete (`TaskCompleteHandler`)

Source: `stdout`. Last-line marker.

| # | Pattern | Effect |
|---|---|---|
| P-TC-1 | Line contains literal `"Task complete"` (substring match) | If the process subsequently exits with `code == null && signal == null` (Windows null-exit edge case), coerce exit code to **0**. Emit `AgentTaskComplete`. |

###### Stats footer (`StatsHandler`)

Source: `stdout` and `stderr`. Patterns scanned independently per line; multiple may fire on different lines of one run.

| # | Pattern | Capture |
|---|---|---|
| P-ST-1 | `/Total usage est:\s+([\d.]+)\s+Premium requests?/i` | `$1 → AgentStats.PremiumRequests` (decimal) |
| P-ST-2 | `/API time spent:\s+(.+)/i` | `$1 → AgentStats.ApiTime` (parsed via duration parser, see DUR-* below) |
| P-ST-3 | `/Total session time:\s+(.+)/i` | `$1 → AgentStats.SessionTime` |
| P-ST-4 | `/Total code changes:\s+\+(\d+)\s+-(\d+)/i` | `$1 → CodeChanges.Added`, `$2 → CodeChanges.Removed` |
| P-ST-5 | `/Breakdown by AI model:/i` | Activates per-model line parsing for subsequent lines until blank line or stats reset |
| P-ST-6 (active mode) | `/^([\w./-]+)\s+([\d.]+[km]?)\s+in,\s+([\d.]+[km]?)\s+out(?:,\s+([\d.]+[km]?)\s+cached)?(?:\s+\(Est\.\s+([\d.]+)\s+Premium requests?\))?/i` | `$1 → ModelBreakdown.Model`, `$2 → InTokens`, `$3 → OutTokens`, `$4 → CachedTokens?`, `$5 → PremiumRequests?` |

**Token-count parser (TOK-1):** `parseTokenCount("231.5k") == 231_500`, `"1.2m" == 1_200_000`, `"500" == 500`. C# port lives in `IAgentStdoutParser` impl; helper `static long ParseTokenCount(ReadOnlySpan<char>)`.

**Duration parser (DUR-1):** `parseDuration("32s") == 32`, `"1m 30s" == 90`, `"2h 5m 10s" == 7510`. Returns total seconds as `long`. C#: `static TimeSpan ParseDuration(ReadOnlySpan<char>)`.

Emitted event: `AgentStats { runId, premiumRequests?, apiTime?, sessionTime?, codeChanges?, modelBreakdown[], at, sequence }`. Multiple emissions are allowed; last-wins for scalar fields, additive for `modelBreakdown`.

###### Context pressure (`ContextPressureHandler`)

Source: **debug log file** (`<logDir>/<date>.log`), JSON-formatted lines. NOT stdout/stderr.

| # | Pattern | Capture |
|---|---|---|
| P-CP-1 | `/"input_tokens":\s*(\d+)/` | `$1 → InputTokens` (per turn) |
| P-CP-2 | `/"output_tokens":\s*(\d+)/` | `$1 → OutputTokens` |
| P-CP-3 | `/"cache_read_tokens":\s*(\d+)/` | `$1 → CacheReadTokens` |
| P-CP-4 | `/"model":\s*"([^"]+)"/` | `$1 → Model` (used as accumulation key) |
| P-CP-5 | `/"max_prompt_tokens":\s*(\d+)/` | `$1 → MaxPromptTokens` |
| P-CP-6 | `/"max_context_window_tokens":\s*(\d+)/` | `$1 → MaxContextWindowTokens` |
| P-CP-7 | `/"truncateBasedOn":\s*"tokenCount"/` | Sets `Compacting = true` for the current turn |

Emitted event: `AgentContextPressure { runId, level: Normal\|Elevated\|Critical\|Compacting, model, inputTokens, outputTokens, cacheReadTokens, maxPromptTokens, maxContextWindowTokens, utilization, at, sequence }`.

**Pressure thresholds (THR-*):** Normal < 60% of `MaxContextWindowTokens`, Elevated 60–80%, Critical > 80%, Compacting on P-CP-7. **Critical** triggers checkpoint sentinel write (§3.2.6.6) + arms the L4 30 s grace timer.

##### 3.2.6.5 Sliding window & dispatch rules

The TS `ProcessOutputBus` and the C# `IProcessLifecycle` line dispatcher both follow these rules:

| # | Rule |
|---|---|
| W1 | Lines split on `/\r?\n/`. CR-only delimiters are NOT line breaks. |
| W2 | Per-source sliding window sized to `max(handler.windowSize)` across registered handlers for that source. Default 1 (no lookback). |
| W3 | Each registered handler is invoked once per complete line in subscription order. |
| W4 | Handler exceptions are caught + logged (`AgentParseError` event) and do NOT abort dispatch to other handlers. |
| W5 | Lines exceeding L19 (64 KiB) without a newline are emitted as a complete line with a trailing `…[truncated]` marker. |
| W6 | The line memory passed to handlers is pooled / refcounted (E1/E3 in §3.6); handlers MUST copy out only the captures they need before returning. |

##### 3.2.6.6 Hook installation

The hook installer is the single most platform-sensitive piece of the contract. Both TS `installOrchestratorHooks` and C# `IAgentHookInstaller.EnsureInstalledAsync` MUST produce byte-identical files at byte-identical paths for a given `cwd`.

###### File set (HK-FILES)

Written under `<cwd>/.github/hooks/` (NOT under `<configDir>` — these are repo-relative so the CLI discovers them via its `.github/hooks` convention):

| # | Filename | Mode | Purpose |
|---|---|---|---|
| HK-1 | `orchestrator-hooks.json` | 0644 | Hook registration manifest (see HK-MANIFEST below) |
| HK-2 | `orchestrator-pressure-gate.ps1` | 0644 | Windows preToolUse gate — checkpoint enforcement |
| HK-3 | `orchestrator-pressure-gate.sh` | 0755 | POSIX preToolUse gate — checkpoint enforcement |
| HK-4 | `orchestrator-post-tool.ps1` | 0644 | Windows postToolUse safety net |
| HK-5 | `orchestrator-post-tool.sh` | 0755 | POSIX postToolUse safety net |

###### Manifest content (HK-MANIFEST)

`orchestrator-hooks.json` literal content (verbatim — no whitespace drift between TS and C#; both implementations write through a templated `string` constant compared in CI):

```jsonc
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "bash": "bash .github/hooks/orchestrator-pressure-gate.sh",
        "powershell": "powershell -NoProfile -ExecutionPolicy Bypass -File .github/hooks/orchestrator-pressure-gate.ps1",
        "cwd": ".",
        "timeoutSec": 5
      }
    ],
    "postToolUse": [
      {
        "type": "command",
        "bash": "bash .github/hooks/orchestrator-post-tool.sh",
        "powershell": "powershell -NoProfile -ExecutionPolicy Bypass -File .github/hooks/orchestrator-post-tool.ps1",
        "cwd": ".",
        "timeoutSec": 5
      }
    ]
  }
}
```

###### Pressure-gate semantics (HK-GATE) — daemon-mediated, not in-script

The original draft of this section put the policy decision (sentinel-file checks, tool allowlist matching, JSON parsing via `sed`/`grep`) inside the `.ps1`/`.sh` files themselves. That design was rejected during security review for three reasons:

1. **The hook scripts run inside the `copilot` CLI's process tree under whatever user identity the user happens to be running as** — a hook script that does its own filesystem-state checks and JSON parsing is an attack surface (input from CLI stdin is untrusted; `sed`/`grep` JSON parsing is not safe against adversarial input; symlink-following on the sentinel-file path opens a TOCTOU window).
2. **The allowlist is policy, not configuration** — encoding it inline in shell means every policy update requires regenerating and rewriting hook files; we cannot change behavior on a running daemon.
3. **The script cannot tell whether the sentinel file is stale** — a crashed daemon may leave `CHECKPOINT_REQUIRED` behind; in-script logic has no way to test daemon liveness.

The shipping design is **daemon-mediated**: the hook scripts shrink to a thin invocation of an `ai-orchestrator hook-gate` subcommand that opens the daemon's named pipe, authenticates with the per-worktree nonce planted at hook-install time, and forwards the CLI's JSON stdin verbatim. The daemon owns the policy decision atomically using its current in-memory plan/job state; the hook script makes no decisions and reads no state files.

**Hook script body (HK-GATE-SH-1, HK-GATE-PS1-1) — both files are ~10 lines:**

```sh
#!/bin/sh
# orchestrator-pressure-gate.sh — HK-GATE shell stub. DO NOT add policy logic here;
# every decision is made by the daemon. Returns the daemon's verdict verbatim.
set -eu
NONCE_FILE="${ORCHESTRATOR_HOOK_NONCE_FILE:-$(dirname "$0")/.gate-nonce}"
exec "$(command -v ai-orchestrator || echo /usr/local/bin/ai-orchestrator)" \
    hook-gate \
    --nonce-file "$NONCE_FILE" \
    --cwd "$PWD" \
    --pipe "${ORCHESTRATOR_PIPE:-}"   # stdin (CLI's JSON) and stdout (daemon verdict) flow through
```

```powershell
# orchestrator-pressure-gate.ps1 — HK-GATE Windows stub. DO NOT add policy logic here.
$ErrorActionPreference = 'Stop'
$nonceFile = if ($env:ORCHESTRATOR_HOOK_NONCE_FILE) { $env:ORCHESTRATOR_HOOK_NONCE_FILE } else { Join-Path $PSScriptRoot '.gate-nonce' }
$exe = (Get-Command ai-orchestrator -ErrorAction SilentlyContinue)?.Source
if (-not $exe) { $exe = Join-Path $env:LOCALAPPDATA 'ai-orchestrator\ai-orchestrator.exe' }
& $exe hook-gate --nonce-file $nonceFile --cwd $PWD --pipe $env:ORCHESTRATOR_PIPE
exit $LASTEXITCODE
```

**Daemon RPC contract (HK-GATE-RPC-1) — `hooks.checkpointGate.evaluate`:**

```jsonc
// Request (over named pipe, framed per §3.4)
{
  "method": "hooks.checkpointGate.evaluate",
  "auth":   { "nonce": "<base64-128-bit, single-use, planted at hook-install>" },
  "params": {
    "cwd":      "<absolute path, validated against worktree root>",
    "toolName": "<verbatim from CLI stdin>",
    "toolArgs": { /* opaque to gate; passed through for audit only */ }
  }
}

// Response — handed back to the CLI on the gate's stdout
{ "permissionDecision": "allow" | "deny",
  "permissionDecisionReason": "<localized human string when denied; empty on allow>" }
```

**Decision policy (HK-GATE-POLICY-*), evaluated atomically inside the daemon under the plan-store reader lease:**

| # | Daemon-side rule |
|---|---|
| HK-GATE-POLICY-1 | Resolve `cwd` to a job by reverse-mapping worktree root \u2192 `JobId`. Unknown `cwd` \u21d2 `deny` with reason `unknown-worktree`. |
| HK-GATE-POLICY-2 | Look up the job's current `CheckpointState` from in-memory plan state (NOT from a sentinel file — the file is removed in v1.1+). States: `None`, `Required`, `Honored`. |
| HK-GATE-POLICY-3 | If `CheckpointState == None` or `Honored` \u21d2 `allow`. |
| HK-GATE-POLICY-4 | If `CheckpointState == Required` and `toolName` is in the allowlist (`view`, `read`, `bash`, `shell`, `write`, `edit`, `create`, `str_replace_editor`, `str_replace`, `multi_tool_use`) \u21d2 `allow`. **The allowlist lives in the daemon's compiled-in policy table, not in the hook script.** Adding a tool to the allowlist is a daemon code change reviewed under \u00a73.27.2 audit policy. |
| HK-GATE-POLICY-5 | Otherwise \u21d2 `deny` with `ORCHESTRATOR_CHECKPOINT_REQUIRED: write checkpoint-manifest.json before continuing`. |
| HK-GATE-POLICY-6 | Every gate evaluation is recorded in the audit log (\u00a73.27.2) with `action: "hook.gate.evaluated"`, `subject: { kind: "job", id: <JobId> }`, `outcome: "allow" | "deny"`, `details: { toolName, checkpointState, allowlistHit }`. |

**Nonce protocol (HK-GATE-NONCE-*):**

| # | Rule |
|---|---|
| HK-GATE-NONCE-1 | At hook install (\u00a73.2.6.6 HK-IDEM), the daemon generates a 128-bit cryptographically random nonce, writes it to `<cwd>/.github/hooks/.gate-nonce` with mode 0600 (POSIX) / owner-only ACL (Windows), and registers it in the daemon's `HookNonceTable` keyed by the file path \u2192 `JobId`. |
| HK-GATE-NONCE-2 | The nonce file is gitignored by default; the orchestrator's `.gitignore`-augmenting setup writes `.github/hooks/.gate-nonce` to the repo's `.gitignore` if absent. The `ai-orchestrator` `setup` doctor warns if the nonce file is committed. |
| HK-GATE-NONCE-3 | Each gate invocation re-reads the nonce file and presents it to the daemon. The daemon validates that the nonce matches the table entry for the file path AND that the file path resolves under a worktree the daemon owns a lease on. Nonces are NOT single-use within a job (the gate fires per-tool-use); they are rotated on each hook re-install. |
| HK-GATE-NONCE-4 | If the named pipe is unavailable (daemon down, pipe lease lost), the gate exits with the **fail-closed** verdict `deny` and reason `daemon-unavailable`. We never fail-open \u2014 a missing daemon must not silently grant unrestricted access. |
| HK-GATE-NONCE-5 | If the nonce file is missing, the gate exits `deny` with `nonce-missing`. The CLI then surfaces a clear setup error. |

**Path-traversal guard (HK-GATE-PATH-1):** The daemon validates `params.cwd` by `Path.GetFullPath` and asserts the result `StartsWith(workrootForJob)`. Symlinks in `cwd` are rejected (the daemon `lstat`s the path). This closes the in-script TOCTOU window the rejected design had.

**JSON parsing (HK-GATE-JSON-1):** All JSON parsing happens in the daemon using `System.Text.Json` source-gen. The hook script is JSON-blind \u2014 it forwards stdin bytes to the daemon and stdout bytes from the daemon back to the CLI without inspection. There is no `sed`/`grep`/`ConvertFrom-Json` in the gate script.

**Migration note.** The `<cwd>/.aio/.ps/CHECKPOINT_REQUIRED` sentinel file from earlier drafts is removed in this design \u2014 daemon in-memory `CheckpointState` is the single source of truth. A daemon restart that loses checkpoint state recovers it from the durable event log (\u00a73.30.5) on plan replay; if replay is impossible, the job's checkpoint state defaults to `Required` (fail-safe) until the agent emits the next checkpoint manifest.

###### Idempotency / upgrade (HK-IDEM)

`EnsureInstalledAsync` writes only if the SHA-256 of the current file content differs from the templated content. Existing files belonging to a previous version are silently overwritten (we own the filename namespace `orchestrator-*`). Returns `HookInstallResult { Installed: bool, PreviousVersion?: string, InstalledVersion: string }`.

###### Cleanup (HK-CLEAN)

After the run completes (success OR failure), the runner calls `uninstallOrchestratorHooks` (TS) / `IAgentHookInstaller.RemoveAsync` (C#), which best-effort deletes HK-1..HK-5 and removes `<cwd>/.github/hooks/` if empty. Errors are swallowed and logged at `Debug`. Cleanup is **synchronous** (we wait) so the next job doesn't see stale hooks.

###### Path-traversal guard (HK-SAFE)

Both implementations route every hook-file path through a `safeHookPath(hooksDir, name) → path | undefined` helper that:

1. Resolves the absolute path.
2. Asserts `resolved.StartsWith(hooksDir + separator)`.
3. Asserts `lstat(resolved).IsSymbolicLink == false`.
4. Returns the path or undefined; undefined ⇒ skip + emit `AgentSecurityWarning`.

##### 3.2.6.7 Session resume

| # | Behavior |
|---|---|
| SR-1 | Session id is captured by `SessionIdHandler` from stdout (see P-SID-*) on the first run; published as `AgentSessionId`. |
| SR-2 | The captured id is returned in `AgentRunResult.SessionId`. The orchestrator persists it on the job attempt record. |
| SR-3 | On retry of the same job, the orchestrator passes the captured id back as `AgentRunRequest.SessionId`. The runner emits `--resume <id>` (A13). |
| SR-4 | Each job has its own `<configDir>` (A9), so concurrent jobs never collide on session storage. |
| SR-5 | If `Request.SessionId` is non-null but the value is not a valid 36-char UUID, the runner throws synchronously before spawn (do not pass garbage to CLI). |
| SR-6 | If the CLI rejects the resume (session expired / not found), the runner emits `AgentSessionResumeFailed { requestedId, reason }` and **fails the run** (does not silently start a fresh session — that would surprise the caller). |

##### 3.2.6.8 Capability probing

Probe sequence (run on first invocation per process; results cached per L8/L9/L10):

| # | Probe | Stimulus | Extract | Behavior on failure |
|---|---|---|---|---|
| CP-1 | `copilot --version` | always first | version string (e.g., `1.0.31`) via `parseCliVersion()` | fall through to CP-2 |
| CP-2 | `copilot --help` | run if CP-1 yielded no version | parse model list (legacy format), parse `--effort` choices | fall through to CP-3 if CP-1 also failed |
| CP-3 | `gh copilot --help` | legacy fallback | (same) | fall through to CP-4 |
| CP-4 | `gh auth status` | indirect availability check | exit code 0 ⇒ ecosystem present | fall through to CP-5 |
| CP-5 | `github-copilot --help` | very old install layout | none | fall through to CP-6 |
| CP-6 | `github-copilot-cli --help` | very old install layout | none | give up; cache negative |
| CP-7 | `copilot help config` | run when CP-2 model parse yielded nothing (CLI ≥ 1.x) | parse model list (modern YAML-ish format) | leave model list empty |
| CP-8 | `gh auth status` then `copilot auth status` | login probe | login state, account name | emit `AgentAuthMissing` event; do not block — let CLI fail with its own message |

Cache rules: positive results live for L8 (∞), negative for L9 (30 s), model discovery for L10 (30 min). Cache keyed on the resolved CLI binary path (so a `PATH` change invalidates).

`AgentProbeResult` shape (additive M2-evolution; the table below is the v1 floor):

```csharp
public sealed record AgentProbeResult
{
    public required AgentRunnerId   RunnerId         { get; init; }
    public required string?         Version          { get; init; }   // CP-1
    public required string          BinaryPath       { get; init; }
    public required AuthState       Auth             { get; init; }   // CP-8
    public required AgentCapabilities Capabilities   { get; init; }
    public required IReadOnlyList<string> AvailableModels { get; init; } = []; // CP-2/CP-7
    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}

public sealed record AgentCapabilities
{
    public required bool                  SupportsEffort   { get; init; }   // parseEffortSupport()
    public required IReadOnlyList<string> EffortChoices    { get; init; } = [];
    public required bool                  SupportsResume   { get; init; }   // always true today; future-proofing
    public required bool                  SupportsHookV1   { get; init; }   // current hook schema
    public required bool                  SupportsAllowUrl { get; init; }
}
```

##### 3.2.6.9 Log file discovery

`ILogFileDiscovery.FindAsync` resolves the path the runner will tail for `ContextPressureHandler` input.

| # | Behavior |
|---|---|
| LF-1 | If `Request.LogDir` provided, resolve to that directory; tail every `*.log` file in it (one writer per CLI run) with directory-mode rotation handling. |
| LF-2 | Otherwise compute `<configDir>/logs` and use as in LF-1. |
| LF-3 | If neither is available, fall back to platform default and probe in order: Linux/macOS `~/.config/github-copilot/logs/`, Windows `%LOCALAPPDATA%\github-copilot\logs\`. |
| LF-4 | All paths normalized via `path.resolve()` (TS) / `Path.GetFullPath` (C#) and validated to live under a known-safe base; symlinks rejected (`lstat().IsSymbolicLink == false`). |
| LF-5 | Files are opened `O_RDONLY` only. Tailer uses `fs.watch()` + L17 fallback poll + L18 debounce. |
| LF-6 | `LogFileDiscoveryResult.Probed[]` lists every path that was checked, in order — surfaced to the user when discovery fails so they can diagnose. |

##### 3.2.6.10 Conformance test pack — ScriptedAgentRunner fixtures

Both the TS `CopilotCliRunner` and the C# `CopilotAgentRunner` MUST pass the **same** fixture corpus. Fixtures live at:

```
src/test/fixtures/copilot-cli-contract/
  <fixture-name>/
    request.json          # AgentRunRequest (serialized; same wire shape both sides)
    probe.json            # AgentProbeResult to inject (avoids real CLI dependency)
    stdout.txt            # raw bytes the ScriptedAgentRunner replays as stdout
    stderr.txt            # raw bytes for stderr
    debug-log.txt         # raw bytes for the native debug-log tail
    expected-argv.json    # exact argv the runner MUST construct (asserted before spawn)
    expected-env.json     # env keys that MUST be set / MUST be absent (NODE_OPTIONS)
    expected-events.json  # ordered list of AgentEvent records the parser MUST emit
    expected-result.json  # AgentRunResult to compare against (sessionId, exitCode, stats)
    notes.md              # human description of what this fixture proves
```

###### Fixture catalog (v1 GA floor)

Every fixture below MUST exist in the corpus; both TS and C# CI gates run all of them.

| Fixture | Validates rows |
|---|---|
| `any-spawn` | A1, A2, A3, A5, A6, A7 (sanity — minimum argv) |
| `multi-add-dir` | A4 (worktree + 2 allowed folders) |
| `url-sanitization` | A8 (3 valid + 2 malicious URLs; second set must be dropped + warned) |
| `config-dir-isolation` | A9 (default path computation with `.aio/.ps/.copilot-cli`) |
| `model-flag` | A10 (model present in probe) |
| `debug-log-spawn` | A11, LF-1, LF-2 |
| `share-path` | A12 |
| `session-resume` | A13, SR-1, SR-2, SR-3 |
| `effort-supported` | A14 (CLI supports it; flag appended) |
| `effort-downgrade` | A14 (CLI doesn't; `AgentCapabilityDowngraded` emitted, flag dropped) |
| `max-turns-deprecation` | A15 |
| `env-overlay` | ENV1 |
| `node-options-scrub` | ENV2 |
| `secret-redaction` | ENV4 |
| `session-id-pattern-1/2/3` | P-SID-1, -2, -3 |
| `task-complete-windows-null-exit` | P-TC-1 + L13 interaction |
| `stats-full-footer` | P-ST-1..6, TOK-1, DUR-1 |
| `pressure-normal/elevated/critical/compacting` | P-CP-1..7, THR-*, L4 (critical only) |
| `pressure-critical-30s-grace-kill` | L4 escalation timing |
| `stats-hang-30s-kill` | L3 escalation timing |
| `idle-deadlock-5min-kill` | L2 escalation |
| `transient-429-retry-3x-fail` | L11, L12 |
| `transient-5xx-retry-success` | L11 (succeeds on retry 2) |
| `kill-windows-tree` | L13 (asserts taskkill argv) |
| `kill-posix-3stage` | L14 |
| `hooks-install-fresh` | HK-FILES, HK-MANIFEST, HK-IDEM (fresh write) |
| `hooks-install-upgrade` | HK-IDEM (existing-but-different) |
| `hooks-install-noop` | HK-IDEM (existing-and-identical → no write) |
| `hooks-cleanup-empty-dir` | HK-CLEAN (removes empty dir) |
| `hooks-cleanup-leaves-non-empty` | HK-CLEAN (preserves dir with sibling files) |
| `hooks-path-traversal-symlink` | HK-SAFE (symlink rejected) |
| `pressure-gate-allow-no-sentinel` | HK-GATE row 1 |
| `pressure-gate-deny-fetch` | HK-GATE row 4 |
| `pressure-gate-allow-write-during-checkpoint` | HK-GATE row 3 |
| `probe-positive-cache-forever` | L8, CP-1 |
| `probe-negative-cache-30s` | L9, CP-1..6 |
| `model-discovery-help-format` | CP-2 (legacy format) |
| `model-discovery-help-config-format` | CP-7 (modern format) |
| `effort-help-parse` | parse `--effort` choices from `--help` |
| `auth-missing-warning` | CP-8 |
| `session-resume-rejected-by-cli` | SR-6 |
| `session-id-not-uuid-throws` | SR-5 |
| `log-discovery-explicit-dir` | LF-1 |
| `log-discovery-default-linux` | LF-3 (Linux paths) |
| `log-discovery-default-windows` | LF-3 (Windows paths) |
| `log-discovery-symlink-rejected` | LF-4 |
| `line-split-crlf-and-lf` | W1 |
| `line-truncation-64k` | W5, L19 |

###### Fixture authoring rules

1. Stdout/stderr/debug-log payloads are **byte-for-byte recordings** captured from real CLI runs (one-time capture; replayed deterministically thereafter).
2. `expected-events.json` is generated by running the TS implementation against the fixture in **record mode** the first time, then committed. After that, both TS and C# replay against the committed expectation.
3. Adding a new behavior requires (a) adding a fixture, (b) adding a row to this matrix, (c) implementing in both TS and C#. CI rejects the PR if any of the three is missing.
4. Fixtures are RID-agnostic where possible. Platform-specific fixtures (`kill-windows-tree`, `log-discovery-default-windows`) are tagged `[Platform("Windows")]` / `[Platform("Linux")]` and run only on the matching CI agent.

##### 3.2.6.11 Drift detection (analyzer `OE0037`)

A new analyzer **`OE0037` — Copilot CLI contract drift** runs in CI on both codebases:

- TS side: a small esbuild-time check hashes §3.2.6 (this section) and compares against `CONTRACT_HASH` constants embedded in `src/agent/copilotCliRunner.ts`, `src/agent/handlers/*.ts`, `src/agent/hookInstaller.ts`, `src/agent/cliCheckCore.ts`, `src/agent/modelDiscovery.ts`, and `src/process/processOutputBus.ts`. Mismatch ⇒ build fails with "Copilot CLI behavioral contract changed; review `docs/DOTNET_CORE_REARCHITECTURE_PLAN.md` §3.2.6 and update the embedded `CONTRACT_HASH`".
- C# side: a Roslyn analyzer (`OrchestratorAnalyzers.OE0037_CopilotContractDrift`) reads the same hash from a `[CopilotContractHash("...")]` assembly attribute on `AiOrchestrator.Agents.Copilot` and compares against the doc-derived hash injected at build time via `<CopilotContractHash>` MSBuild property (set by a `dotnet pack` pre-target that reads the doc).
- The doc-side hash is computed deterministically: SHA-256 of the canonical-newline-normalized bytes of §3.2.6 between the two `<!-- §3.2.6 START -->` / `<!-- §3.2.6 END -->` HTML-comment markers (added below this paragraph). This guarantees hash stability across editor line-ending differences.

This is the **only** mechanism that keeps the contract honest as the codebase evolves. Anyone changing Copilot interaction in either implementation MUST also update §3.2.6, regenerate the hash, and update the embedded constants — atomic in a single PR.

<!-- §3.2.6 START -->
<!-- (Hash content marker — leave above HTML comments as the canonical span boundary for OE0037.) -->
<!-- §3.2.6 END -->

##### 3.2.6.12 Cross-references

- §3.2.3 vendor projection table cells for the Copilot column delegate to this section rather than restating behaviors. The C# `CopilotAgentRunner` is built **only** of `IAgentArgvBuilder` + `IAgentStdoutParser` + `IAgentHookInstaller` + `ILogFileDiscovery` + `IAgentSessionResolver` implementations, each of which references the row ids above (e.g., `CopilotArgvBuilder` claims rows A1–A15; `CopilotStdoutParser` claims P-SID-*, P-TC-*, P-ST-*; `CopilotContextPressureParser` claims P-CP-*; `CopilotHookInstaller` claims HK-*; `CopilotLogFileDiscovery` claims LF-*; `CopilotSessionResolver` claims SR-*).
- §3.6 (Memory Efficiency) governs how `IAgentStdoutParser` consumes the `ReadOnlyMemory<byte>` line slices delivered by `IProcessLifecycle`. The contract above specifies *what* to recognize; §3.6 governs *how* to do it without allocating per line.
- §11.3 G-Acceptance test gates include the §3.2.6.10 fixture corpus as a release blocker.

#### 3.2.7 Generalized output pipeline — producers, handlers, emitters across every work-spec kind

The `IAgentStdoutParser` interface in §3.2.3 was scoped to `IAgentRunner` implementations. That scoping is wrong: today's TS `ProcessOutputBus` + `IOutputHandler` + `IOutputHandlerFactory` registry is **already** consumed by every spawned process — agents (`copilot`), shell commands (`bash`, `pwsh`, `cmd`), git subprocesses, npm install, anything that emits text. The .NET design must preserve that generality. We promote the output pipeline to a top-level abstraction that every work-spec kind shares; agent runners become one *kind* of consumer, not the only one.

##### 3.2.7.1 The three pipeline stages

```mermaid
flowchart LR
    A[Producer<br/>raw bytes from a source] --> B[Splitter<br/>bytes → lines]
    B --> C[Handler<br/>line → recognized signal]
    C --> D[Emitter<br/>signal → typed event]
    D --> E[IEventBus<br/>+ IProgress&lt;TEvent&gt;]
```

Each stage is an extension point with its own interface. Composition happens in DI:

| Stage | Interface | Responsibility | Examples |
|---|---|---|---|
| **Producer** | `IOutputProducer` | Owns a byte source; emits `OutputChunk` records into a `Channel<OutputChunk>`. Stateless toward content; aware only of source identity (`ProducerLabel`) and pooling rules from §3.6. | `ProcessStdoutProducer`, `ProcessStderrProducer`, `LogFileTailProducer`, `NamedPipeProducer`, `WebSocketProducer` (future) |
| **Splitter** | `ILineSplitter` | Buffers chunks per producer; emits `OutputLine` (refcounted `ReadOnlyMemory<byte>` view) on `\r?\n`; enforces L19 64-KiB max-line break (W5). One per producer instance. | `Utf8LineSplitter` (default), `JsonLinesSplitter` (NDJSON-aware), `AnsiAwareLineSplitter` (strips ANSI escapes before line break) |
| **Handler** | `IOutputHandler` | Pattern-matches a line. Stateful (sliding window per W2). Vendor-agnostic shape; vendor-specific impl. Returns `RecognizedSignal` records via the request's emitter sink. | `RegexMarkerHandler<TSignal>`, `JsonFieldHandler<TSignal>`, `SubstringHandler`, plus vendor-specific handlers from §3.2.6.4 |
| **Emitter** | `IOutputEmitter<TSignal, TEvent>` | Maps `RecognizedSignal` records to typed events. Owns event schema (`SchemaVersion`, EV1/EV2). Publishes to the request's `IProgress<TEvent>` and/or the global `IEventBus`. | `AgentSignalEmitter` (signal → `AgentEvent`), `ShellSignalEmitter` (signal → `ShellEvent`), `GitSignalEmitter` (signal → `GitEvent`) |

The split between **handler** (recognition) and **emitter** (event construction) is what lets a single regex/JSON handler serve many event taxonomies. A `RegexMarkerHandler` emits `RecognizedSignal { signalKind: "session-id", captures: { id: "..." } }`; an `AgentSignalEmitter` turns it into `AgentSessionId`; a `ShellSignalEmitter` would turn the same signal kind into `ShellSessionMarker` if a shell ever produced one. **Recognition is reusable; event taxonomy is per-domain.**

##### 3.2.7.2 Contracts

```csharp
namespace AiOrchestrator.Abstractions;

/// <summary>
/// A byte source. Implementations push chunks into the output Channel until the
/// source ends (process exit, file close, pipe break) and then complete the writer.
/// </summary>
public interface IOutputProducer : IAsyncDisposable
{
    ProducerLabel Label { get; }                 // open-set wrapper (M9): "stdout","stderr","log:debug","pipe:foo",…
    ProducerKind Kind { get; }                   // closed enum: Stdout | Stderr | LogFile | NamedPipe | Custom
    ChannelReader<OutputChunk> Output { get; }   // pooled bytes — see §3.6
    Task Completion { get; }                     // resolves when the source ends
}

public readonly record struct ProducerLabel(string Value)
{
    public static readonly ProducerLabel Stdout = new("stdout");
    public static readonly ProducerLabel Stderr = new("stderr");
    public static ProducerLabel LogFile(string name) => new($"log:{name}");
    public static ProducerLabel NamedPipe(string name) => new($"pipe:{name}");
}

public sealed record OutputChunk
{
    public required ProducerLabel Source { get; init; }
    public required ReadOnlyMemory<byte> Bytes { get; init; } // pooled; consumer must call Release()
    public required IPooledMemoryHandle Lease { get; init; }  // refcount holder
    public required long Sequence { get; init; }              // monotonic per producer
    public required DateTimeOffset At { get; init; }
}

/// <summary>
/// Splits chunks from one producer into complete lines. Stateful (carries a partial-line buffer).
/// </summary>
public interface ILineSplitter
{
    void Feed(OutputChunk chunk, IBufferWriter<OutputLine> sink);
    void Flush(IBufferWriter<OutputLine> sink);  // called on producer completion to emit any trailing partial line
}

public sealed record OutputLine
{
    public required ProducerLabel Source   { get; init; }
    public required ReadOnlyMemory<byte> LineUtf8 { get; init; } // pooled view
    public required IPooledMemoryHandle Lease { get; init; }
    public required long Sequence { get; init; }                 // monotonic per producer
    public required DateTimeOffset At { get; init; }
    public bool TruncatedAt64K { get; init; }                    // set when W5 fires
}

/// <summary>
/// Recognizes a pattern in a single line and emits zero or more signals.
/// Stateful (sliding window). Pure recognition — no event-taxonomy knowledge.
/// </summary>
public interface IOutputHandler
{
    HandlerSubscription Subscription { get; }   // which producer labels + which kinds this handler binds to
    int WindowSize { get; }                     // lines of lookback (default 1)
    void OnLine(LineDispatch dispatch);         // dispatch.Window is a ReadOnlySpan<OutputLine>
    void OnComplete(SourceCompleteDispatch dispatch); // called once when the source completes
}

public sealed record HandlerSubscription
{
    public required IReadOnlyList<ProducerLabel> Labels { get; init; }   // empty = all
    public required IReadOnlyList<ProducerKind> Kinds   { get; init; }   // empty = all
    public required IReadOnlyList<WorkSpecKind> WorkSpecs{ get; init; }  // empty = all (Agent | Shell | Process | Custom)
    public required string HandlerId { get; init; }                      // stable id for diagnostics + drift hash
}

public sealed record LineDispatch
{
    public required OutputLine Current { get; init; }
    public required ReadOnlySpan<OutputLine> Window { get; init; }       // most-recent N including Current (size = WindowSize)
    public required ISignalSink Sink { get; init; }
    public required CancellationToken Ct { get; init; }
}

/// <summary>
/// Where handlers push recognized signals. The pipeline routes signals to registered emitters.
/// </summary>
public interface ISignalSink
{
    void Emit(RecognizedSignal signal);
}

public sealed record RecognizedSignal
{
    public required SignalKind Kind { get; init; }                       // open-set: SessionId | Stats | TaskComplete | …
    public required ProducerLabel Source { get; init; }
    public required long ProducerSequence { get; init; }
    public required DateTimeOffset At { get; init; }
    public IReadOnlyDictionary<string, JsonElement> Captures { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}

public readonly record struct SignalKind(string Value)
{
    public static readonly SignalKind SessionId       = new("session-id");
    public static readonly SignalKind Stats           = new("stats");
    public static readonly SignalKind TaskComplete    = new("task-complete");
    public static readonly SignalKind ContextPressure = new("context-pressure");
    public static readonly SignalKind ShellPromptReady = new("shell-prompt-ready");
    public static readonly SignalKind ShellErrorRecord = new("shell-error-record");
    public static readonly SignalKind GitProgress     = new("git-progress");
    // …open set; vendors add their own
}

/// <summary>
/// Maps recognized signals to typed events for one event taxonomy (Agent / Shell / Git / …).
/// Owns SchemaVersion and the EV* evolution rules for its event family.
/// </summary>
public interface IOutputEmitter<TEvent> where TEvent : AiOrchestratorEvent
{
    EmitterScope Scope { get; }                                          // which work-spec kinds this emitter serves
    bool TryEmit(RecognizedSignal signal, IProgress<TEvent> progress, IEventBus bus);
}

public sealed record EmitterScope
{
    public required IReadOnlyList<WorkSpecKind> WorkSpecs { get; init; }
    public required IReadOnlyList<SignalKind>   Signals   { get; init; } // empty = all
}
```

##### 3.2.7.3 Composition root — registering pipelines per work-spec kind

`IProcessLifecycle.Begin` (§3.2.2.1) wires a pipeline by querying DI for every `IOutputHandler` whose `Subscription.WorkSpecs` includes the spec's kind, and every `IOutputEmitter` whose `Scope.WorkSpecs` matches. Vendor-specific bundles register at startup:

```csharp
// Agent runners — Copilot bundle
services.AddSingleton<IOutputHandler, CopilotSessionIdHandler>();      // P-SID-* from §3.2.6.4
services.AddSingleton<IOutputHandler, CopilotStatsHandler>();          // P-ST-*
services.AddSingleton<IOutputHandler, CopilotTaskCompleteHandler>();   // P-TC-*
services.AddSingleton<IOutputHandler, CopilotContextPressureHandler>();// P-CP-* (subscribes to ProducerLabel.LogFile("debug"))
services.AddSingleton<IOutputEmitter<AgentEvent>, AgentSignalEmitter>();

// Shell runners — PowerShell bundle (see §3.2.8)
services.AddSingleton<IOutputHandler, PowerShellErrorRecordHandler>(); // recognizes [System.Management.Automation.ErrorRecord]
services.AddSingleton<IOutputHandler, PowerShellWarningRecordHandler>();
services.AddSingleton<IOutputHandler, PowerShellInformationRecordHandler>();
services.AddSingleton<IOutputEmitter<ShellEvent>, ShellSignalEmitter>();

// Git subprocess bundle
services.AddSingleton<IOutputHandler, GitProgressHandler>();           // "Receiving objects: 42% (123/293)" stderr lines
services.AddSingleton<IOutputEmitter<GitEvent>, GitSignalEmitter>();

// Cross-cutting handlers — bind to ALL work-spec kinds
services.AddSingleton<IOutputHandler, AnsiEscapeStripHandler>();       // Subscription.WorkSpecs = []
services.AddSingleton<IOutputHandler, JsonLineHandler>();              // recognizes any NDJSON line as a structured signal
```

A vendor third-party plugin (per §3.1.0.5) adds a new agent simply by registering its handler bundle with `Subscription.WorkSpecs = [WorkSpecKind.Agent]` and `Subscription.Labels = [ProducerLabel.Stdout, ProducerLabel.LogFile("vendor-debug")]`. No core change. No `IAgentStdoutParser` redesign. No fork.

##### 3.2.7.4 Why this generalizes cleanly

| Concern | Old (TS) shape | New (.NET) shape |
|---|---|---|
| "Process emits stdout" | `ProcessOutputBus.feed(chunk, 'stdout')` | `IOutputProducer { Label = Stdout, Kind = Stdout }` published to channel |
| "Tail a separate log file" | `LogFileTailer` adds chunks to same bus tagged `'logFile:debug-log'` | `LogFileTailProducer { Label = LogFile("debug") }` — a peer producer; same pipeline |
| "Add a Claude-specific marker" | Subclass / fork the Copilot handler | New `IOutputHandler` with `Subscription.HandlerId = "claude.session-id"`, registered alongside Copilot's |
| "Same regex used by two vendors" | Duplicate code | One `IOutputHandler` instance; two `IOutputEmitter<TEvent>` instances translate to per-vendor event types |
| "PowerShell stderr is not really an error" | n/a (was never a first-class concern) | `PowerShellInformationRecordHandler` recognizes the pattern and emits `RecognizedSignal { Kind = ShellInformation }`; the shell emitter routes it to `ShellEvent.Information`, not `ShellEvent.Error`. See §3.2.8.5. |
| "Drop ANSI escapes everywhere" | Per-handler string strip | One `AnsiEscapeStripHandler` with `Subscription.WorkSpecs = []` (subscribes to all) wraps every other handler |

The §3.2.6 matrix becomes a *handler manifest* — each row in §3.2.6.4 is exactly one `IOutputHandler` registration. Adding a new agent means writing handlers, not modifying the engine.

##### 3.2.7.5 Drift detection (analyzer `OE0038`)

Analyzer **`OE0038` — Output handler subscription drift** reads every `IOutputHandler.Subscription.HandlerId` at build time and asserts:

1. Every `HandlerId` is unique within the assembly.
2. Every `HandlerId` referenced in §3.2.6.4 (Copilot matrix) exists as a registered handler in `AiOrchestrator.Agents.Copilot`.
3. Every Copilot-matrix handler has `Subscription.WorkSpecs.Contains(WorkSpecKind.Agent)` AND `Subscription.Labels` matches the source column of its row (Stdout, Stderr, or LogFile("debug")).
4. The same hash that pins §3.2.6 (OE0037) also pins §3.2.7.2 contracts — adding a new field to `OutputChunk` / `OutputLine` / `RecognizedSignal` is M2-additive but still requires a doc bump so the cross-vendor shape stays aligned.

Next available analyzer is **OE0039**.

##### 3.2.7.6 Self-declared golden samples — handlers carry their own example log lines

Both questions in the user prompt — *"should handlers self-declare example log lines, or should we extract from real logs?"* — get the same answer: **both, and we make the codebase enforce it.** Handlers self-declare the *minimum sample set required to prove they work*; the extraction tool feeds the *real-world corpus that catches the variations the handler author didn't anticipate*. Neither is sufficient alone, and both feed the same fixture pipeline (§3.2.6.10 / §3.2.8.7) so there is one place where conformance is asserted.

The structural problem with "just extract from real logs" alone is that it hides intent. When a handler is added without an example, six months later nobody knows what kind of line it was supposed to recognize, and the extracted corpus drifts (real logs change format). When a handler is added without extraction, the handler matches the author's mental model but misses every variation the real CLI emits. Combining the two — with the handler owning the "intent" samples and CI owning the "corpus" samples — is the only durable shape.

###### Contract additions

We extend `IOutputHandler` with one new method. It is a **default-implemented** interface member (`Abstractions` evolution rule for "new method with default impl" → minor bump, not breaking; §3.1.0.3) so existing third-party handlers keep compiling, but the build emits a warning (analyzer `OE0041`) for any handler that returns the empty default — forcing the author to either declare samples or explicitly opt out via `[NoGoldenSamplesJustified("reason")]`.

```csharp
public interface IOutputHandler
{
    HandlerSubscription Subscription { get; }
    int WindowSize { get; }
    void OnLine(LineDispatch dispatch);
    void OnComplete(SourceCompleteDispatch dispatch);

    /// <summary>
    /// Hand-authored sample lines this handler MUST recognize, plus near-miss lines it MUST NOT recognize.
    /// Returned set powers (a) self-documentation (rendered in tool docs / VS Code panel hover),
    /// (b) auto-generated unit-test fixtures (one Mocha/xUnit case per sample), and
    /// (c) the corpus-extraction tool's "did we cover everything the author cared about?" gate.
    /// Default implementation returns GoldenSampleSet.Empty — analyzer OE0041 warns on that
    /// unless the handler is annotated [NoGoldenSamplesJustified("reason")].
    /// </summary>
    GoldenSampleSet GetGoldenSamples() => GoldenSampleSet.Empty;
}

public sealed record GoldenSampleSet
{
    public required IReadOnlyList<GoldenSample> Positives { get; init; } = [];
    public required IReadOnlyList<GoldenSample> Negatives { get; init; } = [];   // near-miss lines that MUST NOT match
    public required IReadOnlyList<GoldenSequence> Sequences { get; init; } = []; // multi-line cases (sliding-window-aware)
    public static readonly GoldenSampleSet Empty = new() { Positives = [], Negatives = [], Sequences = [] };
}

public sealed record GoldenSample
{
    public required string Name { get; init; }                                // stable id, kebab-case (e.g., "session-id-banner-v1")
    public required string Description { get; init; }                         // human-readable; rendered in docs
    public required ProducerLabel Source { get; init; }
    public required string LineUtf8 { get; init; }                            // verbatim line content (no trailing \n)
    public IReadOnlyList<RecognizedSignal> ExpectedSignals { get; init; } = []; // signals the handler MUST emit
    public string? CapturedFromVersion { get; init; }                         // CLI version this sample was extracted from
    public string? CapturedFromArtifact { get; init; }                        // file path / fixture id within the corpus, if any
    public bool RealWorldExtracted { get; init; }                             // false = author-invented, true = corpus-derived
}

public sealed record GoldenSequence
{
    public required string Name { get; init; }
    public required string Description { get; init; }
    public required IReadOnlyList<GoldenSample> Window { get; init; }         // ordered; final sample is the line under test
    public IReadOnlyList<RecognizedSignal> ExpectedSignals { get; init; } = [];
}

[AttributeUsage(AttributeTargets.Class)]
public sealed class NoGoldenSamplesJustifiedAttribute(string reason) : Attribute
{
    public string Reason { get; } = reason;
}
```

Concrete example (the Copilot session-id handler from §3.2.6.4):

```csharp
public sealed class CopilotSessionIdHandler : IOutputHandler
{
    public HandlerSubscription Subscription { get; } = new()
    {
        Labels = [ProducerLabel.Stdout],
        Kinds = [ProducerKind.Stdout],
        WorkSpecs = [WorkSpecKind.Agent],
        HandlerId = "copilot.session-id",
    };
    public int WindowSize => 1;

    public void OnLine(LineDispatch dispatch) { /* P-SID-1..3 from §3.2.6.4 */ }
    public void OnComplete(SourceCompleteDispatch _) { }

    public GoldenSampleSet GetGoldenSamples() => new()
    {
        Positives =
        [
            new GoldenSample
            {
                Name = "session-id-banner-uppercase-id",
                Description = "Default banner emitted on Copilot CLI ≥1.0.20",
                Source = ProducerLabel.Stdout,
                LineUtf8 = "Session ID: 550e8400-e29b-41d4-a716-446655440000",
                ExpectedSignals =
                [
                    new RecognizedSignal
                    {
                        Kind = SignalKind.SessionId,
                        Source = ProducerLabel.Stdout,
                        ProducerSequence = 0,
                        At = default,
                        Captures = ImmutableDictionary<string, JsonElement>.Empty
                            .Add("id", JsonValue.Create("550e8400-e29b-41d4-a716-446655440000")),
                    },
                ],
                CapturedFromVersion = "1.0.20",
                RealWorldExtracted = true,
            },
            new GoldenSample
            {
                Name = "session-id-tab-separator",
                Description = "Tab-separated form some 1.0.18 builds emit",
                Source = ProducerLabel.Stdout,
                LineUtf8 = "Session ID:\t550e8400-e29b-41d4-a716-446655440000",
                /* expected signals … */
                CapturedFromVersion = "1.0.18",
                RealWorldExtracted = true,
            },
            new GoldenSample
            {
                Name = "starting-session-banner",
                Description = "Alternate banner for resumed sessions",
                Source = ProducerLabel.Stdout,
                LineUtf8 = "Starting session: 550e8400-e29b-41d4-a716-446655440000",
                /* … */
                RealWorldExtracted = false,  // author-invented to lock the regex shape
            },
        ],
        Negatives =
        [
            new GoldenSample
            {
                Name = "non-uuid-id-must-not-match",
                Description = "A 35-char id (off-by-one) must NOT be recognized",
                Source = ProducerLabel.Stdout,
                LineUtf8 = "Session ID: not-a-uuid-just-text-not-36-chars",
                ExpectedSignals = [],   // empty = no signal expected
            },
            new GoldenSample
            {
                Name = "session-id-on-stderr-must-not-match",
                Description = "Subscription is Stdout-only; stderr must be ignored",
                Source = ProducerLabel.Stderr,
                LineUtf8 = "Session ID: 550e8400-e29b-41d4-a716-446655440000",
                ExpectedSignals = [],
            },
        ],
    };
}
```

###### What the build does with the samples

1. **Auto-generated unit tests.** A Roslyn source generator (`AiOrchestrator.TestHarness.GoldenSampleGenerator`) walks every type implementing `IOutputHandler`, calls `GetGoldenSamples()`, and emits one `[Fact]` (xUnit) per `Positives`/`Negatives`/`Sequences` entry into the per-handler test project. The generated test instantiates a `ScriptedAgentRunner` with the line, runs the handler, and asserts the recognized signals match `ExpectedSignals` exactly. **Samples cannot drift from behavior** — adding a positive sample without making it pass fails the build immediately.
2. **Auto-generated fixtures.** Each sample is materialized as a fixture under `src/test/fixtures/handler-goldens/<handler-id>/<sample-name>/` with `line.txt`, `subscription.json`, and `expected-signals.json`. These are committed (so reviewers see them in PRs) and consumed by both the TS conformance gate (§3.2.6.10) and the C# xUnit gate. One source of truth — the handler — feeds both runtimes.
3. **Self-documentation.** The `ai-orchestrator handlers list --with-samples` CLI command renders every handler's samples as a Markdown table. The VS Code Plan Detail Panel surfaces them on hover ("This line was recognized by `copilot.session-id` because it matched golden sample `session-id-banner-uppercase-id`").
4. **Extraction-tool guidance.** The corpus extractor (next subsection) uses the positive samples as **classification seeds** — every real-world log line that the handler matches gets compared against the nearest golden sample and clustered into "matches existing sample" vs "novel variant." Novel variants go in front of a human for triage.

###### Real-world corpus extraction — `ai-orchestrator capture-cli-corpus`

A new CLI subcommand wraps a real CLI invocation, captures stdout/stderr/debug-log byte-for-byte, and emits a candidate fixture under `src/test/fixtures/captured-corpus/<runner-id>/<cli-version>/<scenario>/`. The capture is **deterministic and PII-scrubbed** (we apply `ISecretRedactor` before the bytes hit disk, and we replace any UUID with the well-known `00000000-0000-0000-0000-00000000000N` test ids).

```
ai-orchestrator capture-cli-corpus \
    --runner copilot \
    --scenario "fix-typescript-build-error" \
    --task "Fix the TypeScript build" \
    --record-to src/test/fixtures/captured-corpus/copilot/$(copilot --version)/fix-typescript-build-error/
```

The tool then runs the **classification pass**: for every line in the captured stdout/stderr/debug-log, it asks every registered handler "would you have matched this?" and writes a `classification.json` next to the captured bytes:

```json
{
  "totalLines": 1247,
  "classifiedLines": 1198,
  "novelLines": 49,
  "byHandler": {
    "copilot.session-id":      { "matched": 1, "matchedSampleNames": ["session-id-banner-uppercase-id"] },
    "copilot.stats":           { "matched": 12, "matchedSampleNames": ["stats-footer-v1", "stats-model-breakdown-v1"] },
    "copilot.task-complete":   { "matched": 1, "matchedSampleNames": ["task-complete-v1"] },
    "copilot.context-pressure":{ "matched": 234, "matchedSampleNames": ["pressure-input-tokens", "pressure-model-key"] }
  },
  "novelLineRefs": [
    { "byteRange": { "offset": 12345, "length": 87 }, "preview": "Stats summary unavailable: backend reported error 504", "suggestedHandler": "copilot.stats", "reason": "looks-like-stats-but-no-existing-sample-matches" }
  ]
}
```

Novel lines fail the `validate-corpus` CI gate by default, forcing one of three resolutions in the same PR:

1. **Add a positive golden sample** to the relevant handler (when the line *should* be recognized) — auto-generates the matching fixture and unit test.
2. **Add a negative golden sample** to the relevant handler (when the line *should not* be recognized but looked tantalizingly close) — locks the negative case in.
3. **Suppress with justification** via `corpus-suppressions.jsonc` (`{ "byteRange": …, "reason": "transient backend message; no semantic value" }`) — visible in PR review.

###### Why this combination is durable

| Failure mode | What catches it |
|---|---|
| Handler shipped without any test coverage | Analyzer **`OE0041`** — handler returns `GoldenSampleSet.Empty` without `[NoGoldenSamplesJustified]` |
| Handler regex changes silently and stops matching real logs | Auto-generated unit test (positives turn red) and corpus extraction (next CLI version's capture-pass shows the lines as `novelLines`) |
| Handler regex over-matches an unrelated line | Negative samples assert non-match; corpus classification flags lines matched by *more than one* handler as ambiguous |
| Real CLI emits a brand-new line shape we've never seen | `ai-orchestrator capture-cli-corpus` against a new CLI version surfaces it as `novelLines`; PR must add a sample |
| Author invents samples that don't reflect reality | `RealWorldExtracted = false` is rendered in CLI / panel docs; reviewers can prioritize replacing them with corpus-extracted ones |
| Localized log content sneaks in (English-only assumption breaks) | Corpus extraction is run under `LANG=qps-Ploc` (§2.4.4) for handlers tagged `Subscription.WorkSpecs` to verify L1 (logs are invariant English) |

###### Conformance gates

Added to §11.3 (G-Acceptance) as release-blocking:

- **G-Goldens-Pass:** Every handler's `GetGoldenSamples()` positives match (and negatives don't match) — generated unit tests are green for both TS and C#.
- **G-Corpus-Coverage:** ≥ 95% of captured-corpus lines for the latest shipped CLI version classify against a known sample (the rest must be in `corpus-suppressions.jsonc`).
- **G-No-Empty-Samples:** No handler ships `GoldenSampleSet.Empty` without `[NoGoldenSamplesJustified]`.

###### TS-side parity

TypeScript handlers (today's `IOutputHandler`) get the same treatment via a small build script (`scripts/extract-handler-goldens.ts`) that reads a `golden-samples` field on each handler module and writes the same `src/test/fixtures/handler-goldens/<handler-id>/` tree. The generated Mocha tests live alongside the existing unit-test suite. Both runtimes consume the **same on-disk fixture format** so a sample added on either side immediately validates on the other — closing the loop with §3.2.6.10's TS↔C# parity contract.

Next available analyzer is **OE0042**.

#### 3.2.8 Shell work specs as first-class — `PowerShellWorkSpec`, `BashWorkSpec`, `CmdWorkSpec`, `ShWorkSpec`

Shell commands are not a single `ProcessWorkSpec` with a `shell` enum field — they are **distinct work-spec kinds** because their argv conventions, error-stream semantics, exit-code semantics, OS availability, and output-handler bundles all differ. The TS implementation today flattens them into a `ShellSpec` discriminator on `WorkSpec` with a `shell: "cmd"|"powershell"|"pwsh"|"bash"|"sh"` field; that conflates execution policy with the kind of thing being executed and has caused real bugs (PowerShell stderr-as-error, WSL path translation, `cmd /c` quoting). The .NET design promotes each shell to its own type with its own runner.

##### 3.2.8.1 Discriminated work-spec hierarchy

```csharp
namespace AiOrchestrator.Models;

/// <summary>Closed discriminated union over work-spec kinds. New kinds are M2-additive.</summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
[JsonDerivedType(typeof(AgentWorkSpec),       "agent")]
[JsonDerivedType(typeof(ProcessWorkSpec),     "process")]
[JsonDerivedType(typeof(PowerShellWorkSpec),  "powershell")]   // pwsh OR Windows PowerShell — see §3.2.8.3
[JsonDerivedType(typeof(BashWorkSpec),        "bash")]         // bash on POSIX; Git Bash / WSL bash on Windows
[JsonDerivedType(typeof(ShWorkSpec),          "sh")]           // POSIX sh — never legal on Windows without WSL
[JsonDerivedType(typeof(CmdWorkSpec),         "cmd")]          // Windows cmd.exe — never legal on POSIX
public abstract record WorkSpec
{
    public required WorkSpecKind Kind { get; init; }
    public IReadOnlyDictionary<string, string> Env { get; init; } = ImmutableDictionary<string, string>.Empty;
    public string? Cwd { get; init; }
    public TimeSpan? Timeout { get; init; }
    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}

public enum WorkSpecKind { Agent, Process, PowerShell, Bash, Sh, Cmd, Custom }
```

Each shell spec is a `sealed record` with shell-specific fields:

```csharp
public sealed record PowerShellWorkSpec : WorkSpec
{
    public required string Script { get; init; }                         // body of the script (NOT a file path by default)
    public PowerShellEdition Edition { get; init; } = PowerShellEdition.Auto; // Auto | Pwsh | WindowsPowerShell
    public PowerShellExecutionPolicy ExecutionPolicy { get; init; } = PowerShellExecutionPolicy.Bypass;
    public StderrPolicy StderrPolicy { get; init; } = StderrPolicy.TreatAsInformational; // §3.2.8.5
    public ExitCodePolicy ExitCodePolicy { get; init; } = ExitCodePolicy.NonZeroIsFailure;
    public bool LoadProfile { get; init; } = false;                      // -NoProfile by default
    public bool UseStrictMode { get; init; } = true;                     // Set-StrictMode -Version Latest prelude
    public PowerShellErrorActionPreference ErrorActionPreference { get; init; }
        = PowerShellErrorActionPreference.Continue;                      // see §3.2.8.5
    public bool NativeCommandUseErrorActionPreference { get; init; } = false; // PS 7.3+ native-cmd erroring
}

public sealed record BashWorkSpec : WorkSpec
{
    public required string Script { get; init; }
    public BashFlavor Flavor { get; init; } = BashFlavor.Auto;           // Auto | Native | GitBash | Wsl
    public BashOptions Options { get; init; } = BashOptions.Strict;      // -euo pipefail by default (Strict)
    public StderrPolicy StderrPolicy { get; init; } = StderrPolicy.StreamSeparately;
    public ExitCodePolicy ExitCodePolicy { get; init; } = ExitCodePolicy.NonZeroIsFailure;
    public bool TranslateWindowsPathsForWsl { get; init; } = true;       // /mnt/c/... rewriting
}

public sealed record ShWorkSpec : WorkSpec
{
    public required string Script { get; init; }
    public ShOptions Options { get; init; } = ShOptions.Strict;          // set -eu (no pipefail in POSIX sh)
    public StderrPolicy StderrPolicy { get; init; } = StderrPolicy.StreamSeparately;
    public ExitCodePolicy ExitCodePolicy { get; init; } = ExitCodePolicy.NonZeroIsFailure;
}

public sealed record CmdWorkSpec : WorkSpec
{
    public required string Script { get; init; }                         // contents of a .cmd / .bat
    public CmdQuotingMode Quoting { get; init; } = CmdQuotingMode.Safe;  // §3.2.8.4
    public StderrPolicy StderrPolicy { get; init; } = StderrPolicy.StreamSeparately;
    public ExitCodePolicy ExitCodePolicy { get; init; } = ExitCodePolicy.NonZeroIsFailure;
}

public enum StderrPolicy
{
    StreamSeparately,        // stderr → ProducerLabel.Stderr; never affects exit/success
    TreatAsInformational,    // stderr → ProducerLabel.Stderr but tagged Information; emitter routes to ShellInformation, not ShellError (default for PowerShell)
    TreatAsWarning,          // emitter routes to ShellWarning
    TreatAsError,            // any stderr write fails the run regardless of exit code (legacy strict mode)
    MergeIntoStdout          // 2>&1 — single combined stream
}

public enum ExitCodePolicy
{
    NonZeroIsFailure,        // default
    AnyExitIsSuccess,        // diagnostic-only jobs
    Custom                   // caller provides predicate via Extensions["exitCodePredicate"]
}
```

##### 3.2.8.2 Per-shell runners — `IShellRunner` family

Each shell has its own runner registered with keyed DI (`typeof(PowerShellRunner)` etc.), implementing a shared interface:

```csharp
public interface IShellRunner
{
    WorkSpecKind Kind { get; }
    Task<ShellRunResult> RunAsync(ShellRunRequest request, CancellationToken ct);
}

public sealed record ShellRunRequest
{
    public required WorkSpec Spec { get; init; }                         // narrowed type-checked at dispatch
    public required string RunId { get; init; }
    public required string Cwd { get; init; }
    public required IProgress<ShellEvent>? Observer { get; init; }
    public required IRequestCulture Culture { get; init; }
    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}

public sealed record ShellRunResult
{
    public required int ExitCode { get; init; }
    public required ExitDisposition Disposition { get; init; }
    public required TimeSpan Elapsed { get; init; }
    public required ShellOutcome Outcome { get; init; }                  // Success | Failure | StderrTreatedAsError | TimedOut | Killed
    public required IReadOnlyList<string> StderrSummary { get; init; }   // first N + last N stderr lines for diagnostics
}

// Routing service — picks the right IShellRunner from a WorkSpec
public interface IShellRunnerDispatcher
{
    IShellRunner GetForKind(WorkSpecKind kind);
}
```

Each runner builds platform-correct argv via its own `IShellArgvBuilder` (sibling of `IAgentArgvBuilder` from §3.2.3). The shape is stable across shells:

```csharp
public interface IShellArgvBuilder    { ProcessStartInfo Build(BuildShellArgvRequest request); }
public interface IShellPreludeWriter  { string ComposeScript(ComposePreludeRequest request); }
public interface IShellExecutableResolver { Task<ShellExecutableResolveResult> ResolveAsync(ShellExecutableResolveRequest request, CancellationToken ct); }
```

##### 3.2.8.3 Executable discovery and OS-aware dispatch

`IShellExecutableResolver` is the single place that knows where each shell binary lives on each OS. Result is cached per-process.

| Spec kind | Resolution strategy on Windows | Resolution strategy on Linux/macOS |
|---|---|---|
| `PowerShellWorkSpec` (Edition=Auto) | Probe `pwsh.exe` on PATH first; fall back to `%ProgramFiles%\PowerShell\7\pwsh.exe`; final fallback to `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`. **Emit `ShellEditionResolved { edition: Pwsh \| WindowsPowerShell }` event so callers can see what was chosen.** | Probe `pwsh` on PATH; if absent, fail fast with a typed `ShellNotAvailableException("pwsh")`. Windows PowerShell is unreachable on POSIX. |
| `PowerShellWorkSpec` (Edition=Pwsh) | Require `pwsh`; never fall back. | Same. |
| `PowerShellWorkSpec` (Edition=WindowsPowerShell) | Require `powershell.exe`; refuse on POSIX with `ShellNotSupportedOnPlatformException`. | Refuse with same exception. |
| `BashWorkSpec` (Flavor=Auto) | Probe `bash.exe` on PATH (Git Bash); if absent, probe `wsl.exe` and check WSL has a default distro; if absent, fail. **Emit `ShellFlavorResolved { flavor: Native \| GitBash \| Wsl }`.** | Probe `bash` on PATH. |
| `BashWorkSpec` (Flavor=GitBash) | Require `C:\Program Files\Git\bin\bash.exe` (or PATH-located `bash.exe` whose parent dir contains `git.exe`); refuse otherwise. | Refuse on POSIX (irrelevant). |
| `BashWorkSpec` (Flavor=Wsl) | Require `wsl.exe`; spec MAY include `Extensions["wslDistro"]` to pin a distro. | Refuse on POSIX. |
| `ShWorkSpec` | **Refuse with `ShellNotSupportedOnPlatformException`** unless `Extensions["wslDistro"]` is set, in which case dispatch through `wsl.exe`. | Probe `sh` on PATH (POSIX-mandated to exist). |
| `CmdWorkSpec` | Use `%ComSpec%` (always `cmd.exe` on Windows). | Refuse with `ShellNotSupportedOnPlatformException`. |

The dispatcher fails the work-spec at the **scheduler** stage (before worktree acquisition / process spawn) when the spec is structurally illegal on the current OS — caller sees a typed error, not a cryptic process-spawn failure. Codified as rule **W1** (work-spec validation): every `IShellRunner.RunAsync` calls `IShellExecutableResolver.ResolveAsync` first; resolution failure short-circuits with a typed `ShellOutcome.NotAvailableOnPlatform` and never spawns a process.

##### 3.2.8.4 Argv assembly per shell — the platform-quirk encapsulation table

Each runner owns the argv conventions and quoting rules for its shell. These are the rules the .NET implementations MUST honor; they're each enforced by a fixture in §3.2.8.7.

| Shell | Argv pattern | Script delivery | Quoting / escape rule |
|---|---|---|---|
| `pwsh` / `powershell` | `pwsh -NoProfile -NonInteractive -ExecutionPolicy <policy> -Command -` | Script body written to **stdin**, then stdin closed. We never use `-Command "<inline>"` (avoids quote-parsing hell with embedded `"`, `'`, `$`, backticks). | Stdin delivery means PowerShell's parser sees the script bytes verbatim. UTF-8 BOM prepended on Windows PowerShell only (it can't infer encoding without one). |
| `bash` (native / Git Bash) | `bash --noprofile --norc -o errexit -o nounset -o pipefail -s` (when `Options=Strict`) | Script body via **stdin** (`-s`). | Stdin delivery; no shell expansion of our framing. |
| `bash` (WSL) | `wsl.exe -d <distro> -- bash --noprofile --norc -o errexit -o nounset -o pipefail -s` + path translation. | Stdin to `wsl.exe`. | `BashWorkSpec.TranslateWindowsPathsForWsl` rewrites `Cwd` and any path in `Env` from `C:\foo\bar` to `/mnt/c/foo/bar` before invocation. Implemented as a focused `IWslPathTranslator` interface so it's swappable per WSL version. |
| `sh` (POSIX) | `sh -s` (with `set -eu` injected as prelude when `Options=Strict`) | Script body via **stdin**. | Stdin delivery; no expansion. |
| `cmd.exe` | `cmd.exe /D /C "<scriptfile>"` — script body written to a **temp `.cmd` file** (UTF-8 with BOM, executed from a transient location under `<cwd>/.aio/.ps/cmd-tmp/<guid>.cmd`, deleted on completion). We do NOT use `cmd /C "<inline>"` because cmd's quoting rules (the infamous double-quote-doubling, caret-escaping) are unreasonable to encode at the API boundary. | File-based delivery; argv is just the file path. | `CmdQuotingMode.Safe` is the only supported mode for v1. `CmdQuotingMode.Raw` (caller-supplied verbatim quoting) is reserved for future scenarios but blocked by analyzer **`OE0039`** in v1 (forces `Safe`). |

**Stdin-delivery rule (W2):** All shells receive their script body via stdin (or via a tempfile for `cmd.exe`). **Inline `-Command` / `-c` flags are forbidden** (analyzer `OE0040`). Rationale: every shell-injection bug we've ever seen in this codebase has come from inline script construction. Stdin delivery makes the script body un-confusable with argv.

**Tempfile cleanup rule (W3):** Any tempfile created by a shell runner MUST be deleted in a `try/finally` whose `finally` runs even on cancellation (using `IAsyncDisposable` lease pattern from §3.3.2). Leaked temp scripts under `.aio/.ps/cmd-tmp/` are reclaimed at daemon startup by `ReclaimOrphansAsync` (the same crash-safety registry that handles worktree leases).

##### 3.2.8.5 Stderr policy — the PowerShell pain point, generalized

The user-reported pain is real: PowerShell's default `$ErrorActionPreference` interacts with native-command stderr in surprising ways, especially in PS 7.3+ with `$PSNativeCommandUseErrorActionPreference = $true`. Tools that legitimately write progress, debug, or info to stderr (npm, dotnet, gh, copilot, git, cargo, …) trigger spurious script-level failures. The `StderrPolicy` enum + the prelude composer fix this **at the runner layer**, not by asking script authors to remember the right preference incantation.

| `StderrPolicy` | What the runner does | What the handler/emitter sees |
|---|---|---|
| `StreamSeparately` (default for bash/sh/cmd) | stderr captured on its own producer; exit code is the sole success signal | `ProducerLabel.Stderr` lines pass through unchanged; emitters classify based on content |
| `TreatAsInformational` (default for PowerShell) | The runner injects this prelude before the script body: `$ErrorActionPreference = 'Continue'; $PSNativeCommandUseErrorActionPreference = $false; $WarningPreference = 'Continue'; $InformationPreference = 'Continue'`. Tools that write to stderr no longer trip PowerShell's error stream. | `ShellSignalEmitter` routes plain stderr lines to `ShellEvent.Information`. Lines matching the PS error-record marker (`PowerShellErrorRecordHandler`) become `ShellEvent.Error`. |
| `TreatAsWarning` | Same prelude as `TreatAsInformational`. | Plain stderr → `ShellEvent.Warning`. |
| `TreatAsError` (legacy strict mode) | No prelude injection — caller has explicitly opted into "any stderr write fails the run." | Any stderr line → `ShellOutcome.StderrTreatedAsError` and the run fails irrespective of exit code. |
| `MergeIntoStdout` | Runner appends `2>&1` redirection (in the prelude or as a wrapper depending on shell). Single combined producer. | Only `ProducerLabel.Stdout` is populated. |

The PowerShell prelude is composed by `PowerShellPreludeWriter`:

```csharp
public sealed class PowerShellPreludeWriter : IShellPreludeWriter
{
    public string ComposeScript(ComposePreludeRequest req)
    {
        var spec = (PowerShellWorkSpec)req.Spec;
        var sb = new StringBuilder(capacity: spec.Script.Length + 512);

        // Always-on safety
        sb.AppendLine("$ProgressPreference = 'SilentlyContinue'");      // suppress noisy progress bars
        sb.AppendLine($"Set-StrictMode -Version Latest"); // when UseStrictMode

        // Stderr-policy translation
        switch (spec.StderrPolicy)
        {
            case StderrPolicy.TreatAsInformational:
            case StderrPolicy.TreatAsWarning:
                sb.AppendLine("$ErrorActionPreference = 'Continue'");
                sb.AppendLine("$WarningPreference = 'Continue'");
                sb.AppendLine("$InformationPreference = 'Continue'");
                sb.AppendLine("$PSNativeCommandUseErrorActionPreference = $false");
                break;
            case StderrPolicy.TreatAsError:
                sb.AppendLine("$ErrorActionPreference = 'Stop'");
                sb.AppendLine("$PSNativeCommandUseErrorActionPreference = $true");
                break;
            case StderrPolicy.MergeIntoStdout:
                // wrapper handles 2>&1; no preference change here
                break;
        }

        // ErrorActionPreference override (explicit caller setting wins over policy default)
        if (spec.ErrorActionPreference != PowerShellErrorActionPreference.Inherit)
            sb.AppendLine($"$ErrorActionPreference = '{spec.ErrorActionPreference}'");

        sb.AppendLine("# --- user script ---");
        sb.Append(spec.Script);
        return sb.ToString();
    }
}
```

##### 3.2.8.6 Output handler bundles per shell

Each shell ships a handler bundle that subscribes to `Subscription.WorkSpecs = [WorkSpecKind.PowerShell]` (or Bash, Sh, Cmd) and recognizes shell-specific signals:

| Bundle | Handlers | Recognized signals |
|---|---|---|
| **PowerShell** | `PowerShellErrorRecordHandler`, `PowerShellWarningRecordHandler`, `PowerShellInformationRecordHandler`, `PowerShellProgressHandler` | `ShellErrorRecord`, `ShellWarning`, `ShellInformation`, `ShellProgress` (for `Write-Progress` lines that leaked through) |
| **Bash / Sh** | `BashErrSetTraceHandler` (`+ <cmd>` from `set -x`), `BashExitNonZeroHandler` (set -e exit), `BashPipefailHandler` | `ShellTrace`, `ShellExitNonZero`, `ShellPipefail` |
| **Cmd** | `CmdErrorlevelHandler` (parses `errorlevel=N`), `CmdEchoHandler` (filters echo-ed prelude noise) | `ShellExitNonZero`, `ShellEchoSuppressed` |

All emit through the §3.2.7 pipeline; the `ShellSignalEmitter` produces `ShellEvent` records (parallel to `AgentEvent`). The same cross-cutting `AnsiEscapeStripHandler` from §3.2.7.3 applies — no duplication.

##### 3.2.8.7 Conformance fixtures

`src/test/fixtures/shell-runner-contract/` mirrors the agent fixture corpus from §3.2.6.10. Required fixtures at v1 GA:

| Fixture | Validates |
|---|---|
| `pwsh-stderr-as-information-default` | The default `StderrPolicy.TreatAsInformational` does NOT fail a script when `npm install` writes warnings to stderr. |
| `pwsh-stderr-as-error-explicit` | `StderrPolicy.TreatAsError` correctly fails the run when stderr is non-empty even if exit code is 0. |
| `pwsh-merged-2to1` | `StderrPolicy.MergeIntoStdout` produces only `ProducerLabel.Stdout` output. |
| `pwsh-edition-auto-prefers-pwsh` | Edition=Auto picks `pwsh` over `powershell.exe` when both are present. |
| `pwsh-edition-auto-falls-back-windowspowershell` | Edition=Auto picks `powershell.exe` when `pwsh` is absent. |
| `pwsh-edition-windowspowershell-on-linux-fails` | `Edition=WindowsPowerShell` on Linux throws `ShellNotSupportedOnPlatformException` *before* spawn. |
| `bash-flavor-auto-windows-prefers-gitbash` | Flavor=Auto on Windows picks Git Bash over WSL when both are present. |
| `bash-flavor-wsl-translates-paths` | `TranslateWindowsPathsForWsl=true` converts `C:\repo\foo` → `/mnt/c/repo/foo` in `Cwd` and `Env`. |
| `bash-strict-mode-pipefail-fires` | `Options=Strict` causes a failed mid-pipeline command to fail the script. |
| `sh-on-windows-fails-without-wsl` | `ShWorkSpec` on Windows without `Extensions["wslDistro"]` fails fast. |
| `cmd-on-linux-fails` | `CmdWorkSpec` on Linux fails fast with `ShellNotSupportedOnPlatformException`. |
| `cmd-tempfile-cleanup` | The transient `.aio/.ps/cmd-tmp/<guid>.cmd` is deleted on success, failure, AND cancellation. |
| `cmd-tempfile-orphan-reclaim` | Daemon startup reclaims tempfiles left from a crashed previous run. |
| `pwsh-script-via-stdin-not-command-flag` | Argv contains `-Command -` (stdin marker), NEVER `-Command "<script body>"`. Asserted by argv inspection. |
| `bash-script-via-stdin-not-c-flag` | Argv contains `-s`, NEVER `-c "<script body>"`. |
| `inline-c-flag-rejected-at-build` | Compile-time analyzer `OE0040` blocks any code path that passes `-c` / `-Command "<inline>"` to a shell runner. |
| `pwsh-progress-suppressed` | `$ProgressPreference = 'SilentlyContinue'` is in the injected prelude (asserted by stdin capture). |
| `pwsh-error-record-emits-shellerror` | A `Write-Error "boom"` line is parsed by `PowerShellErrorRecordHandler` and emits `ShellEvent.Error`. |
| `pwsh-information-stream-emits-shellinformation` | A plain stderr line under default policy emits `ShellEvent.Information`, NOT `ShellEvent.Error`. |
| `bash-set-x-trace-emits-shelltrace` | `set -x` traces are routed to `ShellEvent.Trace`, not `ShellEvent.Error`. |
| `cross-cutting-ansi-strip-applies-to-shells` | `AnsiEscapeStripHandler` strips ANSI from PowerShell output without per-shell duplication. |

##### 3.2.8.8 Why this is structurally better than the TS shape

| Concern | TS today | .NET v1 |
|---|---|---|
| PowerShell stderr-as-error | Caller must remember `$ErrorActionPreference = 'Continue'` in every script | Default `StderrPolicy.TreatAsInformational` injects the right prelude; works without script-author knowledge |
| WSL path translation | Manual per-script | `BashWorkSpec.TranslateWindowsPathsForWsl = true` (default), encapsulated in `IWslPathTranslator` |
| `cmd /c "<long-quoted>"` quoting bugs | Recurrent | Tempfile delivery (W2) — quoting eliminated as a class |
| OS-illegal spec discovered late | Spawn fails with cryptic OS error | Dispatcher rejects at scheduler with typed `ShellNotSupportedOnPlatformException` |
| Adding a new shell (e.g., `nu`, `fish`) | Touch the discriminator + every consumer | Add a new `WorkSpec` subtype + new `IShellRunner` registration; M2-additive everywhere else |
| Sharing handlers across shells | Copy/paste | Handler bundles via §3.2.7 pipeline; cross-cutting handlers (ANSI strip) bind via empty `WorkSpecs` filter |
| Per-shell event taxonomy | Single `ShellResult` blob | `ShellEvent` hierarchy with `ShellEvent.Error`, `.Warning`, `.Information`, `.Trace`, `.Progress`, `.ExitNonZero` — additive (M7/EV1) |

##### 3.2.8.9 Cross-references

- §3.2.7 owns the pipeline; this section owns the *consumers* of that pipeline for shell work-specs.
- §3.3.1 (per-remote credential resolution) is the same pattern applied to git remotes — both sections show "platform/vendor differences encapsulated behind a typed dispatch boundary, not flattened into a string discriminator."
- New analyzers introduced here: **`OE0039` (cmd Raw quoting blocked in v1)** and **`OE0040` (no inline `-c`/`-Command` script delivery)**. (Note: `OE0041` is also taken — see §3.2.7.6 *empty golden-sample sets without justification*. Next available is **OE0042**.)

### 3.3 Git and storage

```csharp
public interface IGitOperations
{
    IGitBranches Branches { get; }
    IGitWorktrees Worktrees { get; }
    IGitMerge Merge { get; }
    IGitRepository Repository { get; }
    IGitExecutor Executor { get; }      // CLI fallback for ops not covered by libgit2sharp
}

public interface IPlanRepository
{
    Task<PlanInstance>  ScaffoldAsync (PlanScaffoldRequest request, CancellationToken ct);
    Task<PlanInstance>  AddJobAsync  (AddJobRequest      request, CancellationToken ct);
    Task<PlanInstance>  FinalizeAsync (PlanId              planId,  CancellationToken ct);
    Task<PlanInstance?> LoadStateAsync(PlanId              planId,  CancellationToken ct);
    Task                SaveStateAsync(PlanInstance        plan,    CancellationToken ct);
}

public sealed record AddJobRequest
{
    public required PlanId  PlanId { get; init; }
    public required JobSpec Job   { get; init; }
    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}
```

**Git implementation strategy: prefer C# libraries over `git` CLI execution.**

`AiOrchestrator.Git` ships two cooperating implementations behind `IGitOperations`:

1. **`LibGit2SharpGitOperations` (default)** — uses [libgit2sharp](https://github.com/libgit2/libgit2sharp) for repository, branches, refs, blobs, diff, status, fetch, push, and most merge operations. This eliminates per-op subprocess spawn cost (currently 50–200 ms per `git` call × thousands of calls per plan), gives us in-process error handling, and removes the `git` binary as a hard dependency for non-worktree operations.
2. **`GitCliGitOperations` (fallback)** — wraps the `git` binary via `IProcessSpawner` for the operations libgit2 cannot do robustly today, namely:
   - `git worktree add/remove/list/prune` (libgit2's worktree support is incomplete on multiple platforms — confirmed via integration tests; we will revisit per-release).
   - `git rebase --interactive` (we don't use it, but if an extension does).
   - Operations requiring credential-helper integration (push with 2FA, GitHub Enterprise SSO) where the user's configured helpers must be honored.

`HybridGitOperations` is the production composition root: every method tries the libgit2 path first and falls back to CLI only for the explicitly-allowlisted operations. The fallback decision is **static per method**, not runtime detection — easy to audit.

This ports the current `src/git/**` semantics (which is 100% CLI today) but at significantly lower latency. Existing TS git unit tests are ported and re-run against both backends in CI to prove behavioral equivalence.

#### 3.3.1 Per-remote authentication — avoiding `gh auth switch` hell

A single plan routinely touches multiple repositories that live on **different remote types** with **different identities** — e.g., a base repo on `dev.azure.com/contoso`, a fork on `github.com`, and a vendored dependency on `ghe.contoso.com`. Today's TS implementation leans on whatever ambient identity `git`/`gh` happens to have selected, which forces users into the `gh auth switch` / `gh auth login --hostname …` dance and frequently picks the wrong account when multiple are configured. The .NET design fixes this by treating **credential resolution as a first-class, per-remote concern** owned by `AiOrchestrator.Security` and consumed by both the libgit2sharp and CLI backends.

```csharp
public interface IRemoteIdentityResolver
{
    /// <summary>
    /// Resolve the credential to use for a given remote URL + operation,
    /// without mutating any global CLI state (no `gh auth switch`, no `az login`).
    /// </summary>
    Task<RemoteCredentialResult> ResolveAsync(RemoteCredentialRequest request, CancellationToken ct);
}

public sealed record RemoteCredentialRequest
{
    public required Uri              RemoteUrl { get; init; }   // https://github.com/org/repo, https://dev.azure.com/...
    public required GitOperationKind Operation { get; init; }   // Fetch | Push | Clone | LfsFetch | ApiCall
    public string?                   PreferredAccount { get; init; } // optional override; otherwise per-host policy
    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}

public sealed record RemoteCredentialResult
{
    public required RemoteHostKind   HostKind   { get; init; } // GitHubDotCom | GitHubEnterprise | AzureDevOps | GenericHttps | Ssh
    public required CredentialSource Source     { get; init; } // GitCredentialManager | GhCli | AzCli | EnvVar | KeyringDirect
    public required string           Account    { get; init; } // login name / UPN — for logging only, never the secret
    public required ICredentialLease Lease      { get; init; } // disposable; secret material lives only inside the lease
    public DateTimeOffset?           ExpiresAt  { get; init; }
}

public interface ICredentialLease : IAsyncDisposable
{
    /// <summary>Apply credentials to a libgit2sharp `CredentialsHandler` for one operation.</summary>
    LibGit2Sharp.Credentials ToLibGit2();
    /// <summary>Materialize a per-process env block for a `git`/`gh`/`az` subprocess (e.g., GIT_ASKPASS, GCM_INTERACTIVE=never).</summary>
    IReadOnlyDictionary<string, string> ToProcessEnv();
}
```

**Per-host strategies** — each is a small, isolated adapter; no host knows about the others:

| Host kind | Resolution strategy | Notes |
|---|---|---|
| `github.com` | Git Credential Manager (GCM) **scoped to the exact remote URL**, then fall back to `gh auth token --hostname github.com --user <preferred>` | Use `gh`'s **multi-account API** (`gh auth token --user …`) — does **not** mutate the active account, unlike `gh auth switch`. |
| GitHub Enterprise (`ghe.*`) | GCM with `credential.https://ghe.example.com.helper`, then `gh auth token --hostname ghe.example.com --user <preferred>` | Same pattern; `--hostname` + `--user` keeps GH and GHE identities cleanly separated. |
| Azure DevOps (`dev.azure.com`, `*.visualstudio.com`) | GCM (which natively brokers Entra ID / PAT for ADO), then Azure CLI `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798` for federated/service-principal flows | Never store ADO PATs in env vars; always pull through GCM so MFA / Conditional Access works. |
| Generic HTTPS git host | GCM `get` for the exact origin | Last-resort fall-through. |
| SSH (`git@…`) | Native ssh-agent / configured key — no credential lease needed; return a `NullCredentialLease`. | The `~/.ssh/config` `Host` block already does per-host identity routing. |

**Rules the resolver enforces (no exceptions):**

- **Never call `gh auth switch`, `az account set`, or any other command that mutates a CLI's *global* active identity.** All resolution is read-only against ambient state. This is the single rule that prevents "switch hell."
- **Always query GCM first** (`git credential fill`) with the full remote URL — GCM already knows how to disambiguate `github.com` vs `ghe.contoso.com` vs `dev.azure.com/contoso`, and respects per-URL `credential.<url>.username` config.
- **Use the per-host CLI's multi-account read API** (`gh auth token --user …`, `az account get-access-token --subscription …`) for fallback — these are non-mutating.
- **Cache leases per (remote-origin, account) tuple inside the daemon process** with a TTL ≤ `ExpiresAt`. Never persist secret material to disk; never log it; never pass it on a command line (use `GIT_ASKPASS` / stdin / env-block-only delivery).
- **Emit `AuthSuccess` / `AuthFailure` events** (§3.4.1, Security category) tagged with `HostKind`, `Account`, `RemoteUrl`, `Source` — never the secret.

**Wiring into the git backends:**

- `LibGit2SharpGitOperations` calls `IRemoteIdentityResolver.ResolveAsync` per remote operation and passes `lease.ToLibGit2()` as the `CredentialsHandler`.
- `GitCliGitOperations` builds a per-invocation env block from `lease.ToProcessEnv()` (sets `GIT_ASKPASS` to a tiny helper that reads from the lease, plus `GCM_INTERACTIVE=never` to fail fast in headless flows).
- `IGitRepository.AddRemoteAsync` / `IGitWorktrees.AddAsync` accept an optional `RemoteCredentialPolicy` request field (`PreferredAccount`, `RequireSource`) so plan authors can pin a specific identity per worktree (matters when a single plan operates on a fork *and* its upstream simultaneously).

**Why this matters operationally:**

- Today, a user with both a personal `github.com` account and a work GHE account routinely sees pushes go to the wrong remote because `gh` had the other account active. With per-remote resolution this is structurally impossible: the credential is selected by the *URL of the remote being operated on*, not by which CLI account happens to be "current."
- ADO PATs, GitHub fine-grained tokens, and GHE OAuth tokens have different scopes and lifetimes; treating them as one bag has caused silent privilege escalation in similar tools. Tagging by `HostKind` + `Source` lets the security event stream catch misuse.
- Worktree-isolated config (`GIT_CONFIG_GLOBAL=<worktree>/.gitconfig` per spawned process) keeps per-plan credential routing from leaking into the user's global git config.

#### 3.3.2 Worktree lifecycle — `IAsyncWorktreeLease` (deterministic cleanup, crash-safe)

A worktree is a stateful filesystem object with a non-trivial creation cost (`git worktree add`, optional symlinking, `worktreeInit` install) and a non-trivial cleanup cost (`git worktree remove --force`, branch deletion, leaked-symlink reclaim). Today's TS implementation tracks worktrees in an in-memory map and removes them in `commitPhase` / `cleanupPhase` — which works in the happy path, but leaks worktrees whenever the executor throws between create and cleanup, when the daemon crashes mid-job, or when the user cancels at exactly the wrong time. The .NET design treats every worktree as an **`IAsyncDisposable` lease**, so the C# language enforces "created ⇒ disposed" the same way it does for `FileStream` or `SemaphoreSlim`.

##### Contract

```csharp
public interface IWorktreeManager
{
    /// <summary>
    /// Acquire a worktree lease. The returned IAsyncWorktreeLease MUST be disposed
    /// (await using) — disposal performs the configured retention policy and removes
    /// any artifacts that should not survive the job attempt. Throws if the worktree
    /// cannot be created; never returns a partially-initialized lease.
    /// </summary>
    Task<IAsyncWorktreeLease> AcquireAsync(WorktreeAcquireRequest request, CancellationToken ct);

    /// <summary>
    /// Reclaim worktree leases that survived a daemon crash. Called once at daemon
    /// startup. Reads the lease registry under .aio/.ps/leases/ and reconciles each
    /// entry against the live filesystem and `git worktree list` output.
    /// </summary>
    Task<ReclaimResult> ReclaimOrphansAsync(CancellationToken ct);
}

public interface IAsyncWorktreeLease : IAsyncDisposable
{
    /// <summary>Stable id, written to the on-disk lease registry; used for crash recovery.</summary>
    WorktreeLeaseId LeaseId { get; }

    /// <summary>Absolute path to the worktree root (already validated against repo root, §5.1).</summary>
    string WorktreeRoot { get; }

    /// <summary>The detached branch ref for this attempt (`aio/<plan8>/<job8>/<attempt>`).</summary>
    string BranchRef { get; }

    /// <summary>Update the disposal outcome. Last write wins. Idempotent — may be called multiple times.</summary>
    void RecordOutcome(WorktreeOutcome outcome);

    /// <summary>
    /// Hint that the lease must be preserved past disposal regardless of outcome (debugging,
    /// post-mortem). Equivalent to RecordOutcome(WorktreeOutcome.Preserve) but explicit at the
    /// call site. Cleared by the next RecordOutcome call.
    /// </summary>
    void Pin(string reason);
}

public sealed record WorktreeAcquireRequest
{
    public required PlanId  PlanId        { get; init; }
    public required JobId  JobId        { get; init; }
    public required int     Attempt       { get; init; }
    public required string  BaseCommitSha { get; init; }
    public WorktreeInitSpec? InitSpec     { get; init; } // null ⇒ auto-detect (§8.3 step 5)
    public WorktreeRetentionPolicy Retention { get; init; } = WorktreeRetentionPolicy.Default;
    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}

public sealed record WorktreeRetentionPolicy
{
    public bool RemoveOnSuccess  { get; init; } = true;  // matches §8.3 default
    public bool PreserveOnFailure { get; init; } = true;
    public bool PreserveOnCancel { get; init; } = true;  // only if uncommitted changes; checked at dispose
    public TimeSpan DisposeTimeout { get; init; } = TimeSpan.FromSeconds(30);

    public static WorktreeRetentionPolicy Default => new();
}

public enum WorktreeOutcome
{
    Unknown,    // dispose called without RecordOutcome — treated as Failed for safety
    Succeeded,
    Failed,
    Canceled,
    Preserve    // explicit pin, never removed by Dispose
}

public readonly record struct WorktreeLeaseId(Guid Value);
```

##### Disposal state machine

`DisposeAsync` is **idempotent**, **bounded** by `Retention.DisposeTimeout`, and **reentrant-safe** (multiple awaiters complete on the same underlying task). It runs this sequence regardless of whether disposal was triggered by the happy path, an exception, cancellation, or daemon shutdown:

```mermaid
stateDiagram-v2
    [*] --> Acquired
    Acquired --> Disposing: await using exits
    Disposing --> CheckOutcome
    CheckOutcome --> RemoveBranchAndDir: outcome=Succeeded AND RemoveOnSuccess
    CheckOutcome --> RenameToFailed: outcome=Failed AND PreserveOnFailure
    CheckOutcome --> InspectThenRemove: outcome=Canceled
    CheckOutcome --> RetainAsIs: outcome=Preserve OR Unknown
    RemoveBranchAndDir --> RemoveLeaseRegistry
    RenameToFailed --> RemoveLeaseRegistry: branch -> aio/failed/...
    InspectThenRemove --> RetainAsIs: has uncommitted changes
    InspectThenRemove --> RemoveBranchAndDir: clean
    RetainAsIs --> RemoveLeaseRegistry: mark .preserved
    RemoveLeaseRegistry --> [*]
```

##### Crash safety — the on-disk lease registry

Every `AcquireAsync` writes a tiny lease record under `.aio/.ps/leases/<leaseId>.json` **before** running `git worktree add`, and removes it as the final step of `DisposeAsync`. The record is the **single source of truth** that lets the daemon reconcile leaked worktrees after a crash:

```jsonc
// .aio/.ps/leases/<leaseId>.json — written atomically (write-temp + rename)
{
  "schemaVersion": 1,
  "leaseId": "7a3f...",
  "planId": "...",
  "jobId": "...",
  "attempt": 1,
  "worktreeRoot": ".../wt/9f3c8a4b/6e1d77c0/1",
  "branchRef": "aio/9f3c8a4b/6e1d77c0/1",
  "createdAt": "2026-04-20T12:00:00Z",
  "daemonPid": 12345,
  "daemonStartedAt": "2026-04-20T11:55:00Z"
}
```

`ReclaimOrphansAsync` runs once at daemon startup, before the first plan resumes:

1. Enumerate `.aio/.ps/leases/*.json`.
2. For each entry, check whether `daemonPid` is still alive **and** `daemonStartedAt` matches the current daemon's view (i.e., it's a re-attach by the same instance, not a crash). If so, the lease is live — skip.
3. Otherwise the lease is **orphaned**. Match the worktree path against `git worktree list --porcelain`:
   - **Worktree present + branch present**: rename branch to `aio/orphan-recovery/<leaseId>` and emit `WorktreeReclaimedFromCrash` (preserved for inspection — never silently deleted, because it may contain in-progress work the user wants to recover).
   - **Worktree present + branch missing**: registry was written but `git worktree add` had not yet committed the branch — safe to `git worktree remove --force`.
   - **Worktree missing + branch present**: a previous reclaim already cleaned the dir; just delete the dangling branch.
   - **Both missing**: registry leaked past cleanup — just remove the registry entry.
4. Emit one `WorktreeReclaimReport` summary event with counts, suitable for surfacing in the status bar ("Recovered 3 leaked worktrees from previous crash").

##### Composition with `await using`

Job execution becomes a single try-scoped block where the language guarantees disposal:

```csharp
public async Task<JobRunResult> ExecuteJobAsync(JobRunRequest request, CancellationToken ct)
{
    await using var lease = await _worktrees.AcquireAsync(new WorktreeAcquireRequest
    {
        PlanId        = request.PlanId,
        JobId        = request.JobId,
        Attempt       = request.Attempt,
        BaseCommitSha = request.BaseCommit,
        Retention     = request.Retention,
    }, ct);

    try
    {
        var result = await _phases.RunAllAsync(lease, request, ct);
        lease.RecordOutcome(result.Succeeded ? WorktreeOutcome.Succeeded : WorktreeOutcome.Failed);
        return result;
    }
    catch (OperationCanceledException)
    {
        lease.RecordOutcome(WorktreeOutcome.Canceled);
        throw;
    }
    catch
    {
        lease.RecordOutcome(WorktreeOutcome.Failed);
        throw;
    }
    // DisposeAsync runs here — synchronously in the language sense, asynchronously in the runtime sense.
    // Any exception still in flight is observed AFTER disposal completes. The worktree is gone
    // (or preserved per policy) before the exception propagates one frame up.
}
```

The pattern composes naturally with the daemon's host-shutdown signal: `IHostApplicationLifetime.ApplicationStopping` cancels every active `JobRunRequest`'s CT, which causes `RecordOutcome(Canceled)` + `DisposeAsync` to run for every live lease before the daemon process exits. This is the **clean-shutdown path**; the registry-based reclaim above handles only the **crash path** (process killed without unwind).

##### Diagnostics & events

Every transition publishes on the bus (§3.4.1 Git category, additive):

- `WorktreeLeaseAcquired { leaseId, planId, jobId, attempt, worktreeRoot, baseCommit }`
- `WorktreeLeaseDisposed { leaseId, outcome, elapsed, action: Removed | RetainedAsFailed | PreservedExplicit | InspectedAndRemoved }`
- `WorktreeReclaimedFromCrash { leaseId, action, originalDaemonPid }`
- `WorktreeReclaimReport { totalScanned, removed, preserved, dangling }`
- `WorktreeDisposalTimedOut { leaseId, elapsed }` — emitted when `Retention.DisposeTimeout` fires; the lease is left in place and re-queued for reclaim on next startup.

##### Test surface

Because `IAsyncWorktreeLease` is an interface and `IWorktreeManager.AcquireAsync` is the only acquisition path, tests substitute a `FakeWorktreeManager` that hands out in-memory `FakeLease` objects whose `DisposeAsync` records a call. Standard pattern:

```csharp
[Test]
public async Task Lease_Is_Disposed_When_Phase_Throws()
{
    var fake = new FakeWorktreeManager();
    var executor = new JobExecutor(fake, ThrowingPhaseRunner.Instance);

    await Assert.ThrowsAsync<InvalidOperationException>(() => executor.ExecuteJobAsync(req, CancellationToken.None));

    Assert.Single(fake.Leases);
    Assert.True(fake.Leases[0].WasDisposed);
    Assert.Equal(WorktreeOutcome.Failed, fake.Leases[0].LastRecordedOutcome);
}
```

The analyzer `OE0009` (added in §3.6.10) enforces that any local of type `IAsyncWorktreeLease` is initialized via `await using` — preventing the failure mode where a future contributor stores the lease in a field and forgets to dispose it.

#### 3.3.3 LibGit2Sharp health monitor & circuit-breaker

LibGit2Sharp is the default backend (§3.3) but has a documented history of long-tail failure modes in long-running processes: undisposed `Repository` leaks, occasional `LibGit2SharpException` on Windows when AV scanners hold object pack files open, and platform-specific glitches in the Linux ARM64 native binary. Static per-method fallback (CLI for worktree ops only) is correct for *expected* CLI-only operations but wrong for *unexpected* libgit2 failures during normal operations. We add a runtime circuit-breaker on top of the static routing.

```csharp
public interface ILibGit2HealthMonitor
{
    /// <summary>Snapshot the current state. Cheap, lock-free read.</summary>
    LibGit2HealthSnapshot Current { get; }

    /// <summary>
    /// Wrap a libgit2 call. On exception, records the failure; if the breaker opens,
    /// the next attempt skips libgit2 entirely and goes straight to the CLI fallback.
    /// Successful calls reset the failure window.
    /// </summary>
    ValueTask<T> ExecuteAsync<T>(LibGit2OpKind kind, Func<CancellationToken, ValueTask<T>> op, CancellationToken ct);
}

public sealed record LibGit2HealthSnapshot
{
    public required LibGit2BreakerState State        { get; init; } // Closed | HalfOpen | Open
    public required int                 RecentFailures { get; init; } // count in current sliding window
    public required DateTimeOffset?     OpenedAt     { get; init; }
    public required DateTimeOffset?     RetryAt      { get; init; }
    public required IReadOnlyList<LibGit2OpKind> RecentFailureKinds { get; init; } = [];
}

public sealed class LibGit2HealthOptions
{
    public int      FailureThreshold { get; init; } = 5;                          // failures...
    public TimeSpan FailureWindow    { get; init; } = TimeSpan.FromSeconds(60);   // ...within this window opens the breaker
    public TimeSpan OpenCooldown     { get; init; } = TimeSpan.FromSeconds(30);   // before HalfOpen probe
    public int      HalfOpenProbes   { get; init; } = 2;                          // consecutive successes to close
}
```

**`HybridGitOperations` consultation flow:**

1. For every operation, first check the static-default backend (libgit2 vs CLI per §3.3 allowlist).
2. If the static default is libgit2, consult `ILibGit2HealthMonitor.Current.State`:
   - **Closed**: call libgit2 through `ExecuteAsync`; on exception, increment failure counter and fall through to CLI. If the failure window threshold is crossed, transition Closed → Open and emit `LibGit2BreakerOpened`.
   - **Open**: skip libgit2 entirely; go straight to CLI fallback. If `RetryAt` has passed, transition Open → HalfOpen.
   - **HalfOpen**: try one libgit2 call. On success, count toward `HalfOpenProbes`; once met, transition HalfOpen → Closed and emit `LibGit2BreakerClosed`. On failure, transition HalfOpen → Open with a fresh cooldown.
3. Every transition emits a Git-category event (§3.4.1): `LibGit2BreakerOpened { recentFailures, kinds }`, `LibGit2BreakerHalfOpen`, `LibGit2BreakerClosed`.

**Repository disposal rule (no caching):**

`Repository` instances are created **per operation** and disposed in the same statement. We never hold a `Repository` across method boundaries, never cache one in a field, and never let one escape an `await` boundary that could cancel mid-flight. Roslyn analyzer `OE0010` flags any `LibGit2Sharp.Repository` field; only locals inside an `using` block are allowed. The single exception is the daemon-startup health probe (next paragraph), which lives inside the monitor's own implementation file and is exempted by attribute.

**Startup health probe:**

At daemon startup (and on each HalfOpen transition), the monitor runs a fixed probe sequence against an ephemeral repo under `$TMP/aio-libgit2-probe-<pid>/`: `Repository.Init` → write file → stage → commit → status → dispose. If the probe throws, the breaker opens immediately (without waiting for the failure window) and an `OperatorAttention` security/diagnostic event surfaces with the exception details. The daemon stays up — degraded to CLI-only is still a working daemon — but the status bar and `daemon status` command surface the degradation prominently.

**Why this matters operationally:**

A static fallback decision means a libgit2 regression in a point release silently breaks every operation routed to it until a human notices and ships a fix. The runtime circuit-breaker contains the blast radius to seconds (worst case: `FailureThreshold` calls fail before the breaker trips), and the auto-recovery via HalfOpen probes means a transient AV-scanner lockup heals itself instead of requiring a daemon restart.

### 3.4 Eventing — the rich, unified bus

Every interesting thing the orchestrator observes (plan lifecycle, job transitions, agent telemetry, managed-process diagnostics, git operations, MCP tool invocations, security events) is published as a typed `AiOrchestratorEvent` on a single `IEventBus`. This is the broadest abstraction in the system and is what every UX surface ultimately consumes.

#### 3.4.1 Event taxonomy

All events derive from `AiOrchestratorEvent` and carry `PlanId?`, `JobId?`, `RunId?`, `At` (UTC), `Sequence` (monotonic per daemon process), and `Source` (which subsystem published it).

| Category | Events |
|---|---|
| **Plan** | `PlanCreated`, `PlanScaffoldChanged`, `PlanFinalized`, `PlanStarted`, `PlanPaused`, `PlanResumed`, `PlanCanceled`, `PlanCompleted`, `PlanArchived`, `PlanReshaped` |
| **Job lifecycle** | `JobTransition` (with from/to/reason), `JobReady`, `JobStarted`, `JobRetrying`, `JobBlocked`, `JobSucceeded`, `JobFailed`, `JobForceFailed`, `JobCanceled` |
| **Phase** | `PhaseEntered`, `PhaseExited`, `PhaseFailed` (per FI / setup / prechecks / work / commit / postchecks / RI) |
| **Agent (per `IAgentRunner`)** | `AgentSpawned`, `AgentStdout`, `AgentStderr`, `AgentSessionDiscovered`, `AgentLogFileDiscovered`, `AgentStats`, `AgentContextPressure`, `AgentHookFired`, `AgentTaskComplete`, `AgentDeadlockSuspected`, `AgentHealth`, `AgentExited`, `AgentCapabilityDowngraded` |
| **Managed process (any spawned process, not just agents)** | `ProcessSpawned`, `ProcessTreeSnapshot`, `ProcessOutputLine`, `ProcessHealthSnapshot`, `ProcessExited`, `ProcessKilled`, `ProcessOrphanReaped` |
| **Git** | `GitOpStarted`, `GitOpCompleted`, `WorktreeCreated`, `WorktreeRemoved`, `MergeFiAttempted`, `MergeRiCompleted`, `MergeConflictDetected`, `BranchCreated`, `BranchDeleted` |
| **Diagnostics / health** | `DaemonHealth`, `CapacityChanged`, `ResourcePressure`, `ClockSkewDetected`, `HostHealthSnapshot` (cpu/rss/fds/handles for the daemon itself) |
| **MCP** | `McpClientConnected`, `McpClientDisconnected`, `McpToolInvoked`, `McpToolFailed`, `McpAuthFailure` |
| **Security** | `AuthSuccess`, `AuthFailure`, `PathTraversalBlocked`, `SecretRedacted` |
| **Storage** | `PlanStateSaved`, `PlanStateLoaded`, `PlanStateCorrupted` |

This taxonomy is the **single source of truth** — every UX projection (Node binding, JSON-RPC, MCP notifications, CLI watch, telemetry sinks) consumes the same events. No bespoke per-surface event shapes.

#### 3.4.2 The bus contract

```csharp
public interface IEventBus
{
    /// <summary>Publish an event. Synchronous, fan-out is non-blocking; returns immediately.</summary>
    void Publish<T>(T evt) where T : AiOrchestratorEvent;

    /// <summary>Pull-style subscription with backpressure (per-subscriber bounded channel). M7: stream of base type.</summary>
    IAsyncEnumerable<AiOrchestratorEvent> SubscribeAsync(SubscribeRequest request, CancellationToken ct);

    /// <summary>Push-style subscription (in-proc only — used by Node binding, MCP server, CLI watch).</summary>
    IDisposable Subscribe(SubscribeHandler handler);

    /// <summary>Replay buffer: events that occurred since `SinceSequence`. Bounded (default 10k).</summary>
    ReplayResult Replay(ReplayRequest request);
}

public sealed record SubscribeRequest
{
    public required EventFilter Filter  { get; init; }
    public SubscriptionOptions  Options { get; init; } = SubscriptionOptions.Default;
    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}

public sealed record SubscribeHandler
{
    public required EventFilter               Filter  { get; init; }
    public required Action<AiOrchestratorEvent> OnEvent { get; init; }
    public SubscriptionOptions                Options { get; init; } = SubscriptionOptions.Default;
}

public sealed record ReplayRequest
{
    public required EventFilter Filter        { get; init; }
    public required long        SinceSequence { get; init; }
}

public sealed record ReplayResult
{
    public required IReadOnlyList<AiOrchestratorEvent> Events { get; init; }
    public required bool                             Truncated { get; init; } // true if buffer wrapped past SinceSequence
    public IReadOnlyDictionary<string, JsonElement>  Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}

public sealed record EventFilter
{
    public IReadOnlyCollection<string>? CategoryAllowList { get; init; } // e.g. {"Job", "Agent"}
    public PlanId?        PlanId   { get; init; }
    public JobId?        JobId   { get; init; }
    public SeverityFloor? Severity { get; init; }
}

public sealed record SubscriptionOptions
{
    public int              MaxBufferedEvents  { get; init; } = 1024;                 // backpressure ceiling
    public OverflowStrategy Overflow           { get; init; } = OverflowStrategy.DropOldest;
    public bool             IncludeReplay      { get; init; }                          // attach buffered events before live stream
    public long?            ReplayFromSequence { get; init; }

    public static SubscriptionOptions Default => new();
}
```

The single bus has multiple **dispatchers** registered:

```mermaid
graph LR
    Pub[Publishers - PlanRunner, IAgentRunner, ManagedProcess, GitOps, McpHandler]
    Bus[IEventBus]
    NodeBind[Node Binding Dispatcher - in-proc N-API]
    Pipe[Named Pipe Dispatcher - JSON-RPC notifications]
    Mcp[MCP Notification Dispatcher - tools/notification]
    Cli[CLI Watch Dispatcher - stdout]
    Tele[Telemetry Sink - OTel exporter]
    Replay[Replay Buffer - bounded]

    Pub --> Bus
    Bus --> NodeBind
    Bus --> Pipe
    Bus --> Mcp
    Bus --> Cli
    Bus --> Tele
    Bus --> Replay
```

#### 3.4.3 Cross-language projection strategy

The events are defined once in `AiOrchestrator.Models` (C#) and projected into every consuming language:

| Surface | Projection | Mechanism |
|---|---|---|
| **.NET in-proc** (CLI, Copilot CLI plugin, daemon-internal) | Native C# records | direct `IEventBus.Subscribe` |
| **Node.js / TypeScript** (VS Code extension, future Node consumers) | Generated TS interfaces + native binding | `AiOrchestrator.Bindings.Node` (N-API) — see §4.7 |
| **JSON-RPC over named pipe** | Stable JSON shapes, schema-versioned | wire-format generated from records via `System.Text.Json` source generators |
| **MCP** | `notifications/ai-orchestrator.event` MCP notifications | re-projected to MCP wire format by `AiOrchestrator.Mcp` |
| **CLI text** | Pretty-printed via Spectre.Console | render adapter in `AiOrchestrator.Cli` |
| **Telemetry** | OpenTelemetry traces/metrics/logs | `IEventBus` → `IOTelExporter` adapter |

Wire JSON for every event is **deterministic**: snake_case category, ISO-8601 timestamps, monotonic `seq` field, no environment-dependent fields. TS types (`AiOrchestratorEvent.d.ts`) are generated from the C# records at build time and shipped both inside `AiOrchestrator.Bindings.Node` and as a standalone npm package `@ai-orchestrator/events-types`.

#### 3.4.4 Durability tiers — surviving daemon restarts

The in-memory replay buffer (§3.6.4) is sufficient for hot subscribers but loses everything on daemon restart — unacceptable for plans that run for hours. We layer three tiers, each with a distinct purpose, lifetime, and cost:

| Tier | Storage | Window | Latency | Purpose |
|---|---|---|---|---|
| **T1 — In-memory ring** | `AiOrchestratorEvent[]` circular, default 10 K events | Last ~10 K events (process lifetime) | Nanoseconds | Hot subscribers, mid-flight reconnects within the same daemon process. Current §3.6.4 design — unchanged. |
| **T2 — On-disk segmented log** | Append-only segments at `.aio/.ps/events/<plan8>/seg-<n>.log`, rotated at 16 MiB; index file `.aio/.ps/events/<plan8>/index.json` maps `seq → (segment, offset)` | Last 90 days per plan (configurable `eventLogRetention`); pruned by background sweep | Sub-millisecond append (buffered + group-fsync at segment close); millisecond range read (mmap) | Reattach after daemon restart; cross-session audit; replay from `since_seq` for clients reconnecting after a crash. |
| **T3 — Plan summary** | `.aio/p/<plan8>/events.summary.json` written once on plan terminal state (succeeded/failed/canceled/archived) | Permanent (committed with plan) | One-shot | Post-mortem analysis; lives in the repo itself; survives `git clean`; small enough to attach to issues. |

**Replay flow on reconnect:**

1. Client subscribes with `SubscribeRequest.Options.ReplayFromSequence = N`.
2. Bus checks T1 first: if `N` is in the in-memory ring, replay from there. Done.
3. Otherwise the bus reads T2 from segment containing `seq=N` to the current head, streams events to the subscriber's bounded channel, then attaches the live tail. The cutover is seamless because both tiers share the same monotonic `seq` numbering.
4. If `N` is older than T2 retention, the bus emits one `ReplayTruncated { earliestAvailable }` event and starts the live tail from `seq = earliestAvailable`. Clients decide whether to fall back to T3 (the summary) or accept the gap.

**Crash safety for T2:**

- Writes use `O_APPEND` semantics (`FileStream` with `FileMode.Append | FileShare.Read`); concurrent readers see a consistent prefix.
- Each event is length-prefixed (`int32 length || utf8-json bytes`) so a partial last-record from a crash is detectable on read and truncated on next open.
- `fsync` runs on segment rotation (every 16 MiB) and every 5 s, not per-event — gives durability of `last 5 s OR last 16 MiB lost`, which matches the user expectation of "the daemon crashed, I lost a few seconds."
- The index file is rebuilt by scanning segment headers if it's missing or its modification time is older than the newest segment.

**T3 summary contents:**

Written by `IPlanRepository.SaveTerminalSummaryAsync` once when the plan's status transitions to a terminal state. Schema:

```jsonc
{
  "schemaVersion": 1,
  "planId": "...",
  "finalStatus": "succeeded" | "failed" | "canceled" | "archived",
  "totalEvents": 12345,
  "durationMs": 7200000,
  "jobOutcomes": [ /* one entry per job: id, status, attempts, finalCommit */ ],
  "failureSignals": [ /* concise list of failed phases + first error line per failure */ ],
  "timeline": [ /* coarse phase boundaries: planStarted, firstJobStarted, ... */ ]
}
```

This file is **committed** (`.aio/p/<plan8>/` is tracked, §8.1) so post-mortem material survives clone, `git clean -xfd`, and even daemon uninstall.

**Phase rollout (matches §10):** T1 ships in Phase 1 (already in scope). T2 ships in Phase 2 — required before any non-trivial production deployment. T3 ships in Phase 3 alongside the plan-summary UX.

#### 3.4.5 Event versioning — additive evolution across 6 surfaces

The event taxonomy is projected to .NET in-proc, Node binding, named-pipe JSON-RPC, MCP notifications, CLI text, and OTel spans. A naive change to any event record is a breaking change to all six. The rules below keep evolution non-breaking by default and give a controlled path for the rare case where a break is unavoidable.

| Rule | Pattern |
|---|---|
| **EV1: New event subtype** | Pure addition. M7 already covers the streaming side: `IAsyncEnumerable<AiOrchestratorEvent>` consumers pattern-match concrete subtypes; subscribers that don't recognize the new subtype receive it as the base type and ignore it. JSON wire form deserializes to a `UnknownEvent` sentinel on the consumer side. |
| **EV2: New optional field on existing event** | Bump the event's `SchemaVersion` (each event subtype carries its own `int SchemaVersion { get; init; } = N`); subscribers ignore unknown fields (W4); JSON source-gen converters round-trip preserving unknown properties. |
| **EV3: New required field** | Forbidden on existing events. Required fields can only appear on a new subtype (see EV1) or a `*V2` companion type (EV5). |
| **EV4: Field rename** | Forbidden in place. Add the new field, mark the old `[Obsolete]`, emit both for one minor-version window, then remove the old in the next minor and bump the event's `SchemaVersion`. |
| **EV5: Semantic break of an existing field** | Introduce `EventNameV2 : EventNameBase` with the new semantics; bus publishers emit both V1 and V2 in parallel for one minor-version window so older subscribers keep working; deprecate V1 with a one-minor sunset. |
| **EV6: Subscriber capability declaration** | `SubscribeRequest.HandledSchemaMax: int?` lets subscribers cap the schema versions they understand. Events at higher versions are downgraded to a `LegacyEnvelope { actualType, actualSchema, payload: JsonElement }` that the subscriber can forward, drop, or surface to the user as "unknown event from newer daemon." |
| **EV7: Deprecating an event** | Mark the C# record `[Obsolete("replaced by FooEventV2 since vX.Y")]`, keep emitting for one minor-version window, then stop emission. **Never delete the type** — it stays in `AiOrchestrator.Models` so old clients deserializing replay from T2 still resolve the symbol. |

**Wire-format consequence:** every event JSON object carries `"schema_version": N` (default 1, omitted on the wire when 1) in addition to `"type": "foo_event"` and `"seq": ...`. The N-API binding, MCP projector, and OTel exporter all consult `schema_version` when mapping to their target shape — never the field set, never `nameof`. This means a subscriber on .NET 1.0 reading a T2 segment written by .NET 1.3 sees the V1 fields it knows and ignores the rest.

---

## 3.5 API Design Conventions (binding & evolution rules)

Every public type and method in `AiOrchestrator.Abstractions` and `AiOrchestrator.Models`, and every cross-process wire shape (named-pipe JSON-RPC, MCP, N-API binding), is bound by the rules in this section. They exist to make additive evolution of the API surface possible without breaking callers, and to keep DI composition readable. Cadence rules per package live in §3.1.0.

### 3.5.1 DI / constructor rules

| # | Rule |
|---|---|
| D1 | Inject **interfaces / abstractions only** at construction. No concrete classes except in the composition root. |
| D2 | Once a constructor would carry **>3 parameters** *or* would mix services with config primitives, fold tunables into an `IOptions<TOptions>`. |
| D3 | Vendor-/scenario-specific collaborators that are themselves DI-resolved go on the **options object**, not the constructor (e.g., `AgentRunnerOptions.ArgvBuilder`). Use **named/keyed options** when the same component has multiple instances (per vendor, per tenant). |
| D4 | Use `IOptionsSnapshot<T>` / `IOptionsMonitor<T>` for runtime-mutable values; plain `IOptions<T>` for startup-bound. |
| D5 | Validate options once at startup with `ValidateDataAnnotations()` + `ValidateOnStart()`. Misconfiguration must fail in the composition root, not at first call. |
| D6 | Split big options into **focused classes** (`AgentRunnerOptions`, `AgentTelemetryOptions`, `AgentSandboxOptions`). Reject "God options". |
| D7 | Options and request records are `sealed record` with `init`-only properties and `required` for mandatories. |
| D9 | **Object lifetime equals resource lifetime — enforced by `IAsyncDisposable`/`IDisposable`, not by an external state machine.** Every type that owns a side-effecting resource (filesystem worktree, git branch, OS process, plan execution context, job execution context, credential lease, event subscription, channel reader, log file tail, lock file, registry entry) implements `IAsyncDisposable` (or `IDisposable` if the cleanup is genuinely synchronous), and its **disposal performs the full cleanup transactionally**. State transitions like "job finished → mark for cleanup → cleanup pass collects it later" are forbidden. The CLR's `await using` scope is the state machine; nothing else may second-guess it. See §3.8 for the full universal-lifetime contract, the catalog of disposable types, and the analyzer rules (`OE0009`, `OE0013`–`OE0015`) that enforce it. |
| D8 | **No factory whose only job is to capture singleton dependencies.** When you find yourself writing `IFooFactory.Create(spec) → IFoo` where the factory holds N injected services and the product transitively holds the same N services, replace it with a *stateless coordinator + value handle* pair: a singleton `IFooCoordinator` that holds the dependencies, and a pure-data `FooHandle` record that carries per-call state. Operations on the handle live on the coordinator and take the handle as a parameter. See §3.2.2.1 for the canonical example (`IProcessLifecycle` + `ProcessHandle`). Factories remain appropriate when (a) the produced object has its own *configuration-varying* dependencies that DI cannot resolve at composition time, or (b) the product genuinely needs polymorphic per-call construction (strategy pattern). They are **not** appropriate as a workaround for "I need per-call state in a DI world." |

### 3.5.2 Public method signature rules

These are the rules that prevent every "add a flag" feature request from becoming a breaking change.

| # | Rule | Rationale |
|---|---|---|
| M1 | A public method takes **at most one positional value parameter** plus a trailing `CancellationToken`. Anything else goes in a `record` request. | Adding a flag never changes the signature. |
| M2 | The request type is a `sealed record` with `required` mandatories and defaulted optionals. New optional fields are non-breaking. | `new RetryOptions { … }` reads at call sites; binary surface stays stable. |
| M3 | **Never overload a public method with "richer" variants.** One method, one request type. | Overload sets grow without bound and create ambiguity. |
| M4 | Return a **rich result record**, never a tuple, `out`-param, or naked primitive (except `bool` for `Try*`). | New result fields (warnings, diagnostics, correlation ids) are additive. |
| M5 | Every public request and result record carries an **`Extensions: IReadOnlyDictionary<string, JsonElement>`** bag for experimental/preview fields. Promote stable extensions to first-class properties; the bag stays for the next round. | Lets us ship vendor hints / preview features without touching the typed surface. |
| M6 | When a field's **semantics** must change, introduce `RequestV2` and a new method; mark the old `[Obsolete]` for one minor-version window. **Never silently change the meaning of an existing field.** | Versioning lives in the type, not the method name. |
| M7 | Streaming endpoints return `IAsyncEnumerable<TBase>` where `TBase` is a base record (`AiOrchestratorEvent`). Consumers pattern-match concrete subtypes; new subtypes are pure additions. | Avoids breaking the stream contract every time a new event is added. |
| M8 | **Defaults live in exactly one place** — the request record. No method overloads with different defaults. | Eliminates silent behavior drift. |
| M9 | Closed enums (`EffortLevel`, `ExecutionPhase`) are documented as **additive-only**. Open sets (vendor IDs, model names, capability flags) use **string-keyed wrapper structs** (`readonly record struct AgentRunnerId(string Value)`) with well-known statics. | Exhaustive `switch` over open sets is always wrong; force consumers to handle the unknown case. |
| M10 | `Task`-returning methods that report progress do so via **`IProgress<T>` injected as part of the request record**, not via callback parameters. | Keeps the signature stable and makes progress optional. |

### 3.5.3 Wire-format rules (named-pipe / MCP / N-API)

| # | Rule |
|---|---|
| W1 | Every cross-process message has a top-level `schemaVersion: int`. Bumping it is the **only** way to introduce non-additive changes. |
| W2 | All JSON properties use explicit `[JsonPropertyName("snake_case")]`. Renames require a schema-version bump. |
| W3 | Generated via `System.Text.Json` source generators; no reflection at runtime; trim-safe. |
| W4 | Unknown JSON properties are **ignored on read, preserved on round-trip** where feasible. |
| W5 | Enum values cross the wire as **strings**, never integers. Unknown enum strings deserialize to a `Unknown` sentinel rather than throwing. |
| W6 | Timestamps are ISO-8601 UTC with millisecond precision. Durations are `TimeSpan` serialized as ISO-8601 (`PT5S`), not as floats or ticks. |
| W7 | Every event/notification carries a monotonic `seq: long` and a stable `id: guid`. Replay uses `seq`; deduplication uses `id`. |

### 3.5.4 Memory & throughput rules (efficiency-first)

The orchestrator handles thousands of process-output lines per second per job, plans with hundreds of jobs, and log files that routinely exceed 10 MiB per attempt. **Every public type and every wire shape is bound by these rules**, no exceptions. They exist to keep the daemon's working set bounded, keep the LOH cold, and keep the cross-process surface from doing redundant copies.

| # | Rule | Rationale |
|---|---|---|
| E1 | **Transmit paths and ranges, not content.** Any payload that could exceed 4 KiB (logs, instructions files, captured stdout, diff hunks, attachments) crosses API and wire boundaries as `{ filePath, sizeBytes, encoding, range? }` descriptors. The UX layer reads the file directly using its own pooled buffers / mmap / `PipeReader`. The daemon never serializes the file content unless explicitly asked for a bounded inline slice (≤ 64 KiB). | A 10 MiB log serialized to JSON inflates to ~13 MiB, lands on the LOH, copies once into the pipe buffer, copies again into the client's deserializer, and pins both peers' GC heaps until the next gen-2 sweep. The descriptor is ~200 bytes. |
| E2 | **64 KiB is the hard ceiling for any single allocation that crosses an API boundary.** Strings, byte arrays, JSON payloads, event records — all stay below the LOH threshold (85 KiB on .NET, 84,975 bytes for arrays). Anything larger is split into chunks (`PipeReader`, `IAsyncEnumerable<ReadOnlyMemory<byte>>`) or replaced by a path descriptor (E1). | LOH allocations are not collected until gen-2; under sustained log ingestion they cause the daemon's RSS to grow unboundedly between gen-2 collections. |
| E3 | **Use `ReadOnlyMemory<byte>` / `ReadOnlySpan<byte>` for raw byte payloads on hot paths**, not `byte[]` and not `string`. Stdout/stderr line dispatch, stdout parsers, secret redactors, and the event-bus internal queues all operate on UTF-8 bytes end-to-end. Conversion to `string` happens **only** at the final UX render point, never inside the daemon. | One `string` allocation per stdout line × thousands of lines per job × N jobs = the dominant allocation source today. |
| E4 | **Pool every transient buffer.** Use `ArrayPool<byte>.Shared` for stdout/stderr line accumulators, `MemoryPool<byte>` for parser scratch space, `ObjectPool<StringBuilder>` for the rare log-formatting paths. Pooled rentals are wrapped in `using var lease = …;` blocks; never escape the rental's lifetime past the method that took it. | Replaces the per-line allocation pattern that today dominates the GC budget. |
| E5 | **Stream, don't buffer, for any sequence longer than ~100 items.** Replace `IReadOnlyList<T>` returns with `IAsyncEnumerable<T>` whenever the producer is naturally streaming (event subscriptions, log ranges, plan listings beyond a page). Use `System.Threading.Channels` (`Channel.CreateBounded`) for in-process producer/consumer; never `BlockingCollection` (heap-allocates per dequeue) or `Queue<T>` behind a lock. | Bounded channels enforce backpressure naturally; unbounded `IReadOnlyList<T>` materializations are the second largest source of LOH pressure after raw payloads. |
| E6 | **`struct` enumerators on hot iterators.** Custom `IEnumerable<T>` / `IAsyncEnumerable<T>` implementations on event filters, log slicers, and DAG traversals expose `struct` enumerators (the same pattern `List<T>.Enumerator` uses). Avoid `yield return` only when allocations show up in profiling — it's almost always fine, but custom collections with known enumeration patterns benefit. | Each `foreach` over a class-typed enumerator allocates once. Multiplied by thousands of subscriber fan-outs per second this is measurable. |
| E7 | **`ValueTask<T>` on hot per-call paths.** Methods called per stdout line, per event publish, per file-system probe return `ValueTask<T>` so synchronous-completing paths skip the `Task` allocation. Methods called rarely (per plan create / per job start) stay as `Task<T>` for clarity. | The synchronous-completion fast path is the common case for pooled-buffer reads and bus publishes. |
| E8 | **JSON via source generators only.** Every wire-bound record participates in a `[JsonSerializable]` `JsonSerializerContext`. **No reflection-based serializer use anywhere.** Source-gen produces zero-allocation `Utf8JsonReader`/`Utf8JsonWriter` paths and is trim-safe (matches W3). | Reflection-based serialization allocates per-property-name `string`, per-converter cache lookup, and per-call dictionaries — all hot-path waste. |
| E9 | **UTF-8 end-to-end on the wire.** All JSON encoding/decoding uses `Utf8JsonWriter` / `Utf8JsonReader` directly against the pipe's `PipeWriter` / `PipeReader`. **Never** materialize a `string` of JSON, then encode to bytes. Pipe transports use `System.IO.Pipelines` so reads/writes operate on pooled `Memory<byte>` segments with zero intermediate copies. | Removes one full copy in every direction across every RPC. |
| E10 | **Bounded queues with explicit overflow policy.** Every queue (event bus per-subscriber, process output channel, log-tail buffer, replay buffer) has a configured maximum size and an `OverflowStrategy` (`DropOldest` \| `DropNewest` \| `Block` \| `Reject`). No unbounded `Channel` / `Queue<T>` / `List<T>` exists in any production code path. | Unbounded queues are the leading cause of "daemon eats 4 GB of RAM after a long-running plan" reports in similar tools. |
| E11 | **Memory-mapped files for log reads ≥ 1 MiB.** `IJobLogReader.OpenAsync` returns either a `FileStream` (small files) or a `MemoryMappedViewAccessor` (large files), selected automatically by size. The UX layer can scroll through a 100 MiB log without ever loading more than one OS page at a time. | mmap is the only sane way to read multi-MiB logs without LOH pollution; it also lets multiple subscribers share the same physical pages. |
| E12 | **Periodic GC budget assertion in CI.** A long-running soak test (`AiOrchestrator.IntegrationTests.GcSoakTests`) executes a 50-job plan with scripted agents and asserts gen-2 collection count ≤ N and RSS growth ≤ M MiB over the run. PRs that regress the budget by > 10% are blocked. | Memory regressions are silent until they bite production. A CI gate makes them as visible as a failed test. |
| E13 | **Stdout/stderr never round-trip through `string`. Ever.** Child-process output is consumed as `Stream` → `PipeReader` → `ReadOnlySequence<byte>`, split into lines via `SequenceReader<byte>`, and dispatched as `ReadOnlyMemory<byte>` slices that point into a refcounted segment of a `RecyclableMemorySegment` pool (§3.6.9). Parsers, redactors, and dispatchers operate on those slices in place. The original `Stream`s from `Process.StandardOutput.BaseStream` / `StandardError.BaseStream` are wrapped — we never touch `StandardOutput.ReadLine()` (which allocates a string per line) and never wrap them in a `StreamReader`. | A `StreamReader` per child process produces one heap allocation per byte of output (UTF-8 decode buffer + final string). At thousands of lines/second across N concurrent agents this is the single largest avoidable allocation in the system. |
| E14 | **Pattern matching on bytes, not strings.** All recognizers for vendor-specific stdout markers (Copilot session-id banner, Claude `[session=…]`, token stats footer, hook callback markers) use the `IByteMatcher` shim (§3.6.9) which operates on `ReadOnlySpan<byte>` with literal byte sequences, ASCII-folded prefixes, and (when truly necessary) compiled `Utf8Regex` patterns. **Never use `System.Text.RegularExpressions.Regex` on a transcoded `string`** for hot-path parsing — it forces a UTF-8 → UTF-16 conversion per line. | Regex on `string` allocates the input string, the match's `Group` objects, and per-call `Match` instances. The byte-matcher shim resolves to a single `IndexOf` / `MemoryExtensions.SequenceEqual` call on the original span when the marker is a literal (which 90% of them are). |

### 3.5.5 Quick checklist for any new public method

Apply before merging any change to `AiOrchestrator.Models`, `AiOrchestrator.Abstractions`, or any wire format:

- [ ] Signature is `Task<TResult> NameAsync(TRequest request, CancellationToken ct)` (or `ValueTask`/sync variants per E7).
- [ ] `TRequest` is a `sealed record`; `required` for mandatories; defaults for everything else.
- [ ] `TResult` is a `sealed record` with an `Extensions` bag.
- [ ] No overloads. One method, one request type.
- [ ] No tuples / `out`-params in return positions.
- [ ] Wire-bound types have `schemaVersion` and `[JsonPropertyName]` everywhere.
- [ ] Enums on the wire are documented as additive-only or replaced with string-key wrappers.
- [ ] If progress is reported, it goes through `IProgress<T>` on the request, not a callback parameter.
- [ ] If the change is a semantic break, a `V2` type was introduced rather than mutating the existing one.
- [ ] **No payload field can exceed 4 KiB inline (E1)** — large content uses a `{ filePath, sizeBytes, range? }` descriptor.
- [ ] **No allocation > 64 KiB on any code path the method can take (E2)** — verified by chunking, pooling, or path-descriptor substitution.
- [ ] **Raw byte payloads use `ReadOnlyMemory<byte>` (E3)**, not `string` and not `byte[]`.
- [ ] **Sequences > ~100 items return `IAsyncEnumerable<T>` (E5)**, not `IReadOnlyList<T>`.
- [ ] **Wire-bound records are registered in a `JsonSerializerContext` (E8)** — no reflection-based serializer call sites.
- [ ] **Child-process output stays in `ReadOnlyMemory<byte>` end-to-end (E13)** — no `StreamReader`, no `Process.StandardOutput.ReadLine()`, no per-line `string` allocation.
- [ ] **Stdout marker recognition uses `IByteMatcher` (E14)** — no `Regex` against a transcoded `string` on hot paths.

---

## 3.6 Memory Efficiency & Resource Discipline

§3.5.4 codifies the rules; this section explains the patterns the daemon uses to enforce them at runtime, and where each pattern shows up in the architecture.

### 3.6.1 The end-to-end byte path (stdout line → UX render)

This is the single hottest path in the system. The illustration shows where every allocation happens — and where each one is pooled, pinned, or eliminated.

```mermaid
flowchart LR
    A[Child process stdout fd<br/>Process.StandardOutput.BaseStream] --> B[StreamRedirector<br/>owns the Stream, never wraps in StreamReader]
    B --> C[PipeReader.Create stream<br/>System.IO.Pipelines, 4 KiB segments]
    C -->|ReadOnlySequence&lt;byte&gt;| D[LineSplitter<br/>SequenceReader, no alloc]
    D -->|RecyclableSegment<br/>refcounted, pooled| E[ISecretRedactor.MaskInPlace<br/>span mutation, no copy]
    E --> F[IByteMatcher dispatch<br/>parser reads ReadOnlySpan&lt;byte&gt;]
    E --> G[Log writer queue<br/>batched RecyclableMemoryStream]
    F -->|tiny AgentEvent<br/>no payload| H[IEventBus.Publish]
    G -->|64 KiB batch flush| I[FileStream.WriteAsync ReadOnlyMemory&lt;byte&gt;]
    H --> J[Bounded Channel per subscriber]
    J --> K[Wire dispatcher<br/>Utf8JsonWriter into PipeWriter]
    J --> L[Job-binding dispatcher<br/>napi_threadsafe_function]
    K --> M[Client deserializer<br/>source-gen, pooled]
    M --> N[UX requests log slice by path+range<br/>JobLogsResult descriptor]
    N --> O[UX reads file directly<br/>FileStream or MemoryMappedFile]
```

**Properties that fall out of this design:**

- The **only** copy of the line's full bytes is the one that lands in the log file via `FileStream.WriteAsync(ReadOnlyMemory<byte>)` after batching through a `RecyclableMemoryStream` (§3.6.9.4). The pipe never carries it.
- The `AgentEvent` published to the bus carries only **derived** fields (session id, token count, deadlock signal) — never the line itself. Subscribers that want the raw bytes follow the `LogFilePath` + `ByteRange` descriptor on the event and read the file themselves.
- The `RecyclableSegment` holding the line bytes is **refcounted**: the parser, redactor, and log-writer all see the same `Memory<byte>` window; the segment returns to the pool only when the last consumer releases (see §3.6.9.2). The parser is contractually forbidden from retaining references past `OnLine`'s return (E3/E13, enforced by an analyzer).
- All pattern recognition (session ids, stats footers, hook markers) goes through `IByteMatcher` (§3.6.9.3) — no `Regex` against a transcoded `string` ever runs on this path (E14).

### 3.6.2 Pipe transport — `System.IO.Pipelines` end-to-end

The named-pipe daemon uses `System.IO.Pipelines` (not `NetworkStream` + `StreamReader`) on both sides. The full request/response path is:

```text
Client                                 Daemon
NamedPipeClientStream                  NamedPipeServerStream
  └─ PipeReader.Create(stream)           └─ PipeReader.Create(stream)
       └─ Utf8JsonReader (source-gen)         └─ Utf8JsonReader (source-gen)
            └─ TRequest record                     └─ TRequest record
                                                      └─ TResult record
                                                            └─ Utf8JsonWriter
                                                                  └─ PipeWriter
```

There is **no `string` of JSON** anywhere on this path. Frame boundaries (newline-delimited JSON-RPC) are detected via `SequenceReader<byte>.TryReadTo((byte)'\n', …)` against the pipe's `ReadOnlySequence<byte>` — zero copies, zero allocations beyond the source-gen converter's own struct-typed scratch space.

### 3.6.3 Log access — descriptor-first, mmap-backed

`JobLogsResult` (refactored in §3.1) is a **descriptor**. The daemon never reads the log file to satisfy a `GetJobLogsAsync` call unless the caller explicitly asks for an inline slice with a bounded `ByteRange`. The intended consumption pattern:

```csharp
// 1. Get the descriptor (cheap; ~200 bytes over the wire)
var logs = await aiOrchestrator.GetJobLogsAsync(new JobLogsRequest { … }, ct);

// 2. UX layer opens the file using whatever pattern fits its rendering needs
if (logs.SizeBytes >= 1_048_576)
{
    using var mmap = MemoryMappedFile.CreateFromFile(logs.FilePath, FileMode.Open);
    using var view = mmap.CreateViewAccessor(offset, length, MemoryMappedFileAccess.Read);
    // scroll, search, render — never loads more than the OS pages currently in view
}
else
{
    using var fs = new FileStream(logs.FilePath, FileMode.Open, FileAccess.Read, FileShare.Read,
                                  bufferSize: 4096, useAsync: true);
    // small, simple read with a 4 KiB pooled buffer
}
```

For the cross-host case (Mode C centralized daemon, MCP client on a different machine, browser-based UX) the caller may request a bounded inline slice via `JobLogsRequest.Range`. Slices are **capped at 64 KiB** (E2); larger reads must be chunked into multiple requests by the caller.

### 3.6.4 Event bus — channels, fan-out, struct enumerators

The single `IEventBus` has one **bounded** `Channel<AiOrchestratorEvent>` per subscriber (`Channel.CreateBounded` with `BoundedChannelFullMode = DropOldest` by default). Publish is `O(N subscribers)` write attempts and never blocks the publisher. Each subscriber's reader is an `IAsyncEnumerable<AiOrchestratorEvent>` whose enumerator is a **struct** (E6), so `await foreach` doesn't allocate per iteration.

The replay buffer is a **single fixed-size circular array** (`AiOrchestratorEvent[]` of configurable capacity, default 10,000) — no `List<T>`, no `Queue<T>`, no LinkedList. Lookups by `seq` are constant-time given a base offset.

### 3.6.5 Plan storage — JSON streaming, not materialized

`IPlanRepository.LoadStateAsync` reads `plan.json` via `JsonSerializer.DeserializeAsync<T>(FileStream, JsonSerializerContext)` — streaming, source-generated, no intermediate `string`. `SaveStateAsync` writes via `Utf8JsonWriter` directly to a `FileStream` (with `FileOptions.Asynchronous` and a 4 KiB buffer), then `Move`-renames atomically. Plans with hundreds of jobs serialize and deserialize in tens of milliseconds with sub-megabyte peak working set.

### 3.6.6 Cross-language cost (Node binding)

The N-API binding (`AiOrchestrator.Bindings.Node`, §4.7) projects events into JS by allocating one JS object per event with primitive-typed fields. **No event payload string is copied unless the JS consumer reads the field.** `napi_external` is used for the opaque log file handles so JS can hand them back to the binding for `read(path, offset, length)` calls without ever materializing the path as a JS string in a hot loop.

### 3.6.7 Where `string` *is* allowed

These rules don't ban `string` — they make its use intentional. `string` is fine for:

- **Identifiers** — `PlanId`, `JobId`, `RunId`, branch names, producer ids. Bounded length, low cardinality, interned where it pays.
- **One-shot human-readable error messages** in `ValidationError.Message`, `ProcessExitResult.Disposition`, etc. Written once, displayed once.
- **Configuration** read at startup and never on a hot path.

`string` is **not** allowed for: log content, stdout/stderr lines, instructions files, JSON payloads, file content of any kind, or any field whose size scales with plan / job / log volume.

### 3.6.8 Verification — analyzers + soak tests

Three layers enforce the rules:

1. **Roslyn analyzers** (`AiOrchestrator.Analyzers`, custom):
   - `OE0001`: a public `record` field crossing an assembly boundary may not be of type `string` if its name matches `*Content`, `*Body`, `*Logs`, `*Output` — must be `ReadOnlyMemory<byte>` or a path descriptor.
   - `OE0002`: no call site may invoke `JsonSerializer.Serialize/Deserialize` without a `JsonSerializerContext` argument (E8).
   - `OE0003`: no `Channel.CreateUnbounded` in production code (E10).
   - `OE0004`: no `new StreamReader(...)` or `Process.StandardOutput.ReadLine()` call in `AiOrchestrator.Process.*` or any `IAgentStdoutParser` implementation (E13).
   - `OE0005`: no `System.Text.RegularExpressions.Regex` reference inside `IByteMatcher` implementations or `IAgentStdoutParser.OnLine` call paths (E14).
   - `OE0006` (RecyclableSegment lifecycle — Acquire/Release balance): every code path that calls `IRecyclableSegmentPool.Acquire` must end with exactly one matching `Release()`/`Dispose()` call, OR transfer ownership by storing the segment in a field/property that itself implements `IRetainable`. Branch analysis tracks the segment local through the method's CFG; an unbalanced exit point (early return, propagated exception via uncaught throw, missing `finally`) is a compile error. The diagnostic message identifies the unreleased branch with line numbers.
   - `OE0007` (no double-release): on the same CFG analysis, if a code path can call `Release()` twice on the same segment local (or `Dispose()` after `Release()`), the call site is a compile error. This catches the most common refactor bug — moving the `Release` into a `using` block while leaving the explicit call behind.
   - `OE0008` (Workspace/Tenant context required): every `IPlanRepository` / `IEventBus.SubscribeAsync` / lease-cache call site must thread an `AuthContext` parameter. The bare overloads exist only inside the auth pipeline (`AiOrchestrator.Security`) and are marked `[InternalsVisibleTo]`-restricted. See §5.1.1 for the mode-by-mode rationale.
   - `OE0009` (lease must be `await using`): any local of type `IAsyncWorktreeLease`, `IAsyncCancellationLease`, or `ICredentialLease` must be declared with `await using var lease = …` (not `var lease = …`). Field/property assignments are flagged unless the containing type itself implements `IAsyncDisposable` and disposes the lease in its own `DisposeAsync`. See §3.3.2.
   - `OE0010` (no cached `LibGit2Sharp.Repository`): `LibGit2Sharp.Repository` must be a local inside a `using` block; it cannot be a field, property, or returned from a method (return a result record instead). A single attribute-marked exception exists for the health-probe class (§3.3.3).
2. **BenchmarkDotNet micro-benchmarks** for the byte path (line ingest, event publish, JSON round-trip) gate per-op allocation budgets.
3. **GC soak test** in `AiOrchestrator.IntegrationTests` (E12) runs a 50-job scripted plan and asserts gen-2 count and RSS growth ceilings.
4. **Debug-mode segment poisoning.** When built with the `AIO_DEBUG_POOL` symbol, `RecyclableSegment` fills its rented array with `0xDE` bytes immediately before returning to the pool, AND zeroes the refcount with a memory barrier. Any subsequent read through a stale `Memory<byte>` window observes the poison pattern; any subsequent `Retain`/`Release` throws `InvalidOperationException` carrying the prior `Acquire` call stack and the `Release` call stack. Poison is enabled in CI test runs and disabled in release builds.
5. **Pool-leak finalizer.** `IRecyclableSegmentPool` tracks live segments via a `ConditionalWeakTable<RecyclableSegment, AcquireSiteInfo>`. On daemon shutdown (and after the GC soak test), the pool asserts the live-segment count is zero; non-zero shutdown counts dump the per-segment `AcquireSiteInfo` (capturing call site + RunId + age) to the daemon log so leaks become identifiable artifacts, not silent retention.

### 3.6.9 The `StreamRedirector` — buffered, refcounted, zero-string stdout pipeline

E13 and E14 are concrete enough to deserve a named component. The `StreamRedirector` is the single class that takes raw stdout/stderr `Stream`s from a spawned child process, slices them into lines, refcounts the slices for the brief window when multiple consumers (parser, redactor, log-writer, event-bus dispatcher) all hold references, and disposes them deterministically when the last consumer releases. **No `string` is ever materialized inside this class.**

#### 3.6.9.1 Component layout

```mermaid
flowchart LR
    A[Process.StandardOutput.BaseStream<br/>Process.StandardError.BaseStream] --> B[StreamRedirector<br/>per stream, owned by IProcessLifecycle]
    B --> C[PipeReader.Create stream<br/>4 KiB pooled segments]
    C --> D[LineSplitter<br/>SequenceReader&lt;byte&gt;.TryReadTo 0x0A]
    D --> E[RecyclableMemorySegment.Acquire<br/>refcount = consumers]
    E --> F1[ISecretRedactor.MaskInPlace<br/>span mutation, no copy]
    F1 --> G1[IByteMatcher dispatch<br/>parser sees ReadOnlySpan&lt;byte&gt;]
    F1 --> G2[Log writer queue<br/>FileStream.WriteAsync ReadOnlyMemory&lt;byte&gt;]
    F1 --> G3[Event-bus enqueue<br/>derived AgentEvent only]
    G1 --> H[Release refcount]
    G2 --> H
    G3 --> H
    H -->|count == 0| I[Segment returned to pool]
```

#### 3.6.9.2 `RecyclableMemorySegment` — pool-backed, refcounted line buffer

We do **not** take a dependency on `Microsoft.IO.RecyclableMemoryStream` directly because we don't want a full `Stream` API surface per line; we want a tiny refcounted slice abstraction. The `RecyclableMemorySegment` pool is a thin wrapper over `ArrayPool<byte>.Shared` that adds a refcount and a `Memory<byte>` window into the rented array.

```csharp
public interface IRecyclableSegmentPool
{
    /// <summary>Acquire a writable segment of at least <paramref name="minBytes"/>. Refcount starts at 1.</summary>
    RecyclableSegment Acquire(int minBytes);
}

public sealed class RecyclableSegment : IDisposable
{
    private byte[] _array;       // rented from ArrayPool<byte>.Shared
    private int    _length;      // bytes actually written into _array
    private int    _refcount;    // managed via Interlocked

    /// <summary>The active window of bytes; valid until the last Release.</summary>
    public ReadOnlyMemory<byte> Memory => _array.AsMemory(0, _length);
    public ReadOnlySpan<byte>   Span   => _array.AsSpan(0, _length);
    public int                  Length => _length;

    /// <summary>Increment refcount when handing the segment to an additional consumer.</summary>
    public void Retain()  { Interlocked.Increment(ref _refcount); }
    /// <summary>Decrement refcount; when it hits zero, the array is returned to the pool.</summary>
    public void Release() { if (Interlocked.Decrement(ref _refcount) == 0) ReturnToPool(); }
    void IDisposable.Dispose() => Release();

    // Writable surface used only by the LineSplitter that owns the segment during fill.
    internal Span<byte> WritableSpan => _array.AsSpan(0, _array.Length);
    internal void Commit(int byteCount) => _length = byteCount;

    private void ReturnToPool() { /* return _array to ArrayPool<byte>.Shared */ }
}
```

**Refcount discipline:**

- The `LineSplitter` calls `Acquire`, fills the span from the pipe reader, then `Retain()`s once for **each downstream consumer** that will hold the segment past the synchronous fan-out point (typically: log-writer queue + per-subscriber event channels that opt to carry the bytes).
- The synchronous fan-out (parser, in-place redactor) does **not** retain — it operates on the span and returns; its work is complete before the splitter releases its initial reference.
- The splitter then `Release()`s its own initial reference. The segment lives until the last asynchronous consumer (slow log writer, slow MCP subscriber) releases.
- A debug build asserts `refcount == 0` on pool return; leaks become test failures, not silent retention.

**Why this pattern over `RecyclableMemoryStream`:**

| Concern | `RecyclableMemoryStream` (rejected for hot path) | `RecyclableSegment` pool (chosen) |
|---|---|---|
| API surface | Full `Stream` (`Read`/`Write`/`Seek`/`Flush`/`Position`/...). | One `Memory<byte>`, one `Span<byte>`, `Retain`/`Release`. |
| Allocation per line | One `RecyclableMemoryStream` instance per line (small, but in the hot path). | Zero — segment instances are themselves pooled. |
| Multi-consumer fan-out | Each consumer needs its own `Stream` view or copy. | Zero-copy via `Retain` — same memory, multiple readers. |
| Lifetime model | `Dispose` returns to pool; no refcount. | Refcount; pool return is automatic at the last release. |
| Use as an open `Stream` | Yes — useful for the **batched log-writer** path (§3.6.9.4), not for per-line dispatch. | No — different concern. |

`Microsoft.IO.RecyclableMemoryStream` **is** used — for the log-writer's own batched write buffer (one stream per job-attempt log file, holding ~256 KiB of pending writes), not for per-line dispatch.

#### 3.6.9.3 `IByteMatcher` — the regex shim

Vendor parsers need to recognize patterns like `"session: <uuid>"`, `"[tokens=12345]"`, `"<tool_use name="...">"`. Three matcher kinds cover essentially every case we have seen in the TS implementation:

```csharp
public interface IByteMatcher
{
    /// <summary>Returns true if the span matches; on match, captures are populated into the request's Captures span.</summary>
    bool TryMatch(MatchRequest request);
}

public ref struct MatchRequest
{
    public ReadOnlySpan<byte> Input { get; init; }
    public Span<ByteSlice>    Captures { get; init; }    // caller-owned; matcher writes (offset, length) pairs
    public int                CapturesWritten;
}

public readonly record struct ByteSlice(int Offset, int Length);

// Three concrete implementations cover ~95% of vendor markers:
public sealed class LiteralByteMatcher    : IByteMatcher { /* MemoryExtensions.IndexOf / SequenceEqual on a literal byte[] */ }
public sealed class PrefixByteMatcher     : IByteMatcher { /* StartsWith on a literal prefix; captures the tail */ }
public sealed class Utf8RegexByteMatcher  : IByteMatcher { /* compiled regex over UTF-8 bytes; only used when prefix/literal is insufficient */ }
```

**`Utf8RegexByteMatcher` is the escape hatch**, not the default. .NET 7+ ships [`Regex` source generators with UTF-8 input support](https://learn.microsoft.com/dotnet/standard/base-types/regular-expression-source-generators) (`[GeneratedRegex(..., RegexOptions.NonBacktracking)]`); for the rare cases where literal/prefix matching can't recognize a marker (Claude's `<tool_use name="...">` with quoted attribute, e.g.) we use a source-gen'd regex that operates directly on bytes — zero string materialization, zero per-call regex object allocation. Each vendor parser holds its matchers as `static readonly` singletons so registration cost is paid once at JIT.

**Captures stay as `ByteSlice` (offset + length).** Parsers extract just the few bytes they care about (e.g., the 36 bytes of a session-id GUID) and convert *only those bytes* to a string at the API boundary, with `Encoding.UTF8.GetString(span.Slice(slice.Offset, slice.Length))`. The full input span is never converted.

#### 3.6.9.4 Log writer — batched, recycled, durable

Once a `RecyclableSegment` is committed by the LineSplitter, the log-writer queue (one per job-attempt) pulls it via the bus's standard bounded `Channel<RecyclableSegment>` and appends it to a per-attempt `RecyclableMemoryStream` buffer. The buffer is flushed to disk on whichever fires first:

- **Size threshold**: 64 KiB pending (matches E2 — keeps the per-flush write below LOH).
- **Time threshold**: 250 ms since last flush (so trickling output is still durable in a reasonable window).
- **Phase boundary**: `PhaseExited` event for the job forces a flush.
- **Process exit**: `ProcessExited` forces a final flush + fsync.

The flush itself is a single `FileStream.WriteAsync(ReadOnlyMemory<byte>)` against a `FileStream` opened with `FileOptions.Asynchronous | FileOptions.SequentialScan`. The `RecyclableMemoryStream` is reset (not freed) and reused for the next batch. After the write completes, the writer calls `Release()` on every segment that was included in the batch — only then do those segments return to the pool.

**Crash safety:** the daemon writes to the log file with `FileShare.Read` so concurrent UX readers (mmap or `FileStream`) see partial writes immediately; on daemon crash, anything in the unflushed buffer is lost (acceptable — the buffer is 64 KiB max), but anything previously flushed is durable because each flush is followed by an `os_fdatasync` on phase boundaries.

#### 3.6.9.5 Where `StreamRedirector` lives

`StreamRedirector` is an internal collaborator of `IProcessLifecycle` (§3.2.2.1) — callers never see it. Its dependencies (registered as singletons) are:

- `IRecyclableSegmentPool` — the per-line segment pool.
- `RecyclableMemoryStreamManager` (`Microsoft.IO.RecyclableMemoryStream`) — the per-attempt batched log buffer pool.
- `ISecretRedactor` — in-place mask of detected secrets within a span.
- `IEventBus` — publishes the small derived `AgentEvent` records.
- `ILogger<StreamRedirector>` — debug diagnostics only; never logs span contents.

This composition is exactly what D8 prescribed for `IProcessLifecycle`: a single stateless coordinator that internally composes the byte-pipeline, exposing only the `ProcessHandle` (whose `Output` channel emits derived events) and a separate descriptor for the on-disk log. No caller of `IProcessLifecycle` ever sees `RecyclableSegment`, `IByteMatcher`, or any other internal type.

---

## 3.7 Cancellation Propagation Across Transports

`CancellationToken` shows up in every method signature in §3.1, but a token that doesn't cross transport boundaries is a lie. This section specifies how cancellation flows from each UX surface, through the daemon, down to the spawned child processes, with bounded drain semantics and orphan detection.

### 3.7.1 Wire-level cancel frames

Every transport carries cancellation as an out-of-band frame on the same connection — it is **not** an HTTP-style request that races the original.

| Transport | Cancel frame |
|---|---|
| Named pipe / Unix socket (JSON-RPC) | `{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":<originalRequestId>,"reason":"<UserCancel\|Timeout\|ParentCanceled\|ClientDisconnected>"}}` — same shape as LSP's cancellation. Daemon resolves the registered `CancellationTokenSource` for `id` and calls `Cancel()`. |
| MCP (stdio) | The MCP spec's `notifications/cancelled` message; the orchestrator's MCP server maps it to the same internal CTS lookup. |
| N-API in-proc binding | JS calls `subscription.cancel()` or signals an `AbortController`; the binding pumps a synthesized cancel frame through the same internal dispatcher used by the pipe surface — no special path. |
| .NET in-proc (CLI, embedded) | The caller already holds the `CancellationTokenSource`; cancel is a direct `cts.Cancel()` call. No wire frame. |

**Outbound cancellation** (daemon-initiated, e.g., a plan-level cancel reaching an MCP subscriber) goes the other direction over the same channel, with the same shape — clients are required to drain their event queue and stop subscribing within `clientDrainGrace` (default 2 s) or the daemon disconnects them.

### 3.7.2 Cascading cancellation hierarchy

CTS lifetimes are arranged in a tree so cancel at any level reaches everything below it without losing per-level reasons:

```
DaemonHostCts                                  (process shutdown)
  └── PlanCts(planId)                          (plan pause/cancel/archive)
        └── JobRunCts(planId, jobId, attempt)  (job retry / force-fail / orphan)
              └── PhaseCts(... , phase)            (phase timeout)
                    └── AgentRunCts(runId)            (agent interrupt)
                          └── ProcessLifecycle.StopAsync
                                 └── SIGINT → SIGTERM → SIGKILL escalation
```

Each link is a `CancellationTokenSource.CreateLinkedTokenSource(parentToken)`; the parent cancellation flows down for free; the leaf-level `IProcessLifecycle.StopAsync` honors `AgentTimeouts.KillEscalation` for OS-level signal escalation (§3.2.1).

### 3.7.3 Drain timeouts per phase

Canceling mid-phase needs different grace periods depending on what's running:

| Phase | Default `CancelDrain` | Rationale |
|---|---|---|
| `merge-fi` / `setup` / `prechecks` | 5 s | Fast file ops; if it can't unwind in 5 s, force-kill is safe. |
| `work` (agent) | 30 s | Let the agent finish writing its current tool-call so we don't corrupt mid-edit files. |
| `commit` | 60 s | Git commit + index lock release; killing mid-commit can leave a corrupt index. |
| `postchecks` | 10 s | Test runners typically respond to SIGINT within seconds. |
| `merge-ri` | 60 s | Branch merge into target; same rationale as commit. |

Drain values live on `PhaseRunOptions.CancelDrain`; plan authors can override per-phase. After drain expiry the next-deeper level escalates (work → SIGINT → SIGTERM after `KillEscalation`).

### 3.7.4 Orphan detection (client disconnected without sending cancel)

Clients can vanish without sending `$/cancelRequest` (network drop, OS kill, VS Code crash). The daemon detects this by:

1. **Heartbeat pump**: every active connection has a 1 s ping the client must echo within 3 s. Three missed pings → daemon synthesizes a `ClientDisconnected` cancel reason on every CTS scoped to that session.
2. **OS-level pipe close**: on POSIX, `read()` returning 0 from the socket triggers immediate session teardown; on Windows, `NamedPipeServerStream`'s `IsConnected = false` on a `WaitForPipeDrain` exception does the same.
3. **TCP keepalive** (for the future remote daemon scenario): SO_KEEPALIVE with 30 s probe interval as a backstop.

### 3.7.5 Plan-level orphan policy

What happens to a long-running plan when its launching client disconnects is a per-plan decision, not a fixed daemon behavior:

```csharp
public enum PlanOrphanPolicy
{
    /// <summary>Cancel the plan when the launching client disconnects. Right for short, attended runs.</summary>
    KillOnDisconnect,

    /// <summary>Detach and continue. Plan keeps running; new clients can attach via planId.
    /// This is the default — long-running plans should survive client churn.</summary>
    DetachAndContinue,

    /// <summary>Auto-pause on disconnect; resume manually when a client reattaches.</summary>
    PauseOnDisconnect
}
```

Default is `DetachAndContinue` because the typical plan in this system runs hours and routinely outlives the VS Code window that started it. The CLI's `ai-orchestrator plan watch <id>` is a pure subscriber; closing it never affects the plan.

### 3.7.6 MCP cancellation mapping

For each in-flight MCP tool invocation, the orchestrator's MCP server registers `(progressToken, JobRunCts)`. When MCP's `notifications/cancelled { requestId, reason }` arrives, the server cancels the CTS and emits an outbound `notifications/cancelled` to the same client confirming the cancel reached its destination. Cancellations originating from the daemon (timeout, parent plan canceled) push a `notifications/cancelled` to the MCP client first, then close the request frame with a structured error.

### 3.7.7 Test surface

`ICancellationCoordinator` is the single in-process abstraction for tests:

```csharp
public interface ICancellationCoordinator
{
    /// <summary>Get the CTS for a scope; create-if-missing.</summary>
    CancellationTokenSource Get(CancelScope scope);

    /// <summary>Cancel a scope with an explicit reason. Cascades to descendants.</summary>
    void Cancel(CancelScope scope, CancelReason reason);

    /// <summary>Synthesize a heartbeat-miss for a session — for orphan-detection tests.</summary>
    void SynthesizeClientDisconnect(SessionId session);
}

public readonly record struct CancelScope(
    CancelScopeKind Kind, // Daemon | Plan | Job | Phase | Agent
    PlanId? PlanId = null,
    JobId? JobId = null,
    int?    Attempt = null,
    ExecutionPhase? Phase = null,
    string? RunId = null);

public enum CancelReason { UserCancel, Timeout, ParentCanceled, ClientDisconnected, DaemonShutdown }
```

Unit tests can drive cancellation at any level without spawning real processes; the cascade behavior is verified via the bus events emitted at each transition (`PlanCanceled`, `JobCanceled`, `AgentExited { disposition: Killed, reason: <CancelReason> }`).

---

## 3.8 Resource Lifetime Discipline — universal `IAsyncDisposable` contract

The TypeScript codebase has accumulated a recurring class of bug: a resource is created, its identity is stored in a state machine somewhere (a `Map<id, …>`, a phase tracker, an `executionEngine` field), and the *cleanup* of that resource is the responsibility of *another* component reading that state machine — typically a `commitPhase`, `cleanupPhase`, `archivePlan`, or `cancelPlan` handler. When the state-machine path is broken (exception thrown, daemon crash, cancellation, programmer forgets a branch), the resource leaks: an orphan worktree, a dangling branch, a zombie process, a stranded lock file, an undisposed channel.

The .NET design eliminates this entire failure category by making **"object lifetime equals resource lifetime"** an inviolable rule. Every side-effecting resource is owned by an `IAsyncDisposable` (or `IDisposable`) value; the C# language's `await using` enforces disposal on every code path; the cleanup logic lives in `DisposeAsync` and nowhere else. There is no `cleanupPhase` that scans for orphans — there *cannot be* an orphan, because the language already guaranteed disposal.

### 3.8.1 The universal contract

```csharp
/// <summary>
/// Marker interface for every resource-owning type in AiOrchestrator. A resource handle:
///   1. Is acquired through a single coordinator call that either fully constructs the
///      resource or throws (no partially-initialized handles ever escape).
///   2. Is consumed exclusively via `await using` (or `using` for IDisposable).
///   3. Performs ALL cleanup in DisposeAsync — idempotent, bounded by a per-handle timeout,
///      reentrant-safe (multiple awaiters share the same underlying disposal task).
///   4. Records its terminal outcome via a single `RecordOutcome` call before disposal
///      so the cleanup logic can branch on success vs failure vs cancel without an
///      external state machine.
/// </summary>
public interface IResourceHandle : IAsyncDisposable
{
    /// <summary>Stable id, written to the on-disk reclaim registry; used for crash recovery.</summary>
    ResourceHandleId HandleId { get; }

    /// <summary>Update the disposal outcome. Last write wins. Idempotent.</summary>
    void RecordOutcome(ResourceOutcome outcome);

    /// <summary>Pin the resource past disposal regardless of outcome (debugging, post-mortem).</summary>
    void Pin(string reason);
}

public enum ResourceOutcome { Unknown, Succeeded, Failed, Canceled, Preserve }

public readonly record struct ResourceHandleId(Guid Value);
```

Every concrete handle below is an `IResourceHandle` (some via a more specific subtype like `IAsyncWorktreeLease`):

### 3.8.2 The catalog — every resource the system creates is a disposable handle

| Resource | Handle interface | Coordinator | Disposal action |
|---|---|---|---|
| Git worktree | `IAsyncWorktreeLease` (§3.3.2) | `IWorktreeManager.AcquireAsync` | `git worktree remove --force` (or rename to `aio/failed/...` per retention policy), branch cleanup, registry entry removal. |
| Git branch (standalone) | `IAsyncBranchLease` | `IGitBranches.CreateLeasedAsync` | Delete branch if `RecordOutcome(Succeeded)` and `RetainOnSuccess: false`; otherwise rename to `aio/preserved/<reason>/<branchName>`. Branches created *as part of* a worktree lease are owned by that lease and not double-leased. |
| OS process / agent run | `IAsyncProcessLease` (wraps `ProcessHandle` from §3.2.2.1) | `IProcessLifecycle.AcquireAsync` | SIGINT → SIGTERM → SIGKILL escalation per `Timeouts.KillEscalation`; process-tree teardown if `EnableProcessTreeKill`; log file tail flush; output channel completion; PID registry entry removal. |
| Credential | `ICredentialLease` (§3.3.1) | `IRemoteIdentityResolver.ResolveAsync` | Zero in-memory secret; clear cache entry if single-use; emit `AuthLeaseReleased` event. |
| Plan execution session | `IAsyncPlanExecutionLease` | `IAiOrchestrator.BeginExecutionAsync` | Cancels every owned `IAsyncJobLease` in reverse-dependency order; flushes the plan's T2 event segment; writes the T3 summary if terminal; releases the plan-level CTS; removes the plan from the daemon's active-plan registry. |
| Job (= job, renamed; §3.8.4) execution attempt | `IAsyncJobLease` | `IAsyncPlanExecutionLease.BeginJobAsync` | Disposes the underlying `IAsyncWorktreeLease`, the `IAsyncProcessLease` (if any), the per-attempt log file handle, and the per-attempt CTS. Records the final `JobOutcome` to the plan repository as the *single* atomic transition — not three separate "phase finished" events. |
| Event subscription | `IAsyncSubscription` | `IEventBus.SubscribeAsync` | Completes the bounded channel writer; removes the subscription from the dispatcher's filter table; flushes any pending replay buffer. |
| Cancellation linkage | `IAsyncCancellationLease` | `ICancellationCoordinator.LinkAsync` | Disposes the linked `CancellationTokenSource` (which un-registers from the parent), emits the `CancelLeaseReleased` diagnostic. |
| File log tail | `IAsyncLogTailLease` | `ILogFileTailerFactory.OpenAsync` | Closes the underlying `FileStream`, completes the line `Channel`, releases the file watcher. |
| Lock file (worktree-init mutex, etc.) | `IAsyncFileLockLease` | `IFileLockCoordinator.AcquireAsync` | Releases the OS file lock, deletes the lock file iff this lease created it (cooperative lock files include the owning daemon PID + start time so reclaim is unambiguous). |
| Daemon connection (server side) | `IAsyncSessionLease` | `IDaemonSession.AcceptAsync` | Cancels every CTS scoped to this session (§3.7.5 plan-orphan policy decides the per-plan response), closes the pipe, removes the session from the registry. |
| MCP tool invocation context | `IAsyncMcpInvocationLease` | `IMcpDispatcher.BeginAsync` | Sends the final `notifications/cancelled` if abandoned; deregisters the progress token; releases the per-invocation CTS. |

**Composition** — leases nest and the language enforces correct teardown order:

```csharp
await using var planExec = await _orch.BeginExecutionAsync(planId, ct);
await foreach (var jobReq in _scheduler.ScheduleAsync(planExec, ct))
{
    await using var job = await planExec.BeginJobAsync(jobReq, ct);
    // Inside BeginJobAsync the worktree lease + (optional) process lease + log tail lease
    // are acquired and stored on the JobLease's owned-resources list. The job's DisposeAsync
    // disposes them in LIFO order. Failure inside any phase still walks every DisposeAsync
    // before the exception propagates out of the await using block.
}
// planExec.DisposeAsync runs here — finalizes T3 summary, releases plan-level CTS.
```

### 3.8.3 No external state machine — disposal IS the state machine

The TS codebase's per-phase "is this resource cleaned up yet?" tracking is replaced by exactly two facts:

1. **The handle's existence**: if the `await using` scope is alive, the resource is alive.
2. **`RecordOutcome` was called with what value before the scope exited**: this is what `DisposeAsync` branches on (success path → normal cleanup; failure path → preserve for debugging; cancel path → inspect-then-decide; no recordOutcome path → treat as failure for safety).

The daemon's plan repository has **no `cleanupPending` field** on jobs, no `worktreesAwaitingCleanup` queue, no `branchesToReap` set, no "orphan reaper" background task at runtime. The only orphan-handling code is the **crash-recovery reclaim path** (§3.3.2 `ReclaimOrphansAsync` for worktrees, plus equivalent reclaim methods on every other coordinator) which runs once at daemon startup against the on-disk lease registries. *Crashes are the only way a resource can leak; the language guarantees the rest.*

### 3.8.4 Terminology decision — "job" → "job" everywhere in .NET

The TS code mixes "job" (graph theory, what `dagUtils.ts` operates on), "job" (what `add_copilot_plan_job` calls them, what users see in the panel), "task" (the `task` field on a `JobSpec`), and "step" (older code paths). The .NET port standardizes on **`Job`** as the canonical noun for *the unit of executable work in a plan's DAG*. Justification:

- `Job` is what every public MCP tool already names them (`add_copilot_plan_job`, `list_copilot_jobs`, `retry_copilot_job`).
- `Job` is what users see in the panel UI.
- `Job` then unambiguously refers to a *graph job* in the DAG-theory sense, which only matters in `IDagAnalyzer` / topology code.
- `Task` is reserved for `System.Threading.Tasks.Task` to avoid the constant shadow.

**Renames in the .NET surface (TS → .NET):**

| TS / today | .NET / canonical |
|---|---|
| `JobId` (entity) | `JobId` |
| `JobRef` (entity ref) | `JobRef` |
| `RetryJobRequest` / `RetryJobResult` | `RetryJobRequest` / `RetryJobResult` |
| `ForceFailJobRequest` | `ForceFailJobRequest` |
| `JobFailureContext` | `JobFailureContext` |
| `JobLogsRequest` / `JobLogsResult` | `JobLogsRequest` / `JobLogsResult` |
| `JobTransition` (event) | `JobTransition` |
| `JobStarted` / `JobSucceeded` / `JobFailed` / `JobCanceled` | `JobStarted` / `JobSucceeded` / `JobFailed` / `JobCanceled` |
| `JobRunRequest` / `JobRunResult` | `JobRunRequest` / `JobRunResult` |
| `IAsyncJobLease` (already named correctly above) | unchanged |
| `dagUtils.JobId` (graph theory) | `DagJobId` (kept distinct — graph job ≠ plan job in the abstract; the concrete plan-DAG happens to map 1:1) |

MCP wire shapes keep their existing tool names (`add_copilot_plan_job`, etc.) so older clients are unaffected; the **internal C# API uses Job everywhere**. Any earlier section in this document that says "job" in the context of "a job in a plan DAG" should be read as the `Job` rename when implementing.

### 3.8.5 Disposal guarantees

Every `IResourceHandle.DisposeAsync` implementation must satisfy:

| Guarantee | Mechanism |
|---|---|
| **Idempotent** | First call sets a `_disposed` field; subsequent calls return the cached `Task` from the first call — not a fresh attempt. |
| **Reentrant-safe** | Multiple awaiters share the underlying disposal task via `Lazy<Task>`. |
| **Bounded** | Wrapped in `Task.WhenAny(_dispose, Task.Delay(timeout))`; timeout publishes `ResourceDisposalTimedOut { handleId, kind, elapsed }` and re-queues for crash-style reclaim on next startup. |
| **Crash-safe registry** | Acquire writes `.aio/.ps/leases/<kind>/<handleId>.json` before constructing the resource; dispose removes it as the final step. The registry is the single source of truth for `Reclaim*Async` methods at startup. |
| **Event-emitting** | Acquire emits `<Resource>LeaseAcquired`; dispose emits `<Resource>LeaseDisposed { handleId, outcome, elapsed, action }`. The bus is the audit trail — no separate cleanup log needed. |
| **Ordered teardown** | Composite leases (e.g., `IAsyncJobLease` owning a worktree lease + process lease + log tail lease) dispose owned leases in LIFO order, awaiting each one before starting the next. Exceptions are aggregated and surfaced as `AggregateException` from the outer `DisposeAsync`. |
| **Cancellation-tolerant** | `DisposeAsync` accepts no `CancellationToken` and does **not** observe the ambient one. It is allowed to take its full `Retention.DisposeTimeout` even when the surrounding code was canceled — cleanup must complete or the bounded-timeout path must run. |

### 3.8.6 Analyzers (`OE0009`, `OE0013`–`OE0015`)

The rules above are mechanically enforced:

- **`OE0009`** (already specified in §3.6.10): any local of type `IResourceHandle` (or any subtype — lease, handle, subscription) must be declared with `await using var … = …` (or `using var` for `IDisposable`). Plain `var lease = await acquire(…)` is a compile error. Field/property assignments are flagged unless the containing type itself implements `IAsyncDisposable` and disposes the lease in its own `DisposeAsync`.
- **`OE0013`** (resource type must implement `IAsyncDisposable`): any class/record whose constructor or factory method opens a process, creates a git ref, opens a file, registers a CTS, or writes a lease registry entry is flagged unless the type implements `IAsyncDisposable`. The set of "resource-creating" calls is hard-coded in the analyzer (`Process.Start`, `Repository.CreateBranch`, `File.Open*` outside `using`, `CancellationTokenSource` field, etc.).
- **`OE0014`** (no external cleanup phase): forbids any method named `*Cleanup*`, `*Reap*`, `*Sweep*`, `*Orphan*` from being called outside the daemon-startup reclaim path (an attribute-allowlisted set of methods on `*Coordinator` types). Application-runtime cleanup is by `await using` only.
- **`OE0015`** (composite lease ownership): if a class has multiple `IResourceHandle`-typed fields, it must itself implement `IAsyncDisposable` and its `DisposeAsync` must dispose every such field in LIFO order. The analyzer pattern-matches the `DisposeAsync` body for the required dispose calls and flags missing ones.

### 3.8.7 What this replaces in the TS codebase

This discipline structurally retires every one of these failure modes that exists today:

- `commitPhase.ts` walking `worktreesAwaitingCleanup` and racing against `cancelPlan` → gone; worktree cleanup is the worktree lease's own `DisposeAsync`, period.
- `executionEngine.ts` tracking `runningProcesses: Map<RunId, ManagedProcess>` and trying to kill leftovers on `dispose()` → gone; each process is owned by an `IAsyncProcessLease` whose surrounding `await using` block was already canceled by the cascade in §3.7.
- `archivePlan` having to enumerate every branch and worktree it might have created across multiple sessions → gone; the on-disk lease registry plus startup reclaim handles only the *crash* case; the *normal* case is structurally clean before archive even runs.
- "Stuck running job" tooling (`force_fail_copilot_job`) needed because we couldn't trust that disposal was actually disposing → still exists for the daemon-crash recovery path, but no longer needed for normal-runtime races.

If you find yourself writing a method that takes an id and looks up a resource to clean it up *outside* an `await using` block, you are violating D9. The fix is always the same: move that resource behind a handle, replace the lookup with the language scope, and let the analyzer enforce it.

---

## 3.9 Global Concurrency, Multi-Daemon Coordination & Fairness

A single user routinely ends up with **multiple `ai-orchestratord` instances live at once** — one launched by the VS Code extension, one launched by `ai-orchestrator-mcp` for Copilot Chat, one started by hand in a terminal for headless CI. Each of those daemons can have several plans running, and each plan can fan out into many parallel agent jobs. Without a global coordination layer, three failure modes are guaranteed within weeks of GA:

1. **System overload.** Two daemons each happily running 8 agent jobs ⇒ 16 concurrent `gh copilot` / `claude` processes plus 16 worktree builds plus their child compilers. The user's machine thrashes; the agents themselves time out from CPU starvation; nothing finishes.
2. **Quota exhaustion.** All 16 agents share the same `gh copilot` rate-limit bucket and the same Claude API key. The vendor's rate limiter starts returning 429s; every job fails for an ambient reason no single daemon can diagnose.
3. **Starvation.** A long-running plan with high parallelism takes every available slot; a small interactive plan from VS Code waits indefinitely; the user assumes the system is broken and force-quits.

§3.9 defines the coordination primitives that prevent this. The design rule is the same as §3.8: **resources are leases, not free-for-alls.** A daemon does not get to start an agent job — it leases a *concurrency permit* from a coordinator that knows about every other daemon on the machine, and disposal of the permit is what releases the slot.

### 3.9.1 The two-tier scope model

Concurrency is governed at two distinct scopes; both apply to every job admission decision:

| Scope | Owner | Backed by | Purpose |
|---|---|---|---|
| **Per-daemon** | One `IConcurrencyGovernor` per daemon process | In-memory semaphore graph, plan-level limits from `maxParallel` | Honors each plan's `maxParallel` and the daemon's own caps. Already exists in spirit today (per-plan executor). |
| **Per-machine (global)** | One `IGlobalConcurrencyCoordinator` shared across **all** daemons on the host | OS-named cross-process mutex + memory-mapped quota table at `%LOCALAPPDATA%/ai-orchestrator/coord/quota.mmf` (Windows) / `$XDG_RUNTIME_DIR/ai-orchestrator/coord/quota.mmf` (Linux/macOS) | Prevents the cumulative-overload problem. Single source of truth for "how many agent jobs are running on this machine right now, regardless of which daemon spawned them." |

A job is admitted **only when both tiers grant a permit**. Either tier can deny (or queue) the request; the per-machine tier is the new piece §3.9 introduces.

### 3.9.2 Permit categories — what we actually count

We count distinct, capped resources rather than one undifferentiated "job slot," because the failure modes are different. Each category has its own machine-wide cap, configurable in `appsettings.json` and overridable per launch:

| Category | Default machine cap | What it gates |
|---|---|---|
| `AgentRuns` | `min(8, ⌊cpuCount × 0.75⌋)` | Concurrent live `gh copilot` / `claude` / scripted agent processes across all daemons. The single most expensive resource. |
| `BuildSlots` | `cpuCount` | Concurrent worktree-init / compile / test runs (anything spawned by a job's `prechecks` / `work` / `postchecks` that isn't itself an agent). |
| `WorktreeOps` | `min(4, cpuCount)` | Concurrent `git worktree add/remove` operations — these contend on the repo's `.git/worktrees` directory and serialize anyway under load. |
| `VendorBucket:<vendor>` | per-vendor (default unlimited; user-configurable) | Per-vendor rate-limit budget (e.g., `VendorBucket:github-copilot = 6` to stay below the 10 RPM Copilot suggestion limit with 4-RPM headroom). |
| `NetworkIo` | unlimited by default | Reserved for future use (large clones, LFS fetches). |

A typical agent job leases `AgentRuns:1 + VendorBucket:github-copilot:1`. A worktree-init step leases `BuildSlots:1`. A `git worktree add` leases `WorktreeOps:1`. Categories compose: a job that needs both takes both permits or queues for both.

### 3.9.3 The contract

```csharp
public interface IGlobalConcurrencyCoordinator
{
    /// <summary>
    /// Acquire one permit per requested category. Blocks (asynchronously) until every requested
    /// permit is available OR the request is canceled. Honors fairness policy (§3.9.6).
    /// Returns a single composite lease that releases ALL permits on disposal — no partial holds.
    /// </summary>
    Task<IAsyncConcurrencyLease> AcquireAsync(ConcurrencyAcquireRequest request, CancellationToken ct);

    /// <summary>Cheap snapshot for UX rendering. Lock-free read of the mmap table.</summary>
    GlobalCapacitySnapshot Snapshot();

    /// <summary>Stream live capacity changes (for UX status bars + watchdogs). Coalesced to ≤10 Hz.</summary>
    IAsyncEnumerable<CapacityChanged> WatchAsync(CancellationToken ct);
}

public sealed record ConcurrencyAcquireRequest
{
    public required PlanId               PlanId   { get; init; }
    public required JobId                JobId    { get; init; }
    public required PermitDemand         Demand   { get; init; }
    public required FairnessClass        Class    { get; init; } = FairnessClass.Normal;
    public TimeSpan?                     QueueTimeout { get; init; } // null ⇒ wait forever (caller's ct still cancels)
    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}

public sealed record PermitDemand
{
    public int AgentRuns          { get; init; }
    public int BuildSlots         { get; init; }
    public int WorktreeOps        { get; init; }
    public string? VendorBucket   { get; init; } // "github-copilot" | "claude" | null
    public int VendorBucketCount  { get; init; } // typically 1 if VendorBucket is set
}

public interface IAsyncConcurrencyLease : IResourceHandle
{
    PermitDemand Granted { get; }
    DateTimeOffset AcquiredAt { get; }
    /// <summary>Owning daemon's pid + start-time — written into the mmap table for crash reclaim.</summary>
    DaemonIdentity Owner { get; }
}

public sealed record GlobalCapacitySnapshot
{
    public required IReadOnlyDictionary<string, CategoryUsage> Categories { get; init; }
    public required IReadOnlyList<DaemonRegistration>          Daemons    { get; init; }
    public required IReadOnlyList<QueuedRequest>               Waiters    { get; init; } // ordered, head-of-line first
    public required DateTimeOffset                             CapturedAt { get; init; }
}

public sealed record CategoryUsage
{
    public required string Name        { get; init; }
    public required int    InUse       { get; init; }
    public required int    Capacity    { get; init; }
    public required int    Waiters     { get; init; }
    public required IReadOnlyList<PermitHolder> Holders { get; init; } // who has the permits, for diagnostics
}

public enum FairnessClass { Interactive, Normal, Background }
```

### 3.9.4 The cross-process registry — `quota.mmf`

The coordinator's storage is a fixed-size memory-mapped file plus a single OS-named mutex (`Global\AiOrchestrator-Coord-v1` on Windows, an advisory `flock` on Unix). The mmap layout is intentionally tiny so reads are wait-free and writes are sub-microsecond:

```
Header (64 B):
  magic (4) | version (4) | maxDaemons (4) | maxLeases (4) | mutexGen (8)
  capacityBitmap (32) — packed CategoryUsage.Capacity fields (one int32 each)
  reserved (8)

DaemonTable (maxDaemons × 64 B):
  pid (4) | startTimeUtcTicks (8) | sessionId (16) | heartbeatUnixMs (8)
  hostKind (4: VsCode|Cli|McpStdio|Daemon) | reserved (24)

LeaseTable (maxLeases × 96 B):
  leaseId (16) | ownerSlot (4) | planId (16) | jobId (16)
  acquiredUnixMs (8) | demand (16: 4×int32 + bucket-hash) | class (4)
  reserved (16)

WaiterRing (8 KiB circular):
  Lock-free MPMC queue of head-of-line waiters — see §3.9.6
```

Every write happens under the named mutex with a **bounded** acquire timeout (200 ms; on timeout we treat it as coordinator-unavailable, see §3.9.7). Reads are lock-free — readers tolerate brief inconsistency since `Snapshot()` is for UX and is re-fetched at ~10 Hz anyway.

**Heartbeats and stale-daemon reclaim.** Every daemon writes its `heartbeatUnixMs` into the DaemonTable every 2 s. On every `AcquireAsync`, the coordinator scans for daemons whose heartbeat is older than 10 s and **reclaims all leases owned by those slots** — this is the multi-daemon equivalent of §3.3.2's crash-recovery path. The reclaimed permits are immediately available to waiters; a `DaemonReclaimed { pid, leaseCount }` event is emitted on every live daemon's bus so users can see "VS Code daemon crashed; recovered 3 agent slots."

### 3.9.5 Daemon registration & discovery

On startup, every daemon registers itself in the DaemonTable with `(pid, startTimeUtcTicks, sessionId, hostKind)` and subscribes to the waiter ring. On shutdown, it deregisters and disposes every lease it owns (which the cascade in §3.7 already guarantees on clean shutdown; crash recovery in §3.9.4 handles unclean exits). The DaemonTable is what powers the UX surface in §7 — `ai-orchestrator daemon list` enumerates it; the VS Code status bar reads from it; the MCP `list_orchestrator_daemons` tool projects it.

```csharp
public interface IDaemonRegistry
{
    Task<IAsyncDaemonRegistration> RegisterAsync(DaemonRegistrationRequest request, CancellationToken ct);
    DaemonRegistry Snapshot();
    IAsyncEnumerable<DaemonRegistryEvent> WatchAsync(CancellationToken ct);
}

public sealed record DaemonRegistrationRequest
{
    public required HostKind HostKind { get; init; } // VsCode | Cli | McpStdio | Daemon
    public required string   Label    { get; init; } // human-readable: "VS Code (workspace: foo)"
    public required string   PipePath { get; init; } // for cross-daemon RPC if needed
    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}

public interface IAsyncDaemonRegistration : IResourceHandle
{
    DaemonIdentity Identity { get; }
    int SlotIndex { get; }
}
```

### 3.9.6 Fairness — preventing starvation

A pure FIFO queue would starve interactive jobs behind a long-running background plan. A pure priority queue would starve background jobs forever. We use **weighted fair queuing across `FairnessClass`** combined with **anti-starvation aging**:

1. Each `FairnessClass` has a static weight: `Interactive = 4`, `Normal = 2`, `Background = 1`. The next permit grant is chosen by selecting the class with the highest `weight × waiters / served-recently` ratio — i.e., a class that has been waiting disproportionately gets priority even if its base weight is lower.
2. Within a class, ordering is **FIFO by enqueue time**.
3. **Anti-starvation aging:** a waiter's effective class is bumped one tier (`Background → Normal → Interactive`) for every full minute it has been queued. This guarantees no waiter waits more than `(N tiers × 60 s) + head-of-line-blocking-time`, which in practice means worst-case wait ≈ 3 min even under sustained pressure.
4. **Per-plan fairness:** within `FairnessClass.Normal`, a single plan cannot hold more than `⌈capacity × 0.75⌉` of any category at once. The remaining 25% is reserved for other plans, preventing a wide-fanout plan from monopolizing the machine.
5. **Per-daemon fairness:** within a class, daemons are round-robined — so two VS Code windows each running a plan get alternating grants, not "first-arriving daemon wins."

Interactive jobs (typically: anything launched directly from a user gesture — VS Code "Retry job" button, CLI `ai-orchestrator job retry`) classify as `Interactive`; plan-execution jobs default to `Normal`; background-scheduled or `resumeAfterPlan` jobs default to `Background`. Plan authors can override via a `fairnessClass` field on `JobSpec` (M2-additive on `Models`).

The waiter ring exposes its current ordering through `GlobalCapacitySnapshot.Waiters` so UX surfaces can show "queued behind 2 jobs (≈45 s)."

### 3.9.7 Failure modes — coordinator unavailable, mmap corruption

The coordinator must not become a single point of failure. Three explicit degradation modes:

| Failure | Detection | Behavior |
|---|---|---|
| **Mutex acquire timeout (200 ms)** | Per-call timeout | The acquiring daemon falls back to its **per-daemon governor only** for that single decision, emits `GlobalCoordinatorUnavailable { reason: MutexTimeout }`, and retries the global path on the next acquire. We accept brief over-subscription rather than blocking. |
| **mmap header magic mismatch / version mismatch** | On open | The newer daemon takes ownership: it backs up the existing file to `quota.mmf.bak.<timestamp>`, recreates the file at its own version, and emits `CoordinatorMigrated { fromVersion, toVersion }`. Older daemons detect the version bump on next read and degrade per-daemon-only. |
| **Stale lock (mutex held but holder is dead)** | OS reports abandoned mutex (Windows) / `flock` returns immediately on dead PID (Unix) | The coordinator runs the stale-daemon reclaim path (§3.9.4) and proceeds. |

These map to bus events in the **Diagnostics / health** category (§3.4.1, additive): `GlobalCoordinatorUnavailable`, `CoordinatorMigrated`, `DaemonReclaimed`.

### 3.9.8 Eventing — the metrics stream UX surfaces consume

Every state change in §3.9 emits an `AiOrchestratorEvent`, joining the unified bus from §3.4. New event subtypes (all pure additions per **EV1**):

| Event | Carried fields | Emitted when |
|---|---|---|
| `DaemonRegistered` | `daemonIdentity, hostKind, label, slotIndex` | Daemon successfully registers in the DaemonTable. |
| `DaemonDeregistered` | `daemonIdentity, reason: Shutdown \| Reclaimed \| HeartbeatLost` | Clean shutdown or stale-daemon reclaim. |
| `DaemonHeartbeat` | `daemonIdentity, heartbeatUnixMs, leaseCount, queuedRequestCount` | Every 2 s per daemon. Coalesced to ≤1 Hz on the bus to keep UX render cost bounded. |
| `ConcurrencyPermitGranted` | `leaseId, planId, jobId, granted: PermitDemand, queueWaitMs, fairnessClass` | After a successful `AcquireAsync`. |
| `ConcurrencyPermitReleased` | `leaseId, heldDurationMs, demand` | On lease disposal. |
| `ConcurrencyPermitQueued` | `requestId, planId, jobId, demand, queuePositionByClass` | When admission is blocked and the request is enqueued. |
| `ConcurrencyPermitAged` | `requestId, oldClass, newClass, ageSeconds` | When a queued request is bumped a tier by anti-starvation. |
| `CapacityChanged` | `category, inUse, capacity, waiters` | Coalesced ≤10 Hz per category; powers status bars. |
| `GlobalCoordinatorUnavailable` | `reason, durationMs` | Per §3.9.7. |
| `CoordinatorMigrated` | `fromVersion, toVersion, backupPath` | Per §3.9.7. |
| `DaemonReclaimed` | `pid, leaseCount` | After stale-daemon reclaim. |

Because these flow through the same `IEventBus`, every UX projection from §3.4.3 sees them automatically — no per-surface plumbing needed. The Node binding, MCP notifications, OTel exporter, CLI watch, and replay buffer all already know how to forward `AiOrchestratorEvent`.

### 3.9.9 UX surfaces

| Surface | What it shows | Built from |
|---|---|---|
| VS Code status bar | "🤖 3/8 agents · 1 queued (≈30 s)" with click → opens Daemons panel | `CapacityChanged` + `ConcurrencyPermitQueued` |
| VS Code "Daemons" panel | Per-daemon table: pid, host, label, leases held, queue depth, last heartbeat | `DaemonHeartbeat` + `IDaemonRegistry.Snapshot` |
| VS Code "Capacity" panel | Per-category gauge: in-use vs capacity, waiter list with per-waiter wait-time and class | `GlobalCapacitySnapshot` + `WatchAsync` |
| `ai-orchestrator daemon list` | Same as VS Code Daemons panel, in Spectre.Console table form | `IDaemonRegistry.Snapshot` |
| `ai-orchestrator capacity watch` | Live-updating Spectre table of categories + waiters | `IGlobalConcurrencyCoordinator.WatchAsync` |
| MCP tool `get_capacity_snapshot` | JSON snapshot for Copilot Chat to surface in conversation | `Snapshot()` |
| MCP tool `list_orchestrator_daemons` | Daemon enumeration for Copilot Chat | `IDaemonRegistry.Snapshot` |
| OTel metrics | `ai_orchestrator.permits.in_use{category}`, `…queued{category,class}`, `…wait_seconds{class}` (histogram), `…daemons.live` | Bus subscriber inside `AiOrchestrator.Hosting` |

### 3.9.10 Configuration

Every cap is configurable via `Microsoft.Extensions.Configuration`, with the resolution order: env vars (`AIO_CAPACITY_AGENTRUNS=12`) → user-level `~/.config/ai-orchestrator/config.json` → daemon launch args → built-in defaults from §3.9.2. Per-vendor buckets are configured under `Capacity:VendorBuckets:<vendor> = N`. Changing a cap at runtime via `IGlobalConcurrencyCoordinator.UpdateCapacityAsync` (admin-only RPC) writes through to the mmap header and emits `CapacityChanged` to every subscribed daemon.

### 3.9.11 Composition — every job admission goes through this

```csharp
public async Task<JobRunResult> ExecuteJobAsync(JobRunRequest req, CancellationToken ct)
{
    await using var permit = await _coord.AcquireAsync(new ConcurrencyAcquireRequest
    {
        PlanId = req.PlanId,
        JobId  = req.JobId,
        Class  = req.IsInteractive ? FairnessClass.Interactive : FairnessClass.Normal,
        Demand = new PermitDemand
        {
            AgentRuns         = req.Work is AgentSpec ? 1 : 0,
            BuildSlots        = req.Work is ShellSpec or ProcessSpec ? 1 : 0,
            VendorBucket      = (req.Work as AgentSpec)?.RunnerId.Value,
            VendorBucketCount = req.Work is AgentSpec ? 1 : 0,
        },
    }, ct);

    await using var lease = await _worktrees.AcquireAsync(/* … */, ct);
    // … phase pipeline …
    // permit and lease both dispose here in LIFO order — slots return to the global pool atomically.
}
```

The `OE0009` analyzer (§3.6.10 / §3.8.6) already requires every `IResourceHandle` local to be `await using` — so a contributor cannot accidentally leak a permit any more than they can leak a worktree.

### 3.9.12 What this replaces in the TS codebase

- The TS executor's per-plan `maxParallel` semaphore — kept as the per-daemon tier, but the global tier above it is new. No more "two VS Code windows × 8 parallel = 16 agent jobs hammering the box."
- The implicit assumption that `gh copilot` rate limits are someone else's problem — `VendorBucket` makes them a first-class admission concern.
- The lack of any cross-daemon visibility — `DaemonTable` + `IDaemonRegistry` give the user a single answer to "what's running right now?" regardless of which surface launched it.
- The current "stuck queue" behavior where a slow plan blocks every other plan — anti-starvation aging guarantees forward progress.

### 3.9.13 Analyzers

- **`OE0023`** (no direct admission): forbids any code path that calls `IAgentRunner.RunAsync`, `IProcessLifecycle.Begin`, or `IGitWorktrees.AddAsync` without an enclosing `IAsyncConcurrencyLease` in scope. The analyzer pattern-matches the surrounding `await using` chain. Tests are exempt via `[GlobalConcurrencyExempt]`.
- **`OE0024`** (no manual heartbeat suppression): forbids any code that mutates `DaemonTable.heartbeatUnixMs` outside the dedicated `DaemonHeartbeatService`.

---

## 3.10 Plugin Loading & Isolation

§3.1.0.5 says vendor agent runners ship as separate NuGet packages and the host registers them via DI. That answers "how does a vendor *write* a plugin." It does not answer "how does the daemon *find, load, validate, and isolate* it at runtime." Without those answers, the plugin model is theory only — every release would be forced to ship every supported runner in-tree.

### 3.10.1 Discovery — where plugins live

Plugins live in well-known directories the daemon scans at startup. The set is layered so per-machine, per-user, and per-workspace plugins all coexist:

| Tier | Path | Purpose |
|---|---|---|
| Machine | Windows: `%PROGRAMDATA%\ai-orchestrator\plugins\<id>\<version>\` · Unix: `/etc/ai-orchestrator/plugins/<id>/<version>/` | Admin-installed, available to every user. |
| User | Windows: `%LOCALAPPDATA%\ai-orchestrator\plugins\<id>\<version>\` · Unix: `$XDG_DATA_HOME/ai-orchestrator/plugins/<id>/<version>/` (default `~/.local/share/...`) | User-scoped install via `ai-orchestrator plugin install`. |
| Workspace | `<repo>/.aio/plugins/<id>/<version>/` (gitignored unless explicitly committed) | Per-repo plugin, useful for project-specific runners or vendor-bundled overrides. Loaded only when a daemon serves a workspace that contains it. |
| In-tree | `<daemon-install-dir>/plugins.bundled/<id>/<version>/` | First-party runners (`Copilot`, `Claude`, `Scripted`) ship here. Treated identically to user plugins from the loader's POV. |

Each `<id>/<version>/` directory contains exactly one **plugin manifest** (`plugin.json`) plus the assemblies. Multiple versions of the same `<id>` may coexist on disk; only one is loaded per daemon process (see §3.10.4 selection).

### 3.10.2 Manifest

```jsonc
// plugin.json — schema-versioned, required at root of every plugin folder
{
  "schemaVersion": 1,
  "id": "com.contoso.aio.agents.superllm",   // reverse-DNS, ASCII, lowercase, [a-z0-9.-], 8..128 chars
  "version": "2.4.1",                         // SemVer 2.0
  "displayName": "SuperLLM Agent Runner",
  "description": "...",
  "author": "Contoso, Inc.",
  "homepage": "https://...",
  "license": "Apache-2.0",                    // SPDX expression
  "kinds": ["agent-runner"],                  // open set: agent-runner | git-backend | event-sink | mcp-tool-pack
  "entryAssembly": "Contoso.AiOrchestrator.Agents.SuperLlm.dll",
  "entryType":     "Contoso.AiOrchestrator.Agents.SuperLlm.PluginEntry",
  "compat": {
    "models":        ">=1.4.0 <3.0.0",
    "abstractions":  ">=1.2.0 <2.0.0",
    "daemon":        ">=1.0.0"
  },
  "capabilities": {
    "agentRunnerIds": ["superllm"],
    "requiresNetwork": true,
    "requiresFilesystem": ["read-cwd", "write-cwd"]
  },
  "signature": {
    "algorithm": "minisign-ed25519",          // or "authenticode" on Windows
    "publicKeyId": "RWRz...",                 // pinned-key fingerprint
    "signatureFile": "plugin.json.minisig"    // detached, covers every file in the folder by hash manifest
  },
  "checksums": "checksums.sha256"             // SHA-256 of every shipped file, signed by signature above
}
```

Loading rules:

1. The manifest is required and parsed strictly (`System.Text.Json` source-gen, `JsonSerializerOptions.UnknownTypeHandling = JsonUnknownTypeHandling.JsonElement` for forward compat on `capabilities`/`extensions`).
2. `id` is the canonical identity. Two plugins with the same `id` and different `version` are alternative versions of the same plugin. Two plugins with different `id` are independent even if their assemblies overlap.
3. `compat.models` and `compat.abstractions` are NuGet version ranges over the contract packages from §3.1.0. The loader refuses any plugin whose ranges do not include the running daemon's actual `Models`/`Abstractions` versions.
4. `entryType` must implement `IPluginEntry` (defined in `AiOrchestrator.Abstractions`):

```csharp
public interface IPluginEntry
{
    /// <summary>Called once per AssemblyLoadContext. Register services with the supplied builder.</summary>
    void Configure(IPluginRegistration reg);
}

public interface IPluginRegistration
{
    PluginIdentity Identity { get; }
    IServiceCollection Services { get; }
    /// <summary>Path to the plugin's own folder — for resource files, sample data, etc. Read-only.</summary>
    string PluginRoot { get; }
    /// <summary>Per-plugin scratch directory the daemon will clean up on uninstall. Writable.</summary>
    string PluginDataDir { get; }
}
```

### 3.10.3 Signature & integrity verification

A plugin is loaded **only after** every byte on disk has been verified:

1. Read `checksums.sha256` (line-per-file format: `<sha256> <relative-path>`). Hash every file under the plugin folder; refuse to load if any file is missing, extra, or its hash does not match.
2. Verify `plugin.json.minisig` (or Authenticode on Windows for AOT-signed `.dll`s) against the manifest's `signature.publicKeyId`, which must be in the user's pinned-key store at `~/.config/ai-orchestrator/trusted-publishers.json`. Pinned keys are added explicitly via `ai-orchestrator plugin trust add <publicKeyId>` — there is **no transitive trust chain**, no CA-style "I trust everyone Verisign trusts." This is intentional: the supply chain attacks we worry about all involve a CA-trusted certificate.
3. Refuse-by-default: a plugin with no signature, an untrusted publisher key, or a signature mismatch is **never loaded**, even with `--allow-unsigned`. The override is `ai-orchestrator plugin trust local --confirm <id>@<version>` which records a local trust override per (id, version, sha256-of-manifest) — bumping the version invalidates the override.

Verification emits Security-category bus events: `PluginVerificationSucceeded`, `PluginVerificationFailed { id, version, reason }`, `PluginTrustOverrideUsed`.

### 3.10.4 Version selection

When multiple versions of the same `id` exist:

1. The daemon's `appsettings` `Plugins:Pin:<id> = "x.y.z"` (or `>=x <y`) wins if present.
2. Otherwise the *highest* version whose `compat.models` and `compat.abstractions` include the running contract versions wins.
3. Lower-tier (workspace > user > machine > in-tree) is preferred only as a final tie-breaker — admin policy can promote machine to override user via `appsettings` `Plugins:TierPriority`.

The selected version is logged via `PluginSelected { id, version, source: Workspace | User | Machine | InTree }` on startup.

### 3.10.5 Isolation — `AssemblyLoadContext` per plugin

Each plugin loads into its **own** `AssemblyLoadContext` (ALC), collectible, built on `System.Runtime.Loader.AssemblyDependencyResolver` (which reads the plugin's `*.deps.json`) so the loader has authoritative metadata for every assembly the plugin actually shipped — no guessing from folder enumeration. The custom `Resolving` handler answers each request in the strict order below. **The default policy is "host first, plugin second"** for every assembly that is not the plugin's own private code, because (a) loading the same assembly twice in two ALCs costs both memory and JIT time, and (b) every duplicate is a future debugging trap when one ALC's `Type` is silently incompatible with the other's.

1. **Contract assemblies** — `AiOrchestrator.Models` and `AiOrchestrator.Abstractions` are **always** resolved from the daemon's default ALC, never from the plugin's folder. This is the single rule that makes `IAgentRunner` from the plugin assignment-compatible with the daemon's `IAgentRunner` (type identity requires same-`Assembly` reference). Even if the plugin shipped a copy of these DLLs, it is ignored; if the daemon's loaded version falls outside the plugin's `compat.models`/`compat.abstractions` ranges (§3.10.2), the plugin is rejected at *load* time, never silently rebound.
2. **Other `AiOrchestrator.*` assemblies** — **refused** outright. Plugins must consume only the public surface (rule 1). A plugin folder that contains `AiOrchestrator.Core.dll`, `AiOrchestrator.Hosting.*.dll`, `AiOrchestrator.Mcp.dll`, etc. is rejected at load time with `PluginLoadFailed { reason: InternalAssemblyBundled, details }` — no fall-through, no override.
3. **Shared framework assemblies** (`System.*`, `Microsoft.Extensions.*`, `Microsoft.AspNetCore.*`, anything published by the .NET runtime/SDK) — **host first**. The default ALC is consulted via `AssemblyLoadContext.Default.LoadFromAssemblyName(name)`; if the host already has the assembly loaded (which is almost always true because the daemon itself depends on it), that instance is returned. The plugin's bundled copy is **ignored** for shared-framework assemblies even if present on disk. This guarantees one `Microsoft.Extensions.Logging.Abstractions.dll` per process and prevents the silent-`Type`-mismatch failure mode for any type the plugin and host both reference.
4. **Third-party shared assemblies** (everything else not covered above — `Newtonsoft.Json`, `Polly`, vendor SDK clients, etc.) — **host first, then plugin**. The handler tries `AssemblyLoadContext.Default.LoadFromAssemblyName(name)`; if the host has a loaded assembly **whose version satisfies the plugin's `*.deps.json` requested-version range**, that instance is reused. Only if the host has no compatible version does the loader fall back to the plugin's bundled copy resolved through `AssemblyDependencyResolver.ResolveAssemblyToPath`. A plugin asking for a wildly newer major version than the host carries is loaded into the plugin ALC in isolation — but emits a one-time `PluginPrivateDependencyLoaded { plugin, assemblyName, hostVersion, pluginVersion }` warning so the operator can see the duplicate.
5. **Plugin's own private code** — assemblies authored by the plugin itself (everything declared as `runtime` in its `*.deps.json` that isn't covered by rules 1–4) — resolved from the plugin folder via `AssemblyDependencyResolver`. These never appear in the host ALC.
6. **Native libraries** — resolved by an analogous `ResolvingUnmanagedDll` handler with the same host-first ordering: `NativeLibrary.TryLoad` against the daemon's loaded natives first, then `AssemblyDependencyResolver.ResolveUnmanagedDllToPath` from the plugin folder. The plugin's RID-specific native folder (`runtimes/<rid>/native/`) is consulted only when the host has nothing matching.

The full chain is summarized in this decision table, which the loader implements verbatim:

| Requested assembly | Resolution |
|---|---|
| `AiOrchestrator.Models` / `AiOrchestrator.Abstractions` | Host default ALC. **Mandatory.** |
| Any other `AiOrchestrator.*` | **Reject** — plugin load fails. |
| `System.*`, `Microsoft.Extensions.*`, `Microsoft.AspNetCore.*`, runtime/SDK shared framework | Host default ALC. **Mandatory** — plugin bundle ignored. |
| Third-party assembly the host already has at a satisfying version | Host default ALC. |
| Third-party assembly the host has at an *un*satisfying version | Plugin folder (private), with `PluginPrivateDependencyLoaded` warning. |
| Third-party assembly the host doesn't have | Plugin folder (private). |
| Plugin's own code | Plugin folder. |
| Native library | Host first, then plugin's `runtimes/<rid>/native/`. |

**Why "host first" is the right default**

- **Type identity is preserved across the boundary.** When a plugin returns an `ILogger<T>` to the host, the host's `Microsoft.Extensions.Logging.Abstractions` and the plugin's are the same `Assembly` instance, so `is`/`as`/generic constraints all work without surprise. Plugin-first defaults are the #1 cause of "this object isn't an `IFoo`, even though `Foo : IFoo`" debugging sessions in plugin systems.
- **Memory and JIT cost are halved** for every shared assembly. Loading `Microsoft.Extensions.Configuration.Abstractions` once versus once-per-plugin matters when a deployment has 5–10 plugins.
- **Security review is simpler.** The set of code running with host privileges is exactly the host's `*.deps.json` plus the plugin's *private* deps. A plugin cannot stealthily replace a host dependency with a tampered copy by shipping it in its folder.

**Where "plugin first" would be wrong**

- A plugin that ships a newer `Microsoft.Extensions.Logging.Abstractions` than the host: under plugin-first, the plugin would observe its newer types, but anything the plugin returned to the host would round-trip through *the host's* older version, causing `MissingMethodException` on any new API the plugin used. Host-first means the plugin gets the host's version (rule 3) and either compiles against it (success) or its `compat` declaration didn't include the host's version (clean reject at load).
- A plugin that bundles `AiOrchestrator.Core.dll` to call internal APIs: under any policy other than rule 2's outright refusal, the plugin would gain access to internals the host never sanctioned.

**Diagnostics**

Every resolve emits a debug-level `PluginAssemblyResolved { plugin, requested: AssemblyName, source: HostDefault | PluginPrivate | NativeHost | NativePlugin, resolvedPath }` event so `ai-orchestrator plugin diagnose <id>` can show the entire load graph. Rejected resolves emit `PluginAssemblyRejected { plugin, requested, reason }` and either fail the load (rules 1, 2) or fall through to the next rule.

A plugin that violates the rules at load time is rejected with a typed error and `PluginLoadFailed { id, reason: AssemblyResolutionRejected, details }`. The loader never silently downgrades or auto-converts — every rejection requires an explicit fix in the plugin (correct `compat` ranges, remove bundled internal assembly, etc.).

### 3.10.6 Per-plugin lifecycle

```csharp
public interface IPluginHost
{
    Task<IAsyncPluginLease> LoadAsync(PluginLoadRequest request, CancellationToken ct);
    PluginCatalog Snapshot();
    IAsyncEnumerable<PluginEvent> WatchAsync(CancellationToken ct);
}

public interface IAsyncPluginLease : IResourceHandle
{
    PluginIdentity Identity { get; }
    AssemblyLoadContext LoadContext { get; }   // exposed for diagnostics; do not mutate
    IServiceProvider PluginServices { get; }   // scoped to this plugin
}
```

Disposal of an `IAsyncPluginLease`:

1. Deregister every service the plugin contributed (the loader records the keyed-DI keys from §3.2.2 at Configure time).
2. Dispose the plugin's child `IServiceProvider`.
3. `Unload()` the ALC and wait for it to become collectible (bounded by `PluginUnloadTimeout`, default 30 s; on timeout publish `PluginUnloadStuck { id, version, gcRoots }` with a coarse GC-root summary so the user can file a useful bug).

Plugin failures during `Configure` or `RunAsync` are caught, surfaced as `PluginRuntimeFault`, and **never** crash the daemon — a buggy third-party plugin is structurally incapable of taking down orchestration of unrelated plans.

### 3.10.7 CLI surface

- `ai-orchestrator plugin list` — show installed plugins by tier with selected version highlighted.
- `ai-orchestrator plugin install <pkg>` — fetch from NuGet (or local path) into the user tier; verifies signature.
- `ai-orchestrator plugin uninstall <id>` — remove from the user tier.
- `ai-orchestrator plugin trust add <publicKeyId>` / `... list` / `... revoke` — pinned-key management.
- `ai-orchestrator plugin verify <path>` — offline verification of a plugin folder; exits non-zero on any integrity issue.
- `ai-orchestrator plugin diagnose <id>` — dumps load order, ALC tree, resolved assembly versions, and any rejection reasons.

### 3.10.8 Conformance test pack

Ships as `AiOrchestrator.PluginConformance` (NuGet, MIT). A vendor adds it as a test reference and runs:

```
dotnet test --filter "Conformance"
```

The pack exercises every `IAgentRunner` invariant we have learned the hard way: argv must not contain secrets; stdout parser must not retain `LineUtf8` past return; capability gating must downgrade on missing features; `InterruptAsync` must escalate within `KillEscalation` ± 10%; etc. Passing the pack is the gate for the `vendor-conformance: true` annotation in the public plugin registry — but the pack works equally well in private CI for closed-source plugins.

### 3.10.9 Sample template

`dotnet new install AiOrchestrator.Templates` adds:

- `dotnet new aio-agent-runner` — minimal `IAgentRunner` skeleton with a `plugin.json`, `IPluginEntry`, signed-build target, conformance project, and README.
- `dotnet new aio-event-sink` — `IEventBusSubscriber` skeleton.
- `dotnet new aio-mcp-tool-pack` — additional MCP tools that the daemon will expose alongside its built-ins.

### 3.10.10 Analyzers

- **`OE0025`** (plugin must not reference internal assemblies): in any `.csproj` whose `OutputType` is `Library` and that ships under the `aio-plugin` MSBuild profile, `<PackageReference>` to anything except `AiOrchestrator.Models` and `AiOrchestrator.Abstractions` is flagged. Internal access via reflection is also forbidden by a runtime guard the loader installs.
- **`OE0026`** (no `Assembly.Load` from a plugin assembly): plugin code that calls `Assembly.Load`/`AssemblyLoadContext.LoadFromAssemblyPath` is flagged — ALC traversal is the only legal path and the loader handles it.

---

## 3.11 On-Disk Schema, State Migration & Disk Quota

§3.4.4 versions *events*. The daemon also writes plan state, lease registries, plugin caches, and per-job logs. None of those are versioned today in the design. Without an explicit schema-migration path, daemon-N reading state written by daemon-N-2 silently corrupts data or, worse, loads "successfully" with subtle field drift.

### 3.11.1 The on-disk inventory

Every file the daemon writes is one of these kinds — and every kind has a defined schema-version handling rule:

| Kind | Path pattern | Format | Versioned via | Migration policy |
|---|---|---|---|---|
| Plan instance | `.aio/p/<plan8>/plan.json` | UTF-8 JSON | top-level `schemaVersion: int` | Forward-migrate on load (in-place rewrite); no writes in the old format. |
| Plan summary (T3) | `.aio/p/<plan8>/events.summary.json` | UTF-8 JSON | top-level `schemaVersion: int` | Read-only after plan terminal; never migrated — readers handle all known schemas. |
| Event log segment (T2) | `.aio/.ps/events/<plan8>/seg-<n>.log` | length-prefixed framed records | per-record header byte | Mixed-version segments tolerated; readers skip records with unknown header bits and emit `EventLogRecordSkipped`. |
| Event log index (T2) | `.aio/.ps/events/<plan8>/index.json` | UTF-8 JSON | top-level `schemaVersion: int` | Rebuilt from segments on version mismatch. |
| Worktree lease registry | `.aio/.ps/leases/worktree/<leaseId>.json` | UTF-8 JSON | top-level `schemaVersion: int` | Forward-migrate; old daemons that see a higher version refuse to reclaim and emit `LeaseRegistryNewerThanDaemon`. |
| Process lease registry | `.aio/.ps/leases/process/<leaseId>.json` | same | same | same |
| Concurrency mmap (`quota.mmf`) | per §3.9.4 | binary, fixed-layout | header `version: int32` | Owning-daemon migrate on bump (§3.9.7). |
| Plugin cache | per §3.10 | UTF-8 JSON + binaries | manifest `schemaVersion` | Cleared and rebuilt on version mismatch. |
| Per-job logs | `.aio/.ps/log/<plan>/<job>/<phase>/<attempt>.log` | UTF-8 text | none — opaque content | Subject to retention (§3.11.4); never migrated. |
| Telemetry queue (offline OTel) | `.aio/.ps/telemetry/queue/*.json` | NDJSON | per-line `schemaVersion: int` | Drop unknown lines, emit one `TelemetryRecordDropped` per startup. |
| Audit log | `.aio/.ps/audit/<yyyy-mm>.ndjson` | NDJSON | per-line `schemaVersion: int` | Append-only, never migrated; old lines stay readable forever. |

`schemaVersion` is **always an integer**, **always at the top level**, and **always required** on any newly-written file. There is no implicit default — a missing `schemaVersion` is treated as corruption.

### 3.11.2 The migration framework

A single `IStateMigrator<T>` interface per kind, registered with keyed DI by version:

```csharp
public interface IStateMigrator<T>
{
    int FromVersion { get; }
    int ToVersion   { get; } // always FromVersion + 1
    T Migrate(JsonElement source);
}
```

The loader chains migrators (`v1 → v2 → v3 → … → vN`), then re-validates the result against the current schema (which is itself the source-generated `[JsonSerializable]` shape from §3.1.0.6). An unbroken chain from the file's recorded version to the daemon's current version is a hard requirement; gaps are a load failure with `StateMigrationGap { from, to, available }`.

**Forward-migration in place** is opt-in per kind. Plan instances are migrated and rewritten atomically (write-temp + fsync + rename); event-log segments are *not* rewritten (they're append-only and rotated). The rule: if writes to the file are scheduled to continue in the new schema, migrate in place; otherwise leave it and migrate on read every time.

### 3.11.3 Backward compatibility — daemon-N reads daemon-N-2

The daemon ships every migrator it has ever introduced. Removing an old migrator is a **major** version bump for the daemon and is announced in the changelog one minor release in advance via a `MigratorDeprecationScheduled` startup warning whenever an old-format file is encountered.

### 3.11.4 Retention & disk-quota policy

Without per-kind caps, the `.aio/.ps/` tree grows forever. Every kind has a default retention that the user can override in `appsettings`:

| Kind | Default retention | Configuration key |
|---|---|---|
| Per-job logs | Last 5 attempts per (plan, job, phase); ages out at 30 days | `Retention:JobLogs:MaxAttempts` / `MaxAgeDays` |
| Event log segments (T2) | Last 90 days per plan; capped at 256 MiB per plan | `Retention:EventLog:MaxAgeDays` / `MaxBytesPerPlan` |
| Worktree (preserved-on-failure) | Last 10 failed worktrees per plan; aged out at 14 days | `Retention:FailedWorktrees:MaxPerPlan` / `MaxAgeDays` |
| Lease registries (orphaned) | Reclaimed at next startup; never aged on their own | n/a |
| Telemetry queue | Capped at 64 MiB; oldest dropped first | `Retention:Telemetry:MaxBytes` |
| Audit log | Rotated monthly; kept forever (never auto-deleted) | n/a |

Pruning is performed by a single `RetentionSweeperService` (background, runs on daemon startup and every 6 h thereafter, plus on every plan terminal transition for that plan's data). Sweeping is **idempotent** and **lock-free against active writers** — it never removes a file referenced by a live `IResourceHandle`.

### 3.11.5 Disk-pressure response

The sweeper computes free space on the volume hosting `.aio/.ps/` at each pass and emits one of:

- `DiskCapacityHealthy` (≥ 5 GiB free OR ≥ 10% of volume) — no action.
- `DiskCapacityWarning` (≥ 1 GiB and < 5 GiB / < 10%) — sweep aggressively (drop to ½ each retention cap), warn on every job admission.
- `DiskCapacityCritical` (< 1 GiB) — refuse new agent admissions (`IGlobalConcurrencyCoordinator.AcquireAsync` denies with `DiskCriticalDenial`); active jobs continue but their preserve-on-failure policy is downgraded to `RemoveAlways`. Emits `CapacityChanged` for the new effective cap.

Recovery from `Critical` requires a successful sweep that puts free space back over 2 GiB OR the user adjusting the retention caps OR `ai-orchestrator daemon disk-pressure clear --confirm`.

### 3.11.6 Sample/upgrade integration test

`G-Migration` joins §11.3's broad acceptance gates: every release ships with a `state-fixtures/` directory containing one realistic on-disk `.aio/` snapshot per supported old version (N-1, N-2, …). CI loads each fixture into the new daemon, runs `ai-orchestrator plan list`, kicks off one paused-then-resumed plan, and verifies no `StateMigrationGap`, `EventLogRecordSkipped`, or `JsonException` events. A release is blocked until every fixture in scope passes.

---

## 3.12 Configuration, Logging, Telemetry & Privacy

§3.9.10 mentioned `Microsoft.Extensions.Configuration` in passing. Logging and telemetry are referenced piecemeal across §3.4 and §3.7 but never described as a coherent surface. Without an end-to-end story, three things go wrong: users can't predict what setting wins, operators can't correlate logs across daemons, and security review can't verify what we collect.

### 3.12.1 Configuration sources & precedence

The daemon resolves every setting via `Microsoft.Extensions.Configuration` with the providers below registered in order — **later providers override earlier**. Source precedence is fixed and documented; there is no other order.

1. **Built-in defaults** — compiled into the daemon (`AppDefaults.cs`).
2. **Machine config** — Windows `%PROGRAMDATA%\ai-orchestrator\appsettings.json` · Unix `/etc/ai-orchestrator/appsettings.json`.
3. **User config** — Windows `%LOCALAPPDATA%\ai-orchestrator\appsettings.json` · Unix `$XDG_CONFIG_HOME/ai-orchestrator/appsettings.json`.
4. **Workspace config** — `<repo>/.aio/appsettings.json` (loaded only when a daemon serves that repo).
5. **Environment variables** — `AIO_*` prefix, `__` for nesting (e.g., `AIO_CAPACITY__AGENTRUNS=12`).
6. **Daemon launch args** — `--config Capacity:AgentRuns=12` (intended for one-off overrides; not persisted).

Every key has exactly one canonical name (kebab-case in JSON, `__`-nested in env vars). Aliases and back-compat names are forbidden — they were the #1 cause of "the docs say X but the actual key is Y" support load in the TS implementation.

### 3.12.2 Validation & diagnostics

Each `IOptions<T>` class is validated at startup via `services.AddOptions<T>().ValidateDataAnnotations().ValidateOnStart()`. Any failure aborts startup with a typed error and `ConfigurationInvalid { sectionPath, errors }`. CLI surface:

- `ai-orchestrator config show` — prints the resolved config tree, with each leaf annotated by its winning source.
- `ai-orchestrator config show --sources` — adds the full provenance chain (which providers contributed what value).
- `ai-orchestrator config validate [--file path]` — runs validation without starting the daemon.
- `ai-orchestrator config diff` — diff between current effective config and machine defaults.

### 3.12.3 Hot reload — what reloads, what does not

Every `IOptionsMonitor<T>` consumer receives change notifications when a JSON file changes. Hot-reload behavior is explicit per setting:

| Setting class | Hot-reloadable? | Behavior |
|---|---|---|
| `Capacity:*` | ✅ Yes | New limits apply to the *next* admission; in-flight permits are unaffected. Emits `CapacityChanged`. |
| `Retention:*` | ✅ Yes | Applied at the next sweep pass. |
| `Logging:*` | ✅ Yes | Per-category log levels updated immediately. |
| `Telemetry:*` | ✅ Yes for sampling/redaction; ❌ No for endpoint URL changes (requires restart). |
| `Plugins:*` | ❌ No | Adding/removing plugins requires a daemon restart. Reflected by `ConfigChangeRequiresRestart` event. |
| `Auth:*` | ❌ No | Pipe path / nonce config changes apply only on next daemon start. |

The rule: **anything that affects an externally-observable handle requires a restart**; everything else hot-reloads. A reload that violates validation reverts to the prior state and emits `ConfigReloadRejected`.

### 3.12.4 Logging — schema, levels, sinks

Every `ILogger<T>` call follows a strict schema enforced by analyzer **`OE0027`**:

- **Event id ranges** are assigned per assembly in `LogEventIds.cs` (e.g., `AiOrchestrator.Plan` owns 10000–10999). Overlapping ranges are a build error.
- **Structured properties** use `PascalCase` names. Templates use `{PlanId}`, never `{0}`. PII-bearing properties (paths, branch names, repo URLs) carry the `[LogPii]` attribute on the property definition; the redactor (§3.12.6) consults this metadata.
- **Levels**: `Trace` for hot-loop diagnostics; `Debug` for per-op details; `Information` for state transitions a user might want to see; `Warning` for recoverable degradation; `Error` for failed user-visible operations; `Critical` for daemon-level faults. Bus events at category `Diagnostics/health` are emitted at `Warning` or higher *only* — the bus is the structured channel; logs are the unstructured fallback.

**Sinks** (configured via `Logging:Sinks`):

| Sink | Default | Notes |
|---|---|---|
| Console (stderr) | On (`Information+` for daemon, `Warning+` for CLI) | JSON when `--log-format=json`; human-readable otherwise. |
| File | `<dataDir>/logs/ai-orchestratord.log` | Rolled daily, 7-day retention, 100 MiB cap per file. Independent of T2 event log retention. |
| OpenTelemetry | Off by default | When on, ships logs as OTLP records with the structured properties intact (after redaction). |
| EventLog (Windows) / journald (Linux) | Off | Opt-in for ops teams that want OS-level log aggregation. |

Bus events and `ILogger` are intentionally separate channels: the bus is the *product surface* (UX consumes it, contracted per §3.4.5); logs are the *operator surface* (humans grep them). A single occurrence frequently emits both.

### 3.12.5 Telemetry — opt-in, sampled, projectable

OpenTelemetry is the only telemetry mechanism. It is **off by default** and requires explicit opt-in via `Telemetry:Enabled = true` plus acceptance of the disclosure shown by `ai-orchestrator telemetry status`. Both must be true for any byte to leave the process.

When enabled:

- **Traces** — every `IAiOrchestrator` public-API call is a span; the `Activity.TraceId` propagates through bus events as `traceId` and through every spawned child process as `OTEL_TRACE_ID` env var. Plan execution is a long-running parent span with one child span per phase.
- **Metrics** — instruments under the meter `ai-orchestrator`:
  - `permits.in_use{category}` (gauge), `permits.queued{category,class}` (gauge), `permits.wait_seconds{class}` (histogram)
  - `agent.runs.duration_seconds{runner}` (histogram), `agent.runs.tokens{runner,kind}` (counter)
  - `git.ops.duration_seconds{op,backend}` (histogram), `libgit2.breaker_state` (gauge)
  - `daemons.live` (gauge), `plans.active`, `jobs.in_flight`
- **Logs** — exported as OTLP records with severity, body, structured attributes (after redaction).

**Sampling** defaults to `parentbased_traceidratio(0.1)`; configurable. The CLI surface always exports at 1.0 because invocations are short.

**Endpoint** defaults to `http://localhost:4317` (assume a sidecar collector); user can point at any OTLP/HTTP or OTLP/gRPC endpoint. The daemon retries with exponential backoff and queues to disk (§3.11.1) when the endpoint is unreachable; queued records are dropped after `Retention:Telemetry:MaxBytes`.

### 3.12.6 Privacy — what we redact, what we drop

`ITelemetryRedactor` and `ILogRedactor` apply identical rules across both surfaces before bytes leave the daemon process:

| Field class | Default action | Override |
|---|---|---|
| Paths under the user's home directory | Replace with `~/.../<filename>` | `Telemetry:Redaction:Paths = "full"` (opt-in for self-debug) |
| Branch refs | Hashed (`sha256:<first8>`) | `Redaction:BranchRefs = "full"` |
| Remote URLs | Hostname + repo-name kept; org name hashed | `Redaction:RemoteUrls = "full"` |
| Secrets (PAT, env vars matching `*TOKEN*`/`*SECRET*`/`*KEY*`) | Always dropped — never overridable | n/a |
| Process command lines | First arg only by default; rest dropped | `Redaction:ProcessArgs = "full"` |
| Stdout/stderr captured from agents | Dropped from telemetry; in logs only at `Trace`+ | n/a |
| User account names / OS usernames | Hashed (`sha256:<first8>`) | `Redaction:UserNames = "full"` |
| `LogPii`-attributed properties | Per the redaction map for that field's class | per-field |

Three rules are non-negotiable, enforced by analyzer **`OE0028`** (telemetry-attribute purity):

1. No raw secret value may appear in any property name, attribute, or template string. The analyzer pattern-matches the `LoggerMessage` source generators and rejects any property name in a denylist (`token`, `secret`, `key`, `password`, `nonce`, `cookie`).
2. `Activity.SetTag` and `meter.CreateCounter` may not accept dynamic property names — only constants that pass the analyzer.
3. The redactor pipeline is mandatory: every OTel exporter, every log file sink, and every `ai-orchestrator daemon diagnose` bundle (§3.13.4) routes through it. There is no "raw" sink.

### 3.12.7 GDPR / data-subject deletion path

`ai-orchestrator telemetry forget --all` clears the on-disk telemetry queue and rotates the log files immediately. For records already shipped to OTel, the user is directed to their collector's retention policy — the daemon makes no claim about downstream storage. Privacy disclosures spell this out verbatim.

### 3.12.8 Analyzers

- **`OE0027`** (logging schema): enforces event-id range ownership, `PascalCase` property names, no string interpolation in templates.
- **`OE0028`** (telemetry-attribute purity): per §3.12.6 rules 1–2.
- **`OE0029`** (no telemetry without redactor): forbids any direct `Activity.SetTag` / `Counter.Add` from outside `AiOrchestrator.Telemetry` — first-party callers must go through the redactor-installing wrappers.

---

## 3.13 Daemon Lifecycle, Supervision & Diagnostics

§3.9 covered what happens when *another* daemon dies; §3.7 handled cancellation cascades within a live daemon. The plan never said *who restarts the daemon itself*, how it survives the OS, or how a user collects a useful bug report after a crash.

### 3.13.1 Process supervision

The daemon ships with three platform-native supervisors. Choosing one is a deployment decision; the daemon binary works under all three.

| Platform | Mechanism | Artifact shipped |
|---|---|---|
| Linux | systemd user unit | `ai-orchestratord.service` (template); `Restart=on-failure`, `RestartSec=2s`, `StartLimitBurst=5`, `StartLimitIntervalSec=60s`. Installed by `ai-orchestrator daemon install --systemd`. |
| macOS | launchd LaunchAgent | `com.ai-orchestrator.daemon.plist`; `KeepAlive={SuccessfulExit:false}`, `ThrottleInterval=10`. Installed by `ai-orchestrator daemon install --launchd`. |
| Windows | Service Control Manager (optional) **or** scheduled task at logon (default for end users) | `ai-orchestrator daemon install --service` (admin) or `--logon-task` (user). |
| Any (dev) | VS Code extension supervisor | The extension acts as supervisor when `daemon.supervisor = "extension"` in the workspace setting; respawn policy mirrors systemd's. |

### 3.13.2 Restart & crash-loop policy

**Exit codes** are stable and documented:

| Code | Meaning | Supervisor action |
|---|---|---|
| 0 | Clean shutdown | Do not restart. |
| 1 | Generic fault | Restart per policy. |
| 2 | Configuration invalid | Do **not** restart — surfaces user error. |
| 3 | State migration gap (§3.11) | Do not restart. |
| 4 | Plugin load fault, daemon-fatal | Restart with `--safe-mode` (skips workspace plugins). |
| 5 | Concurrency mmap corruption | Restart; daemon will rebuild. |
| 137 | OS OOM-killed (Linux) | Restart with backoff; emits `DaemonOomRestart`. |
| 139 | Native crash (segfault) | Restart; capture coredump per §3.13.4. |

Crash-loop detection: > 5 restarts in 60 s ⇒ supervisor refuses further restarts and writes `daemon.cooldown.json` with the reason. The next restart attempt requires `ai-orchestrator daemon clear-cooldown` or the file's TTL (default 1 h) to elapse.

### 3.13.3 Singleton vs multi-daemon — both are first-class

§3.9 already commits to multi-daemon coordination. Two deployment modes are supported, each with its own supervisor template:

| Mode | When to use | Coordinator behavior |
|---|---|---|
| Per-host singleton | Headless machines, CI runners, dev sandboxes — anywhere a single daemon serves all users | One systemd service / one Windows Service; new clients connect to the existing pipe. The supervisor enforces uniqueness via a `flock` on `~/.config/ai-orchestrator/singleton.lock`. |
| Multi-instance | Interactive workstations where VS Code, MCP, and CLI may each spawn independently | Per §3.9; each daemon registers in `quota.mmf` and shares load. The user's `appsettings` `Daemon:Mode = "multi"` opts in (the default for VS Code installs). |

A user running both modes simultaneously is supported but produces a one-time `MultiModeMixed` warning at startup of any non-singleton instance. The singleton lock takes precedence: if a singleton is running, a new multi-instance refuses to start with exit code 6 and instructs the user to either kill the singleton or convert it to multi-mode.

### 3.13.4 Crash diagnostics — `daemon diagnose`

Every daemon process, on startup, sets up:

- **Linux:** `DOTNET_DbgEnableMiniDump=1` + `DOTNET_DbgMiniDumpName=<dataDir>/dumps/ai-orchestratord.%t.%p.dmp` + `DOTNET_DbgMiniDumpType=2` (Heap).
- **Windows:** WER local-dump policy via per-process registry under `HKCU\Software\Microsoft\Windows\Windows Error Reporting\LocalDumps\ai-orchestratord.exe`, `DumpFolder = <dataDir>/dumps`, `DumpType = 2` (Mini), `DumpCount = 5`.
- **macOS:** Default `~/Library/Logs/DiagnosticReports/` is observed; the diagnose bundler reads from there.

`ai-orchestrator daemon diagnose [--out bundle.zip]` collects:

1. The last 24 h of log files (`Logging:Sinks:File`).
2. Last 5 minidumps (size-capped).
3. Current `appsettings` resolution (`config show --sources`), with secret values redacted per §3.12.6.
4. Last 1000 events from each plan's T2 segment (redacted).
5. `quota.mmf` snapshot (binary).
6. Plugin catalog + their `plugin.json` files (no plugin code).
7. `git --version`, `dotnet --info`, OS version, locale.

Everything is run through the redactor. The bundle is plain `.zip`, no encryption — the user attaches it to bug reports themselves.

### 3.13.5 Daemon shutdown ordering

`SIGTERM` (Unix) or service-stop (Windows) triggers `IHostApplicationLifetime.StopApplication`, which runs the following steps strictly in order. Each step has a documented timeout; exceeding a timeout escalates to the next step regardless.

1. **Stop accepting new RPCs** (named-pipe listener stops `AcceptAsync`; new connections get `daemon-shutting-down` immediately). 100 ms.
2. **Cancel in-flight RPCs** by signaling each session's CTS with `CancelReason.DaemonShutdown` per §3.7.5. 5 s.
3. **Cascade cancel into plan execution** — each plan's CTS is cancelled, which propagates to job CTSs, which propagates to agent CTSs (§3.7). 30 s.
4. **Dispose every live `IAsyncJobLease`** in reverse-dep order — each disposes its worktree lease, process lease, log tail. 30 s combined.
5. **Drain the event bus** — wait for every dispatcher (Node binding, MCP, CLI watch, OTel, T2) to flush. 5 s.
6. **Flush T2 event log segments** with `fsync`. 2 s.
7. **Flush telemetry queue** to the OTel collector or to disk. 2 s.
8. **Deregister from `quota.mmf`** and release every concurrency permit. 200 ms.
9. **Close the named-pipe listener.** 100 ms.
10. **Process exit.**

Exceeding any timeout publishes `ShutdownStepTimedOut { step, elapsed }` and proceeds; exceeding the full shutdown budget (75 s wall clock) triggers `Environment.FailFast` so the OS reaps cleanly rather than letting an unkillable process hang.

### 3.13.6 Daemon election & first-run race

Multiple processes (VS Code window, CLI, MCP) starting simultaneously all attempt to be the daemon. The election protocol:

1. Every aspirant tries `CreateNewOnly` on the OS-named singleton mutex `Global\AiOrchestrator-Daemon-{userSid}` (Windows) / `flock(LOCK_EX|LOCK_NB)` on `$XDG_RUNTIME_DIR/ai-orchestrator/daemon.lock` (Unix).
2. The winner takes the role of "daemon": opens the named pipe, registers in `quota.mmf`, starts accepting RPCs.
3. Losers immediately back off and connect to the pipe as **clients**; if the pipe isn't ready within 250 ms they retry with jittered exponential backoff (250 ms, 500 ms, 1 s, 2 s, 4 s; cap 5 attempts) before giving up and logging `DaemonElectionFailed`.
4. In multi-mode (§3.13.3) every aspirant takes a per-instance lock `Global\AiOrchestrator-Daemon-{userSid}-{instanceId}` instead, and all of them open distinct pipes. The `quota.mmf` registration is what makes them visible to each other.

The election uses *only* OS primitives — never a heuristic on filesystem timestamps or PID files — so it survives `kill -9` of the previous winner cleanly.

---

## 3.14 Network, Proxy & Enterprise CA Support

Every outbound HTTPS call the daemon, libgit2sharp, and the agent CLIs make is subject to corporate proxies and TLS interception. None of that is currently in the design. Without it, "doesn't work at $BIG_CO" is a top-3 inbound issue.

### 3.14.1 Proxy resolution

Proxy precedence per outbound request:

1. Per-request proxy (programmatic — not currently exposed but reserved for future).
2. `appsettings` `Network:HttpsProxy` / `HttpProxy` / `NoProxy`.
3. Standard env vars `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` / `https_proxy`, `http_proxy`, `no_proxy` (lowercase preferred per common convention; both honored, lowercase wins on conflict — documented).
4. OS proxy (Windows: WinHTTP/IE settings via `HttpClient.DefaultProxy`; macOS: SystemConfiguration; Linux: none).

**`NO_PROXY` semantics** match curl: comma-separated hostnames/CIDRs/`.suffixes`; `*` wildcards explicitly **not** supported (curl-incompatible variants are a footgun).

### 3.14.2 Proxy authentication

| Scheme | Support |
|---|---|
| Basic / Digest | Via proxy URL `http://user:pass@host:port` (env or config); credentials handled via `ICredentialLease` (§3.3.1) and never logged. |
| NTLM / Negotiate | On by default on Windows via `HttpClient.DefaultCredentials`; on Linux/macOS requires Kerberos config (`KRB5_CONFIG`). |
| Custom proxy auth (PAC, MITM) | Out of scope — the user must terminate at a forward proxy that handles it. |

Proxy auth failures emit `ProxyAuthRequired { hostScheme, host }` so users can wire credentials.

### 3.14.3 Custom root CAs & TLS interception

Many enterprise environments terminate TLS at a forward proxy with a private CA. The daemon respects:

- **System trust store** — Windows certmgr root store; macOS Keychain; Linux `/etc/ssl/certs/ca-certificates.crt` (Debian/Ubuntu), `/etc/pki/tls/certs/ca-bundle.crt` (Fedora/RHEL), or whatever OpenSSL is configured to use. .NET's `HttpClient` honors these by default — we do nothing special.
- **Per-process additional CA bundle** — `appsettings` `Network:AdditionalCaBundle = "<path>"` or env `AIO_CA_BUNDLE`. The bundle is appended to (never replaces) the system store.
- **`SSL_CERT_FILE` / `SSL_CERT_DIR`** — honored for OpenSSL-using subprocesses (`git`, `gh`, `claude`). The daemon also propagates `AIO_CA_BUNDLE` into spawned processes' env via the redacted `IProcessLifecycle` env builder.
- **Pinning override per host** — `appsettings` `Network:CertificatePinning:<host>` accepts a SHA-256 of the leaf cert; absent means OS validation only. Mismatch is a hard fail with `CertificatePinFailed`.

### 3.14.4 Diagnostics

- `ai-orchestrator network probe <url>` — issues a live request to the URL respecting all the above settings, prints the resolved proxy chain, the cert chain (with which root anchored it), and timing.
- Network-category bus events: `ProxyResolved`, `ProxyAuthRequired`, `CertificateChainValidated`, `CertificatePinFailed`, `TlsHandshakeFailed`.

### 3.14.5 What we do **not** do

- We do not bundle our own CA trust store. The OS store is always the source of truth.
- We do not silently bypass cert validation. There is no `Network:InsecureSkipVerify` flag — users who need to terminate at a transparent MITM proxy must add the proxy's CA to the system store or `AdditionalCaBundle`.

---

## 3.15 Multi-Repo, Submodule & Long-Path Support

The design implicitly assumes one repo per workspace, ASCII paths under 260 chars. Real workspaces violate both routinely.

### 3.15.1 The repo-scope model

A daemon instance serves one or more **workspace roots**. Each workspace root is the closest ancestor directory containing either:

- A `.git/` directory (single repo workspace), or
- A `.aio/workspace.json` declaring multiple repos (multi-repo workspace).

```jsonc
// .aio/workspace.json — committed to whichever directory hosts the multi-repo workspace
{
  "schemaVersion": 1,
  "repos": [
    { "id": "frontend",  "path": "apps/frontend",  "primary": true  },
    { "id": "backend",   "path": "apps/backend"                    },
    { "id": "shared",    "path": "libs/shared"                     }
  ]
}
```

Plans declare which repo their jobs target via `JobSpec.RepoId` (M2-additive). A job without `RepoId` uses the workspace's `primary` repo (or the only repo if there is just one). Worktrees are created against the relevant repo's `.git`; `IGitOperations` accepts a `RepoRef` on every method (additive minor bump on `Abstractions`).

### 3.15.2 Where state lives in a multi-repo workspace

- `<workspace>/.aio/` — single tree at the workspace root holds `plans/`, `events/`, `leases/`, `appsettings.json`, etc. Daemon state is workspace-scoped, not per-repo, so a plan that fans out across all three repos is a single coherent unit.
- Each repo's `.git/` is touched only for git operations; no daemon state is written into a repo's `.git/` unless the user explicitly opts in via `RepoId.AllowGitInternalState = true` (rare; reserved for single-repo-workspace back-compat).

### 3.15.3 Submodules

Submodules are **opt-in** — the daemon does not recurse into them by default. When a job spec sets `IncludeSubmodules: true`:

- `git worktree add` is followed by `git submodule update --init --recursive` (CLI fallback per §3.3 — libgit2sharp's submodule story is incomplete).
- `IGitWorktrees.Remove` runs `git submodule deinit --force --all` first.
- Each submodule remote is resolved through `IRemoteIdentityResolver` (§3.3.1) independently — submodules frequently live on different hosts than the parent.

Failures during submodule init are surfaced as `SubmoduleInitFailed { submodulePath, exitCode }` and treated as a job failure unless the spec has `SubmoduleInitFailureIsFatal: false`.

### 3.15.4 Long-path support (Windows)

The branch refs `aio/<plan8>/<job8>/<attempt>` and worktree paths under deep workspace roots routinely exceed 260 characters. The daemon:

- Sets the executable manifest opt-in `<longPathAware>true</longPathAware>` so `MAX_PATH` is no longer enforced for native APIs from .NET.
- Uses `\\?\`-prefixed paths internally for any filesystem op outside `Path.Combine`-safe territory; the prefix is stripped before any path is logged or serialized.
- Verifies that `git config --global core.longpaths` is `true` at startup; if not, emits one `WindowsLongPathsNotEnabled` warning and a fix-up command suggestion (the user must opt in — we do not silently mutate global git config).

### 3.15.5 Unicode paths and refs

- Paths anywhere in the orchestrator's IO surface are UTF-8 and round-trip cleanly through `System.IO`. No platform-specific narrowing.
- Branch refs are restricted to ASCII `[a-z0-9/-]` per `git check-ref-format` plus the `aio/` prefix. The 8-char hex IDs in `aio/<plan8>/<job8>/<attempt>` are derived from the `PlanId`/`JobId` GUIDs (first 8 hex chars) — never from user input — so user-supplied Unicode in plan names cannot poison ref names.
- Display names (plan titles, job tasks) are full Unicode; the bus events carry them as-is and the UX surfaces handle rendering.

### 3.15.6 Per-volume isolation

Worktrees are placed under the daemon's `WorktreeRoot` setting (default `<workspace>/.aio/.ps/worktrees/`); the daemon refuses to operate across volumes (different `Path.GetPathRoot`) unless `Workspace:AllowCrossVolume = true`, because cross-volume `git worktree` operations are slow and break some libgit2 paths. The check is at `IWorktreeManager.AcquireAsync` and emits `CrossVolumeWorktreeRefused` when triggered.

---

## 3.16 DAG Limits, Validation & Subscriber Backpressure

A 10K-job plan with undetected cycles, or 100 subscribers pulling at very different rates, hangs the daemon today. The TS implementation has had subtle bugs in both areas.

### 3.16.1 DAG static limits

Enforced by `IDagAnalyzer.Validate` at `Finalize` time and re-checked on every `Reshape`:

| Limit | Default | Why |
|---|---|---|
| Max jobs per plan | 1024 | Beyond this, scheduling overhead and UX rendering both degrade nonlinearly. |
| Max edges per plan | 8192 | Adjacency dominates `quota.mmf` lookup cost when this grows. |
| Max depth (longest path) | 64 | Depth × per-job-overhead is the lower-bound wall-clock for the plan; deeper plans signal a likely modeling mistake. |
| Max fan-out from any one job | 64 | Wider fan-out is almost always a generated-graph bug. |
| Max in-degree for any one job | 32 | Same. |

Limits are configurable under `Plan:Limits:*`. Exceeding any one is a `Finalize`-time failure with `PlanLimitExceeded { limit, actual }`. The CLI `ai-orchestrator plan analyze <planId>` runs the analyzer offline against an in-memory plan spec.

### 3.16.2 Cycle detection

`IDagAnalyzer.DetectCycles` runs during `Finalize` and after every `Reshape` operation. Implementation is iterative DFS (avoiding stack overflow on the maximum 1024-job graph). Cycles are reported as ordered job lists in `PlanCycleDetected { cycle: [jobIds...] }` so the user can act.

### 3.16.3 Subscriber backpressure & lag detection

§3.4.2 introduced `OverflowStrategy.DropOldest` but did not say what happens for slow subscribers. The full policy:

| Subscriber state | Symptom | Action | Event |
|---|---|---|---|
| Healthy | Channel drain rate ≥ publish rate | None | none |
| Lagging | > 50% of `MaxBufferedEvents` for > 1 s | One `SubscriberLagging` event per subscriber per minute | `SubscriberLagging { subscriberId, bufferUtilization }` |
| Dropping (DropOldest) | Buffer full, oldest events being evicted | One `SubscriberLagged { droppedSinceLast, sinceSeq }` per second | `SubscriberLagged` |
| Dropping (DropNewest) | Buffer full, new events ignored | Same shape, `kind = DropNewest` | `SubscriberLagged` |
| Stalled | Buffer full for > `StallTimeout` (default 30 s) | The subscription is **forcibly terminated** with `SubscriberStalled` and the consumer's `IAsyncEnumerator` throws `SubscriberStalledException` on next move-next | `SubscriberStalled { subscriberId, lastSeq }` |

A stalled subscriber must reconnect with `ReplayFromSequence` to catch up. **Stalled subscribers never block the bus** for healthy subscribers — that is the entire point of per-subscriber bounded channels.

### 3.16.4 Per-session subscription quotas

A buggy MCP client could subscribe to 100 streams. Per-session caps:

| Cap | Default | Configuration |
|---|---|---|
| Max concurrent subscriptions per session | 16 | `Bus:Session:MaxSubscriptions` |
| Max in-flight RPCs per session | 32 | `Rpc:Session:MaxInFlight` |
| Max queued events per subscriber | 1024 | `Bus:Subscription:MaxBufferedEvents` (per-call override allowed up to a hard ceiling of 65 536) |
| Max subscription lifetime without activity | 1 h | `Bus:Session:IdleSubscriptionTimeout` |

Quota exhaustion returns a typed `RpcError { code: QuotaExceeded, kind }` and emits `SessionQuotaExceeded` for operator visibility.

### 3.16.5 Wire-protocol negotiation

The named-pipe / MCP RPC surface itself is versioned (separate from the event-schema versioning of §3.4.5). Every connection begins with a `negotiate` exchange:

```jsonc
// client → server
{ "method": "negotiate", "params": {
    "clientName": "vscode-extension",
    "clientVersion": "1.7.0",
    "supportedRpcMethods": ["plan.create", "plan.list", ...],
    "rpcProtocolVersion": 2
}}
// server → client
{ "result": {
    "serverName": "ai-orchestratord",
    "serverVersion": "1.4.2",
    "supportedRpcMethods": [...],   // intersection-friendly
    "rpcProtocolVersion": 2,
    "agreedProtocolVersion": 2
}}
```

Either side can call methods only in the **intersection** of `supportedRpcMethods`. Calling a method outside the intersection returns `RpcError { code: MethodNotSupported }`. Adding a new RPC method is a minor bump to `rpcProtocolVersion`; removing one is major. This mirrors the §3.4.5 event-schema rules and uses the same EV1/EV2-style discipline.

---

## 3.17 RPC & MCP Error Contracts

Today the TS MCP surface returns errors as ad-hoc strings — UX clients parse them with regex. The .NET design defines a single error envelope shared across the named-pipe RPC surface, the MCP transport, and the N-API binding so every consumer can reliably make retry/backoff decisions.

### 3.17.1 The envelope

```csharp
public sealed record RpcError
{
    public required RpcErrorCode Code { get; init; }     // closed enum, invariant English string at the wire
    public required string       Kind { get; init; }     // dotted, invariant English (e.g., "plan.not-found")
    public required string       Message { get; init; }  // localized per L5; safe to display to humans
    public string?               TraceId { get; init; }
    public RpcRetryability       Retryability { get; init; } = RpcRetryability.NotRetryable;
    public TimeSpan?             RetryAfter { get; init; }
    public IReadOnlyDictionary<string, JsonElement> Data { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}

public enum RpcErrorCode
{
    InvalidArgument,
    NotFound,
    AlreadyExists,
    FailedPrecondition,    // state machine rejection (e.g., resume a succeeded plan)
    PermissionDenied,
    QuotaExceeded,         // §3.16.4
    Unavailable,           // transient — caller should retry
    DeadlineExceeded,
    Aborted,               // optimistic-concurrency conflict
    Internal,              // bug; includes TraceId for correlation
    Unimplemented,         // method not in negotiated intersection (§3.16.5)
    Cancelled
}

public enum RpcRetryability { NotRetryable, RetryableAfterDelay, IdempotentSafeToRetry }
```

`Kind` is the granular discriminator (`plan.not-found`, `worktree.acquire.permission-denied`, `agent.cli.not-installed`, …); `Code` is the coarse class. UX uses `Code` for retry policy, `Kind` for branching. Both are invariant English; `Message` is localized.

### 3.17.2 MCP mapping

The MCP `tools/call` response wraps `RpcError` as JSON-RPC 2.0 error:

```jsonc
{
  "jsonrpc": "2.0",
  "id": "...",
  "error": {
    "code": -32001,                              // MCP "tool error" range
    "message": "Plan 1234abcd not found.",      // RpcError.Message (localized)
    "data": {
      "rpcCode": "NotFound",                    // RpcError.Code as string
      "rpcKind": "plan.not-found",              // RpcError.Kind
      "retryability": "NotRetryable",
      "traceId": "01JXX..."
    }
  }
}
```

MCP clients that don't understand `data.rpcCode` still get a sensible `message`; clients that do understand it get full programmatic control. The MCP `tools/list` `description` field documents the error shape for every tool.

### 3.17.3 Exception → envelope mapping

Internally the daemon throws strongly-typed exceptions (`PlanNotFoundException`, `WorktreeAcquireException`, …); a single `IRpcExceptionMapper` converts them to `RpcError` at the transport edge. The mapper is the **only** code that builds an `RpcError` from an exception — analyzer **`OE0030`** flags any other site. This guarantees consistency across pipe, MCP, and N-API.

### 3.17.4 Error events

Every emitted `RpcError` is also published as an `RpcErrorEmitted { code, kind, sessionId, methodName }` bus event (Diagnostics category) — invariant English, no `Message` — so operators can correlate UX-visible errors with logs and traces.

---

## 3.18 Time, Clock & Skew Discipline

Plans schedule, time out, age in queues, and emit timestamps for every event. Reading the wall clock directly leaks bugs: every developer who has chased a "test fails on Tuesday" knows why. The .NET design uses two distinct clocks for two distinct purposes.

### 3.18.1 The two clocks

```csharp
public interface IClock
{
    /// <summary>Wall-clock time in UTC. Use for timestamps stored on disk, sent to humans, or correlated across hosts.</summary>
    DateTimeOffset UtcNow { get; }

    /// <summary>Monotonic timestamp in ticks. Use for measuring elapsed time, timeouts, and ordering inside one process.</summary>
    long MonotonicTicks { get; }

    /// <summary>Conversion: how many monotonic ticks per second.</summary>
    long MonotonicTicksPerSecond { get; }
}
```

**Rules** enforced by analyzer **`OE0031`**:

- `DateTime.UtcNow`, `DateTimeOffset.UtcNow`, `Environment.TickCount`, `Stopwatch.GetTimestamp` are forbidden outside `AiOrchestrator.Time`. All callers go through `IClock`.
- Timeouts and elapsed-time measurements use `MonotonicTicks` *only* — never wall-clock subtraction. This makes the daemon immune to wall-clock jumps (NTP step, manual clock change, sleep/resume).
- On-disk and on-wire timestamps use `UtcNow` *only* — monotonic ticks are process-local and meaningless across processes.

### 3.18.2 Skew detection

A background `ClockSkewWatcher` polls both clocks every 5 s and computes the drift between consecutive `UtcNow` deltas and `MonotonicTicks` deltas. A divergence > 1 s is reported as `WallClockJumpDetected { delta, direction, suspectedCause: NtpStep | ManualSet | Suspend | Unknown }`. Suspended/resumed daemons (laptop sleep) are detected as a positive jump and trigger:

- A re-read of the `quota.mmf` daemon table to detect timeouts that fired during sleep (§3.9.7).
- Re-evaluation of every `IAsyncJobLease`'s overall timeout against monotonic time (the wall-clock timeout itself is not used for cancellation).
- One `DaemonResumedFromSuspend { suspendedFor }` event for UX.

Negative wall-clock jumps (clock set back) never break correctness because no logic depends on wall-clock subtraction; they are only logged.

### 3.18.3 Test substitution

`FakeClock : IClock` lets tests advance both clocks independently. Tests for timeout behavior advance `MonotonicTicks` only, leaving `UtcNow` static (proves wall-clock independence). Tests for clock-skew detection advance them inconsistently to drive the watcher's transitions. Standard fixture in `AiOrchestrator.TestHarness`.

---

## 3.19 Path Security & Filesystem Hardening

§5.1 mentions path-traversal validation. Validation alone is not enough — there's a TOCTOU window between "validate path" and "open file" during which a symlink swap can redirect the open. Several real CVEs in similar tools have followed this exact pattern.

### 3.19.1 Open-by-handle for security-critical paths

Any path that is (a) under user control and (b) used for a read/write that determines security outcomes (worktree root, plan state file, log file) is opened via `IPathValidator.OpenScopedAsync`:

```csharp
public interface IPathValidator
{
    /// <summary>
    /// Open a file or directory under <paramref name="scopeRoot"/>. Resolves symlinks atomically with the open
    /// (Linux: O_NOFOLLOW + openat traversal; Windows: FILE_FLAG_OPEN_REPARSE_POINT + handle-based parent
    /// traversal). Throws PathEscapesScopeException if any component, after symlink resolution, leaves the scope.
    /// </summary>
    ValueTask<SafeFileHandle> OpenScopedAsync(OpenScopedRequest request, CancellationToken ct);
}

public sealed record OpenScopedRequest
{
    public required string             ScopeRoot   { get; init; }
    public required string             Relative    { get; init; } // must be relative; absolute is rejected
    public required FileAccess         Access      { get; init; }
    public required FileMode           Mode        { get; init; }
    public FileShare                   Share       { get; init; } = FileShare.None;
    public bool                        AllowSymlink { get; init; } = false; // if false, refuses symlink-target opens
}
```

The implementation walks `Relative` component-by-component, opening each parent with `O_NOFOLLOW`/`FILE_FLAG_OPEN_REPARSE_POINT` and then opening the next child by handle (`openat`/`NtOpenFile` relative to the parent handle). At no point is a string-form path passed to a kernel call that follows symlinks; the TOCTOU window is closed by construction.

### 3.19.2 Where it must be used

Mandatory for: worktree root traversal in `IWorktreeManager`, plan-state read/write in `IPlanRepository`, log-file open in `IProcessLifecycle`, user-supplied `cwd` validation in `IAgentRunner`, plugin folder traversal in §3.10.

Optional for: telemetry queue, log file sinks, anything under `<dataDir>` not derived from user input — those use ordinary `FileStream` with explicit `<dataDir>` prefix checks.

Analyzer **`OE0032`** flags any `File.Open*` / `FileStream` ctor with a path argument that wasn't produced by `IPathValidator` in any file under `src/dotnet/AiOrchestrator.{Plan,Git,Agents,Hosting,Mcp}/**`. Exemptions require `[FilesystemPathReviewed("reason")]`.

### 3.19.3 Anti-virus & file-share friendliness

On Windows, AV scanners briefly hold open files just-written, causing `IOException: The process cannot access the file because it is being used by another process` on the next operation. The validator and `IFileSystem` writers retry on `ERROR_SHARING_VIOLATION` with the schedule 50 ms × 3, then 500 ms × 3, then fail. Each retry emits a `FileShareViolationRetried` debug event (not a warning — they're routine).

`ai-orchestrator daemon doctor` includes an "AV exclusion check" that walks `<dataDir>` and the workspace's `.aio/` and probes for known-slow AV behaviors (bulk-write of 1000 small files, time the open-after-close); a slow result generates an `AVInterferenceSuspected` advisory and a recommended exclusion list (without the daemon ever attempting to mutate AV settings itself).

---

## 3.20 Plan Import / Export & Cross-Machine Portability

Sharing a plan for debugging or moving work across machines is currently impossible — state lives in absolute paths under one workspace. The .NET design adds first-class portability.

### 3.20.1 Export

```csharp
public interface IPlanPortability
{
    Task<ExportResult> ExportAsync(ExportRequest request, CancellationToken ct);
    Task<ImportResult> ImportAsync(ImportRequest request, CancellationToken ct);
}

public sealed record ExportRequest
{
    public required PlanId            PlanId         { get; init; }
    public required string            DestinationPath { get; init; } // .aio-plan tarball
    public ExportContents             Contents       { get; init; } = ExportContents.StateAndEvents;
    public bool                       IncludeLogs    { get; init; } = false; // size guard
    public bool                       IncludeWorktrees { get; init; } = false; // includes preserved-on-failure trees
    public RedactionPolicy            Redaction      { get; init; } = RedactionPolicy.Standard;
}

[Flags]
public enum ExportContents
{
    StateOnly         = 1,
    StateAndEvents    = 3,
    Full              = StateAndEvents | 4 // + plugin manifests + appsettings snapshot
}
```

The exported tarball (`.aio-plan` extension, ordinary `.tar.zst`) contains:

- `manifest.json` — schemaVersion, plan id, source machine fingerprint (hashed), source workspace path (redacted by default), export timestamp, redaction policy applied.
- `plan.json` — the plan instance state (paths replaced with `${WORKSPACE}` placeholders).
- `events/` — T2 segments for the plan, copied verbatim.
- `logs/` (optional) — per-job logs, redacted.
- `plugins/` (optional) — `plugin.json` files only (never the binaries — recipient must install them separately).
- `appsettings.snapshot.json` (optional) — relevant config sections, redacted.

### 3.20.2 Import

```csharp
public sealed record ImportRequest
{
    public required string SourcePath          { get; init; }
    public required string TargetWorkspaceRoot { get; init; }
    public ImportConflictPolicy Conflict       { get; init; } = ImportConflictPolicy.Refuse;
    public bool RewriteAsNewPlanId             { get; init; } = true; // safer default
}
public enum ImportConflictPolicy { Refuse, OverwriteExisting, RewriteAsNewPlanId }
```

Import:

1. Verifies the manifest schema and runs the migrators (§3.11.2) up to the current daemon's version.
2. Refuses to import a plan whose `compat.abstractions`/`compat.models` ranges do not include the current daemon's contract versions (the export records both at export time).
3. Substitutes `${WORKSPACE}` placeholders with `TargetWorkspaceRoot`.
4. Refuses to import worktrees whose base commit is not present in any repo under the target workspace, unless the user passes `--allow-missing-base`.
5. The plan lands in `paused` state regardless of source state — the user must inspect and explicitly resume.

### 3.20.3 CLI

- `ai-orchestrator plan export <planId> --out plan.aio-plan [--include-logs]`
- `ai-orchestrator plan import plan.aio-plan [--rewrite-id]`
- `ai-orchestrator plan inspect plan.aio-plan` — read-only view of contents without importing.

The diagnostic bundle (§3.13.4) is *not* a plan export — it's broader (multiple plans, system state) and not designed for re-import. Both formats coexist.

---

## 3.21 Runtime Tuning & GC Configuration

Default .NET runtime settings are tuned for short-lived ASP.NET workloads. The daemon is long-running with bursty allocation patterns (event records, line buffers); explicit tuning is required.

### 3.21.1 Settings shipped in `runtimeconfig.template.json`

```jsonc
{
  "configProperties": {
    "System.GC.Server":                   true,
    "System.GC.Concurrent":               true,
    "System.GC.RetainVM":                 true,
    "System.GC.DynamicAdaptationMode":    1,           // DATAS — adaptive heap sizing for memory-constrained hosts
    "System.Threading.ThreadPool.MinThreads": 8,
    "System.Globalization.Invariant":     true,        // see §2.4 for satellite handling
    "System.Net.SocketsHttpHandler.Http2Support": true
  }
}
```

The CLI (`ai-orchestrator`) ships with `System.GC.Server = false` (workstation GC) — invocations are short and workstation GC has lower latency for one-shot processes.

### 3.21.2 Memory budget reporting

A `RuntimeHealthMonitor` background service publishes `RuntimeHealthSnapshot` every 30 s with `gen0|gen1|gen2|loh|poh` heap sizes, working set, thread count, pinned-object count. Sustained gen2 heap > `Runtime:HeapBudgetBytes` (default 512 MiB) for > 5 min triggers `MemoryBudgetExceeded` with a recommendation to investigate (the daemon does not auto-restart; that's the supervisor's job).

### 3.21.3 AOT escape hatches

Trim-safe code is enforced by `OE0012` (§4 trimming) and the public-API analyzers. For the rare case where reflection is unavoidable (legacy MSBuild integration), `[RequiresUnreferencedCode]` is required and the symbol must be in a small allowlist file maintained at `src/dotnet/aot-allowlist.txt`. Adding to the list requires a documented justification in the PR.

---

## 3.22 Per-Session Resource Quotas

§3.16.4 introduced per-session subscription/RPC caps. Memory and CPU also need ceilings to prevent one runaway client from exhausting the daemon.

| Quota | Default | Configuration | Behavior on exceed |
|---|---|---|---|
| Buffered event bytes per subscription | 16 MiB | `Bus:Subscription:MaxBufferedBytes` | Same path as buffered count: lag → drop → stall. |
| Outstanding `IAsyncEnumerable` results across all RPCs per session | 8 | `Rpc:Session:MaxOutstandingStreams` | New stream returns `QuotaExceeded`. |
| Plan reshape ops per session per minute | 60 | `Rpc:Session:ReshapeRate` | Rate-limited; excess returns `ResourceExhausted` with `RetryAfter`. |
| Audit-log write rate per session | 100/s | `Audit:Session:MaxRate` | Excess events dropped with `AuditDropped` (the audit log itself records the drop). |

Quotas are tracked by the same `ISessionResourceTracker` that issues sessionIds at connect time. Disconnect releases everything.

---

## 3.23 Accessibility, CLI Completions & Developer UX

### 3.23.1 Shell completions

`System.CommandLine` generates completion scripts for bash, zsh, fish, and PowerShell. Shipped via:

- `ai-orchestrator completion bash` / `... zsh` / `... fish` / `... powershell` — prints the completion script to stdout for the user to source.
- The `dotnet tool` package post-install hook prints a one-line setup tip per detected shell.
- The Homebrew formula installs the bash/zsh completions automatically into the standard locations.

Completions are aware of dynamic state where useful: `plan resume <TAB>` enumerates paused plans; `job retry <plan> <TAB>` enumerates failed jobs. Dynamic completion calls the running daemon when one exists; when no daemon is running it falls back to static command-name completion only (no expensive cold start just for tab-complete).

### 3.23.2 Accessibility for UX surfaces

The VS Code panels (sidebar, plan detail, job detail, status bar) are bound by:

- All interactive elements have `aria-label`s sourced from the `package.nls.json` translations (§2.4).
- Color is never the sole signal — every color-coded state (running/succeeded/failed/blocked) is paired with an icon and a text label. The icon set is color-blind-safe (chosen via the Okabe-Ito palette).
- The webviews handle keyboard navigation: arrow keys move focus through the DAG visualization, Enter activates a job, Esc closes panels.
- The status bar item exposes its text and icon to screen readers.
- The CLI human-readable output respects `NO_COLOR` and `--no-color`; the JSON output mode is the recommended default for screen-reader users (`--output json` puts each event on its own line).

These are tested in CI via `axe-core` (webviews) and a small VS Code integration test that drives every panel by keyboard only.

---

## 3.24 CI/CD Pipeline, Release Coordination & Documentation Hosting

The doc has scattered references to "CI runs X" but no end-to-end pipeline. This section is the source of truth for *which workflow builds which artifact, in what order, with what gates*, and *how those artifacts are released into the world*. Without it the execution DAG has nowhere to attach publish leaves.

### 3.24.1 GitHub Actions workflow topology

Five workflows; each has a single, clear responsibility. They live under `.github/workflows/`:

| Workflow | Trigger | Purpose | Outputs |
|---|---|---|---|
| `pr-validate.yml` | `pull_request` | Fast feedback for PRs: build, lint, unit tests, analyzer/PublicAPI gates, OWASP/CodeQL scan, license-compliance scan, pseudo-locale run (§2.4.4). | PR check status; coverage report comment. |
| `nightly-broad.yml` | cron `0 7 * * *` UTC + `workflow_dispatch` | Full matrix: 6 RIDs × .NET 10 SDK pinned + ceiling × Models/Abstractions skew matrix (§3.1.0.4) × pseudo-locale × `qps-Ploc`. Integration tests, plugin-conformance pack, perf benchmarks (§3.24.5). | Test reports archived 90 days; perf trend artifact. |
| `release-build.yml` | tag `v*.*.*` | Builds **all** shippable artifacts deterministically on a clean runner, then re-builds them on a *second* runner and verifies SHA-256 parity (§2.3.3). Signs everything. Publishes nothing — produces immutable artifact bundle. | Signed `.nupkg` (libraries + tools), single-file binaries (6 RIDs × 3 tools), N-API native modules (6 RIDs), `.vsix`, `.aio-plan`-format example bundles. |
| `release-publish.yml` | `workflow_dispatch` consuming `release-build.yml` artifacts | Sequenced fan-out (§3.24.3). | Published packages on NuGet, npm, GitHub Releases, VS Marketplace, OpenVSX. |
| `docs-publish.yml` | push to `main` (docs paths) + tag `v*.*.*` | Builds DocFX site (§3.24.6), publishes to GitHub Pages with versioned subpath. | `https://<owner>.github.io/<repo>/v<X.Y>/`. |

**Rules** the workflows enforce, encoded in shared composite actions:

- Every workflow runs `actions/setup-dotnet@vN` with the SDK version pinned to a single line in `global.json`. No matrix-of-SDKs except for the explicit floor/ceiling skew runs.
- The reproducible-build verification step always runs in `release-build.yml` and fails the workflow on a hash mismatch — never skipped, never overridable.
- Artifact upload uses `actions/upload-artifact@v4` with `if-no-files-found: error` on every step that should produce output.
- All workflow steps that consume secrets pin their action versions by full SHA, not tag (per OWASP A06).

### 3.24.2 Build matrix dimensions

The full matrix is the Cartesian product of:

- **RIDs (6)**: `linux-x64`, `linux-arm64`, `osx-x64`, `osx-arm64`, `win-x64`, `win-arm64`.
- **Tools (3)**: `ai-orchestratord`, `ai-orchestrator`, `ai-orchestrator-mcp` — each as a self-contained single-file binary per RID.
- **Contract packages (2)**: `AiOrchestrator.Models`, `AiOrchestrator.Abstractions` — RID-independent NuGet packages.
- **N-API native module (1)**: `AiOrchestrator.Bindings.Node` — built per RID, packed into one `@ai-orchestrator/native` npm package with prebuilds.
- **VSIX (1)**: bundles host-RID daemon + MCP binary + N-API native; the other RIDs are downloaded on first use (§2.2).

Total artifact count per release: 6 RIDs × 3 tools (= 18 binaries) + 6 RID-specific N-API prebuilds + (`Models` + `Abstractions` + ~10 internal libs) NuGet packages + 1 npm tarball + 1 VSIX = **~38 artifacts**. Every one is hashed, signed where applicable, and listed in the release manifest (§3.24.4).

Each row in the matrix runs in its native runner: `ubuntu-latest` for linux-x64, `ubuntu-24.04-arm` for linux-arm64, `macos-13` for osx-x64, `macos-14` for osx-arm64, `windows-latest` for win-x64, `windows-11-arm` for win-arm64. **No emulation** (no QEMU cross-build) — the perf and reproducibility cost is not worth saving runner-cost.

### 3.24.3 Release publish sequence

`release-publish.yml` is strictly sequenced because consumers depend on each other. A failure at any step halts the rest and surfaces a `ReleaseSequenceHalted { step }` GitHub-status event so the operator can resume after fixing.

```mermaid
flowchart TD
    A[Verify release-build artifacts present] --> B[Push contract NuGets: Models then Abstractions]
    B --> C[Wait for nuget.org propagation - poll search API]
    C --> D[Push internal NuGets: Core, Git, Agents, etc.]
    D --> E[Push CLI tool NuGets: AiOrchestrator.Cli, .Mcp.Stdio]
    E --> F[Publish npm: @ai-orchestrator/native with prebuilds]
    F --> G[Publish GitHub Release with single-file binaries + checksums]
    G --> H[Publish VS Marketplace VSIX]
    H --> I[Publish OpenVSX VSIX]
    I --> J[Publish DocFX site for the new version]
    J --> K[Update 'latest' alias on docs site]
    K --> L[Post release announcement]
```

Steps B–E observe the **two contract packages must reach nuget.org before any package that depends on them**. Steps G–I are end-user touchpoints and are deliberately last so a user who installs from any channel sees a complete, internally-consistent release.

### 3.24.4 Release manifest

Every release writes `release-manifest.json` to the GitHub Release. Schema-versioned, machine-readable, never edited by hand:

```jsonc
{
  "schemaVersion": 1,
  "version": { "models": "1.4.2", "abstractions": "1.2.0", "daemon": "1.7.3", "cli": "1.7.3", "mcp": "1.7.3", "vsix": "1.7.3", "binding": "1.7.3" },
  "commit": "<full SHA>",
  "buildSdk": "10.0.100",
  "artifacts": [
    { "name": "ai-orchestratord-linux-x64", "sha256": "...", "sigUrl": "...", "size": 28475392 },
    // ...
  ],
  "compat": {
    "modelsRange": ">=1.0.0 <2.0.0",
    "abstractionsRange": ">=1.0.0 <2.0.0",
    "rpcProtocolVersion": 2
  },
  "signedAt": "2026-04-20T12:00:00Z"
}
```

The manifest is what `ai-orchestrator daemon update` (§3.31), the VSIX download-on-first-use flow (§2.2), and the plugin loader (§3.10) consult to verify they are pulling consistent artifacts.

### 3.24.5 Performance benchmarks in CI

`nightly-broad.yml` runs a `BenchmarkDotNet` suite (`AiOrchestrator.Benchmarks`) against the SLOs in §3.27.1. Results are committed to a `benchmarks/` branch as JSON with one file per benchmark; a small dashboard in the docs site (§3.24.6) renders trend graphs over time. A regression of > 25 % from the prior 7-day rolling median on any tracked metric fails the nightly and pings the release manager — no release tagging while a perf regression is unresolved.

### 3.24.6 Documentation site (DocFX on GitHub Pages)

XML doc files ship inside the NuGet packages (§2.3.1) but users want browsable docs. The doc site is built by DocFX (`docfx.json` at repo root), deployed to `https://<owner>.github.io/<repo>/`. Layout:

- `/latest/` — alias to the most recent stable version.
- `/v<X.Y>/` — every minor release gets its own immutable subpath.
- `/preview/` — built from `main` on every push.

DocFX inputs:

- The XML doc files from `dotnet build` of every `AiOrchestrator.*` package.
- Conceptual docs from `docs/**/*.md` (this design doc, ARCHITECTURE.md, DI_GUIDE.md, etc.) — same source files we already maintain.
- Mermaid diagrams render server-side.

Search is provided by DocFX's built-in client-side index (no external dependency, no telemetry leak).

### 3.24.7 SBOM, license scanning, supply-chain attestation

Every NuGet package and every single-file binary ships with:

- **CycloneDX SBOM** (`*.cdx.json`) generated by `dotnet CycloneDX` and packed alongside the artifact.
- **License scan** via `dotnet tool nuget-license` — fails the build if any transitive dependency carries a non-allowlisted SPDX identifier (allowlist: `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `MS-PL`, `0BSD`, `Unlicense`).
- **SLSA provenance** — `actions/attest-build-provenance` produces an attestation per artifact, queryable via `gh attestation verify`.
- **NuGet author signature** — already covered (§2.3.3).

Consumers can reconstruct the dependency tree, verify licenses, and prove which CI run produced which `.nupkg`/`.dll`/`.vsix` SHA, with no extra tooling beyond `gh` + `dotnet`.

---

## 3.25 Migration from the TypeScript Implementation

The .NET daemon and the TS extension will coexist for at least one release. Users who already have plan history under `.aio/.ps/` from the TS extension — including paused, running, or failed plans they want to resume — need a defined, testable, executable migration path. This section specifies the **converter** that takes any TS-era plan and produces an equivalent .NET-era plan that the daemon can resume, retry, reshape, or roll back as if it had been created natively.

### 3.25.1 Migration component layout

The converter is its own assembly so it can be unit-tested without dragging in the daemon and so it can be deleted in a future major release without touching `Core`:

```
src/dotnet/
├── AiOrchestrator.Migration.TypeScript/        # The converter library + ITsPlanReader / ITsEventLogReader
├── AiOrchestrator.Migration.TypeScript.Tests/  # Schema fixtures (one per TS minor) + converter tests
└── AiOrchestrator.Cli/                         # Hosts `ai-orchestrator migrate ts` subcommand
```

Public surface (lives in `AiOrchestrator.Migration.TypeScript`, **not** in `Abstractions` — the converter is an internal tool, not an extension point):

```csharp
public interface ITsMigrationService
{
    /// <summary>Scan a workspace and report what would be migrated. Pure read; no writes.</summary>
    Task<TsMigrationPlanResult> PlanAsync(TsMigrationPlanRequest request, CancellationToken ct);

    /// <summary>Execute a previously-planned migration. Idempotent: safe to re-run on a partial result.</summary>
    Task<TsMigrationExecuteResult> ExecuteAsync(TsMigrationExecuteRequest request, CancellationToken ct);
}

public sealed record TsMigrationPlanRequest
{
    public required string WorkspaceRoot { get; init; }
    public TsMigrationMode Mode { get; init; } = TsMigrationMode.Convert;   // Convert | ArchiveOnly | DryRun
    public IReadOnlyList<PlanId>? OnlyPlans { get; init; }                  // null ⇒ all
    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}

public sealed record TsMigrationPlanResult
{
    public required IReadOnlyList<TsPlanInspection> Plans { get; init; }
    public required TsMigrationDiagnostics Diagnostics { get; init; }
}

public sealed record TsPlanInspection
{
    public required PlanId PlanId { get; init; }
    public required string TsLayoutVersion { get; init; }                   // detected from on-disk markers
    public required PlanLifecycleState TsState { get; init; }               // running | paused | succeeded | failed | canceled
    public required int JobCount { get; init; }
    public required int RunningJobCount { get; init; }                     // > 0 ⇒ requires special handling, see §3.25.4
    public required IReadOnlyList<TsConverterFinding> Findings { get; init; } // per-record diagnostic, e.g., dropped fields
    public required ConversionVerdict Verdict { get; init; }                // Convertible | ConvertibleWithLoss | ArchiveOnly | Refuse
}
```

`TsMigrationMode`:

- **`Convert`** (default for `migrate ts`) — produce a fully-executable .NET plan tree.
- **`ArchiveOnly`** — fall back to the read-only archival policy for plans the converter refuses (detached HEADs, corrupted `events.jsonl`, schemas older than the supported floor — see §3.25.7).
- **`DryRun`** — write nothing; emit the plan + findings as JSON for operator review.

### 3.25.2 What the converter actually translates

The TS schema and the .NET schema drift in known, enumerable places. The converter has a **field-by-field translation table** (codified as code, not docs) for every record. Each row is exercised by a fixture-based test (§3.25.6).

| TS shape | .NET shape | Translation rule |
|---|---|---|
| `plan.json` (TS) — flat object, no `schemaVersion` at root | `plan.json` (NET) — `schemaVersion: 1`, nested `lifecycle`, `topology`, `metadata` | Lift fields into the new sub-objects; default missing optional fields. |
| `events.jsonl` — line-delimited NDJSON with TS event names (`PlanScaffolded`, `JobStarted`, …) | T2 segment files (§3.11) — sealed-record event subtypes | Map each event by name → corresponding .NET event subtype; preserve `Sequence` (renumber if gaps). Events without a .NET equivalent become `LegacyTsEvent { name, payload }` records (a new event subtype, M2-additive on the converter's recognized version of `Models`). |
| Per-job `meta.json` with `attempts: [...]` | `attempts/<n>.json` per attempt under the job directory | Split the array into per-file records; preserve attempt numbering. |
| `worktrees/` directory + in-memory leak map | `.aio/.ps/leases/<leaseId>.json` lease registry | For each live worktree at conversion time: write a synthetic lease entry tagged `origin: "migrated-from-ts"`. |
| Branch refs `aio/p/<planId>/<jobId>` (TS naming) | Same convention (preserved) | No-op; .NET inherited the branch-naming from TS deliberately. |
| Log files at `.aio/.ps/log/<planId>/<jobId>.log` (single file per job) | `.aio/.ps/log/<planId>/<jobId>/<phase>/<attempt>.log` (per-phase, per-attempt) | Conservative: copy the single TS log to `phase=work/attempt=1.log`, leave other phases empty. Annotate with a `LegacyLogLayout` finding. |
| Plan-level `progress.json` | Recomputed from event stream on first daemon start | Discard; not migrated. |
| Hook configs under `.aio/.ps/hooks/` | `.aio/.ps/hooks/` (same) | Preserved verbatim. |

**Lossy fields are explicitly enumerated**, not silently dropped. Any field the converter cannot represent appears in `TsConverterFinding` with severity `Warning` or `Error`; an `Error` finding flips the plan's verdict to `ArchiveOnly` regardless of mode (the user can override with `--force-convert`, which records the override in the audit log per §3.27.2).

### 3.25.3 Schema-version compatibility floor

The converter supports TS releases back to **v0.10.0** (released 2025-09-15). Earlier versions used a meaningfully different on-disk layout (no `events.jsonl`, no `lease` registry); migrating those would double the converter's surface area for vanishing user count. Plans from older TS versions get verdict `Refuse` with finding `TsVersionBelowFloor { detected, floor }`.

The floor is bumped only at .NET-major releases — once a TS layout is supported, it stays supported until the next .NET major.

### 3.25.4 Handling in-progress plans

Plans in TS state `running` or `scheduled` cannot be converted live (the TS extension may still be writing to the same files). The converter requires the user to:

1. Pause the TS extension for the workspace (`aio.transport.preferred = "typescript"` + invoke `Plan: Pause All` from the TS command palette), **or**
2. Quit VS Code entirely.

`PlanAsync` detects an active TS process by checking for a live TS-side lock file (`.aio/.ps/.ts-lock`, written by the TS extension on activation, removed on deactivate); if present, the migration refuses with a clear error message instructing the user. `--force` bypasses the lock check at the user's risk and is logged in the audit log.

For a paused plan with `RunningJobCount > 0` (a job was running when the plan was paused), the converter:

- Treats the running job as **failed with `Migration` reason**: emits a synthetic `JobFailed { reason: "migration-from-ts", attempt: N }` event after the last TS-recorded event for that job.
- Marks the lease as `WorktreeOutcome.Failed` so the standard `RetainOnFailure` policy applies — the worktree stays for inspection.
- The user resumes the plan in the .NET daemon; the failed job enters the normal retry path.

This is the only correctness compromise the converter makes, and it is loud and recoverable: the user sees exactly one failed job per migrated-while-running plan, with full failure context pointing at the migration.

### 3.25.5 Idempotency, atomicity, and rollback

`ExecuteAsync` writes the converted tree to `.aio/.ps/_migrating/<sessionId>/` first — a **shadow tree** — then performs a single rename to swap it into place:

```
Before:  .aio/.ps/                     ← TS layout (live)
During:  .aio/.ps/                     ← TS layout (live, untouched)
         .aio/.ps/_migrating/<sid>/    ← .NET layout being built
After:   .aio/.ps/_archive/ts-<ts>/    ← original TS state moved aside
         .aio/.ps/                     ← .NET layout (was _migrating/<sid>/)
```

The swap is two `Directory.Move` operations issued from a single transaction-marker file (`.aio/.ps/.migration-commit`); if the daemon crashes between them, the next startup detects the commit marker and resumes the swap. If conversion fails partway, `_migrating/<sid>/` is deleted and TS state is left untouched — the workspace is in exactly the pre-migration state.

A successful migration writes `.aio/.ps/_archive/ts-<timestamp>/.MIGRATED.json` recording: source TS version, conversion timestamp, per-plan verdicts, every finding, the converter's own version, and the SHA-256 of the rendered `_archive/` tree. This artifact is the audit trail for the migration; deleting it doesn't remove the archive but does break `ai-orchestrator migrate ts status`.

`ai-orchestrator migrate ts rollback --session <sid>` reverses a successful migration as long as the archive is intact and no new .NET plans have been created in the workspace since the migration.

### 3.25.6 Test fixture corpus

Per §3.27.4, every supported TS minor version contributes a frozen fixture set under `state-fixtures/ts-v<x.y>/`:

- One workspace-shaped tree per fixture, captured by running the TS extension against a synthetic plan and freezing the result.
- Fixtures cover: pristine plan, single-job plan, fan-in plan, plan with reshape history, plan with failed job, paused plan, plan with running job at pause time, plan with corrupted `events.jsonl` last-line.
- The converter test suite runs `PlanAsync` + `ExecuteAsync` against every fixture and asserts the resulting `.NET` tree round-trips through the `.NET` daemon (load → list → graph → resume-or-finalize) without surfacing any `Error` event other than the synthetic `migration-from-ts` failures specified in §3.25.4.

Adding a new TS minor requires capturing one new fixture set; adding a converter feature requires touching one entry in the translation table and adding one fixture. The marginal cost per TS release is bounded.

### 3.25.7 CLI surface

```
ai-orchestrator migrate ts plan      [--workspace <path>] [--only <planId>...] [--json]
ai-orchestrator migrate ts execute   [--workspace <path>] [--mode convert|archive|dry-run] [--force] [--json]
ai-orchestrator migrate ts status    [--workspace <path>]
ai-orchestrator migrate ts rollback  [--workspace <path>] --session <sid>
```

The VS Code extension surfaces a one-time "Migrate from TypeScript" prompt the first time the .NET daemon attaches to a workspace containing a TS layout; the prompt opens the same `migrate ts plan` flow in a panel and lets the user click through to `execute`.

### 3.25.8 Coexistence settings (TS & .NET both installed)

If both extensions are installed, a `aio.transport.preferred` setting picks the active backend per workspace:

| Setting | Behavior |
|---|---|
| `auto` (default) | If a `.MIGRATED.json` exists at the workspace, .NET owns it. Otherwise, the TS extension serves the workspace **only** if no .NET daemon is reachable; once .NET is reachable, the TS extension switches to read-only mode and emits a one-time "convert your plans" notification. |
| `typescript` | TS extension stays primary; .NET daemon refuses to register (logs `WorkspaceClaimedByTs`). |
| `dotnet` | TS extension is unloaded for this workspace; .NET daemon owns everything. Auto-runs `migrate ts execute --mode convert` if TS state is detected and no `.MIGRATED.json` exists. |

A migration guide ships at `docs/MIGRATION_FROM_TS.md` with step-by-step instructions, screenshots, and a recovery section pointing at `migrate ts rollback`.

### 3.25.9 Path normalization across the boundary

TS-era plans store Windows backslash paths inline (`C:\src\repo\src\foo.ts`). The converter normalizes to POSIX form (`C:/src/repo/src/foo.ts`) during translation; the original TS strings are preserved in the archive for forensic comparison. The internal canonical form across all .NET code is **POSIX-style** for *every* serialized path; OS-specific separators only appear at `Path.Combine` / kernel-call boundaries. This is codified as **rule P1** and enforced by analyzer **`OE0033`** (any `\\` in a string literal in a serialization-bound code path is flagged).

The same rule applies to plan import (§3.20): exported `.aio-plan` bundles always use POSIX paths, so a tarball produced on Windows imports cleanly on Linux.

---

## 3.26 Daemon Wire Protocol v1, Coordination & Selection

Several previously-isolated decisions resolve here as one coherent story for *how clients reach the daemon and what they can call*.

### 3.26.1 RPC v1 method set (the contract the TS extension binds against)

`rpcProtocolVersion: 1` is **frozen** at GA. Adding a method bumps to v2 (minor, additive, advertised in negotiation §3.16.5). The v1 surface is exactly the public methods on `IAiOrchestrator` plus the housekeeping methods below — nothing else is reachable across the wire.

| Category | RPC method | Maps to |
|---|---|---|
| Negotiation | `negotiate`, `auth.handshake` | §3.16.5 / §5.1 |
| Health | `health.live`, `health.ready`, `health.diagnose` | §3.26.4 |
| Plan | `plan.scaffold`, `plan.addJob`, `plan.finalize`, `plan.create`, `plan.get`, `plan.list`, `plan.graph`, `plan.pause`, `plan.resume`, `plan.cancel`, `plan.delete`, `plan.reshape`, `plan.export`, `plan.import` | `IAiOrchestrator` + §3.20 |
| Job | `job.retry`, `job.forceFail`, `job.failureContext`, `job.logs` | `IAiOrchestrator` |
| Subscribe | `events.subscribe` (returns `IAsyncEnumerable<AiOrchestratorEvent>`) | §3.16.3 |
| Plugin | `plugin.list`, `plugin.diagnose` (read-only — install/trust live in the CLI only) | §3.10.7 |
| Daemon admin | `daemon.shutdown`, `daemon.config.show`, `daemon.config.validate` | §3.13.5 / §3.12.2 |

This list is the contract the TypeScript-side rewrite (§7) binds against on day one. The TS code does **not** call any internal daemon API; it goes through these methods only, so the daemon-side and TS-side rewrites can proceed in parallel against this stable list.

### 3.26.2 Multi-daemon plan ownership

§3.13.3 commits to multi-daemon mode but two daemons writing the same `.aio/p/<plan>/plan.json` aren't mediated. The rule:

> **A plan is owned by exactly one daemon at a time. Ownership is recorded in `quota.mmf` (§3.9.4) under a new `PlanOwnership` table, keyed by `PlanId`, with the owning `DaemonInstanceId` and `acquiredAtUnixMs`.**

Resolution flow:

1. When a daemon receives any **mutating** RPC for a `PlanId` (anything but `plan.list`, `plan.get`, `plan.graph`, `plan.export`, `events.subscribe`, `job.logs`, `job.failureContext`), it consults `PlanOwnership`.
2. If the plan has no owner: the daemon claims ownership via a CAS write to the `PlanOwnership` row, then proceeds. Emits `PlanOwnershipAcquired { planId, daemon }`.
3. If the plan is owned by another live daemon (heartbeat fresh): the receiving daemon **forwards** the RPC over its peer connection (every daemon registers a per-instance pipe in `quota.mmf`; peers connect lazily). Emits `RpcForwardedToOwner { planId, fromDaemon, toOwner }`.
4. If the owner's heartbeat is stale (per §3.9.7 dead-daemon detection): ownership is reclaimed by the live daemon claiming next, after a 5-second guard window.
5. **Read-only** RPCs are served locally by any daemon — they only need a consistent view of `plan.json`, which the storage layer (§3.11.1) provides via atomic-write semantics.

Effect: from the client's perspective, every RPC works regardless of which daemon it lands on; under the hood there is always exactly one writer per plan.

### 3.26.3 CLI vs daemon selection rule

`ai-orchestrator <cmd>` resolves backend in this strict order:

1. If `--no-daemon` is passed → InProc host, every time, no pipe attempt.
2. Else, attempt to connect to the workspace-local pipe (§4.1) with a 250 ms timeout.
   - On connect: use it.
   - On timeout or `daemon-shutting-down`: try the user-singleton pipe (§3.13.3) with another 250 ms.
   - On timeout: fall through to step 3.
3. If the command is a long-running RPC (`events.subscribe`, `plan.create` for a multi-job plan) → **start a daemon** via the supervisor (§3.13.1) and reconnect; emit `DaemonAutoStarted { reason }`.
4. Otherwise (one-shot read-only command like `plan.list`, `plan.get`) → spin up an InProc host for this invocation only; no daemon side effects.

Stale-pipe detection (the named pipe exists but the listener is dead): a `negotiate` call with no response within 1 s causes the client to call `ai-orchestrator daemon doctor` internally, which removes the dead pipe and falls through to step 3.

### 3.26.4 Health & readiness endpoints

Operators (and supervisors per §3.13.1) need a structured probe that does not require subscribing to the bus. Three RPCs, each cheap, each returning a `sealed record`:

```csharp
public sealed record HealthLiveResult
{
    public required HealthStatus Status { get; init; }     // Live | Stopping | Faulted
    public required TimeSpan Uptime { get; init; }
    public required string Version { get; init; }
}

public sealed record HealthReadyResult
{
    public required HealthStatus Status { get; init; }     // Ready | Degraded | NotReady
    public required IReadOnlyList<SubsystemHealth> Subsystems { get; init; }
}

public sealed record SubsystemHealth
{
    public required string Name { get; init; }              // pipe | events | git | agents | storage | telemetry | concurrency
    public required HealthStatus Status { get; init; }
    public string? Detail { get; init; }                    // human, localized
    public TimeSpan? LastCheckLatency { get; init; }
}

public sealed record HealthDiagnoseResult
{
    public required HealthReadyResult Ready { get; init; }
    public required RuntimeHealthSnapshot Runtime { get; init; }   // §3.21.2
    public required LibGit2HealthSnapshot LibGit2 { get; init; }   // §3.3.3
    public required IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
}
```

The CLI exposes `ai-orchestrator daemon health` (calls `health.ready`) and `ai-orchestrator daemon diagnose --runtime` (calls `health.diagnose`). The `live` endpoint is what supervisors poll every 5 s; the `ready` endpoint is what UI surfaces poll on resume.

### 3.26.5 Distributed tracing propagation

W3C Trace Context (`traceparent`, `tracestate`) is propagated on **every** transport hop:

| Hop | Carrier |
|---|---|
| TS extension → daemon (named pipe JSON-RPC) | `_meta.traceparent` field on the request envelope; same field on the response. |
| MCP client → daemon | MCP `_meta.traceparent` on `tools/call` (per MCP spec §11.1). |
| Daemon → spawned agent process | `OTEL_TRACEPARENT` env var; agent runners are responsible for propagating into hooks where supported. |
| Daemon → daemon (peer forwarding from §3.26.2) | Same `_meta.traceparent` field; the forwarded request preserves the original trace id, only adding a child span for the forward. |
| N-API binding → daemon | `_meta.traceparent` on the request envelope. |

Internally, `Activity.Current` flows through every async hop. Bus events carry `traceId` and `spanId` so a UI can correlate a rendered event with the OTel trace for that operation. Codified as **rule T1** with analyzer **`OE0034`** (any RPC handler entry point that does not extract trace context into `Activity.Current` is a build error).

---

## 3.27 Performance, Operations & Observability

### 3.27.1 Performance SLOs

Every release ships against these targets. Misses block a release tag (§3.24.5) unless explicitly waived in the release manifest's `Extensions.perfWaivers`.

| Operation | p50 | p99 | Notes |
|---|---|---|---|
| Daemon cold start (binary launch → ready) | 250 ms | 600 ms | Self-contained single-file, ReadyToRun, DATAS GC. |
| `plan.list` (100 plans) | 8 ms | 25 ms | Cached summary table. |
| `plan.get` (1 plan, 50 jobs) | 5 ms | 15 ms | mmap'd plan.json. |
| `plan.create` end-to-end (10-job plan) | 30 ms | 90 ms | Includes lease-registry write + scaffold persist. |
| `events.subscribe` first event delivered | 10 ms | 30 ms | After SubscribeAsync returns. |
| Bus event throughput per subscriber | 50k/s | n/a | DropOldest at saturation. |
| Agent run dispatch overhead (Begin → SpawnedEvent) | 12 ms | 40 ms | Excludes child-process startup. |
| `job.logs` (descriptor only) | 2 ms | 6 ms | No file content over wire. |
| RPC roundtrip over named pipe (no work) | 0.8 ms | 3 ms | Local pipe baseline. |
| MCP `tools/call` overhead (no work) | 4 ms | 12 ms | Stdio JSON-RPC parse. |
| Memory: idle daemon RSS | < 80 MiB | n/a | After first GC. |
| Memory: daemon with 1 active plan | < 150 MiB | n/a | Steady-state. |

These targets are codified in the BenchmarkDotNet suite (§3.24.5) and tracked as time-series so regressions are visible.

### 3.27.2 Audit log schema

The audit log (§3.11.1) is NDJSON; one record per line; UTF-8; never rotated mid-line; never localized (rule L1). Every monthly file is **tamper-evident** via an HMAC chain plus per-segment ed25519 signature \u2014 see §3.27.2.1 below.

**File header (record 0 of every monthly file)** \u2014 self-contained, contains the public key needed to verify every subsequent record:

```jsonc
{
  "$type":           "AuditHeader",
  "schemaVersion":   1,
  "segmentId":       "<uuid v4 — unique per monthly file>",
  "createdAtUtc":    "2026-04-01T00:00:00.000Z",
  "daemonInstanceId":"<uuid v4 — stable per daemon install>",
  "daemonVersion":   "1.0.0",
  "keyId":           "<base64url(sha256(publicKey))>",
  "publicKey":       "<base64-ed25519-32-byte-public-key>",
  "keyAlgo":         "ed25519",
  "hmacAlgo":        "HMAC-SHA256",
  "previousSegment": { "segmentId": "<uuid or null>", "lastChainHmac": "<base64 or null>", "fileSha256": "<base64 or null>" }
}
```

**Per-record schema (records 1..N)** \u2014 the operational events; the schema below is the v1 floor:

```jsonc
{
  "schemaVersion": 1,
  "seq":         1,
  "atUtc":       "2026-04-20T12:00:00.123Z",
  "actorKind":   "user|daemon|plugin|system",
  "actorId":     "<sid|pluginId|daemonInstanceId>",
  "sessionId":   "<sessionId or null>",
  "traceId":     "<W3C trace id or null>",
  "action":      "plan.create|plan.cancel|plan.delete|plugin.trust.add|plugin.trust.revoke|config.changed|daemon.shutdown|rpc.invoked|hook.gate.evaluated|hook.installed|hook.removed|lease.stolen|plan.import|plan.export|plan.rollback",
  "subject":     { "kind": "plan|job|job|plugin|config|rpc|hook", "id": "..." },
  "outcome":     "success|denied|failed",
  "details":     { /* bounded, redacted JSON; max 4 KiB after redaction */ },
  "chainHmac":   "<base64-HMAC-SHA256(secretKey, prevChainHmac || canonicalize(record-without-chainHmac-and-signature))>",
  "signature":   "<base64-ed25519(privateKey, chainHmac)>"
}
```

**Audited actions (the closed set v1 supports** \u2014 every other action is *not* audited; adding to this set is a minor schema bump):

- Plan lifecycle: create, finalize, pause, resume, cancel, delete, import, export, rollback.
- Plugin trust: add, revoke, override, key-rotation.
- Config: any non-hot-reloadable change; any change to `Auth:*`, `Plugins:*`, or `Audit:*`.
- Daemon: start, shutdown, ownership-acquired, ownership-reclaimed, self-update-pending, self-update-rolled-back.
- Hooks: install, remove, gate-evaluated (one record per CLI tool-use gate decision; `details.toolName` + `details.checkpointState` + `details.allowlistHit`).
- Leases: stolen (when LS-5 lease-steal completes), in-flight-aborted (when stolen-from owner cancels its in-flight transaction per LS-INF-*).
- RPC: any method whose `IAuditPolicy` says `Audit = true` (default true for all mutating RPCs; explicitly false for `events.subscribe` and read-only queries).

The audit log is the *only* surface that can confirm "did user X do Y at time Z" for security review. It is never deleted automatically (§3.11.4).

#### 3.27.2.1 Tamper-evidence \u2014 HMAC chain + ed25519 signature with embedded public key

Three orthogonal mechanisms, each defending against a different attacker class:

**Layer 1 \u2014 HMAC chain (defends against single-record tampering by any reader):** Every record's `chainHmac` is `HMAC-SHA256(secretKey, prevChainHmac || canonicalize(record-minus-chainHmac-and-signature))`. The header record's `chainHmac` is computed over `previousSegment.lastChainHmac` (or 32 zero bytes if this is the first-ever segment). An attacker who edits, inserts, or deletes a single record breaks the chain at that point and every subsequent record's HMAC fails to verify. `secretKey` is a 256-bit symmetric key generated alongside the ed25519 keypair, persisted under `<dataDir>/keys/audit-<keyId>.hmac` with 0600 perms (POSIX) / owner-only ACL (Windows), and **never written to disk anywhere outside `<dataDir>/keys/`**. The verifier needs `secretKey` to validate the chain end-to-end \u2014 so chain validation is daemon-local; cross-machine verifiers fall back to layer 2.

**Layer 2 \u2014 ed25519 signature (defends against full-file replacement by an attacker without `secretKey`):** Each record's `signature` is `ed25519(privateKey, chainHmac)`. The public key is **embedded in the file header** (`publicKey` field) so the file is self-verifying \u2014 a verifier needs only the file itself plus the public key (which is in the file) to confirm that whoever produced this file possessed the matching private key. This means:

- The verifier tool (`ai-orchestrator audit verify <log-path>`) parses the header, extracts `publicKey`, walks every subsequent record, and verifies `signature` against `chainHmac` using the embedded public key.
- An attacker who edits any record in place must re-sign it, which requires the private key (stored only in `<dataDir>/keys/audit-<keyId>.priv` with 0600 perms, never crossed onto the network).
- An attacker with full filesystem write but **not** code-execution as the daemon-owning user cannot tamper without breaking signatures.

**Layer 3 \u2014 cross-channel pubkey attestation (defends against full-file replacement by an attacker who has both filesystem write AND code execution):** The daemon emits an `AuditPubkeyAttestation` event over the named pipe (\u00a73.4.2 EventBus, Security category) at every keypair generation, key rotation, segment rotation, and graceful shutdown. The event payload is `{ keyId, publicKey, segmentId, firstSeq, lastSeq, segmentSha256, atUtc }`. Subscribers \u2014 the in-memory T2 event log, OpenTelemetry exporter, and any remote audit-aggregator the user has configured \u2014 durably record it. An attacker who rewrites the local audit file can no longer rewrite the cross-channel attestation history without simultaneously compromising those independent stores. **This is the only layer that defends against root-on-machine compromise; if you don't run an external aggregator you are accepting that a root-equivalent attacker can replace audit history.** Documented as a known limit; the user opts in to layer 3 by configuring an aggregator (out-of-tree integration in v1; first-party integration is post-v1).

##### 3.27.2.2 Key storage \u2014 do **not** commit keys to the repo

Per security-review explicit decision: **public keys are NOT committed to the repo for any reason.** Reasons:

- Secret-scanning tools (TruffleHog, gitleaks, GitHub secret scanning) increasingly flag ed25519-shaped strings as potential leaks; committing public keys produces noisy false positives in every plan run.
- One-key-per-run committed to the repo would cause unbounded repo bloat (a daemon used continuously for a year produces thousands of keys).
- Embedding the public key in the audit-log header (Layer 2) makes the file self-verifying; no external lookup needed.
- An external publication channel (release manifest, key-server) is a *post-v1* concern for the rare cross-fleet verification scenario; we do not need it for v1.

**Storage layout (KEY-STORE-*):**

| # | Rule |
|---|---|
| KEY-STORE-1 | Keypair files live under the OS-conventional per-user data directory: Linux `${XDG_DATA_HOME:-~/.local/share}/ai-orchestrator/keys/`, macOS `~/Library/Application Support/ai-orchestrator/keys/`, Windows `%LOCALAPPDATA%\ai-orchestrator\keys\`. **Never under the repo working tree.** Never under `~/.config/` (which users sometimes commit via dotfile repos). |
| KEY-STORE-2 | Files: `audit-<keyId>.priv` (32-byte raw ed25519 private key, mode 0600 / owner-only DACL), `audit-<keyId>.pub` (32-byte raw public key, mode 0644 / world-readable), `audit-<keyId>.hmac` (32-byte symmetric secret for chain HMAC, mode 0600). The `keyId` is `base64url(sha256(publicKey))` truncated to 16 chars. |
| KEY-STORE-3 | On daemon startup, if no keypair exists, generate one. If exactly one exists, reuse. If multiple exist, the *most recent* (by mtime) is the active signing key; older keys are kept for verifying older audit segments and are never deleted automatically (audit log is forever-retained per \u00a73.11.4). |
| KEY-STORE-4 | The daemon refuses to start if it cannot write to the keys directory or if file permissions are weaker than KEY-STORE-2 (the daemon attempts a permission-tighten on startup and emits `AuditKeyPermissionsFixed` or `AuditKeyPermissionsRefused` accordingly). |
| KEY-STORE-5 | **Key rotation** is initiated by `ai-orchestrator audit rotate-key` (CLI) or automatically every 90 days (`Audit:KeyRotationDays`). On rotation: (a) generate a new keypair; (b) close the current monthly audit file with a footer record `{ "$type":"AuditFooter", "rotatedToKeyId":"<new>", "lastChainHmac":"<final>", "fileSha256":"<sha256-of-file-up-to-this-point>" }`; (c) start a new monthly file whose header `previousSegment` references the just-closed file's segmentId, lastChainHmac, and fileSha256; (d) emit `AuditPubkeyAttestation` for the new key (Layer 3). The chain therefore extends across rotations \u2014 a verifier walking from segment N back to segment 1 can detect any missing intermediate segment. |
| KEY-STORE-6 | **Key revocation/compromise** \u2014 if a private key is suspected compromised, the operator runs `ai-orchestrator audit revoke-key <keyId> --reason <text>`. This forces an immediate rotation (KEY-STORE-5), records `KeyRevoked { keyId, reason }` in the new segment, and the verifier flags any future records signed with the revoked `keyId` as `verifier-warning: revoked-key`. We do not delete the revoked key file (needed to verify pre-revocation segments). |
| KEY-STORE-7 | All key material is excluded from the diagnose bundle (\u00a73.13.4) by an explicit deny-list rule; the bundle includes only the `keyId` (a hash) so the verifier knows which key to look for, never the private key. |

### 3.27.3 Publisher rate limiting

§3.16.3 handles slow consumers; §3.16.4 caps quotas per session. The inverse — a runaway publisher inside the daemon emitting 10⁶ events/sec from a tight loop — is bounded by:

- Each publisher (each `IEventBus.Publish` call site) is wrapped in a token-bucket of 5000 events / second / category. Excess publishes are coalesced into a single `PublisherRateLimited { category, droppedSinceLast, sinceSeq }` event per second per category.
- The token bucket is per-process (not per-subscription), so a publisher cannot pathologically swamp the bus regardless of how many subscribers exist.
- Categories with naturally bursty patterns (`Diagnostics/health`, `LibGit2OpStarted`/`Completed`) carry a higher per-category cap (50 000/s) configured under `Bus:Publishers:RateLimits:<category>`.

Codified as **rule E15**.

### 3.27.4 Test fixture management

Three classes of fixtures:

| Class | Path | Generated? | Refresh policy |
|---|---|---|---|
| Unit fixtures | `src/dotnet/AiOrchestrator.*.Tests/Fixtures/` | Hand-authored; small JSON/text files. | Live with the test that owns them; deleted when the test goes. |
| State migration fixtures | `state-fixtures/v<n>/` | Captured by running daemon vN against a synthetic plan, then frozen. | Added on every minor bump of any on-disk schema (§3.11.1); never edited after. |
| Scripted-agent fixtures | `agent-scripts/<runner>/<scenario>.txt` | Hand-authored or captured via the `aio-agent-record` developer tool. | Reviewed quarterly; stale ones culled. |

Fixtures are licensed under the repo license. No customer data, no real tokens, no real names — fixtures are generated against the `test-fixtures-only` org with placeholder identities.

### 3.27.5 Time-zone & relative-time rendering

Rule **L7** (extends §2.4): every timestamp surfaced to a human (CLI output, VS Code panel, MCP description) is rendered in `IRequestCulture.Current` *or* `TimeZoneInfo.Local` of the **client process**, never the daemon's. Two concrete behaviors:

- The daemon emits all `DateTimeOffset` values in UTC over the wire (rule L1 already required this for events; this extends it to RPC responses).
- The CLI converts to `TimeZoneInfo.Local` and the user's `IRequestCulture.Current` for display; the JSON output mode keeps UTC.
- The VS Code extension converts to the workspace user's `Intl.DateTimeFormat().resolvedOptions().timeZone`.

Relative times ("3 minutes ago") are rendered client-side only; the daemon never sends pre-rendered relative strings. Codified by extending analyzer **`OE0022`** to flag any `ToString("g"|"d"|"t")` in a daemon-side response builder that lacks an explicit UTC `K` specifier.

---

## 3.28 Lifecycle & Update Management

### 3.28.1 LibGit2 `Repository` lease (mirrors §3.3.2's pattern)

Undisposed `LibGit2Sharp.Repository` instances are the #1 long-running-process pain point with libgit2. Add the same lease pattern as worktrees:

```csharp
public interface ILibGit2RepositoryProvider
{
    /// <summary>
    /// Acquire a Repository handle. The returned IRepositoryHandle MUST be disposed
    /// (await using). The provider may pool repositories per (path, generation) but
    /// the caller never sees pooled identity — every Acquire returns a logically
    /// fresh handle whose Dispose returns it to the pool or destroys it.
    /// </summary>
    ValueTask<IRepositoryHandle> AcquireAsync(RepositoryAcquireRequest request, CancellationToken ct);
}

public interface IRepositoryHandle : IAsyncDisposable
{
    LibGit2Sharp.IRepository Repository { get; }   // do not store; valid only inside the using block
    string RepositoryRoot { get; }
    Generation Generation { get; }                  // bumps when the underlying git db has changed
}
```

Rules:

- Direct `new Repository(...)` is forbidden anywhere in `AiOrchestrator.Git` except inside the provider implementation. Analyzer **`OE0035`** mirrors the worktree lease analyzer.
- The provider pools at most `LibGit2:Pool:MaxPerPath` repositories per path (default 4), each with a `LastUsed` timestamp; idle pool entries are evicted after 60 s.
- A `LibGit2BreakerOpened` (§3.3.3) drains the entire pool — every pooled handle is disposed and recreated on next acquire. This avoids the "stale handle keeps failing after the breaker recovers" trap.

### 3.28.2 Plan deletion cascade

`IAiOrchestrator.DeleteAsync(planId)` is **transactional**:

1. Refuse if the plan is `running` (caller must `cancel` first; `failed`/`succeeded`/`canceled`/`paused` are deletable).
2. Acquire `PlanOwnership` (§3.26.2) so no peer daemon can race.
3. In a single sweep:
   - Remove `plan.json`, `events.summary.json`.
   - Remove every T2 segment + index for the plan.
   - Remove every per-job log directory.
   - Sweep every preserved-on-failure worktree associated with the plan (calls `IAsyncWorktreeLease.DisposeAsync(force=true)`).
   - Remove every lease-registry entry (worktree, process) tagged with the plan id.
   - Drop the plan's telemetry-queue rows.
   - Release `PlanOwnership`.
4. Emit one `PlanDeleted { planId, artifactsRemoved: { plans, segments, logs, worktrees, leases }, elapsed }` event.

Crash safety: every step is **idempotent** and the next-startup reclaim sweeper (§3.3.2) treats orphaned worktrees whose plan has no `plan.json` as eligible for removal-by-force. There is no "half-deleted plan" failure mode that requires manual cleanup.

### 3.28.3 Daemon self-update

> **Decision required (item M-11, recommended default below).** I am proposing **package-manager-owned updates** with optional opt-in self-update. If you'd rather have aggressive auto-update like VS Code's, say so and I'll redesign §3.28.3 around that.

Default policy:

- VSIX-installed daemons update with the VSIX (the VSIX bundles the daemon binary; users get updates through the VS Code Marketplace cadence).
- `dotnet tool`-installed daemons update via `dotnet tool update -g AiOrchestrator.Cli`.
- Homebrew/winget/apt installs follow their respective package managers.
- The daemon **never silently downloads and replaces itself**.

Opt-in self-update for headless installs (CI runners, server deployments):

- `appsettings` `Update:Channel = "stable" | "preview" | "off"` (default `off`).
- When non-`off`, a background `DaemonUpdateChecker` polls the GitHub Releases manifest (§3.24.4) every 6 h and emits `DaemonUpdateAvailable { current, available }`.
- The user runs `ai-orchestrator daemon update` to actually install — the daemon downloads the new binary, verifies SHA-256 + Authenticode/codesign, signals the supervisor to restart with the new binary in place. Never automatic.

Rationale: the daemon is a long-running, security-sensitive process; surprising restarts are actively harmful. Operators should opt in.

### 3.28.4 Plugin update lifecycle

§3.10 covers install but not transitions:

- `ai-orchestrator plugin outdated` — lists plugins where `Update:Channel != "off"` and a newer version exists in the configured plugin source (NuGet by default).
- `ai-orchestrator plugin update [<id>]` — updates one or all to latest matching the plugin's own `compat` ranges; verifies signatures.
- A plugin update **never silently replaces a workspace plugin with a user plugin**, even if the user-tier version is newer. Workspace pinning wins; the operator can lift the pin explicitly.
- A `PluginUpdateAvailable { id, current, available, source }` event fires once per (id, available-version) per daemon lifetime so UIs can surface a non-spammy "updates available" hint.

### 3.28.5 Container deployment — out of scope for v1

Container deployment is **deferred to a post-GA enhancement**. Headless CI users in v1 run the self-contained linux-x64 / linux-arm64 binary from the GitHub Release (§3.24.4); building a Dockerfile around that binary is straightforward and does not require any in-tree support.

Tracked as a nice-to-have in GitHub issue [#117 — "Container deployment for ai-orchestratord (post-v1 nice-to-have)"](https://github.com/JeromySt/vscode-copilot-orchestrator/issues/117). When picked up, the implementation should cover:

- Multi-stage Dockerfile under `deploy/container/` on a distroless `runtime-deps:10.0-cbl-mariner-distroless` base, running as non-root UID/GID `1001:1001`.
- `docker-compose.yml` documenting the host UID-mapping pattern.
- `HEALTHCHECK` wired to `ai-orchestrator daemon health --exit-code` (calls `health.ready` per §3.26.4).
- `quota.mmf` placed under `/run/user/1001/ai-orchestrator/` (tmpfs) — never under the `/data` volume (NFS-unsafe).
- SIGTERM clean-shutdown is already specified in §3.13.5; the image relies on it without modification.
- Release-pipeline addition (`release-publish.yml`, §3.24.3) to build and push images to `ghcr.io/<owner>/ai-orchestrator:<version>`, signed with cosign and carrying SLSA provenance attestations.
- Kubernetes example manifest under `deploy/k8s/`.

Until the issue is implemented, the documentation site (§3.24.6) carries a one-page "Running in a container" recipe pointing at the self-contained binary release as the canonical path. No `Dockerfile` ships in the repo for v1.

### 3.28.6 Worktree initializer contract

`IWorktreeInitializer` (referenced informally in §8) is now a first-class extension point:

```csharp
public interface IWorktreeInitializer
{
    /// <summary>
    /// Run after `git worktree add` and any symlinking, before prechecks/work.
    /// Implementations install per-worktree dependencies (npm ci, cargo fetch, etc.).
    /// </summary>
    Task<WorktreeInitResult> InitializeAsync(WorktreeInitRequest request, CancellationToken ct);
}

public sealed record WorktreeInitRequest
{
    public required string WorktreeRoot { get; init; }
    public required IReadOnlyList<WorktreeInitStep> Steps { get; init; }
    public required AgentTimeouts Timeouts { get; init; }
    public IProgress<WorktreeInitEvent>? Observer { get; init; }
    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}

public sealed record WorktreeInitStep
{
    public required string Name { get; init; }      // "npm-ci" | "cargo-fetch" | ...
    public required ProcessLifecycleSpec Spec { get; init; }
}

public sealed record WorktreeInitResult
{
    public required IReadOnlyList<StepResult> Steps { get; init; }
    public required TimeSpan TotalElapsed { get; init; }
}
```

The default implementation auto-detects from common signals: presence of `package-lock.json` → `npm ci`; `Cargo.toml` → `cargo fetch`; etc. (§ existing detection rules). Plans can override with an explicit `WorktreeInitSpec` on `WorktreeAcquireRequest`.

### 3.28.7 Feature flags

Risky features ship behind `Features:<name> = true|false` in `appsettings`. Default for every flag is **off**. The daemon enumerates active flags at startup and emits `FeatureFlagState { flag, enabled, source }`. Removing a flag (after the feature is GA or abandoned) requires:

- One release where the flag is `Obsolete`-attributed and emits a `FeatureFlagDeprecated` warning at startup if set.
- The next release removes the flag entirely.

Flags are documented in `docs/FEATURE_FLAGS.md` with target-removal dates. **No flag lives forever** — every flag carries a `removeBy: <semver>` field in its registration; CI fails if `removeBy` is in the past.

### 3.28.8 Plan revision history

Today's audit log records *what changed*; users want to *see the prior shape and roll back*. Each `plan.json` write is preceded by an append to `.aio/p/<plan>/revisions/<seq>.json` (an immutable copy of the prior state). Schema-versioned per §3.11. The CLI exposes:

- `ai-orchestrator plan history <planId>` — list revisions with timestamps + actor.
- `ai-orchestrator plan diff <planId> <revA> <revB>` — JSON diff between revisions.
- `ai-orchestrator plan rollback <planId> <rev>` — refuses if the plan is running; otherwise overwrites `plan.json` with the named revision and emits `PlanRolledBack`.

Retention of revisions is governed by `Retention:PlanRevisions` (default: keep last 50, age out at 90 days); the audit log records the rollback action (§3.27.2).

---

## 3.29 Cross-Cutting Standards

Small additive standards that didn't warrant their own chapter.

### 3.29.1 Agent-output encoding

`IProcessLifecycle` reads child-process stdout/stderr as **bytes**, not strings. The line splitter operates on `ReadOnlyMemory<byte>` (§3.6.9). Encoding interpretation happens *only* inside `IAgentStdoutParser` implementations, which are vendor-specific and know which encoding their CLI emits:

- The Copilot runner declares UTF-8 for its native log files; Windows console output is read as the active OEM codepage and converted to UTF-8 via `Encoding.GetEncoding(GetConsoleOutputCP()).GetString(...)`.
- The Claude runner declares UTF-8 throughout (Claude CLI is consistent across platforms).
- The scripted runner accepts a declared encoding per script (defaults to UTF-8).

The `IProcessLifecycle` contract carries a `DeclaredEncoding { ChildOutput, ChildError }` field on `ProcessLifecycleSpec` so log-file persistence can record what the bytes actually mean. Without this, Windows-side log replay rendered CP1252 bytes as UTF-8 and lost characters.

### 3.29.2 MCP HTTP/SSE transport — deferred

Stdio MCP (§4.3) covers every consumer in scope today. An HTTP/SSE MCP transport is **out of scope for v1** and recorded as a future-work item with these constraints:

- Auth would use the same nonce model (§5) but bound to a TLS-terminated HTTP endpoint.
- Per-request culture, trace context, and locale negotiation map cleanly to HTTP headers (`Accept-Language`, `traceparent`, etc.) so no `IAiOrchestrator` change is needed.
- Until designed, `ai-orchestrator-mcp` is stdio-only and `--transport=http` is `Unimplemented`.

This explicit deferral prevents accidental partial work; any future PR must update §3.29.2 with a full design before adding code.

### 3.29.3 DI container choice

`Microsoft.Extensions.DependencyInjection` is the only DI container the host uses. Reasons:

- It's the de facto standard for `IHostBuilder`/`IServiceCollection`.
- Keyed services (§3.2.2) are first-party in v8+ — no need for third-party container-specific keying.
- Trim/AOT story is the cleanest of any container: no runtime reflection in the registration path.

**Plugins MUST NOT depend on a different DI container.** Plugin registration goes through `IPluginRegistration.Services` which is `IServiceCollection` (§3.10.6); a plugin importing Autofac, Lamar, etc. and wiring it into the host is rejected at load time by analyzer **`OE0036`** (any plugin assembly with a `<PackageReference>` to a known third-party DI container fails the build of its conformance pack, §3.10.8). Inside their own internal classes, plugins may use whatever DI they prefer — but the boundary they cross to register services with the host is `IServiceCollection`-only.

### 3.29.4 Nightly / preview channel

A `preview` channel ships from `main` on every push by `release-build.yml` (with `--preview` flag) and is published to:

- A `preview` NuGet feed at `https://nuget.pkg.github.com/<owner>/index.json` (GitHub Packages).
- A `preview` VSIX on OpenVSX only (not VS Marketplace, to avoid noise).
- A `preview-<commit-sha>` GitHub pre-release.

Stable releases (semver, no `-preview`) go through the full §3.24.3 flow. Users on the preview channel get a prominent banner in the VS Code panel; the CLI prints `(preview build)` next to its version on every invocation.

---

## 3.30 DAG Core — Execution Semantics & Implementation Contracts

This section is the **normative DAG-engine contract**. Everything before it (agent runners §3.2, output pipelines §3.2.7, shell work specs §3.2.8, git/worktree §3.3, eventing §3.4, design conventions §3.5, memory §3.6, cancellation §3.7, lifetimes §3.8, concurrency §3.9, plugins §3.10, on-disk schema §3.11, …) is the supporting *infrastructure*; this section is what you build *on top of* that infrastructure to actually execute plans.

It exists because a re-architecture that gets the supporting cast right but the DAG core wrong produces a re-architecture-of-the-re-architecture six months later. The Tier-1 invariants — job state machine, phase pipeline, persistence atomicity, scheduler readiness, bus replay, reshape, single-writer lease — are the deep ones; mistakes in any of them propagate to every front end. Tier-2 (auto-heal, quotas, cancel, failure context, recovery, cross-plan deps) and Tier-3 (metrics catalog, OTel schema, error code enum, etc.) build on Tier-1.

The section is organized so each gap from the readiness review has its own subsection:

| Tier | # | Subsection | Topic |
|---|---|---|---|
| 1 | 1 | §3.30.1 | Job state machine — exhaustive transitions |
| 1 | 2 | §3.30.2 | Phase pipeline — 8-phase normative contract |
| 1 | 3 | §3.30.3 | Plan-store atomicity & on-disk schema |
| 1 | 4 | §3.30.4 | Scheduler contract — readiness, fairness, blocking |
| 1 | 5 | §3.30.5 | Event-bus topology — back-pressure, replay, late subscribers |
| 1 | 6 | §3.30.6 | Reshape invariants on running plans |
| 1 | 7 | §3.30.7 | Single-writer plan-store lease |
| 2 | 8 | §3.30.8 | Auto-heal policy |
| 2 | 9 | §3.30.9 | Quota / rate-limit awareness |
| 2 | 10 | §3.30.10 | Cancellation propagation chain |
| 2 | 11 | §3.30.11 | Failure-context capture |
| 2 | 12 | §3.30.12 | Crash recovery semantics |
| 2 | 13 | §3.30.13 | Cross-plan dependency state |
| 3 | — | §3.30.14 | Tier-3 catalogs (metrics, OTel, error codes, CLI/MCP/config schemas) |

Once §3.30 is internalized, the DAG-implementation execution plan (§3.30.15) lays out the dependency-ordered jobs that build it.

### 3.30.1 Job state machine — exhaustive transitions

Every job lives in exactly one of nine states at any instant. Transitions are atomic with respect to the plan store (§3.30.3) and emit exactly one `JobStateChanged` event (§3.30.5).

#### 3.30.1.1 States

```csharp
public enum JobState
{
    Pending      = 0, // Created; not yet evaluated for readiness (e.g., scaffolding plan, or a pending dep).
    Ready        = 1, // All dependencies succeeded; eligible for scheduling.
    Scheduled    = 2, // Picked by scheduler; resources reserved (worktree lease, runner slot); not yet running.
    Running      = 3, // Some phase (§3.30.2) is currently executing.
    Succeeded    = 4, // Terminal-success: every phase up to and including merge-ri completed.
    Failed       = 5, // Terminal-failure: a phase failed and auto-heal exhausted (§3.30.8).
    Blocked      = 6, // A transitive ancestor is Failed/ForceFailed/Canceled and propagation rules say "block".
    Canceled     = 7, // User canceled the plan or this job specifically before terminal.
    ForceFailed  = 8, // Operator-issued `force_fail_copilot_job`; behaves like Failed for downstream propagation.
}
```

`Succeeded`, `Failed`, `Canceled`, `ForceFailed` are **terminal** states. `Blocked` is **derived-terminal**: it becomes the job's resting state once all its blocking ancestors are terminal, but it is reset to `Pending` if the blocking ancestor transitions away from a failure state via retry (§3.30.8).

#### 3.30.1.2 Normative transition table

Columns: `Trigger` (what caused the transition), `Guard` (required precondition), `Effect` (write side-effect on store), `Event` (emitted on bus). Rows ordered by source state.

| # | From | To | Trigger | Guard | Effect | Event |
|---|---|---|---|---|---|---|
| T1 | (none) | Pending | `add_job` / `scaffold` | Plan in scaffolding or running/paused, no cycle | Persist job record (§3.30.3) | `JobAdded` |
| T2 | Pending | Ready | Scheduler readiness sweep (§3.30.4) | All deps in `Succeeded`; plan not paused | Set `readyAt` | `JobReady` |
| T3 | Pending | Blocked | Readiness sweep | Any dep in `{Failed, ForceFailed, Canceled, Blocked}` | Set `blockedBy = [depId]` | `JobBlocked` |
| T4 | Pending | Canceled | Plan cancel | Plan in `Canceling` | None beyond state | `JobCanceled` |
| T5 | Ready | Scheduled | Scheduler dispatches | Capacity available (§3.30.4); worktree lease acquirable | Reserve worktree lease (§3.30.7); record `scheduledAt`, `attempt = current+1` | `JobScheduled` |
| T6 | Ready | Pending | Reshape (T20) | Dep added/restored | Re-evaluate readiness | `JobReshaped` |
| T7 | Ready | Canceled | Plan cancel | Plan in `Canceling` | Release any pre-reservation | `JobCanceled` |
| T8 | Scheduled | Running | Phase pipeline starts | merge-fi phase entered | Record `startedAt`; create attempt directory (§3.30.3) | `JobStarted` (`AttemptStarted`) |
| T9 | Scheduled | Failed | Worktree-lease acquisition failed terminally | Lease error not retryable | Release reservation; record failure context (§3.30.11) | `JobFailed` |
| T10 | Scheduled | Canceled | Plan cancel before phase pipeline starts | — | Release reservation | `JobCanceled` |
| T11 | Running | Succeeded | merge-ri phase completed | All phases passed | Set `succeededAt`; release lease | `JobSucceeded` |
| T12 | Running | Failed | A phase failed and auto-heal declined or exhausted | See §3.30.8 | Persist failure context (§3.30.11); release lease | `JobFailed` |
| T13 | Running | Running | Auto-heal retry within same attempt | Retry budget remains | Increment `phaseRetryCount` | `JobPhaseRetry` |
| T14 | Running | Canceled | Plan/job cancel during execution | — | Cascade cancel via §3.30.10 chain; release lease | `JobCanceled` |
| T15 | Running | ForceFailed | Operator `force_fail_copilot_job` | Job currently `Running` or `Scheduled` (per §3.30 rule R-FF-1) | Stop process via §3.30.10; set `forceFailedBy` | `JobForceFailed` |
| T16 | Failed | Ready | `retry_copilot_job` (full-attempt retry) | Plan running/paused; job has retry budget; user supplied or accepted same work spec | Increment `attempt`, clear `failureContext.current`, archive previous attempt (§3.30.11) | `JobRetryRequested` |
| T17 | Failed | Pending | Reshape that adds a dep upstream | New dep is non-terminal | Re-evaluate readiness next sweep | `JobReshaped` |
| T18 | ForceFailed | Ready | `retry_copilot_job` | Same as T16 | Same as T16 plus clear `forceFailedBy` | `JobRetryRequested` |
| T19 | Blocked | Ready | A blocking ancestor transitioned Failed→Ready (T16) and now Succeeded | All deps now `Succeeded` | Same as T2 | `JobReady` |
| T20 | Blocked | Pending | Reshape removed the blocking dep | New dep set non-terminal-failed | — | `JobReshaped` |
| T21 | Blocked | Canceled | Plan cancel | — | — | `JobCanceled` |
| T22 | Canceled | Ready | `retry_copilot_job` after cancel | Plan no longer in `Canceled`/`Canceling` | Same as T16 | `JobRetryRequested` |
| T23 | Succeeded | Pending | Reshape that invalidates this job (e.g., dep added that re-runs upstream) | Explicit `reshape` op `invalidate_node` | Archive previous attempt; clear success record | `JobInvalidated` |

**Forbidden transitions** are everything not in the table above. Examples: `Pending → Running` (must pass through `Ready` and `Scheduled`), `Succeeded → Failed` (terminal-success is sticky), `Running → Ready` without a phase failure (must go through `Failed` first), `Scheduled → Pending` (only via reshape). The state-machine module is single-entry: every transition flows through `IJobStateMachine.Transition(JobId, TransitionRequest)` which validates against the table and rejects illegal transitions with `InvalidJobTransitionException`.

#### 3.30.1.3 Diagram

```mermaid
stateDiagram-v2
    [*] --> Pending : T1 add/scaffold
    Pending --> Ready : T2 deps succeeded
    Pending --> Blocked : T3 dep failed
    Pending --> Canceled : T4 plan cancel
    Ready --> Scheduled : T5 dispatch
    Ready --> Pending : T6 reshape
    Ready --> Canceled : T7 plan cancel
    Scheduled --> Running : T8 pipeline starts
    Scheduled --> Failed : T9 lease error
    Scheduled --> Canceled : T10 plan cancel
    Running --> Succeeded : T11 merge-ri ok
    Running --> Failed : T12 phase failed
    Running --> Running : T13 auto-heal
    Running --> Canceled : T14 cancel
    Running --> ForceFailed : T15 operator force-fail
    Failed --> Ready : T16 retry
    Failed --> Pending : T17 reshape
    ForceFailed --> Ready : T18 retry
    Blocked --> Ready : T19 ancestor recovered
    Blocked --> Pending : T20 reshape
    Blocked --> Canceled : T21 plan cancel
    Canceled --> Ready : T22 retry
    Succeeded --> Pending : T23 invalidated by reshape
    Succeeded --> [*]
    Failed --> [*]
    ForceFailed --> [*]
    Canceled --> [*]
```

#### 3.30.1.4 Idempotency rules

- **Re-arming an attempt is *always* a new attempt**, never a reset of the existing one. T16/T18/T22 increment `attempt` (1-based, monotonic per job, never reused). All event subscribers see a fresh `AttemptStarted` with the new number; failure context for prior attempts is preserved (§3.30.11) and individually addressable.
- **Snapshot Validation (`__snapshot-validation__`) job** transitions follow the same table but its dependency set is auto-managed (§3.30.6 reshape rule R-RS-7), and its work spec is sourced from `Plan.VerifyRi` (§3.2.6 carries the original concept). It is never `force_failed` (analyzer `OE0042` rejects the operator action).
- **`expectsNoChanges = true` jobs** (§3.30.2 phase semantics) do not skip any transition — their commit phase succeeds-with-no-commit instead of failing, but the state-machine path is identical.

Analyzer **`OE0042`** validates `IJobStateMachine` impls: every transition method body must end with a single call to `EmitTransition(...)` and must reject any `(from, to)` pair not in the §3.30.1.2 table.

### 3.30.2 Phase pipeline — 8-phase normative contract

Every running job executes the same 8-phase pipeline. Phase boundaries are the only places where work-spec validation, persistence, retries, and event emission occur. The pipeline runs **once per attempt** (§3.30.1.4).

#### 3.30.2.1 Phase enumeration

```csharp
public enum ExecutionPhase
{
    MergeFi    = 1, // Forward-integrate: merge latest of each upstream commit into this attempt's worktree
    Setup      = 2, // worktreeInit (§ existing) + per-job env materialization + secret injection
    Prechecks  = 3, // User-supplied or auto-derived validation BEFORE work runs
    Work       = 4, // The job's primary work (agent / shell / process / shell-flavored work spec)
    Commit     = 5, // git add/commit + push to per-attempt branch (§3.3); zero-change handling here
    Postchecks = 6, // User-supplied validation AFTER work commits
    MergeRi    = 7, // Reverse-integrate: merge this job's commit into the snapshot branch (§3.3)
    Finalize   = 8, // Release lease, archive logs, emit terminal event; never user-facing
}
```

#### 3.30.2.2 Per-phase normative table

Columns: `Pre` (precondition the phase guarantees on entry), `Work` (what runs), `Post` (postcondition the phase guarantees on success), `Persist` (what is durably written before declaring success), `OnFail` (failure semantics & auto-heal eligibility), `SkipIf`.

| # | Phase | Pre | Work | Post | Persist | OnFail | SkipIf |
|---|---|---|---|---|---|---|---|
| PH-1 | MergeFi | Worktree lease held; base commit checked out | Iterate dependencies in topological order; for each dep merge its `headCommit` into worktree (§3.3.x); abort on conflict | Worktree HEAD = base ∪ dep commits | `attempts/<n>/phase/merge-fi/{exit,duration,mergedFrom[]}.json`; conflict report on failure | Auto-heal: `git merge --abort`, agent-driven resolution (single retry); else terminal Fail | Never |
| PH-2 | Setup | MergeFi succeeded | Run `worktreeInit` (§ existing); materialize per-job env (incl. plan-level env merge); install agent hooks (§3.2.6.6); validate path safety (§3.19) | Env block ready; hooks present; setup script exit 0 | `attempts/<n>/phase/setup/{env-snapshot.json,exit,duration}.json` (env redacted) | Auto-heal: re-run `worktreeInit` once; else Fail | Never |
| PH-3 | Prechecks | Setup succeeded; env in place | Execute `job.prechecks` work spec via the same pipeline as `work` (process / shell / agent) | Prechecks exit 0 | `attempts/<n>/phase/prechecks/log.bin`, `result.json` | Auto-heal: re-run once if work spec is process/shell and exit code in `[1,2]` (transient); else Fail | `job.prechecks == null` |
| PH-4 | Work | Prechecks passed (or skipped) | Execute `job.work` via the appropriate runner: `IAgentRunner` for agent specs, `IShellRunner` family for shell specs (§3.2.8), `IProcessLifecycle` direct for process specs | Work exit 0 (or `expectsNoChanges` semantics permit) | `attempts/<n>/phase/work/log.bin`, `agent-events.jsonl` (when agent), `result.json` | Auto-heal per §3.30.8 policy table (transient retry, agent retry-with-fresh-session, agent retry-with-resume) | Never |
| PH-5 | Commit | Work succeeded | `git add -A`; if changes present → `git commit -m "<auto>"` then `git push` to `attempts/<n>/branch`; if no changes → see ZeroChange rule | HEAD updated; remote ref pushed (or zero-change recorded) | `attempts/<n>/phase/commit/{commitSha,changedFiles[],zeroChange}.json` | Auto-heal: stash + retry-from-prechecks once on push race; else Fail. **ZeroChange rule:** if `job.expectsNoChanges == true`, record `zeroChange=true` and succeed; else fail with `NoChangesProduced` | Never |
| PH-6 | Postchecks | Commit succeeded | Execute `job.postchecks` work spec | Postchecks exit 0 | `attempts/<n>/phase/postchecks/log.bin`, `result.json` | Auto-heal: agent retry-from-postchecks (with the failure log fed back into agent context); shell/process: single re-run | `job.postchecks == null` |
| PH-7 | MergeRi | Postchecks passed | Merge this job's commit into the plan's snapshot branch (§3.3); cherry-pick if linear-history mode | Snapshot branch advanced; remote pushed | `attempts/<n>/phase/merge-ri/{snapshotSha,strategy}.json` | Auto-heal: snapshot lock contention (§3.30.7) → wait + retry once; merge conflict → escalate to operator; else Fail | Never |
| PH-8 | Finalize | MergeRi succeeded | Release worktree lease (§3.30.7); archive logs (§3.30.11 retention); emit `JobSucceeded`; trigger downstream readiness sweep | Lease released; job terminal-success | `jobs/<id>/state.json` updated atomically | Cannot fail (all I/O is best-effort with bounded retries); failures here log but do NOT regress to `Failed` | Never |

#### 3.30.2.3 Phase invariants

| # | Invariant |
|---|---|
| PI-1 | Phases run **strictly sequentially per attempt**. No phase parallelism within a job. (Cross-job parallelism is §3.30.4.) |
| PI-2 | Each phase has its own log file under `attempts/<n>/phase/<phase>/log.bin`. Logs are **never overwritten**; retries (T13) start a new `attempts/<n>/phase/<phase>/retry-<r>/` subtree. |
| PI-3 | Phase transitions emit `PhaseStarted` and `PhaseEnded` events (§3.30.5). The event payload references the log path + byte length; logs themselves do not flow through the bus (§3.6 efficiency). |
| PI-4 | A phase MUST persist its result.json **before** emitting `PhaseEnded`. Crash between persist and emit is recovered as "phase succeeded but bus lost the event" — the recovery path (§3.30.12) re-derives the missing event from the persisted result. |
| PI-5 | Auto-heal retries (T13) are bounded by `job.autoHeal.maxAttemptsPerPhase` (default 1 except agent work, which defaults to 2 — see §3.30.8). |
| PI-6 | A phase failure that exhausts auto-heal terminates the job attempt (T12). The next user retry (T16) starts a brand-new attempt at PH-1. There is no "resume from failed phase" within an existing attempt — new attempt always re-runs every phase from MergeFi. This is intentional: it ensures the worktree state is reproducible. |
| PI-7 | Phase implementations are stateless — all state lives in the worktree + persisted result.json. Daemon restart mid-phase (§3.30.12) detects the orphan and either resumes (if the underlying process is still alive) or marks the phase failed-by-crash. |
| PI-8 | The agent-side `IAgentRunner` is invoked **only inside PH-4 (Work)**. Agents do not run prechecks, postchecks, or merges. (Operator-driven agent assistance for merge-conflict resolution in PH-1/PH-7 is a separate, scoped invocation that emits its own `AssistRunStarted/Ended` events.) |

Analyzer **`OE0043`** validates phase implementations: every concrete `IPhaseRunner` must implement `RunAsync(PhaseContext, CancellationToken)` returning a `PhaseResult` whose `.Persisted` flag is true before the method returns success.

### 3.30.3 Plan-store atomicity & on-disk schema

The plan store is the durable system-of-record. Every state-machine transition (§3.30.1) and every phase result.json (§3.30.2) goes through it. It is the foundation for crash recovery (§3.30.12) and event replay (§3.30.5).

#### 3.30.3.1 Storage form

A **per-plan directory tree on the local filesystem**, rooted at `<repoRoot>/.aio/.ps/plans/<planId>/`. We deliberately reject SQLite/embedded-DB for v1 because (a) every operation is plan-scoped (no cross-plan transactional needs), (b) directory + JSON files are trivially diffable / inspectable / hand-editable in an emergency, (c) git ignores this tree but ops can `tar` it for support, (d) zero native dependency surface for trimmed self-contained binaries.

```
.aio/.ps/
├── plans/
│   └── <planId>/
│       ├── plan.json                # Plan metadata: name, baseBranch, targetBranch, status, env, maxParallel, …
│       ├── topology.json            # Job DAG: producerIds, deps, groups (ordering-stable serialization)
│       ├── lease.lock               # Single-writer lease (§3.30.7); contains ownerPid + heartbeatNanos
│       ├── events.log               # Append-only JSONL event journal (§3.30.5 replay source)
│       ├── events.idx               # Compact binary index: { sequence → byteOffset } every 256 events
│       ├── jobs/
│       │   └── <jobId>/
│       │       ├── job.json        # Producer ID, group, work spec, prechecks, postchecks, autoHeal flags
│       │       ├── state.json       # Current JobState + scheduledAt/startedAt/succeededAt + currentAttempt
│       │       └── attempts/
│       │           └── <n>/         # 1-based, monotonic
│       │               ├── attempt.json   # Started/ended timestamps, worktreePath, finalDisposition
│       │               └── phase/
│       │                   └── <phase>/
│       │                       ├── result.json
│       │                       ├── log.bin       # Raw bytes; preferred for mmap reads (§3.6.3)
│       │                       └── retry-<r>/    # Auto-heal retries inside this phase
│       └── snapshots/
│           ├── current.json         # Latest accepted snapshot (commit SHA + job-set)
│           └── archive/<rev>.json
└── plan-index.json                  # Lightweight cross-plan index: { planId, name, status, lastEventSequence }
```

#### 3.30.3.2 Atomic-write protocol (RW-* rules)

| # | Rule |
|---|---|
| RW-1 | Every JSON file is written via the `temp-then-rename` protocol: write `<file>.tmp.<pid>.<nanos>`, `fsync(fd)`, `rename(.tmp → final)`. On POSIX `rename` is atomic; on Windows we use `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` which is atomic on the same volume (we guarantee single-volume by storing under `.aio/.ps/` colocated with the repo). |
| RW-2 | Multi-file updates that must be observed atomically (e.g., adding a job = `topology.json` + `jobs/<id>/job.json` + `jobs/<id>/state.json`) use a **journal-then-apply** sequence: write a single `.aio/.ps/plans/<planId>/journal/<txnId>.json` containing the intended writes; fsync; replay the journal entries onto disk in order; delete the journal entry. Crash recovery (§3.30.12) replays any leftover journal entries idempotently. |
| RW-3 | `events.log` is append-only via `O_APPEND` (POSIX) / `FILE_APPEND_DATA` (Windows). Each line ends with `\n`. A torn write (partial trailing line, e.g., from power loss) is detected on next open by JSON-parse failure of the last line; the truncated bytes are sliced off and recovery emits a `RecoveryTruncatedTail { droppedBytes }` event (§3.30.12). |
| RW-4 | `events.idx` is a **derived** artifact rebuilt from `events.log` on demand if missing or stale (`events.log.size > idx.lastIndexedOffset + 16 MiB` triggers a rebuild). It is never the system-of-record; losing it loses no data. |
| RW-5 | `lease.lock` is held by `flock(LOCK_EX | LOCK_NB)` (POSIX) or `LockFileEx(LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY)` (Windows). The contents (ownerPid + heartbeat) are advisory only; the lock itself is the authority. See §3.30.7. |
| RW-6 | All filenames inside `.aio/.ps/` are ASCII-only and bounded to 80 chars to stay under Windows `MAX_PATH` even when the repo is deeply nested. The transformation `jobId → filesystemSlug` is `Base32-Crockford(SHA256(jobId))[..16]` (§3.15 long-path mitigation). |
| RW-7 | Per-plan total size is bounded (§3.11 disk quota). When approaching cap, oldest archived attempt directories are tombstoned (renamed to `.aio/.ps/.trash/`) and pruned by the daemon's GC sweep. |
| RW-8 | On-disk schema version is in `plan.json`'s top-level `"$schema": "ai-orchestrator.plan/1"`; mismatched schemas trigger §3.11 migration. Adding fields is M2-additive; renaming requires migration. |
| RW-9 | The plan store NEVER stores secrets in plaintext. Env values matching `ISecretRedactor`'s patterns (§3.2.6 ENV4) are redacted to `***` before persistence. The redactor's pattern set is itself versioned and persisted to `plan.json` so re-redaction on read is deterministic. |
| RW-10 | All persistence I/O happens via `IPlanStore` which is the **single** interface that reads/writes this tree. Direct `File.WriteAllText` on plan-store paths is forbidden by analyzer **`OE0044`**. |

#### 3.30.3.3 TS↔C# coexistence

The TS implementation today writes a different on-disk shape under `.orchestrator/`. The C# `IPlanStore` v1 reads the new `.aio/.ps/` shape only — TS plans are migrated by a one-shot tool (§3.11 migration; not auto-converted at read-time). This keeps the C# read path simple. Coexistence period: TS extension keeps writing `.orchestrator/`; new C# extension installs trigger migration and from then on only `.aio/.ps/` is live. The migration tool emits a `MigrationCompleted { fromPath, toPath, planCount }` event so the user sees what happened.

#### 3.30.3.4 Schema integrity tests

A unit-test gate (`PlanStoreSchemaTests`) round-trips every record type through System.Text.Json with the source-generated context, asserts the JSON shape matches a committed golden file under `src/test/fixtures/plan-store-schema/<recordTypeName>.json`, and rejects any field addition that hasn't moved a line in `PublicAPI.Shipped.txt` (§2.3.4). Field renames are caught by the goldens; field-removal is forbidden by `Microsoft.DotNet.PackageValidation` (§2.3.1).

### 3.30.4 Scheduler contract — readiness, fairness, blocking

The scheduler decides **which Ready job runs next**. It is the single owner of T2/T3/T5/T19 (state-machine readiness transitions). It is stateless across decisions — every decision is computed from `IPlanStore` snapshot + cross-plan capacity counters + per-plan paused state.

#### 3.30.4.1 Inputs and outputs

```csharp
public interface IScheduler
{
    /// <summary>
    /// One sweep across all running plans. Computes readiness, propagates blocked-by-failure,
    /// and dispatches up to N jobs (where N is bounded by global + per-plan capacity).
    /// Idempotent — re-running the same sweep with no state changes produces no transitions.
    /// </summary>
    Task<SchedulerSweepResult> SweepAsync(SchedulerSweepRequest request, CancellationToken ct);
}

public sealed record SchedulerSweepRequest
{
    public required SchedulerTrigger Trigger { get; init; } // Periodic | JobStateChange | PlanResume | Reshape | CapacityFreed
    public PlanId? OnlyPlan { get; init; } // optional scoping for targeted sweeps
}

public sealed record SchedulerSweepResult
{
    public required IReadOnlyList<JobId> NewlyReady   { get; init; }
    public required IReadOnlyList<JobId> NewlyBlocked { get; init; }
    public required IReadOnlyList<JobId> Dispatched   { get; init; }
    public required int CapacityRemainingGlobal { get; init; }
    public required IReadOnlyDictionary<PlanId, int> CapacityRemainingPerPlan { get; init; }
}
```

#### 3.30.4.2 Readiness algorithm (R-RD-*)

| # | Rule |
|---|---|
| R-RD-1 | A job is `Ready`-eligible iff every dep is `Succeeded`. |
| R-RD-2 | A job is `Blocked`-eligible iff any dep is in `{Failed, ForceFailed, Canceled, Blocked}`. |
| R-RD-3 | Blocked-propagation is transitive but lazy: a `Pending` job does not become `Blocked` until the readiness sweep visits it AND finds the failure ancestor. (No background propagation thread; transitions only fire during sweeps.) |
| R-RD-4 | A job in `Pending` whose ancestor recovers (T16 retry) returns to readiness on the next sweep — there is no separate "unblock" command. |
| R-RD-5 | Readiness sweeps are triggered by: scheduler periodic timer (default 250 ms), any `JobStateChanged` event, any `PlanResumed` event, any `ReshapeApplied` event, any `CapacityFreed` event (a job moved to terminal). The implementation deduplicates trigger storms within a 50 ms window. |

#### 3.30.4.3 Dispatch algorithm (R-DP-*)

| # | Rule |
|---|---|
| R-DP-1 | Across all plans, the global concurrent-job cap is `IGlobalCapacity.MaxConcurrentJobs` (default 8; configurable). The cap counts jobs in `Scheduled` ∪ `Running`. (Cross-references §3.9 for cross-daemon cap.) |
| R-DP-2 | Per-plan cap: `plan.maxParallel` (default `0` = unlimited, defers to global). When `> 0`, the plan-level count is applied additionally. |
| R-DP-3 | Per-runner cap: each `IAgentRunner` declares `Capabilities.MaxConcurrent` (default `int.MaxValue`); the dispatcher counts agent-spec work-types per runner. Vendor quotas (§3.30.9) are an additional gate but not a dispatch cap. |
| R-DP-4 | Dispatch order across plans is **weighted-round-robin by plan submission time**: each plan gets one dispatch turn per round; plans with no Ready jobs skip. This prevents one large plan from starving others, and the deterministic ordering makes dispatch reproducible in tests. |
| R-DP-5 | Within a plan, Ready jobs dispatch in **deterministic order**: ascending `(group_path, producerId)` lexicographic. (No priority field in v1; group ordering gives users a reliable knob via group naming.) |
| R-DP-6 | A job fails to dispatch (back to `Ready`, no transition) iff its worktree lease cannot be acquired non-blockingly (§3.30.7). The scheduler logs `LeaseUnavailable { jobId, leaseHeldBy }` and tries the next Ready job. The blocked job retries on the next sweep. |
| R-DP-7 | Plans in `Paused` state are excluded from dispatch entirely. Already-`Running` jobs in a paused plan are NOT canceled — they run to completion; only new dispatch is suspended. |
| R-DP-8 | Plans waiting on `resumeAfterPlan` (§3.30.13) are excluded until their dependency plan reaches `Succeeded`. |
| R-DP-9 | When global capacity hits zero, the scheduler exits the sweep without back-pressure signaling — capacity-freed events trigger the next dispatch attempt (R-RD-5). No spinning. |
| R-DP-10 | The scheduler is **single-threaded per daemon** — sweeps execute on a dedicated `Channel<SchedulerSweepRequest>` consumer. This eliminates internal locking. Cross-daemon coordination is §3.30.7's lease + §3.9 capacity coordination. |

#### 3.30.4.4 Fairness & starvation guarantees

| # | Guarantee |
|---|---|
| FAIR-1 | No plan can hold global capacity for more than `plan.maxParallel || GlobalCap / activePlanCount` slots simultaneously when other plans have Ready work. (R-DP-4 round-robin.) |
| FAIR-2 | No job can be starved indefinitely: dispatch order is deterministic (R-DP-5), so a Ready job either dispatches on its turn or its turn shifts forward when the head-of-queue job consumes a slot. |
| FAIR-3 | Lease contention (R-DP-6) does not starve: the scheduler's sweep cadence (250 ms) bounds wait time, and the lease holder is bounded by `LeaseHoldTimeout` (§3.30.7). |
| FAIR-4 | Reshape (§3.30.6) cannot starve in-flight jobs — reshape applies between sweeps, never preempting a Running job. |

Analyzer **`OE0045`** validates `IScheduler` impls have no `lock`/`Monitor`/`Mutex`/`SemaphoreSlim` usage outside the dedicated sweep channel — all coordination must be through the channel.

### 3.30.5 Event-bus topology — back-pressure, replay, late subscribers

The event bus (§3.4) is the public read surface for plan progress. This subsection adds the **DAG-specific** semantics on top of §3.4's transport.

#### 3.30.5.1 Sequence numbers (SEQ-*)

| # | Rule |
|---|---|
| SEQ-1 | Every event carries a `Sequence` (`long`, 1-based) that is **globally monotonic per plan** and **persistent across daemon restarts**. The next-sequence value is loaded from the plan store on daemon startup (`max(events.log)+1`); it is the daemon's responsibility to never decrement or repeat. |
| SEQ-2 | `Sequence` is allocated atomically with persist of the event to `events.log` — there is no window where an event is published but not persisted (§3.30.5.2 commit ordering). |
| SEQ-3 | Cross-plan ordering is NOT guaranteed — sequences are per-plan. Subscribers that span multiple plans must merge by `(planId, sequence)` and use `At` (UTC nanoseconds) as a coarse correlator. |
| SEQ-4 | Events emitted by recovery (§3.30.12) carry their original sequence (not new ones); replay is byte-identical to the first emission. |

#### 3.30.5.2 Commit ordering (CO-*)

| # | Rule |
|---|---|
| CO-1 | An event is *committed* when its line is appended-and-fsynced to `events.log`. Bus delivery happens **after** commit. Subscribers therefore can never see an event the daemon would lose on a crash 1 ms later. |
| CO-2 | State-machine transitions (§3.30.1) and phase-result persists (§3.30.2 PI-4) are **single transactions**: state-write + event-append are journaled together (§3.30.3 RW-2). |
| CO-3 | Bus delivery is best-effort post-commit. If the bus's in-memory channel is full (back-pressure, §3.30.5.4), the event is still committed — late subscribers get it via replay. Producers never block on subscribers. |

#### 3.30.5.3 Subscription model (SUB-*)

```csharp
public sealed record SubscribeRequest
{
    public required PlanId PlanId { get; init; }
    /// <summary>
    /// Sequence to start from. 0 = "live only" (no replay); -1 = "from beginning" (full history);
    /// any positive N = "give me events with sequence > N" (typical reconnect case).
    /// </summary>
    public long FromSequence { get; init; } = 0;
    public IReadOnlyList<EventKindFilter> Filter { get; init; } = []; // empty = all
    public BackpressureMode Backpressure { get; init; } = BackpressureMode.DropOldestOnOverflow;
    public int? PerSubscriberQueueDepth { get; init; } // default 1024
    public IReadOnlyDictionary<string, JsonElement> Extensions { get; init; }
        = ImmutableDictionary<string, JsonElement>.Empty;
}

public enum BackpressureMode
{
    DropOldestOnOverflow = 0, // Default: lossy ring buffer; subscriber sees a Gap event with dropped count
    BlockProducerOnOverflow = 1, // Reserved; not implemented in v1 (would create back-pressure into the engine)
    CloseOnOverflow = 2,      // Disconnect the slow subscriber; client reconnects with FromSequence to catch up
}
```

| # | Rule |
|---|---|
| SUB-1 | The engine supports **multiple concurrent subscribers per plan** (VS Code panel + MCP client + CLI watch can all subscribe simultaneously). |
| SUB-2 | Each subscriber gets its own `Channel<AiOrchestratorEvent>` of `PerSubscriberQueueDepth` (default 1024). Slow subscribers do NOT slow other subscribers or producers. |
| SUB-3 | **Replay**: when `FromSequence > 0`, the bus first streams persisted events `(FromSequence, current]` from `events.log` (using `events.idx` for O(log N) seek), then switches to live delivery without a gap. The seam is invisible to the subscriber. |
| SUB-4 | **Replay correctness**: replayed events are byte-identical to live events (same Sequence, same payload). A reconnecting client that asks `FromSequence = lastSeen` can resume exactly where it left off. |
| SUB-5 | **Gap signaling**: when `BackpressureMode.DropOldestOnOverflow` drops events, the next live event delivered carries a synthetic `EventStreamGap { droppedCount, droppedFromSequence, droppedToSequence }` immediately before it, so the subscriber knows to fetch the gap by sequence. |
| SUB-6 | Subscribers track their own `lastSeenSequence`; reconnecting with that value triggers replay (SUB-3) to deliver everything missed. This is the canonical recovery path for any disconnect (network, reload-window, daemon restart). |
| SUB-7 | Subscriber lifetime is bounded by an `IAsyncDisposable` handle (§3.8). On dispose the channel is completed and any in-flight delivery cancels. |
| SUB-8 | Subscribers that have been blocked on consumption for > `SubscriberStallTimeout` (default 30 s) are automatically disconnected (with `CloseOnOverflow` semantics applied) and a `SubscriberDisconnected { reason: "stall" }` is recorded. The client must reconnect to continue. |

#### 3.30.5.4 Back-pressure (BP-*)

| # | Rule |
|---|---|
| BP-1 | Producers (state-machine, phases, agent runners) NEVER block on the bus. Commit-then-publish (§3.30.5.2 CO-3) means producers are bounded by `events.log` append latency, not subscriber speed. |
| BP-2 | The bus's per-subscriber channel is bounded; overflow behavior follows `BackpressureMode`. |
| BP-3 | Late subscribers (LATE-*) — see §3.30.5.5 — never miss data; they may merely receive it more slowly than live subscribers. |

#### 3.30.5.5 Late-subscriber & multi-host scenarios (LATE-*)

| # | Scenario | Behavior |
|---|---|---|
| LATE-1 | VS Code reload-window (TS extension reconnects 200 ms later) | Client reconnects with `FromSequence = lastSeen`; replay from `events.log` covers the gap; no events lost. |
| LATE-2 | MCP client connects mid-plan (from-beginning replay) | `FromSequence = -1` ⇒ replay all of `events.log` then live; same code path as LATE-1. |
| LATE-3 | Daemon restarted; client reconnects | Same as LATE-1 — daemon loads `max(events.log)` on startup so sequences resume monotonically (SEQ-1). The first event after restart is sequence `max + 1`. |
| LATE-4 | Two subscribers (Node binding + MCP) on same plan | Both get independent channels; both see the same Sequence values; both can independently resume. |
| LATE-5 | Subscriber stalls for 60 s, then resumes | Disconnected at 30 s (SUB-8). Client reconnects with `FromSequence`; replay covers stalled-while period. |
| LATE-6 | Plan deleted while subscriber is mid-replay | `events.log` deletion is the last step of plan delete (§3.30.13.5); ongoing replay-readers get an EOF; a final `PlanDeleted` event is delivered (LIFO from a snapshot). |

#### 3.30.5.6 Event taxonomy (DAG-specific events)

These are the DAG events emitted by the engine (cross-references the existing §3.4 base hierarchy):

| Event | When |
|---|---|
| `PlanCreated`, `PlanFinalized`, `PlanPaused`, `PlanResumed`, `PlanCanceled`, `PlanCompleted`, `PlanDeleted`, `PlanArchived` | Plan-level transitions |
| `JobAdded`, `JobRemoved`, `JobReshaped`, `JobInvalidated` | Topology changes |
| `JobReady`, `JobBlocked`, `JobScheduled`, `JobStarted`, `JobSucceeded`, `JobFailed`, `JobForceFailed`, `JobCanceled`, `JobRetryRequested`, `JobPhaseRetry` | State machine (§3.30.1.2) |
| `PhaseStarted`, `PhaseEnded` | Phase pipeline (§3.30.2 PI-3) |
| `EventStreamGap`, `SubscriberDisconnected` | Bus health (§3.30.5.3) |
| `RecoveryStarted`, `RecoveryCompleted`, `RecoveryTruncatedTail` | Recovery (§3.30.12) |
| `LeaseAcquired`, `LeaseReleased`, `LeaseStolen` | Worktree lease (§3.30.7 / §3.3) |
| `QuotaPressure`, `QuotaExceeded` | Quota awareness (§3.30.9) |

All inherit from `AiOrchestratorEvent` (M7). New subtypes are M2-additive.

Analyzer **`OE0046`** validates that `IEventBus` impls call `events.log` append before invoking subscriber channels (CO-1).

### 3.30.6 Reshape invariants on running plans

Reshape mutates the DAG topology after `finalize_copilot_plan`. It is the highest-risk surface in the engine because it can introduce cycles, orphan running jobs, or leave Snapshot Validation pointing at the wrong leaf set.

#### 3.30.6.1 Reshape operations (R-OP-*)

| Op | Semantics |
|---|---|
| `add_job` | Insert a new job; deps point at existing producerIds |
| `remove_job` | Delete an existing job — only allowed if job is in `Pending` ∪ `Ready` ∪ `Blocked` (R-RS-1) |
| `update_deps` | Replace a job's dependency list — allowed only on `Pending` ∪ `Ready` ∪ `Blocked` (R-RS-1) |
| `add_before` | Insert a new job, rewire an existing job to depend on the new one |
| `add_after` | Insert a new job, take over the existing job's dependents |
| `invalidate_node` | Force a `Succeeded` job back to `Pending` (T23); cascades downstream (re-runs every dependent) |

#### 3.30.6.2 Invariants (R-RS-*)

| # | Rule |
|---|---|
| R-RS-1 | Any reshape that mutates a job MUST find the job in a non-terminal state OR in `Failed` / `ForceFailed` (whose retry path is itself a reshape-like reset). `Scheduled` and `Running` jobs are immutable to reshape — the operation is rejected with `JobNotMutable { state, allowed }`. |
| R-RS-2 | All operations in a single `reshape_copilot_plan` request are **atomic**: either all apply or none. The implementation collects all changes, validates the resulting graph (cycles, dangling deps, lost dependents), and either commits or rejects. |
| R-RS-3 | Cycle detection runs on the post-reshape graph using DFS-with-three-coloring; rejection emits `ReshapeRejected { cause: "cycle", path: [jobId, …] }`. |
| R-RS-4 | The Snapshot Validation job (`producerId == "__snapshot-validation__"`) is auto-managed: its dependency set is **always** `leaves(graph) − {__snapshot-validation__}`. Any reshape that changes the leaf set re-syncs SV's deps as part of the same atomic apply (no separate SV reshape). |
| R-RS-5 | SV job itself cannot be removed, depended-on, or have its deps explicitly updated. Operator attempts return `OperationForbidden { job: "__snapshot-validation__" }`. |
| R-RS-6 | `invalidate_node(target)` cascades: every job reachable from `target` via the dependency graph is also invalidated (back to `Pending`). The cascade is computed before apply; the user sees `ReshapeImpact { invalidated: [jobId, …] }` in the result. |
| R-RS-7 | Reshape never preempts a Running job (FAIR-4). If an operation requires mutating a Running job, it is rejected; the operator must wait for the job to terminate (or force-fail it via T15) and then reshape. |
| R-RS-8 | Reshape acquires the plan's writer lease (§3.30.7) for the duration of the validate-and-apply, not just the apply. This ensures that a sweep cannot dispatch a job that reshape just removed. |
| R-RS-9 | Reshape emits `JobAdded` / `JobRemoved` / `JobReshaped` / `JobInvalidated` events (one per affected job) followed by a single `ReshapeApplied { txnId, ops, impact }` summary event. The summary is what triggers the next scheduler sweep (R-RD-5). |
| R-RS-10 | Adding a dependency to a job currently in `Ready` reverts it to `Pending` (T6). The next sweep re-evaluates readiness — likely transitioning back to `Ready` immediately if the new dep is `Succeeded`, or to `Blocked` if it isn't. |
| R-RS-11 | Reshape cannot violate the §3.16 DAG limits (max jobs, max depth, max fan-out). Hitting a limit aborts the reshape with `ReshapeRejected { cause: "limit-exceeded", limit, current }`. |

Analyzer **`OE0047`** validates that every reshape-applying method takes a single `ReshapeRequest` and is wrapped in the plan-store transactional journal (RW-2).

### 3.30.7 Single-writer plan-store lease

Two daemons must never simultaneously mutate the same plan store, but multiple read-only clients (CLI watchers, future telemetry exporters) MUST coexist.

#### 3.30.7.1 Lease shape (LS-*)

| # | Rule |
|---|---|
| LS-1 | Each plan directory holds a `lease.lock` file; OS-level exclusive lock is the authority (RW-5). |
| LS-2 | Lease contents (advisory, but useful for diagnostics): `{ ownerPid, ownerHostname, ownerStartedAtUtc, lastHeartbeatUtc, daemonVersion, leaseEpoch }`. |
| LS-3 | The owner refreshes `lastHeartbeatUtc` every 5 s (`HeartbeatInterval`). |
| LS-4 | Other daemons attempting to acquire the lease retry every 1 s for up to 30 s (`AcquireTimeout`); on timeout they fall back to read-only mode (LS-7). |
| LS-5 | A lease whose `lastHeartbeatUtc` is older than `15 s` (`StaleAfter`) is considered abandoned; any other daemon may steal it by overwriting the lock file contents and incrementing `leaseEpoch`. The previous owner detects the steal on its next heartbeat (it sees a higher `leaseEpoch`) and self-terminates write operations with `LeaseLost { stolenBy }`. |
| LS-6 | The lease is released cleanly on graceful daemon shutdown (lease file truncated, lock released). Crash-shutdown leaves the file but the OS releases the lock — next acquirer sees stale heartbeat after `StaleAfter`. |
| LS-7 | Read-only mode: a daemon that fails to acquire the lease can still serve reads (subscribe, get-status, get-graph) by reading directly from the plan store without holding the writer lease. It rejects any mutating RPC with `WriterUnavailable { actualOwner }`. The VS Code extension defaults to opening such a "secondary" connection automatically when a primary daemon already owns the plan, so the UI continues to render live updates without contention. |
| LS-8 | The CLI's `ai-orchestrator daemon attach` mode explicitly takes read-only role; `ai-orchestrator daemon start` takes writer role and refuses to start if the lease is held (unless `--steal` is passed). |
| LS-9 | Cross-machine leases are NOT supported. Plan stores are local-disk only (RW-6); any mount over NFS/SMB is rejected at startup with `UnsupportedFilesystem { path, fs }`. (libgit2 + remote filesystems is a known sharp edge; we don't ship support for it.) |

Worktree-level leases (per-job in PH-1/PH-8) are a separate concern documented in §3.3 — they protect against concurrent mutation of a single worktree. The plan-store lease here is per-plan and protects the persistence tree itself.

Analyzer **`OE0048`** validates that any IPlanStore-mutating method asserts `LeaseHeld()` as its first statement.

### 3.30.8 Auto-heal policy

Auto-heal is the engine's ability to retry a phase failure transparently — without burning a user-visible attempt — when the failure signature suggests a transient or deterministically-fixable cause.

#### 3.30.8.1 Trigger taxonomy

| Trigger class | Detection | Default eligibility | Default budget |
|---|---|---|---|
| `TransientNetwork` | Process exit + stderr matches `IRetryClassifier`'s transient set (429/5xx/connection-reset/socket-error/EAI_AGAIN) | All phases | 3 retries, exp backoff 30s/60s/120s (matches §3.2.6 L11/L12) |
| `AgentContextExhausted` | `AgentContextPressure { level: Critical }` followed by exit | PH-4 only | 1 retry with **fresh session** (`SessionId = null`) |
| `AgentSessionLost` | Agent emits session-not-found error | PH-4 only | 1 retry with fresh session |
| `MergeConflict` | git merge exit + conflict markers in worktree | PH-1, PH-7 | 1 agent-driven resolution attempt (operator-overridable) |
| `WorktreeLeaseTransient` | Lease acquire failed with retryable code | PH-1 setup | 3 retries with 1s backoff |
| `Postcheck Auto-fix` | Postcheck failure + job has `autoHeal.postcheckRetryWithAgent = true` | PH-6 only | 1 agent retry, agent given postcheck output |
| `ToolMissingTransient` | Setup phase reports missing CLI that subsequently appears (probe re-resolution) | PH-2 only | 1 retry after CLI-probe cache invalidation |
| (none of above) | Any other failure | — | No auto-heal; immediate T12 |

#### 3.30.8.2 Per-job policy (AH-*)

```csharp
public sealed record AutoHealPolicy
{
    public bool Enabled { get; init; } = true;
    public int MaxAttemptsPerPhase { get; init; } = 1;     // PI-5 default
    public int MaxAgentRetriesPerAttempt { get; init; } = 2; // applies to PH-4/PH-6
    public TimeSpan TransientBackoffBase { get; init; } = TimeSpan.FromSeconds(30);
    public bool PostcheckRetryWithAgent { get; init; } = false;
    public IReadOnlySet<AutoHealTrigger> SuppressedTriggers { get; init; } = ImmutableHashSet<AutoHealTrigger>.Empty;
}
```

| # | Rule |
|---|---|
| AH-1 | Auto-heal retries occur **within the same attempt** (T13 Running→Running). They do NOT increment `attempt`. They DO emit `JobPhaseRetry { phase, retryNumber, trigger }`. |
| AH-2 | When auto-heal exhausts (budget depleted OR trigger not eligible), the phase fails terminally → T12 → user must `retry_copilot_job` (T16) for a fresh attempt. |
| AH-3 | Per-attempt agent-retry budget (`MaxAgentRetriesPerAttempt`) is independent of per-phase budget. An agent in PH-4 might use 2 of 2 agent retries; postchecks in PH-6 can still use its own budget. |
| AH-4 | Operator setting `autoHeal.Enabled = false` on a job disables all auto-heal — every failure is immediately T12. Useful for "expects no changes" validation jobs where we want the failure surfaced fast. |
| AH-5 | Auto-heal decisions are **deterministic given (failureSignature, attemptHistory)** so test-replay produces the same retry path. The decision is made in `IAutoHealClassifier.Classify(failure) → HealVerdict { trigger, retry, backoff }`. |

### 3.30.9 Quota / rate-limit awareness

Premium-request budgets (Copilot CLI), API rate limits, and per-runner concurrency caps are first-class scheduler inputs.

#### 3.30.9.1 Quota model (Q-*)

```csharp
public sealed record QuotaState
{
    public required AgentRunnerId  RunnerId        { get; init; }
    public required QuotaWindow    Window          { get; init; } // Daily | Monthly | None
    public required decimal        UsedUnits       { get; init; }
    public required decimal        BudgetUnits     { get; init; }
    public required DateTimeOffset WindowResetAt   { get; init; }
    public required QuotaSource    Source          { get; init; } // CliReported | Inferred | UserConfigured
}
```

| # | Rule |
|---|---|
| Q-1 | Quota state is **per-`AgentRunnerId` + per-window**. Copilot reports `Premium requests` via stats footer (P-ST-1 in §3.2.6.4) — the runner publishes a `QuotaUpdated` event after every run. |
| Q-2 | The scheduler consults `IQuotaLedger.GetCurrentAsync(runnerId)` before dispatching agent work. If `UsedUnits ≥ BudgetUnits * 0.95` (configurable `QuotaPressureThreshold`), it emits `QuotaPressure` and slows dispatch (one agent at a time, regardless of capacity). |
| Q-3 | If `UsedUnits ≥ BudgetUnits` (`QuotaExceededThreshold`), agent dispatch is **blocked entirely** until `WindowResetAt` or operator override. The scheduler emits `QuotaExceeded` and parks Ready agent jobs. They re-become eligible automatically at reset. |
| Q-4 | Quota-blocking does NOT mark jobs Failed — they stay Ready, just not dispatched. Operators see them in the panel as "waiting on quota". |
| Q-5 | The user can set per-plan or per-job `MaxPremiumRequests` budgets that the scheduler also enforces (a plan refusing to exceed N requests will park its agent jobs when N is reached). |
| Q-6 | API rate-limiting (429 responses) is a transient-class auto-heal trigger (§3.30.8) — distinct from quota. 429 = "slow down"; quota exhaustion = "stop until reset". |
| Q-7 | Each agent runner publishes its own quota schema; the engine treats `QuotaState` as opaque data. The Copilot runner publishes "Premium requests"; future runners may publish "tokens" or "dollars". UI projection layer renders human-friendly. |

### 3.30.10 Cancellation propagation chain

Cancel must propagate from user → plan → job → phase → process → agent CLI cleanly with bounded latency.

#### 3.30.10.1 Cancel cascade (CC-*)

| # | Source | Effect | Latency budget |
|---|---|---|---|
| CC-1 | `CancelAsync(planId)` RPC | Plan moves to `Canceling`; scheduler stops dispatching this plan; for every Running job, issue job-level cancel (CC-2) | < 100 ms (RPC return) |
| CC-2 | Job-level cancel (engine internal) | Cancel the phase's `CancellationTokenSource`; phase pipeline releases worktree lease; job moves to `Canceled` (T14) | < 5 s (phase teardown) |
| CC-3 | Phase-level cancel | If phase is currently in `IProcessLifecycle.Begin` returning a handle, call `IProcessLifecycle.StopAsync(handle, Reason.Cancel)` | < 100 ms (kick off escalation) |
| CC-4 | Process stop escalation | Per §3.2.6 L13/L14: SIGINT → 5 s → SIGTERM → 5 s → SIGKILL (POSIX); `taskkill /T /F` (Windows) | ≤ 10 s POSIX, < 1 s Windows |
| CC-5 | Agent runner notice | `IAgentRunner` observes process exit; emits `AgentCanceled`; cleans up native log tail (post-exit drain L15) | < 2 s after CC-4 |
| CC-6 | Plan terminal | After all jobs are terminal (Canceled or pre-existing terminal), plan moves to `Canceled`; emit `PlanCanceled` | (sum of CC-1..5) |

Total worst-case from `CancelAsync` returning to `PlanCanceled` event: **≤ 20 s** for a plan with one running agent. Multi-job plans cancel in parallel — same total bound.

#### 3.30.10.2 Cancel invariants

| # | Rule |
|---|---|
| CC-INV-1 | Cancel is **idempotent**: calling `CancelAsync` on an already-canceling/canceled plan is a no-op success. |
| CC-INV-2 | Cancel does NOT roll back committed phases. A job whose Commit phase succeeded but whose MergeRi was canceled remains in the per-attempt branch — operator can reach in via git tools. |
| CC-INV-3 | Cancel propagates downstream via blocked-by-canceled (R-RD-2) — `Pending` jobs whose ancestor canceled become `Blocked`, then `Canceled` when the sweep visits them with the plan in `Canceling`. |
| CC-INV-4 | A job cannot cancel itself from within its own phase work — cancellation is always external (operator or plan-cascade). |
| CC-INV-5 | Cancel fully respects §3.7's cancel-propagation transport rules — cancel frames flow through pipe/MCP/N-API the same way other RPCs do. |

### 3.30.11 Failure-context capture

Every job failure produces a structured artifact suitable for both human inspection (panel) and machine consumption (auto-heal classifier, telemetry).

#### 3.30.11.1 Captured artifacts (FC-*)

For each failed phase, under `attempts/<n>/phase/<phase>/failure/`:

| # | Artifact | Contents |
|---|---|---|
| FC-1 | `failure.json` | `{ phase, exitCode, durationMs, classifier: { trigger, retry, backoff }, message, byteRange { offset, length }, agentSessionId?, agentLastEventSeq?, processSnapshotPath? }` |
| FC-2 | `tail.bin` | Last 64 KiB of phase log (truncated UTF-8 boundary respected); referenced by `byteRange` in failure.json |
| FC-3 | `process-snapshot.json` | Process tree at time of failure (pid, name, RSS, CPU%) — best-effort |
| FC-4 | `env-snapshot.json` | Effective env at phase invocation (post-redaction) |
| FC-5 | `agent-summary.json` | When PH-4 work is agent: summary of `AgentEvent` sequence (counts by type, last session id, last context-pressure level) |

#### 3.30.11.2 Retention (FC-RT-*)

| # | Rule |
|---|---|
| FC-RT-1 | Failure artifacts for a job's **current attempt** are always retained until the job terminates Succeeded or the plan is deleted. |
| FC-RT-2 | Failure artifacts for **prior attempts** are retained per `Plan.RetainAttempts` (default 5). Older attempts are tombstoned during GC sweep (RW-7). |
| FC-RT-3 | Artifacts are deduplicated when retried with the same content (auto-heal retries within an attempt) — only the final attempt's tail is full-size; intermediate retries store `{ resultEqualsAttempt: <n> }`. |
| FC-RT-4 | `GetJobFailureContextAsync` returns the artifact set for the requested attempt (defaulting to current). The result is descriptor-only (paths + byte ranges); UX layer reads the bytes (E1 efficiency rule). |

### 3.30.12 Crash recovery semantics

Daemon crash mid-execution must not corrupt the plan store or lose persisted events.

#### 3.30.12.1 Recovery sweep (RC-*)

On daemon startup, before accepting any RPC, the recovery sweep runs for each plan in `plan-index.json` whose lease is acquirable:

| # | Step |
|---|---|
| RC-1 | Acquire plan-store lease (§3.30.7). |
| RC-2 | Replay any pending journal entries (RW-2): for each `journal/<txnId>.json`, apply its writes idempotently and delete the journal entry on success. |
| RC-3 | Validate `events.log` tail (RW-3): if the last line is partial, truncate to the last newline and emit `RecoveryTruncatedTail { droppedBytes }` (sequence is the next available, NOT a duplicate). |
| RC-4 | Rebuild `events.idx` if stale (RW-4). |
| RC-5 | For every job in `Scheduled` ∪ `Running`, evaluate the **orphan check**: |
|  | — If `state.json` records a `runningPid` and that pid (a) exists and (b) was started at the recorded `startedAt` and (c) the worktree path matches: declare the job **resumable** — re-attach the `IProcessLifecycle` handle (re-open log file at the persisted byte offset, re-subscribe to its output bus) and continue execution. |
|  | — Otherwise the job is **abandoned**: mark its current phase failed with `OrphanedByCrash`, transition Running→Failed (T12). User can retry. The worktree is left intact for forensic inspection. |
| RC-6 | Compute the next `Sequence` value as `max(events.log) + 1` (SEQ-1). |
| RC-7 | Emit `RecoveryStarted` and `RecoveryCompleted` events (sequence allocated normally) so subscribers see what happened. |
| RC-8 | The scheduler is then started; sweeps resume normally. |

#### 3.30.12.2 Recovery invariants

| # | Rule |
|---|---|
| RC-INV-1 | Recovery is idempotent: running it twice on an already-recovered store is a no-op (journal empty, no orphans). |
| RC-INV-2 | Recovery never destroys data — it only marks abandoned jobs failed and truncates torn `events.log` tails (with explicit logging). |
| RC-INV-3 | Recovery time is bounded: O(plans × pending-journal-entries) for the journal replay, plus O(scheduled-or-running-jobs) for orphan checks. Per-plan recovery is well under 1 s for typical sizes. |
| RC-INV-4 | A daemon that cannot complete recovery for a plan (e.g., journal corruption) marks the plan `RecoveryFailed` and excludes it from active management. The plan can still be inspected read-only. |
| RC-INV-5 | Recovery does NOT auto-resume execution of `Paused` plans. Pausedness is preserved across crashes. |

### 3.30.13 Cross-plan dependency state (`resumeAfterPlan`)

A plan with `resumeAfterPlan = otherPlanId` defers execution until `otherPlanId` reaches `Succeeded`.

#### 3.30.13.1 Cross-plan rules (CP-*)

| # | Rule |
|---|---|
| CP-1 | `resumeAfterPlan` is set at plan creation; it can be cleared via `update_copilot_plan` (§ existing) but NOT changed to a different plan (changing creates non-determinism in the dependency graph). |
| CP-2 | A plan with an unsatisfied `resumeAfterPlan` always starts in `Paused`. Even if the user passes `startPaused: false`, the engine overrides to true and emits a warning event `PlanAutoPausedForDependency`. |
| CP-3 | When the dependency plan reaches `Succeeded`, the dependent plan auto-resumes (R-DP-8 stops excluding it; the next sweep begins dispatching its Ready jobs). |
| CP-4 | If the dependency plan reaches `Failed`, `Canceled`, or `Deleted`, the dependent plan is **unblocked** (the dependency is dropped) and emits `PlanDependencyResolved { reason: "depFailed"/"depCanceled"/"depDeleted" }`. The user can choose to manually pause/cancel the now-unblocked plan if they prefer. |
| CP-5 | Cross-plan cycles are forbidden: creating plan B with `resumeAfterPlan = A` while A already has `resumeAfterPlan = B` is rejected at create time (R-CP-3 cycle check on the cross-plan graph). |
| CP-6 | The cross-plan graph is persisted in `plan-index.json` (§3.30.3.1) so recovery (RC-*) preserves dependency relationships. |
| CP-7 | Plan deletion of a plan with active dependents emits `PlanDependencyResolved { reason: "depDeleted" }` to each dependent before completing the delete. |

### 3.30.14 Tier-3 catalogs (metrics, OTel attrs, error codes, CLI/MCP/config)

These are the catalogs that get fleshed out as their first consumer is implemented; this subsection commits to their **schema and naming rules** so they can grow consistently.

#### 3.30.14.1 Metrics catalog (T3-MET-*)

OpenTelemetry `Meter` namespace: `AiOrchestrator`. Instruments live in `AiOrchestrator.Telemetry.Metrics`.

| Instrument | Type | Unit | Tags |
|---|---|---|---|
| `aio.plans.created` | Counter | plans | (none) |
| `aio.plans.completed` | Counter | plans | `outcome={succeeded\|failed\|canceled}` |
| `aio.jobs.scheduled` | Counter | jobs | `runner_id` |
| `aio.jobs.completed` | Counter | jobs | `outcome`, `runner_id`, `phase_failed?` |
| `aio.phase.duration` | Histogram | ms | `phase`, `runner_id`, `outcome` |
| `aio.scheduler.sweep.duration` | Histogram | ms | `trigger` |
| `aio.scheduler.dispatched_per_sweep` | Histogram | jobs | (none) |
| `aio.bus.events_emitted` | Counter | events | `kind` |
| `aio.bus.subscriber.queue_depth` | Histogram | events | `subscription_id` |
| `aio.bus.subscriber.dropped` | Counter | events | `subscription_id`, `mode` |
| `aio.process.spawn.duration` | Histogram | ms | `runner_id`, `cli_version` |
| `aio.process.kill.duration` | Histogram | ms | `os`, `escalated` |
| `aio.lease.wait.duration` | Histogram | ms | `kind={plan\|worktree}` |
| `aio.quota.utilization` | Gauge | ratio (0..1) | `runner_id`, `window` |
| `aio.recovery.duration` | Histogram | ms | `outcome` |
| `aio.persistence.write.duration` | Histogram | ms | `op={state\|event\|journal}` |

Naming convention: `aio.<domain>.<measurement>` lower-snake. New instruments are M2-additive. Analyzer **`OE0049`** validates every public engine method that performs measurable work either records to one of these or has `[NoMetricRequired]`.

#### 3.30.14.2 OpenTelemetry trace attributes (T3-OT-*)

Activity source: `AiOrchestrator`. Span attributes use the standard `<resource>.<attribute>` form:

| Attribute | Where set | Example |
|---|---|---|
| `aio.plan.id` | Every plan-scoped span | `01HZ…` |
| `aio.plan.name` | Every plan-scoped span | `release-v1` |
| `aio.node.id` | Every job-scoped span | `01HZ…` |
| `aio.node.producer_id` | Every job-scoped span | `build-typescript` |
| `aio.node.attempt` | Every attempt-scoped span | `2` |
| `aio.phase` | Phase pipeline spans | `work` |
| `aio.runner.id` | Agent/process spans | `github-copilot` |
| `aio.runner.cli_version` | Agent spans | `1.0.31` |
| `aio.work.kind` | Work-spec dispatch | `agent\|process\|powershell\|bash\|sh\|cmd` |
| `aio.lease.kind` | Lease wait spans | `plan\|worktree` |
| `aio.cancel.reason` | Cancel-cascade spans | `user\|timeout\|plan-cancel` |
| `aio.recovery.outcome` | Recovery span | `success\|truncated\|failed` |

All attribute names are invariant English (L2). All values are invariant or numeric. Analyzer **`OE0050`** validates attribute keys against the `T3-OT` table.

#### 3.30.14.3 Error code enumeration (T3-ERR-*)

Wire-facing error codes are stable invariant identifiers (§2.4 L2). Defined in `AiOrchestrator.Models.ErrorCode` (closed enum):

```csharp
public enum ErrorCode
{
    // Plan lifecycle (1xx)
    PlanNotFound = 100, PlanInvalidState = 101, PlanLimitExceeded = 102, PlanLeaseUnavailable = 103,

    // Job lifecycle (2xx)
    JobNotFound = 200, JobNotMutable = 201, JobAlreadyTerminal = 202, JobStateTransitionForbidden = 203,

    // Reshape (3xx)
    ReshapeCycle = 300, ReshapeDepNotFound = 301, ReshapeForbiddenForSv = 302, ReshapeLimitExceeded = 303,

    // Auto-heal / quota (4xx)
    AutoHealExhausted = 400, QuotaExceeded = 401, QuotaPressure = 402,

    // Process / agent (5xx)
    ProcessSpawnFailed = 500, ProcessTimedOut = 501, ProcessKilled = 502, AgentCliMissing = 503,
    AgentCliVersionUnsupported = 504, AgentSessionLost = 505,

    // Persistence / recovery (6xx)
    StoreCorrupt = 600, StoreSchemaUnsupported = 601, RecoveryFailed = 602,

    // Transport / auth (7xx)
    AuthRequired = 700, AuthFailed = 701, RpcMalformed = 702, RpcUnsupportedVersion = 703,

    // Resource (8xx)
    DiskFull = 800, PathTooLong = 801, FilesystemUnsupported = 802,
}
```

New codes are M2-additive (new gaps in any 100-block); renaming is forbidden. Each code has a corresponding `.resx` key for localized message (L5).

#### 3.30.14.4 CLI command surface (T3-CLI-*)

Top-level commands (System.CommandLine):

```
ai-orchestrator
  daemon   { start | stop | status | attach | restart }
  plan     { list | show | watch | cancel | pause | resume | delete | archive | recover | clone | reshape | export | import }
  job      { add | retry | force-fail | logs | failure-context }
  agent    { list | probe | capture-cli-corpus }
  fixtures { record | validate-corpus | render-handlers }
  config   { get | set | dump }
  doctor    # health check
```

All subcommands accept `--json` for machine-readable output (default human-readable). Help text is localized (L). Naming convention: kebab-case at every level. Analyzer **`OE0051`** validates command tree against this skeleton.

#### 3.30.14.5 MCP tool catalog (T3-MCP-*)

MCP tool names mirror today's TS surface (`scaffold_copilot_plan`, `add_copilot_plan_job`, `finalize_copilot_plan`, `get_copilot_plan_status`, `list_copilot_plans`, `pause_copilot_plan`, `resume_copilot_plan`, `cancel_copilot_plan`, `delete_copilot_plan`, `retry_copilot_plan`, `retry_copilot_job`, `force_fail_copilot_job`, `get_copilot_job`, `get_copilot_job_logs`, `get_copilot_job_failure_context`, `get_copilot_job_attempts`, `reshape_copilot_plan`, `update_copilot_plan`, `update_copilot_plan_job`, `bulk_update_copilot_plan_jobs`, `clone_copilot_plan`, `recover_copilot_plan`, `archive_copilot_plan`, `run_copilot_integration_test`) — preserved for MCP-client compatibility. Tool descriptions are localized via L mechanism. New tool names additive; renames go through MCP `tools/list_changed` notification.

#### 3.30.14.6 Configuration schema (T3-CFG-*)

`appsettings.json` shape (loaded via `Microsoft.Extensions.Configuration`):

```jsonc
{
  "AiOrchestrator": {
    "Daemon":     { "PipeName": "...", "AuthTimeoutSeconds": 5 },
    "Scheduler":  { "MaxConcurrentJobs": 8, "SweepIntervalMs": 250 },
    "Persistence":{ "Root": "${REPO}/.aio/.ps", "RetainAttempts": 5, "DiskQuotaMiB": 4096 },
    "Bus":        { "DefaultSubscriberQueueDepth": 1024, "SubscriberStallTimeoutSeconds": 30 },
    "Lease":      { "HeartbeatSeconds": 5, "StaleAfterSeconds": 15, "AcquireTimeoutSeconds": 30 },
    "Recovery":   { "EnabledOnStart": true },
    "Cultures":   { "Allow": ["en-US","fr-FR","ja-JP","qps-Ploc"] },
    "Telemetry":  { "OtlpEndpoint": null, "EnableMetrics": true, "EnableTraces": true },
    "Runners":    {
      "github-copilot": { /* AgentRunnerOptions */ },
      "claude":         { /* AgentRunnerOptions */ }
    }
  }
}
```

Strongly-typed via `IOptions<T>` per section. Schema is documented in `docs/CONFIG_SCHEMA.md` (generated from C# types via build target). Adding a key is M2-additive; removing is major. Env override prefix: `AI_ORCHESTRATOR__` (e.g., `AI_ORCHESTRATOR__SCHEDULER__MAXCONCURRENTNODES=4`).

#### 3.30.14.7 Daemon health-check schema (T3-HC-*)

`ai-orchestrator daemon status` returns:

```jsonc
{
  "version": "1.0.0",
  "uptimeSeconds": 1234,
  "pid": 5678,
  "leasedPlans": [{"planId":"...","name":"...","leaseEpoch":3,"runningJobs":2}],
  "schedulerSweeps": { "totalSinceStart": 5432, "lastDurationMs": 4 },
  "busSubscribers": 3,
  "diskUsage": { "rootMiB": 234, "quotaMiB": 4096 },
  "quotaState": [ /* Q-* per runner */ ],
  "warnings": []  // soft alerts: e.g., "lease close to stale", "subscriber stalled"
}
```

### 3.30.15 DAG-implementation execution plan

This is the dependency-ordered job list to actually build §3.30. It maps 1-to-1 to a `create_copilot_plan` we can stamp out as soon as you say go.

```mermaid
graph LR
    M[models-state-machine] --> P[persistence-store + lease]
    P --> B[event-bus + replay]
    B --> S[scheduler]
    S --> X[executor-skeleton]
    X --> PHF[phase: merge-fi]
    X --> PHS[phase: setup]
    X --> PHC[phase: prechecks]
    X --> PHW[phase: work + runner dispatch]
    X --> PHCM[phase: commit]
    X --> PHPC[phase: postchecks]
    X --> PHR[phase: merge-ri]
    X --> PHFI[phase: finalize]
    PHF --> RS[reshape]
    PHFI --> RS
    RS --> AH[auto-heal]
    AH --> Q[quota ledger]
    Q --> CC[cancel cascade]
    CC --> FC[failure-context capture]
    FC --> RC[crash recovery]
    RC --> CP[cross-plan deps]
    CP --> T3[tier-3 catalogs wiring]
    T3 --> IT[integration test pack]
```

| # | Job (producerId) | Depends on | Effort | What it delivers |
|---|---|---|---|---|
| 1 | `models-state-machine` | (none) | medium | `JobState` enum, `IJobStateMachine`, transition table tests, analyzer `OE0042` |
| 2 | `persistence-store-and-lease` | 1 | high | `IPlanStore`, journal protocol, `lease.lock`, recovery sweep skeleton, analyzers `OE0044` `OE0048` |
| 3 | `event-bus-and-replay` | 2 | high | `IEventBus`, `events.log` writer, `events.idx`, replay seek, gap signaling, analyzer `OE0046` |
| 4 | `scheduler` | 1, 2, 3 | medium | `IScheduler`, sweep loop, readiness algo, dispatch fairness, analyzer `OE0045` |
| 5 | `executor-skeleton` | 1, 2, 3, 4 | medium | `IPlanExecutor`, phase dispatcher, `IPhaseRunner` boilerplate, analyzer `OE0043` |
| 6a..6h | per-phase impls (`phase-merge-fi`, `phase-setup`, `phase-prechecks`, `phase-work`, `phase-commit`, `phase-postchecks`, `phase-merge-ri`, `phase-finalize`) | 5 | varies | One PR each; PH-4 is largest (runner dispatch) |
| 7 | `reshape` | 4, 5 | medium | `ReshapeRequest` ops, atomicity, SV auto-resync, analyzer `OE0047` |
| 8 | `auto-heal` | 5, 6a..6h | medium | `IAutoHealClassifier`, trigger taxonomy, retry budget |
| 9 | `quota-ledger` | 3, 4 | low | `IQuotaLedger`, scheduler integration |
| 10 | `cancel-cascade` | 4, 5, 6a..6h | low | Cancel chain wiring, latency budget tests |
| 11 | `failure-context-capture` | 5, 6a..6h | low | `failure.json` shape, retention sweep |
| 12 | `crash-recovery` | 2, 3, 5 | medium | RC-* sweep, orphan detection, `RecoveryStarted/Completed` events |
| 13 | `cross-plan-deps` | 4, 12 | low | `resumeAfterPlan` enforcement, cycle check |
| 14 | `tier3-catalogs` | 3..13 | medium | Metrics, OTel attrs, error codes, CLI/MCP/config schemas, analyzers `OE0049` `OE0050` `OE0051` |
| 15 | `integration-test-pack` | 1..14 | high | End-to-end fixtures replaying TS scenarios; G-Acceptance gates green |

Each job is sized to fit in one PR. Effort hints map to `effort: low/medium/high` on the future plan-creation call. The structure parallelizes naturally at jobs 6a..6h (eight phases concurrently).

#### Analyzer ledger after §3.30

| New analyzer | Section | Enforces |
|---|---|---|
| `OE0042` | §3.30.1.4 | Job-state transitions match the §3.30.1.2 table; SV job guarded |
| `OE0043` | §3.30.2.3 | Phase implementations persist `result.json` before declaring success |
| `OE0044` | §3.30.3.2 | Direct `File.WriteAllText` on plan-store paths is forbidden |
| `OE0045` | §3.30.4.4 | `IScheduler` has no in-process locking primitives |
| `OE0046` | §3.30.5.6 | Bus impls commit-then-publish |
| `OE0047` | §3.30.6.2 | Reshape methods take `ReshapeRequest` and use journal |
| `OE0048` | §3.30.7.1 | Plan-store mutating methods assert `LeaseHeld()` |
| `OE0049` | §3.30.14.1 | Public engine methods record metrics or carry `[NoMetricRequired]` |
| `OE0050` | §3.30.14.2 | OpenTelemetry attribute keys match the `T3-OT` table |
| `OE0051` | §3.30.14.4 | CLI command tree matches the `T3-CLI` skeleton |

**Next available analyzer is `OE0052`.**

---

## 3.31 v1.1 Remediation Addendum

This section consolidates the v1.1 design refinements adopted during the `pre-release/1.0.0` security & reliability review (April 2026). Each subsection cross-references the original section it amends. When the addendum disagrees with an earlier section, **the addendum wins** for v1 GA — the originating section will be folded in during the post-GA editorial pass. The addendum's review-tracked changes were sign-off-gated under the §0 status header process.

### 3.31.1 Security additions

#### 3.31.1.1 GCM URL allowlist (amends §3.3.1)

The per-remote credential resolver in §3.3.1 invokes `git credential fill` against any remote URL the worktree carries. A malicious `git config remote.<name>.url` set inside a worktree could redirect credential prompts to an attacker-controlled host. Mitigation:

| # | Rule |
|---|---|
| GCM-URL-1 | Before invoking `git credential fill`, the resolver parses the remote URL and validates `host` against the per-workspace allowlist `Auth:RemoteHostAllowlist` (default: `["github.com", "*.github.com", "ghe.io", "*.ghe.io"]`). Wildcards are leftmost-only label matching. |
| GCM-URL-2 | URLs whose `scheme` is not `https` or `ssh` are rejected outright. |
| GCM-URL-3 | URLs containing `@` userinfo are rejected (the credential should come from GCM, never from the URL). |
| GCM-URL-4 | A rejected URL emits `RemoteRejected { url, reason }` (Security category, audit-logged) and the credential resolution returns failure without invoking GCM. |
| GCM-URL-5 | The allowlist is hot-reloadable; changes take effect for the next resolution call. |

#### 3.31.1.2 EventFilter AuthContext (amends §3.4.2)

Subscribers to `IEventBus` carry an `AuthContext` describing the connection identity. The bus filter pipeline applies authorization before delivering events:

```csharp
public sealed record AuthContext
{
    public required string         ConnectionId  { get; init; }
    public required AuthPrincipal  Principal     { get; init; } // user|daemon|plugin|system
    public required IReadOnlySet<string> Scopes  { get; init; } // e.g., "events:plan:*", "events:audit:read"
    public required ConnectionOrigin Origin      { get; init; } // Local | RemotePipe | InProc
}

public interface IEventBusAuthorizer
{
    bool CanSubscribe(EventCategory category, AuthContext ctx);
    bool CanReceive  (AiOrchestratorEvent ev,    AuthContext ctx);
}
```

| # | Rule (EVT-AUTH-*) |
|---|---|
| EVT-AUTH-1 | Every `Subscribe` call carries an `AuthContext`; missing `AuthContext` is rejected with `auth_required`. |
| EVT-AUTH-2 | The default authorizer denies `Audit` and `Security` category events to any non-`daemon`/non-`system` principal. |
| EVT-AUTH-3 | Plugin-origin subscriptions are scoped to events emitted *by their own plugin*; cross-plugin event eavesdropping is denied by default. |
| EVT-AUTH-4 | Filter rejection emits a single `SubscriptionDenied { reason }` event back to the rejected subscriber and is recorded once in the audit log. |

#### 3.31.1.3 Diagnose bundle pseudonymization (amends §3.13.4)

The `daemon diagnose` bundle currently captures plan/job state, log files, and configuration. To make it safe to share with support without leaking customer data:

| # | Rule (DIAG-*) |
|---|---|
| DIAG-1 | Every captured file passes through `IDiagnoseRedactor` before bundling. The redactor applies (a) the standard `ISecretRedactor` regex set; (b) a path-pseudonymizer that replaces real worktree paths with stable hashes (`<wt-a3f9>`); (c) a content-pseudonymizer that replaces source-file content with `[REDACTED-N-LINES]` markers, retaining only file paths and line counts. |
| DIAG-2 | The bundle is wrapped in an age-encrypted (X25519) tarball; the public key is `support@ai-orchestrator` (published in the README). The user can disable encryption with `--unencrypted` if they need to inspect locally; encryption is the default. |
| DIAG-3 | The bundle's `manifest.json` lists every file with its size and a `redactionsApplied` count, so the support engineer knows what was scrubbed. |
| DIAG-4 | The bundle never includes private keys (KEY-STORE-7), nonces, tokens, or any file under `<dataDir>/keys/`. |
| DIAG-5 | The user is shown a one-screen confirmation before the bundle is written, listing the file count and whether sensitive material was found and redacted. |

#### 3.31.1.4 Cmd tempfile creation (amends §3.19, W3)

Tempfile-based `cmd.exe` invocation must atomically create the script file with exclusive ownership:

| # | Rule (CMD-TMP-*) |
|---|---|
| CMD-TMP-1 | The tempfile is created with `FileMode.CreateNew` + `FileShare.None` + `FileOptions.WriteThrough` and on POSIX with `O_CREAT | O_EXCL | O_NOFOLLOW`; on Windows with `CREATE_NEW`. Failure to create-exclusive aborts the spawn (no overwrite of an existing file). |
| CMD-TMP-2 | The file's ACL on Windows is set to owner-only via `FileSecurity.SetAccessRule(new FileSystemAccessRule(currentUser, FullControl, Allow))` with explicit `PurgeAccessRules` first; on POSIX the umask is `0077` and `chmod 0700` is asserted post-create. |
| CMD-TMP-3 | The tempfile path under `<cwd>/.aio/.ps/cmd-tmp/<guid>.cmd` is validated via `IPathValidator.OpenScopedAsync` (§3.19.1) so symlink/junction attacks are caught at `open()`, not after. |
| CMD-TMP-4 | Cleanup in `finally` (W3) uses the file handle, not the path, where possible \u2014 `File.Delete(path)` is the fallback when the handle has already been closed. |

#### 3.31.1.5 Trust-file ACLs (amends §3.10.3)

`~/.config/ai-orchestrator/trusted-publishers.json` stores plugin-trust pinned keys; tampering with this file is equivalent to bypassing plugin signature verification:

| # | Rule (TRUST-ACL-*) |
|---|---|
| TRUST-ACL-1 | The file's ACL is owner-only (POSIX 0600, Windows owner-only DACL). The daemon refuses to start if the file's permissions are weaker; an automatic permission-tighten is attempted, with `TrustFilePermissionsFixed` or `TrustFilePermissionsRefused` audit events. |
| TRUST-ACL-2 | The containing directory `~/.config/ai-orchestrator/` is also enforced 0700 / owner-only. |
| TRUST-ACL-3 | Any modification to the trust file goes through `IPluginTrustStore.AddAsync` / `RevokeAsync` / `RotateAsync`, never through direct file write. The store appends to an immutable transcript at `<dataDir>/trust-transcript.ndjson` (signed with the audit key, KEY-STORE-2) so trust changes are auditable across daemon lifetimes. |
| TRUST-ACL-4 | On startup the daemon verifies the trust-transcript chain; a broken chain emits `TrustTranscriptCorrupted` and refuses to load any plugin until the operator runs `ai-orchestrator plugin trust verify --rebuild`. |

### 3.31.2 Reliability & correctness additions

#### 3.31.2.1 Lease-steal CAS-under-lock + in-flight cancel (amends §3.30.7 LS-5)

The original LS-5 specified lease-steal via heartbeat staleness but did not specify ordering with respect to in-flight transactions. The complete protocol:

| # | Rule (LS-CAS-*) |
|---|---|
| LS-CAS-1 | The steal operation is: (a) acquire OS-level exclusive lock on `lease.lock` via `LockFileEx`/`flock`; (b) read the file; (c) verify `lastHeartbeatUtc < now - StaleAfter` AND `leaseEpoch == observedEpoch`; (d) write a new lease record with `leaseEpoch = observedEpoch + 1` and the new owner's identity; (e) `fsync`; (f) release the OS lock. The CAS is the (observedEpoch == previousEpoch) check inside the OS-level lock \u2014 **no read-then-write window outside the lock**. |
| LS-CAS-2 | The previous owner's heartbeat thread is the source of steal-detection: each heartbeat tick re-acquires the OS lock, reads `leaseEpoch`, and if it has advanced beyond what this daemon last wrote, the daemon enters `LeaseLost` mode atomically. |
| LS-CAS-3 (in-flight, LS-INF) | When `LeaseLost` fires, every in-flight write transaction (journal-pending RW-2 op, scheduler dispatch, reshape) is hard-cancelled via the daemon's master `CancellationTokenSource`. **In-flight transactions whose journal entry was written but not yet applied are NOT re-applied by the new owner** \u2014 the new owner sees the journal on disk and discards entries whose `ownerEpoch` is less than the current `leaseEpoch` (RW-2 protocol). This prevents two daemons from both committing the "same" transaction. |
| LS-CAS-4 | The new owner emits `LeaseStolen { fromEpoch, fromOwner, toEpoch, toOwner, atUtc, abortedTransactions: [{txnId, kind}] }` to the audit log AND to the bus (Security category). The old owner emits `LeaseLost { newEpoch, newOwner }` and self-terminates write operations within `KillEscalation` (the same constant used for process kill). |
| LS-CAS-5 | If `fsync` fails between (d) and (e), the steal is aborted; the operating system has not committed the new lease record, so the previous owner remains canonical. |

#### 3.31.2.2 Journal idempotency via content hash (amends §3.30.3 RW-2)

RW-2's journal-then-apply protocol must be replay-safe across crashes. The complete idempotency protocol:

| # | Rule (RW-2-IDEM-*) |
|---|---|
| RW-2-IDEM-1 | Each journal entry carries `txnId` (uuid v7), `ownerEpoch` (the writer's `leaseEpoch` at the time the entry was created), and `contentHash` (`sha256` of the canonical JSON of the post-state). |
| RW-2-IDEM-2 | Apply order: (a) for each journal entry not yet marked `applied=true`, recompute the post-state from the pre-state + op; (b) verify `sha256(canonicalize(postState)) == contentHash`; (c) atomic-rename the new state file into place; (d) mark journal entry `applied=true` and `fsync` the journal. Any mismatch in (b) is a fatal corruption \u2014 the daemon halts and emits `JournalCorrupted { txnId }`. |
| RW-2-IDEM-3 | A crash between (c) and (d) produces a duplicate-apply on next startup. The replay sees `applied=false` but the on-disk state already matches `contentHash`; this is detected and the entry is marked `applied=true` without re-writing (idempotent recovery). |
| RW-2-IDEM-4 | Entries with `ownerEpoch < currentLeaseEpoch` are discarded on startup (LS-CAS-3 cleanup), with one `JournalEntryDiscarded { txnId, ownerEpoch, currentEpoch }` event per entry. |
| RW-2-IDEM-5 | The journal file itself is rotated when it reaches `Journal:MaxBytesPerFile` (default 16 MiB) or `Journal:MaxAgeMinutes` (default 60); rotated journal files are retained per `Retention:Journal:MaxAgeDays` (default 7) for forensic replay. |

#### 3.31.2.3 SUB-3 replay-then-live seam (amends §3.30.5.3)

A late subscriber that requests historical events plus live tail must see a contiguous sequence with no duplicates and no gaps. The seam protocol:

| # | Rule (SUB-3-*) |
|---|---|
| SUB-3-1 | The bus serves replay from the durable T2 event log under a *snapshot* read lease taken at subscribe time; the subscriber is told the snapshot's `endSeq` (the highest sequence number visible at snapshot). |
| SUB-3-2 | While replay is streaming, new live events accumulate in a per-subscriber bounded buffer (`Subscriber:LiveBufferDepth`, default 1024). |
| SUB-3-3 | When replay completes (subscriber has consumed up to and including `endSeq`), the bus drains the live buffer in order. Any event in the buffer with `seq <= endSeq` is dropped (already covered by replay). The handoff is therefore overlap-safe: `min(liveBuffer.seq) > endSeq` is asserted before drain. |
| SUB-3-4 | If the live buffer overflows during replay, the subscriber is detached with `SubscriberLagged { lostFromSeq, lostToSeq }` \u2014 the subscriber must resubscribe with a new `fromSeq` to recover. The bus does not silently drop live events to make room. |
| SUB-3-5 | The seam is exercised by an integration test (`SubscriberSeam_NoOverlap_NoGap`) that runs 10⁶ events with concurrent subscribe-late + slow-consumer pressure. |

#### 3.31.2.4 Scheduler channel bounds + dispatch dedup (amends §3.30.4 R-DP)

The scheduler dispatches ready jobs through bounded channels; without bounds an unbounded ready-set + slow worker pool causes unbounded memory growth.

| # | Rule (SCHED-*) |
|---|---|
| SCHED-1 | The scheduler's outbound dispatch channel is `Channel.CreateBounded<DispatchOrder>(new BoundedChannelOptions(capacity: 256) { FullMode = BoundedChannelFullMode.Wait, SingleWriter = true, SingleReader = false, AllowSynchronousContinuations = false })`. |
| SCHED-2 | A given `(planId, jobId, attempt)` triple appears at most once on the dispatch channel at any time; the scheduler maintains an `InFlightSet` keyed on this triple and refuses to enqueue a duplicate. The set is updated under the same lock that picks the next ready job. |
| SCHED-3 | Workers acknowledge dispatch by removing the triple from `InFlightSet` AFTER they have transitioned the job's state to `Running` (T1). A worker that crashes between dequeue and ack leaves the entry; a watchdog (every `SCHED:WatchdogIntervalMs`, default 5_000) reaps entries whose job state has not advanced and re-enqueues them with a `DispatchReissued { triple }` event. |
| SCHED-4 | Channel-full back-pressure causes the scheduler's sweep loop to pause, **not** the readiness scan \u2014 readiness state continues to update; only dispatch waits. This prevents priority inversion. |

#### 3.31.2.5 T2 event log per-record CRC32C (amends §3.4.4)

Each framed record in the T2 event log carries a CRC32C (Castagnoli polynomial) of the payload bytes; readers verify on every read. Corrupted records are skipped with `EventLogRecordCorrupted { segmentId, offset, expectedCrc, computedCrc }` and an audit event. CRC32C is hardware-accelerated on x86-64 (`SSE4.2`) and ARMv8 (`crc32` extension); throughput overhead is < 0.5% even at 200 MB/s segment write rates.

#### 3.31.2.6 Daemon self-update rollback (amends §3.28.3)

The self-update protocol must support automatic rollback on failure:

| # | Rule (UPD-RB-*) |
|---|---|
| UPD-RB-1 | Before swapping in the new binary, the daemon writes `<dataDir>/update/staged-version.json` with the current version, the new version, and a `rollbackUntilUtc` timestamp set to `now + UpdateRollbackWindow` (default 10 min). |
| UPD-RB-2 | The new daemon starts with `--update-canary`. If it fails its self-test (`health.canary.run`) or fails to acquire the plan-store lease within `UpdateCanaryTimeout` (default 60 s), it exits non-zero. |
| UPD-RB-3 | On canary exit non-zero, the supervisor (systemd unit / Windows service / launchd plist) restarts the daemon, which detects `staged-version.json` with a non-completed status, atomic-renames the previous binary back into place, and emits `DaemonUpdateRolledBack { fromVersion, toVersion, reason }`. |
| UPD-RB-4 | Within `rollbackUntilUtc`, an explicit `ai-orchestrator daemon rollback` command also triggers UPD-RB-3 even if the canary succeeded. After the window, rollback requires a fresh install of the prior version. |
| UPD-RB-5 | The old binary is retained at `<dataDir>/update/binaries/<version>` for the duration of `Retention:DaemonBinaries:Count` (default 3 most-recent versions) for forensic and rollback purposes. |

### 3.31.3 Operational additions

#### 3.31.3.1 NFS/SMB detection (amends LS-9)

Cross-machine plan stores are unsupported. Detection:

| # | Rule (FS-DETECT-*) |
|---|---|
| FS-DETECT-1 | At plan-store init, the daemon calls `statfs` (POSIX) / `GetVolumeInformationByHandleW` + `GetDriveTypeW` (Windows) on the resolved store path. |
| FS-DETECT-2 | POSIX `statfs.f_type` matching `NFS_SUPER_MAGIC` (0x6969), `SMB_SUPER_MAGIC` (0x517B), `CIFS_MAGIC_NUMBER` (0xFF534D42), `FUSE_SUPER_MAGIC` (0x65735546) is rejected with `UnsupportedFilesystem { path, fs: <name> }`. |
| FS-DETECT-3 | Windows `GetDriveTypeW == DRIVE_REMOTE` OR `GetVolumeInformationByHandleW.FileSystemName` in `{ "NFS", "SMB", "CIFS" }` is rejected. |
| FS-DETECT-4 | An override `--allow-network-fs` exists for users running with full understanding of libgit2-on-network-fs sharp edges; using it records `NetworkFsOverride` in the audit log and surfaces a recurring `OperatingOnNetworkFs` warning event every 60 minutes. |

#### 3.31.3.2 SLO measurement environment (amends §3.27.1)

The performance SLOs in §3.27.1 are reproducible against a defined reference environment:

| Class | Reference spec |
|---|---|
| `slo-class-A` | x86-64, 8 cores @ 3.0+ GHz, 16 GiB RAM, NVMe SSD, Linux/Windows host OS, .NET 10.0.x |
| `slo-class-B` | ARM64 (M1 / Snapdragon X), 8 cores, 16 GiB RAM, NVMe SSD, macOS/Linux/Windows |
| `slo-class-C` | x86-64, 4 cores, 8 GiB RAM, SATA SSD (target: GitHub Actions standard runners) |

| # | Rule (SLO-ENV-*) |
|---|---|
| SLO-ENV-1 | Every benchmark in the BenchmarkDotNet suite (§3.24.5) is tagged with the slo-class it targets. Regressions on `slo-class-A` fail the build; regressions on `B`/`C` warn. |
| SLO-ENV-2 | The CI nightly runs all three classes (A and B on dedicated runners, C on a standard GHA runner pool); the time-series dashboard plots all three. |
| SLO-ENV-3 | The §3.27.1 numbers are `slo-class-A`. Sections that quote SLOs without a class tag default to A. |

#### 3.31.3.3 Per-plan disk cap (amends §3.11.4)

Every plan's footprint is capped to prevent a runaway plan from exhausting disk:

| # | Rule (DISK-PLAN-*) |
|---|---|
| DISK-PLAN-1 | `Retention:Plan:MaxBytesTotal` (default 2 GiB) caps the sum of all files under `.aio/p/<plan>/`. |
| DISK-PLAN-2 | When the cap is reached, eviction proceeds in this priority order: (a) per-job logs older than `Retention:JobLogs:MaxAgeDays` regardless of attempt count; (b) preserved-on-failure worktrees older than `Retention:FailedWorktrees:MaxAgeDays`; (c) event-log segments older than `Retention:EventLog:MaxAgeDays`; (d) revisions older than `Retention:PlanRevisions:MaxAgeDays`. |
| DISK-PLAN-3 | If the cap is still exceeded after eviction, the plan is paused with `PlanDiskCapExceeded { planId, sizeBytes, capBytes }` and refuses to dispatch new jobs. The user must explicitly raise the cap, delete data, or archive the plan. |
| DISK-PLAN-4 | A daily disk-usage report event `PlanDiskUsage { planId, sizeBytes, breakdown }` is emitted (Telemetry category) so dashboards can surface trending plans. |

#### 3.31.3.4 DAG-limit enforcement timing (amends §3.16.1)

Limits are enforced at three points, not only on initial plan validation:

| # | Rule (DAG-LIM-*) |
|---|---|
| DAG-LIM-1 | At `plan.scaffold` and `plan.finalize` (initial validation). |
| DAG-LIM-2 | At every `reshape` apply (R-RS-11 already enforces; this pin-points the boundary). |
| DAG-LIM-3 | At every retry that adds work (`retryJob --new-work` etc.); the new work's depth/fan-out impact is computed against the post-mutation graph before commit. |
| DAG-LIM-4 | A daily background sweep validates every loaded plan's graph against current limits and emits `PlanLimitDriftDetected` for plans that have drifted (e.g., because a limit was tightened in config). Drift does NOT auto-pause the plan; operators decide. |

### 3.31.4 Documentation additions

#### 3.31.4.1 Export/Diagnose format unification (amends §3.20 and §3.13.4)

The `plan export` (§3.20) and `daemon diagnose` (§3.13.4) bundles share a common envelope so tooling does not branch on which one it is consuming:

```jsonc
{
  "$type":      "AiOrchestratorBundle",
  "schemaVersion": 1,
  "kind":       "plan-export" | "daemon-diagnose",
  "createdAtUtc": "...",
  "daemonVersion": "1.0.0",
  "redactionsApplied": 17,
  "encryption": { "algo": "age-x25519", "recipient": "support@ai-orchestrator" } | null,
  "manifest":   [ { "path": "...", "sizeBytes": 123, "sha256": "..." }, ... ]
}
```

Both bundle producers write this envelope as `bundle.json` at the bundle root; both consumers (`plan import`, `support analyze`) accept either kind by inspecting `kind`. Adding a third bundle kind is a minor schema bump.

#### 3.31.4.2 T22 vs T14 race rules (amends §3.30.1.4)

T22 (force-fail by operator) and T14 (process exit observed by supervisor) can fire concurrently when an operator force-fails a job whose process is exiting on its own:

| # | Rule (T22-T14-*) |
|---|---|
| T22-T14-1 | Both transitions take the per-job state mutex. The first to acquire wins; the second observes the new state and is a no-op (idempotent — the audit-log entry is still written so observers see both signals). |
| T22-T14-2 | If T14 wins (natural exit), the job's terminal state reflects the actual exit code; the operator's force-fail event is still recorded in the audit log as `outcome: "race-lost-to-natural-exit"`. |
| T22-T14-3 | If T22 wins (force-fail), the natural exit's exit code is recorded in `details.naturalExitCode` for forensic purposes but does not change the terminal state. |
| T22-T14-4 | Tested by `JobLifecycle_T22_T14_Race` integration test (10⁵ iterations with concurrent force-fail + scripted natural exit). |

#### 3.31.4.3 Auto-heal vs phase-resume boundary (amends §3.30.2 PI-6)

Auto-heal (re-run a phase up to N times) and phase-resume (restart a partially-completed phase from its last checkpoint) are distinct mechanisms; the boundary:

| # | Rule (HEAL-RESUME-*) |
|---|---|
| HEAL-RESUME-1 | A phase that exits with a transient/retryable error AND has not produced a checkpoint manifest \u21d2 **auto-heal** (full phase re-run, attempt counter increments). |
| HEAL-RESUME-2 | A phase that exits abnormally (process killed, daemon crash, lease lost) AFTER producing a checkpoint manifest \u21d2 **phase-resume** (restart from checkpoint, attempt counter does NOT increment because the work-already-done is preserved). |
| HEAL-RESUME-3 | A phase that exits with a non-retryable error \u21d2 neither; the job transitions to `Failed` and the user must `retryJob` (which is a fresh attempt with new work). |
| HEAL-RESUME-4 | The decision is made by the post-exit handler before the next attempt is queued; the choice is logged as `PhaseRecovery { mode: "auto-heal" | "phase-resume" | "give-up", reason }`. |

#### 3.31.4.4 add_after rewiring cycle prevention (amends §3.30.6.1)

The `add_after` reshape op rewires existing dependents of an existing job through the new job. Cycle prevention:

| # | Rule (RS-AFTER-*) |
|---|---|
| RS-AFTER-1 | Before applying, the reshape validator computes the closure of jobs reachable from `existingJob` (forward) and the closure of jobs that can reach `existingJob` (backward). If `newJob.dependencies` contains any job in the *forward* closure, the operation is rejected with `ReshapeRejected { cause: "cycle", details: { newJob, conflictingDep } }`. |
| RS-AFTER-2 | After rewiring, every former-dependent of `existingJob` now depends on `newJob`. The validator confirms that `newJob` does not transitively depend on any of those rewired dependents (which would create a cycle through the rewiring). |
| RS-AFTER-3 | The atomicity rule R-RS-3 still applies: validate fully, then apply atomically; partial reshape is impossible. |

### 3.31.5 Sign-off & verification

Per the §0 status header, every change in this addendum was reviewed under three lenses:

- **Architecture (Jeromy):** signed off on overall design coherence, abstraction boundaries, and version-evolution rules (M1\u2013M10).
- **Security (Jeromy / AssumeBreach lens):** signed off on each security-additions subsection (3.31.1) plus the audit-log scheme (\u00a73.27.2.1\u20132).
- **Reliability (Jeromy):** signed off on each reliability subsection (3.31.2) and the SLO/disk-cap operational rules.

The PR template for `pre-release/1.0.0` carries three sign-off checkboxes; merge to `main` is blocked until all three are checked. This process is documented in `.github/pull_request_template.md` and enforced by branch protection.

---

## 3.32 v1.2 Review Remediation Addendum

This addendum addresses the 21 findings raised in the v1.2 architectural review (4 critical, 10 major, 7 minor). It supersedes v1.1 sign-off; new edits in this section are normative. Earlier sections that this addendum amends are referenced by id; the local rules below win on conflict until the parent section is rewritten.

### 3.32.1 Critical (block-GA)

#### 3.32.1.1 RecyclableSegment line views: enforce non-escapability via `ref struct` (amends §3.6.9.2 / E3 / OE0006-7) — **C-1**

The Acquire/Release CFG analyzer is best-effort: `ReadOnlyMemory<byte>` can be captured by closures, async-state-machine fields, and user-supplied `IProgress<T>` callbacks. Vendor third-party plugins compiled outside our analyzer pipeline can violate the lifetime contract silently and read recycled bytes.

| # | Rule (LV-*) |
|---|---|
| LV-1 | The handler-facing line slice is exposed only as `LineView`, a `ref struct` that the C# language refuses to capture into closures, store in fields/properties, box, or smuggle across `await`. `LineView` carries `ReadOnlySpan<byte> Bytes`, `ProducerLabel Source`, `long Sequence`, `DateTimeOffset At`, `bool TruncatedAt64K`. |
| LV-2 | `IOutputHandler.OnLine(LineView view, ISignalSink sink)` and `IAgentStdoutParser.OnLine` are rewritten to take `LineView` (and `ParseLineRequest` becomes a `ref struct`). Existing `ReadOnlyMemory<byte>` in `OutputLine`/`OutputChunk` is retained for the **internal** producer-to-splitter path (which is daemon-owned code subject to OE0006-7) and never crosses the public seam. |
| LV-3 | The `IByteMatcher.MatchRequest` `ref struct` is the only sanctioned way to extract bytes from a `LineView`; captures land in `Span<ByteSlice>` (offsets) and the matcher copies out only the few capture bytes the handler actually retains. |
| LV-4 | OE0006/OE0007 are downgraded from "primary enforcement" to "defense-in-depth on internal code paths." Public-seam safety is delivered structurally by LV-1 — the language, not the analyzer, is the guarantee. |
| LV-5 | The `Subscription.Bus` opt-in to receive a copied-out `ReadOnlyMemory<byte>` for slow async consumers (`SubscribeRequest.IncludeRawLineBytes = true`) drives a one-time copy into a fresh pooled `RecyclableSegment` whose refcount is owned by the subscriber's channel — segment reuse cannot race the subscriber's own consumption. |

#### 3.32.1.2 Hook-gate nonce binding to JobId (amends HK-GATE-NONCE-1..5) — **C-2**

The HK-GATE nonce was validated against worktree ownership but not against the specific `JobId` the nonce was issued for. A process inside worktree A could potentially read worktree B's `.gate-nonce` and replay it from inside its own working directory.

| # | Rule (HK-GATE-NONCE-*) |
|---|---|
| HK-GATE-NONCE-6 | The nonce stored in `<cwd>/.github/hooks/.gate-nonce` is `nonce = HMAC-SHA256(daemonAuditKey, JobId \|\| worktreeRootCanonicalPath)` (truncated to 128 bits). The daemon's `HookNonceTable` stores `JobId` and the canonical worktree-root path keyed on the file's *inode* (POSIX) / *file-id* (Windows), not on the path string. |
| HK-GATE-NONCE-7 | On gate evaluation, the daemon first canonicalizes `params.cwd` (`Path.GetFullPath` + symlink-reject + reparse-point-reject + `OrdinalIgnoreCase` on Windows per §3.32.2.10) **then** looks up the inode/file-id of the actually-presented `.gate-nonce`, **then** asserts the table's `JobId` for that inode-key matches the resolved-from-cwd `JobId`. Mismatch \u21d2 `deny` with reason `nonce-jobid-mismatch` and a `Security` audit event. |
| HK-GATE-NONCE-8 | The nonce file's mode is asserted on every read (`0600` POSIX, owner-only DACL on Windows); a weakened mode causes `deny` with reason `nonce-perms-tampered`, regardless of the nonce value. |
| HK-GATE-NONCE-9 | A single audit event `HookGateCrossWorktreeReplayDetected { sourceJobId, presentingJobId, sourceCwd, presentingCwd }` is emitted when the table lookup succeeds for a different `JobId` than the cwd resolves to \u2014 this is the explicit attack signature, distinct from `nonce-missing`. |

#### 3.32.1.3 Audit-log key rotation & signed transitions (extends §3.27.2) — **C-3**

The embedded-pubkey header solves "which pubkey verifies this segment" but not "which pubkey was active when this entry was signed." Without signed transitions a compromised daemon can rotate keys silently and re-emit the header, breaking chain integrity retroactively. We add §3.27.3.

```
§3.27.3 Audit-log key rotation
```

| # | Rule (KEY-ROT-*) |
|---|---|
| KEY-ROT-1 | The audit log is a sequence of segments. Each segment header carries `pubkey`, `pubkeyFingerprint`, `predecessorFingerprint`, and `previousSegmentLastEntryHash`. The first segment's `predecessorFingerprint` is the **trust-rooted fingerprint** burned into the daemon binary at build time (signed Authenticode/codesigned release artifact), pinning the chain to the official build. |
| KEY-ROT-2 | A `KeyTransition` audit record is the **only** way to introduce a new pubkey. It carries `oldPubkeyFingerprint`, `newPubkey`, `newPubkeyFingerprint`, `transitionAtUtc`, `reason: scheduled\|suspected-compromise\|update-rollover\|operator-rotate`. The record is signed **twice**: once with the **old** key (proves continuity) and once with the **new** key (proves possession). |
| KEY-ROT-3 | A new segment is opened immediately after a `KeyTransition`. Its header's `predecessorFingerprint` equals the prior segment's `pubkeyFingerprint`, and a verifier walks segment headers backward to confirm an unbroken chain to the burned-in trust root. |
| KEY-ROT-4 | The verifier is **fail-closed on mid-segment key change**: any entry whose signature does not verify against its segment's header pubkey causes the segment to be marked `tampered` and the verifier exits with non-zero. There is no "try the other key" fallback. |
| KEY-ROT-5 | Rotation cadence: scheduled rotation every `Audit:KeyRotationDays` (default 90); suspected-compromise rotation is operator-triggered via `ai-orchestrator audit rotate-key --reason suspected-compromise --confirm`; `update-rollover` is automatic during daemon self-update (§3.28.3) and chained with the update record. |
| KEY-ROT-6 | A `KeyTransition` whose old-key signature does not verify is rejected at write time \u2014 the daemon refuses to start a new segment, halts audit emission, and emits an `AuditChainBroken` operator-attention event. New audit emission resumes only after `ai-orchestrator audit verify --rebuild-from <segmentId>` and operator acknowledgement. |
| KEY-ROT-7 | The `AiOrchestrator.Cli` ships an `audit verify` command that walks the chain from the trust root to the current segment and reports any break. Verification is also a CI gate on shipped diagnose bundles (DIAG-*) so support engineers can detect post-bundle tampering. |

#### 3.32.1.4 T2 event-log tear-safe reads (amends §3.4.4 / §3.31.2.5) — **C-4**

OS append is byte-atomic only up to PIPE_BUF (4096 on Linux); records larger than PIPE_BUF can be torn for a concurrent live reader. The CRC32C catches the tear but the documented behavior was crash-only.

| # | Rule (T2-READ-*) |
|---|---|
| T2-READ-1 | Every record write is laid out as `length:uint32 \|\| crc32c:uint32 \|\| payload:bytes`. Writers serialize whole records via a single `WriteAsync(ReadOnlyMemory<byte>)` against a buffered `FileStream`; a record straddling the kernel buffer boundary is still a single syscall but is **not atomic** above the PIPE_BUF threshold. |
| T2-READ-2 | Readers read `length` first; if `length > T2:LiveReadAtomicityCeiling` (default 4096 \u2014 the POSIX PIPE_BUF) AND the read offset is within `T2:LiveTailWindow` (default 1 MiB) of the live tail, the reader takes a shared advisory lock on the segment via `LockFileEx`/`flock(LOCK_SH)`, re-reads `length`, then reads `payload`. Writers take `LOCK_EX` for records larger than the ceiling. The lock window is bounded \u2014 hot-path small records do not pay the lock cost. |
| T2-READ-3 | If CRC verification fails on a record at the file tail and the record is within `T2:LiveTailWindow`, the reader sleeps `T2:TornReadRetryMs` (default 5 ms) and retries up to `T2:TornReadMaxRetries` (default 5). Persistent CRC failure outside the live-tail window is `EventLogRecordCorrupted` (§3.31.2.5); persistent failure at the tail after retries surfaces `EventLogTearDetected { segmentId, offset }` and the reader skips to the next record boundary using the `length` field of the next-good record (segments carry a periodic resync marker every 64 KiB to make boundary discovery O(64KiB) worst-case). |
| T2-READ-4 | The acceptance test `EventLog_TornRead_Eventual_Recovery` writes 1 M records of mixed sizes (10 B \u2013 256 KiB) with concurrent live readers and asserts (a) zero false-CRC-pass observations, (b) zero permanent reader stalls, (c) eventual consistency within 50 ms of writer completion for every record. |
| T2-READ-5 | The reader API exposes `EventLogReadOptions.LiveTailMode { ConsistentSnapshot \| FollowLive }`. `ConsistentSnapshot` reads up to a frozen end-offset captured at open and never crosses into the live-tail window; `FollowLive` engages T2-READ-2/3. Subscribers default to `FollowLive`; `audit verify` and diagnose bundles use `ConsistentSnapshot`. |

### 3.32.2 Major

#### 3.32.2.1 Per-machine concurrency: per-user vs per-host scope (amends §3.9.1) — **M-1**

The `quota.mmf` lives in `$XDG_RUNTIME_DIR` (per-user). Two users on the same host can collectively oversubscribe. We rename and split:

| # | Rule (CONC-SCOPE-*) |
|---|---|
| CONC-SCOPE-1 | The interface formerly called `IGlobalConcurrencyCoordinator` is renamed `IPerUserConcurrencyCoordinator`. The MMF lives at the per-user runtime path. This is the only coordinator on single-user hosts. |
| CONC-SCOPE-2 | A new `IPerHostConcurrencyCoordinator` (optional; activated by `Concurrency:HostScopeEnabled = true`) is backed by an MMF under `%ProgramData%\ai-orchestrator\coord\quota-host.mmf` (Windows, ACL = `NetworkService` + every user) / `/var/lib/ai-orchestrator/coord/quota-host.mmf` (POSIX, mode `0666` with `ai-orchestrator` group). |
| CONC-SCOPE-3 | When both coordinators are present, **both must grant** before a job is admitted; either denying defers admission. The per-host coordinator's caps default to `1.5\u00d7` the per-user defaults so single-user hosts do not pay coordination cost they don't need. |
| CONC-SCOPE-4 | The doc previously labeled "per-machine" is rewritten as "per-user (default), with optional per-host opt-in for multi-tenant hosts." The §3.9.1 table row for the per-machine tier is updated accordingly. |
| CONC-SCOPE-5 | Multi-user installs ship a documented setup step that creates the host-scope MMF directory with the right ACL/group; the daemon's first-run doctor warns if `HostScopeEnabled = true` but the file is unwritable by the daemon's identity. |

#### 3.32.2.2 In-process libgit2 cancellation honesty (amends §3.7.2 / §3.3) — **M-2**

LibGit2Sharp does not honor `CancellationToken` for long ops; in-proc calls cannot be cancelled mid-flight without unsafe abort. We make this explicit and route around it.

| # | Rule (LG2-CANCEL-*) |
|---|---|
| LG2-CANCEL-1 | The `LibGit2OpKind` enum is annotated `[CancellationSemantics(InProc \| CooperativeOnly \| Uncancellable)]`. `Status`, `Diff`, `Lookup`, `Walk` are `InProc` (cheap; observe CT at op boundaries). `Commit`, `Index.Write`, `Branch.Create` are `CooperativeOnly` (CT observed only between sub-operations). `Clone`, `Fetch`, `Push`, `Merge`, `Checkout`-against-remote are `Uncancellable` in the libgit2 backend. |
| LG2-CANCEL-2 | `HybridGitOperations.ExecuteAsync` consults the annotation: `Uncancellable` ops are routed to `GitCliGitOperations` whenever the call site presents a `CancellationToken` whose `CanBeCanceled == true` (i.e., the caller actually expects to cancel). The CLI subprocess can be SIGINT/SIGTERM/SIGKILL'd, satisfying the cascade in §3.7.2. |
| LG2-CANCEL-3 | A `LibGit2OperationUncancellable { kind, sinceMs, reason: "in-flight-libgit2" }` event is emitted whenever an `InProc`/`CooperativeOnly` op is in flight and the parent CTS was cancelled but the op cannot return promptly. The event surfaces in the status bar and lets operators see the stuck op explicitly rather than waiting on an unexplained drain. |
| LG2-CANCEL-4 | The §3.7.3 phase-drain table is amended: `commit` and `merge-ri` defaults rise from 60 s to **120 s** to accommodate `CooperativeOnly` libgit2 ops; the rationale row notes the dependence on backend choice. |
| LG2-CANCEL-5 | The unsafe `Thread.Abort`-style hard-abort path is **not** added. Operators who need a hard escape during a libgit2 hang force-fail the daemon (`force-fail-copilot-job` analog at the daemon level), at which point the OS process termination unwinds. This is documented behavior, not a bug. |

#### 3.32.2.3 EV5/EV6 dual-emission projection generator (amends §3.4.5) — **M-3**

EV5 mandated dual-emission for one minor-version window; the mechanism was unspecified. Without code-gen the rule is aspirational.

| # | Rule (EV-GEN-*) |
|---|---|
| EV-GEN-1 | A `[ProjectsTo(typeof(FooEventV1))]` attribute on a V2 record declares the V1 projection. The Roslyn source generator `AiOrchestrator.Events.SourceGen` emits a partial method `static FooEventV1 ProjectToV1(in FooEventV2 source)` whose body is a field-by-field assignment. Fields present in V2 but not V1 are dropped; fields present in V1 but not V2 must carry `[V1Default(value)]`. Mismatched cases fail at build with `OE0043`. |
| EV-GEN-2 | The bus's `Publish<T>` discovers the `[ProjectsTo]` chain via reflection (cached per-type at first call) and emits the projected V1 record on the same bus tick. Subscribers that opted into `HandledSchemaMax = 1` see V1; subscribers with `HandledSchemaMax >= 2` see only V2 (V1 is suppressed for them to avoid duplicate delivery). The choice is made at the per-subscriber dispatcher, not at publish time. |
| EV-GEN-3 | The dual-emission window is enforced by version metadata on the V2 record: `[DualEmitUntil("1.5.0")]` causes the bus to stop emitting V1 once the daemon's reported version is `>= 1.5.0`. Removing the V1 type before the deadline is `OE0044`. |
| EV-GEN-4 | The `LegacyEnvelope { actualType, actualSchema, payload }` mechanism (EV6) is implemented by the same generator path: when no V<N> projection covers `subscriber.HandledSchemaMax`, the projector emits a `LegacyEnvelope` whose `payload` is the V_max source-gen-serialized JSON of the record. |
| EV-GEN-5 | An integration test (`EventVersioning_DualEmit_NoDuplicates_NoLoss`) seeds two subscribers (V1-only and V2-aware), publishes 10⁵ events of each evolved type, and asserts each subscriber receives every event exactly once with no version skew. |

#### 3.32.2.4 Capture-cli-corpus: out-of-tree by default, gated commit (amends §3.2.7.6) — **M-4**

`ISecretRedactor` is regex-based; it does not scrub user names in paths, hostnames, repo names, branch names, or arbitrary file content quoted in errors. Committing the captured corpus to OSS is a real PII-leak risk.

| # | Rule (CORPUS-PII-*) |
|---|---|
| CORPUS-PII-1 | `ai-orchestrator capture-cli-corpus` writes by default to `~/.aio/corpus/<runner-id>/<cli-version>/<scenario>/`, **never** under the repo. The `--record-to` flag is reserved for paths under `~/.aio/`; paths outside that root require `--unsafe-record-anywhere` and emit a `CorpusUnsafeLocation` warning. |
| CORPUS-PII-2 | Promoting captured fixtures into `src/test/fixtures/captured-corpus/` is a separate command: `ai-orchestrator capture-cli-corpus promote --from <path> --to <fixtureName>`. The promote step requires interactive per-line approval (TUI checklist) OR a `--from-allowlist <path>` file enumerating exact byte ranges to retain. Bulk promote without one of these flags is rejected. |
| CORPUS-PII-3 | The promote step runs an extended scrubber pipeline before write: (a) `ISecretRedactor`; (b) the path-pseudonymizer from DIAG-1; (c) hostname/account/repo extractor that replaces every recognized identifier with stable test ids (`acct-N`, `host-N`, `repo-N`); (d) a quoted-content stripper that replaces multi-line file content blocks with `[REDACTED-N-LINES]`. |
| CORPUS-PII-4 | A CI gate (`validate-corpus-no-pii`) re-runs the scrubber pipeline against every committed fixture and fails the build if any non-stable identifier (regex pattern over `\\w+@\\w+\\.\\w+`, `https?://[^/\\s]+`, raw IPv4/IPv6, common SSN/PAN shapes) appears. |
| CORPUS-PII-5 | A pre-commit hook installed by `ai-orchestrator setup` blocks any commit that adds a file under `src/test/fixtures/captured-corpus/` without the matching `promote` audit record. |

#### 3.32.2.5 Credential-lease invalidation on 401/403 (amends §3.3.1) — **M-5**

GCM/OAuth tokens can be silently rotated by the auth provider mid-cache; the cached lease then surfaces 401/403 to the user as if their credentials were broken.

| # | Rule (CRED-INVAL-*) |
|---|---|
| CRED-INVAL-1 | `LibGit2SharpGitOperations` and `GitCliGitOperations` both wrap remote operations in a single retry on 401/403. On the first occurrence, `IRemoteIdentityResolver.InvalidateAsync(remoteUrl, account)` is called, which removes the cache entry, marks the prior lease tombstoned (subsequent uses fail closed), and triggers a fresh `ResolveAsync`. The retry uses the new lease. |
| CRED-INVAL-2 | A `CredentialRotationDetected { remoteUrl, account, source, latencyMs }` event is emitted (Security category) for every successful re-resolve-after-401. The user's status bar shows a transient "credential refreshed" notice. |
| CRED-INVAL-3 | If the second attempt also returns 401/403, the failure is surfaced to the user as `AuthFailure` with `actionableHint: "credentials revoked or scope insufficient"` and the lease cache for `(remoteUrl, account)` is purged for `Auth:RevokedCachePoisonTtl` (default 5 min) to prevent retry-loop hammering. |
| CRED-INVAL-4 | Long-running operations (clone, fetch with > 1 GiB) that cannot easily be retried surface a `CredentialMidOpRotationLikely` warning when the resolver detects a token whose remaining TTL at op-start was less than the op's expected duration; the user can choose to refresh proactively before launching. |

#### 3.32.2.6 PowerShell prelude isolation via script block (amends §3.2.8.5) — **M-6**

User script that legitimately sets `$ErrorActionPreference = 'Stop'` fights the runner's prelude silently.

| # | Rule (PS-ISO-*) |
|---|---|
| PS-ISO-1 | The `PowerShellPreludeWriter` wraps the user script in a child scope: the composed stdin is `<prelude> ; & { <userScript> }`. Preference variable changes inside the user script's child scope do not propagate back to the runner-controlled scope. |
| PS-ISO-2 | The `StderrPolicy` decision continues to be made at the emitter layer (which observes the actual stderr stream emitted by the child PowerShell process). `StderrPolicy` is therefore independent of any user-side preference change \u2014 the emitter routes lines to `ShellEvent.Information` / `Warning` / `Error` per the policy regardless of the user's `$ErrorActionPreference`. |
| PS-ISO-3 | If the user script genuinely needs a strict-mode parent scope, they can opt in via `PowerShellWorkSpec.LeakUserPreferencesIntoParent = true`; this disables the script-block wrap and reverts to the v1.1 behavior with its documented surprise. The flag emits a `PowerShellPreludeWeakened` warning event so operators can spot it in audit. |
| PS-ISO-4 | An integration test (`Powershell_UserPreferenceChange_DoesNotLeak`) asserts that a user script setting `$ErrorActionPreference = 'Stop'` followed by a stderr-emitting native command still routes via the configured `StderrPolicy.TreatAsInformational` and does not abort the script. |

#### 3.32.2.7 Skew matrix: NuGet-side validator for transitive resolution (amends §3.1.0.4) — **M-7**

OE0019 forbids upward project deps, but third-party plugins can pin two `PackageReference`s that resolve to incompatible Models versions at the host's restore.

| # | Rule (SKEW-NUGET-*) |
|---|---|
| SKEW-NUGET-1 | `AiOrchestrator.Abstractions` ships an MSBuild prop file `build/AiOrchestrator.Abstractions.props` declaring `<TestedModelsRange>[1.0,2.0)</TestedModelsRange>`. The property surfaces in any project that references the package. |
| SKEW-NUGET-2 | A `CompatibilityCheck` MSBuild target (auto-imported via the same prop file) runs before `Restore` completion and asserts that the resolved `AiOrchestrator.Models` version satisfies every `TestedModelsRange` declared by every referenced `Abstractions` version in the closure. Mismatch fails the build with a clear message naming the conflicting packages. |
| SKEW-NUGET-3 | For non-MSBuild consumers (script-based hosts, `dotnet build` with custom restore), the daemon's startup path also performs the check by reading `Assembly.GetCustomAttributes<TestedModelsRangeAttribute>()` on every loaded `Abstractions` assembly and comparing against the resolved `Models` assembly's version. Mismatch logs `AbstractionsModelsSkewDetected` and refuses to start; operators can override with `--accept-skew` (which records the override in the audit log). |
| SKEW-NUGET-4 | The skew matrix table in §3.1.0.4 is regenerated as a CI artifact from the actual `[TestedModelsRange]` declarations \u2014 the doc table cannot drift from the shipped metadata. |

#### 3.32.2.8 LibGit2 breaker: exponential backoff + oscillation telemetry (amends §3.3.3) — **M-8**

A 30 s OpenCooldown with HalfOpenProbes=2 oscillates Open\u2194HalfOpen forever under transient AV scanner contention.

| # | Rule (LG2-BRK-*) |
|---|---|
| LG2-BRK-1 | `LibGit2HealthOptions.OpenCooldown` becomes a `OpenCooldownMin` (default 30 s) and `OpenCooldownMax` (default 10 min). After each failed HalfOpen probe, the cooldown doubles up to the max; on each successful Close, the cooldown resets to min. |
| LG2-BRK-2 | A sliding window tracks the count of `Open \u2192 HalfOpen \u2192 Open` transitions over `LibGit2:OscillationWindow` (default 5 min). When count `>= LibGit2:OscillationThreshold` (default 4), the breaker emits `LibGit2BreakerOscillationDetected { count, recentFailureKinds, recommendedAction }` and the cooldown jumps to `OpenCooldownMax` immediately. |
| LG2-BRK-3 | On oscillation, the daemon also pre-emptively switches the static-default backend for libgit2-able operations to the CLI for `LibGit2:OscillationCliFallbackDuration` (default 1 hour), so users keep working without per-call latency from probe failures. |
| LG2-BRK-4 | Operator command `ai-orchestrator git breaker reset` clears the breaker state, restarts the cooldown at min, and re-enables libgit2 for the next call \u2014 useful after AV exclusions are reconfigured. |
| LG2-BRK-5 | The probe sequence is randomized (small jitter on the temp-repo name + a 50\u2013150 ms randomized delay before each probe) to avoid lock-step oscillation with periodic AV scans. |

#### 3.32.2.9 Reshape transactions (amends §3.30.13 and reshape ops) — **M-9**

Reshape ops were sequenced; SIGKILL between op N and op N+1 leaves a half-applied reshape inconsistent with the journal.

| # | Rule (RS-TXN-*) |
|---|---|
| RS-TXN-1 | `IReshapeService.ApplyAsync(ReshapeBatchRequest)` writes the entire batch to a single journal file `<planDir>/plan.reshape.journal.json` before mutating `plan.json`. The journal carries `txnId`, `ownerEpoch`, `contentHash`, the batch ops, and the **expected post-state's** content hash (RW-2-IDEM-1 conventions). |
| RS-TXN-2 | Apply: (a) write journal; (b) `fsync`; (c) compute new `plan.json` from `plan.json + ops`; (d) verify computed-state hash matches journal's expected hash; (e) atomic-rename new `plan.json` into place; (f) `fsync` directory; (g) mark journal `applied=true`; (h) `fsync` journal. A crash anywhere from (a) through (e) leaves the journal but the old `plan.json`; replay redoes the deterministic computation. A crash between (e) and (h) is detected on restart by hash-equality of on-disk state to journal expected-hash and is marked `applied=true` without rewriting (RW-2-IDEM-3). |
| RS-TXN-3 | Apply rejects partial-batch atomicity bypass: `--single-op` is not exposed; every reshape, even single-op, goes through the journal. This keeps the apply path identical and removes a code-path divergence. |
| RS-TXN-4 | The journal applies under the per-plan write lease (LS-CAS-*) so two daemons cannot race on apply. Lease loss between (a) and (e) discards the journal (RW-2-IDEM-4 / LS-CAS-3). |
| RS-TXN-5 | An integration test (`Reshape_SIGKILL_Anywhere_Recovers_Atomic`) loops 10⁴ random kill points across the apply sequence and asserts the on-disk plan after restart is either the pre-batch state or the full post-batch state \u2014 never partial. |

#### 3.32.2.10 Path validation: case-folding and reparse-point rejection (amends HK-GATE-PATH-1, HK-SAFE, LF-4) — **M-10**

Default `string.StartsWith` is case-sensitive on Windows; symlink-only checks miss junctions/mount points.

| # | Rule (PATH-VAL-*) |
|---|---|
| PATH-VAL-1 | The single helper `IPathValidator.IsUnderRoot(string path, string root)` is the only sanctioned implementation. On Windows it uses `string.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase)` with `rootWithSep` ending in `Path.DirectorySeparatorChar`; on POSIX it uses `Ordinal`. All call sites that previously did inline `StartsWith` checks (HK-GATE-PATH-1, HK-SAFE, LF-4, CMD-TMP-3, etc.) are routed through this helper. |
| PATH-VAL-2 | `IPathValidator` rejects any path component whose attributes include `FILE_ATTRIBUTE_REPARSE_POINT` on Windows (covering symlinks, mount points, junctions) and any path whose components include a symlink on POSIX (`O_NOFOLLOW` semantics on the open + per-component lstat on the resolved path). |
| PATH-VAL-3 | On Windows the validator also rejects path forms that bypass DOS-name canonicalization: `\\?\`, `\\.\` device paths, NTFS alternate data streams (`:`), 8.3 short names that resolve to a different long name. Each rejection emits `PathValidationRejected { path, reason }` and `Security` audit. |
| PATH-VAL-4 | A focused unit-test pack (`PathValidator_Defeats`) catalogs the historical bypass cases (lowercase drive letter, mixed slashes, trailing `.`, trailing space, junction-into-allowed-root, NTFS ADS, `\\?\` prefix, UNC mount point, WSL `\\wsl.localhost`) and asserts each is rejected. |
| PATH-VAL-5 | The Roslyn analyzer `OE0045` flags any `string.StartsWith` whose receiver is a path-typed local/parameter (annotated `[Path]` or named `*Path`/`*Dir`/`*Root`) and the second arg is also path-typed \u2014 such call sites must use `IPathValidator.IsUnderRoot`. |

### 3.32.3 Minor

#### 3.32.3.1 Handler dispatch order is explicit (amends §3.2.7.5 W3) — **m-1**

DI registration order is implementation-specific across assemblies. Add `HandlerSubscription.Priority: int` (default 0; lower runs first; ties broken by `HandlerId` ordinal for determinism). Dispatch enumerates `_handlers.OrderBy(h => h.Priority).ThenBy(h => h.HandlerId, StringComparer.Ordinal)` once at registration and caches the order. Cross-assembly load order no longer affects observable behavior.

#### 3.32.3.2 NFS/SMB detection: `FilesystemKindUnverifiable` warning (amends §3.31.3.1 FS-DETECT-*) — **m-2**

Docker volume mounts, OverlayFS, and encrypted overlays often report as the underlying FS type. When detection cannot definitively classify the filesystem (recognized magic but layered on a known overlay-capable mount, or unrecognized magic on a remote-looking mount point), the daemon emits `FilesystemKindUnverifiable { path, observedFsType, inferredOverlay }` and refuses to start unless the operator passes `--allow-unverifiable-fs` (which then logs `UnverifiableFsAccepted` to the audit log). The user-override path `--allow-network-fs` (FS-DETECT-4) keeps its existing semantics for known-network mounts.

#### 3.32.3.3 Credential helpers: file-descriptor delivery, not env (amends §3.3.1) — **m-3**

Spawned `git` invokes credential helpers as child processes that inherit the env. A misbehaved helper logging its env to stderr leaks the secret. The runner sets `GIT_ASKPASS=<path-to-tiny-helper>`; the helper reads the credential from a CLOEXEC inherited file descriptor (`fd 3`) populated by the daemon's `IProcessLifecycle` from the lease's secret material. The env block on the spawned `git` carries no secret. POSIX uses `dup2`+`fcntl(F_SETFD, FD_CLOEXEC=0 for fd 3 only)`; Windows uses `STARTUPINFOEXW` with an explicit handle list and `bInheritHandles=TRUE` only for the helper-stdin handle. The `GIT_ASKPASS` helper is shipped as a tiny trim-AOT'd binary alongside the daemon.

#### 3.32.3.4 Per-plan disk cap: rename-aware accounting (amends §3.31.3.3 DISK-PLAN-*) — **m-4**

The cap counts on-disk size; an atomic-rename swap (write temp, rename into place) can spike disk usage by `currentSize + newSize` during the rename window, transiently exceeding the cap.

DISK-PLAN-5: every rename-into-place that is part of the plan's footprint reserves `max(currentSize, newSize)` against the cap (not the sum). Reservation is taken before the temp file is written; if reservation would exceed the cap, the operation fails fast with `PlanDiskCapWouldExceed`. The reservation is released once the rename completes successfully. This makes the cap a true upper bound, not a best-effort counter.

#### 3.32.3.5 T3 plan summary: redaction + fuzz (amends §3.4.4 T3) — **m-5**

The committed `events.summary.json` includes "first error line per failure," which can leak unredacted secrets. Two changes:

| # | Rule (T3-RED-*) |
|---|---|
| T3-RED-1 | Every string field in the summary passes through `ISecretRedactor.MaskInPlace` at write time. The `failureSignals[].firstErrorLine` field is additionally truncated to 256 bytes and stripped of common credential-bearing patterns (URL with userinfo, `Bearer\\s+\\S+`, `Authorization:\\s+\\S+`). |
| T3-RED-2 | A test-harness fuzzer (`PlanSummary_Redaction_Fuzz`) seeds 10⁴ synthetic error lines containing high-entropy tokens, JWT-shaped strings, and PEM blocks; the test asserts each is fully redacted in the resulting summary. The fuzzer is part of the GA test gate. |
| T3-RED-3 | If redaction produces an empty `firstErrorLine` (entire content was sensitive), the summary records `firstErrorLine: "[redacted]"` rather than omitting the field, so consumers can distinguish "no failure data" from "failure data was sensitive." |

#### 3.32.3.6 `gh` auto-update suppression (amends ENV1, A6) — **m-6**

`copilot --no-auto-update` (A6) doesn't prevent `gh`'s own update prompts/auto-update when callers go through `gh copilot ai-orchestrator`. The plugin's launcher sets `GH_NO_UPDATE_NOTIFIER=1` and `GH_PROMPT_DISABLED=1` in the env block of the spawned `gh` invocation. The orchestrator's documentation also records the recommended user-side setting for native-CLI users.

#### 3.32.3.7 `<plan8>` / `<job8>` placeholder convention defined (amends §0) — **m-7**

The §0 glossary is amended with the convention: `<plan8>` and `<job8>` denote the lowercase-hex first 8 characters of the corresponding GUID's "N" form (`Guid.ToString("N").Substring(0, 8)`). They are not unique guarantees \u2014 they are short identifiers for human-friendly paths and event sequences. Where uniqueness is required (filesystem path beneath a plan, lease registry key), the full canonical id is used; the truncation is rendering-only.

### 3.32.4 Sign-off & verification

Per §0, every change in this addendum was reviewed under the same three lenses as v1.1:

- **Architecture:** signed off on the LineView non-escapability change (LV-*), the EV5/EV6 source-generator approach (EV-GEN-*), and the reshape-journal protocol (RS-TXN-*).
- **Security (AssumeBreach):** signed off on §3.27.3 (audit-log key rotation), HK-GATE-NONCE-6..9 (cross-worktree replay defense), CORPUS-PII-* (PII-leak prevention), CRED-INVAL-* (credential-rotation handling), PATH-VAL-* (path-validation strengthening), and m-3 (FD-based credential helper delivery).
- **Reliability:** signed off on T2-READ-* (live-tail tear-safe reads), CONC-SCOPE-* (per-host coordination), LG2-CANCEL-* (cancellation honesty), LG2-BRK-* (oscillation control), DISK-PLAN-5 (rename-aware accounting).

The same three-checkbox PR template applies. v1.2 supersedes v1.1; the §0 status header reflects the new baseline.

---

Mirrors today's `McpIpcServer` (`src/mcp/ipc/server.ts`) but generalized:

| Property | Value |
|----------|-------|
| Pipe name (Windows) | `\\.\pipe\ai-orchestratord-<sessionId>` |
| Socket path (Linux/macOS) | `$XDG_RUNTIME_DIR/ai-orchestratord-<sessionId>.sock` (perm `0600`) |
| Auth | 32-byte hex nonce passed via env var `AI_ORCHESTRATORD_NONCE` to the spawned client process; the client's first frame on the connection MUST be `{"type":"auth","nonce":"…"}`. **The nonce is never written to disk.** See §5.2 for the full handshake. |
| Auth timeout | 5s (config); on expiry the daemon closes the socket without responding |
| Connections | One authenticated client at a time (others rejected with `auth_required`) |
| Wire format | Newline-delimited JSON-RPC 2.0 (same as MCP stdio transport today) |
| ACL | Windows: `PipeSecurity` restricting to current user SID; POSIX: `chmod 600` + `chown` current user |
| Secrets | Nonces are **never** placed on argv, **never** written to a handshake file, and **never** logged. Sole transport: env var to the spawned child + the first connection frame back. |

#### 4.1.1 Handshake transport rules (security-critical)

These are non-negotiable invariants enforced by `AiOrchestrator.Security` and verified by an analyzer (`OE0006`):

| # | Rule | Why |
|---|---|---|
| H1 | **In-process hosting performs no handshake.** When `AiOrchestrator.Hosting.InProc` is used (CLI default for short-lived commands, unit/integration tests, the future C#-embedded extension scenarios), the caller resolves `IAiOrchestrator` directly from the DI container. There is no nonce, no socket, no pipe, no auth message — because there is no process boundary to authenticate across. | Authentication exists to identify a peer over a transport. With no transport there is no peer to identify. Inventing one would just be ceremony — and ceremony around secrets is how secrets leak. |
| H2 | **Remote transports always perform a handshake.** Named pipe, Unix domain socket, future HTTP/QUIC — every transport that crosses a process boundary requires the nonce-or-token handshake before the daemon dispatches any RPC. The transport selector in `AiOrchestrator.Hosting.NamedPipe` (and any future remote host) instantiates the auth pipeline before binding RPC handlers. | A connection that bypasses auth defeats the entire local-IPC threat model. |
| H3 | **Nonces transit only through process-spawn env vars and the connection itself.** The parent process generates the nonce, places it on the spawned child's environment block (`ProcessStartInfo.EnvironmentVariables["AI_ORCHESTRATORD_NONCE"]`), and the child sends it back as the first frame of the new connection. The daemon compares constant-time and zeroes the in-memory copy on success. **No file. No argv. No registry. No shared memory. No clipboard.** | File-based handshakes invite a class of attacks the env-var path simply doesn't have: TOCTOU between write and read, world-readable inheritance via `umask` race, leftover-after-crash credential reuse, AV/backup tools indexing the file, accidental commit when the file lives inside a repo, symlink-swap attacks, and — critically — any other process the same user runs can read a `0600` file owned by that user. The env block of a spawned child is only readable by that child (and by code running as the same user with `PROCESS_QUERY_LIMITED_INFORMATION` on Windows / `/proc/<pid>/environ` on Linux), and it's gone the instant the child exits. |
| H4 | **Pipe / socket address transits the same env channel.** `AI_ORCHESTRATORD_PIPE` (Windows) or `AI_ORCHESTRATORD_SOCKET` (POSIX) carries the connection address from parent to child alongside the nonce. The child does not enumerate sockets, scan for pipes, or read any discovery file. | Same reasoning as H3 — every shared-disk discovery channel is an attack surface and a stale-state hazard. |
| H5 | **The nonce is single-use and bound to one connection.** On the daemon side, a successful auth marks the nonce consumed; subsequent connections presenting the same nonce are rejected. The daemon also rotates the nonce after a configurable number of failed auth attempts (default 5) and rebinds the pipe. | Replay protection without a session-cookie protocol. |
| H6 | **Token-based auth (Mode C / future HTTP) follows the same shape.** The token is delivered out-of-band (env var named in `aiOrchestrator.daemon.authTokenEnv`, or platform secret store) and presented as the first frame on the connection. The daemon's auth pipeline is identical for nonces and tokens — the difference is only the credential format and validation rule (constant-time hash compare for nonces; signature/expiry/revocation check for tokens). | One auth pipeline, multiple credential types — keeps the security audit surface small. |

The daemon exposes:

1. The full `IAiOrchestrator` contract as JSON-RPC methods (`plan.scaffold`, `plan.finalize`, `job.retry`, …).
2. A `subscribe` method that opens a server-streaming JSON-RPC channel for events.
3. A `health` method returning daemon version + capability flags.

### 4.2 In-proc host (`AiOrchestrator.Hosting.InProc`)

A library wrapper that constructs `IAiOrchestrator` against the local DI container. Used by:

- The CLI when `--no-daemon` (default for short-lived commands like `plan list`).
- The future C#-embedded VS Code extension scenarios.
- The Copilot CLI plugin.
- Unit/integration tests.

### 4.3 MCP — first-class shipping artifact

MCP becomes a **dedicated product surface**, not an internal feature of the extension or daemon. Two libraries and one binary:

| Component | Role |
|---|---|
| `AiOrchestrator.Mcp` (library) | Pure protocol implementation: tool schemas, request/response dispatch, JSON-RPC framing, notification fan-out. Has **no** dependency on `AiOrchestrator.Hosting.NamedPipe` and **no** dependency on the VS Code extension. Depends only on `AiOrchestrator.Abstractions` (transitively `Models`) and `Microsoft.Extensions.*`. |
| `AiOrchestrator.Mcp.Stdio` (binary `ai-orchestrator-mcp`) | Standalone stdio MCP server. Reads JSON-RPC from stdin, writes to stdout. Internally hosts `AiOrchestrator.Mcp` either against a connected daemon (named-pipe client) **or** against an in-proc orchestrator (`--inproc`). Distributable via `dotnet tool install -g AiOrchestrator.Mcp.Stdio` or as a self-contained single-file binary. |
| Embedded mode | A daemon may also expose the MCP methods on its named pipe for callers that already speak JSON-RPC there. |

This design **removes the MCP server from the API/extension entirely**. Today the MCP server lives inside `src/mcp/**` and runs in the extension host. After this change, the VS Code extension does **not** host an MCP server — it only acts as an MCP client (via Copilot Chat's tooling) when needed. Any stdio-MCP host (Copilot Chat, Claude Desktop, Continue, custom Python agents, CI scripts) can spawn `ai-orchestrator-mcp` directly with no .NET install, no VS Code, and no extension.

The MCP tool surface (`scaffold_copilot_plan`, `add_copilot_plan_job`, `finalize_copilot_plan`, …) is **byte-identical** to today (see §7.4) so no Copilot Chat user perceives the relocation.

### 4.4 CLI (`AiOrchestrator.Cli`)

Built with `System.CommandLine` and packaged as a `dotnet tool` plus per-RID self-contained binaries. Top-level commands map to the contract:

```
ai-orchestrator plan create --from-file plan.yaml
ai-orchestrator plan list [--status running] [--json]
ai-orchestrator plan show <planId> [--graph mermaid]
ai-orchestrator plan pause|resume|cancel|delete <planId>
ai-orchestrator plan logs <planId> <jobId> [--phase work] [--attempt 2]
ai-orchestrator plan watch <planId>           # streams events to stdout
ai-orchestrator plan reshape <planId> --add-job …
ai-orchestrator job retry <planId> <jobId> [--clear-worktree]
ai-orchestrator daemon start|stop|status
ai-orchestrator agent test --runner github-copilot --task "…"
```

Each subcommand:

1. Resolves the host (daemon if running, else in-proc).
2. Calls the contract.
3. Renders results as text (default) or JSON (`--json`).
4. Streams events when applicable (`watch`, long-running `create --wait`).

### 4.5 GitHub Copilot CLI plugin (`AiOrchestrator.Cli.Copilot`)

Registered via `gh extension install github/gh-copilot-ai-orchestrator`. Provides:

```
gh copilot ai-orchestrator plan create …
gh copilot ai-orchestrator watch <planId>
gh copilot ai-orchestrator agent run --runner github-copilot --task "…"
```

Implementation strategy: a thin shim that re-uses `AiOrchestrator.Cli` command handlers but with `gh` auth context propagated as an `IGitHubAuth` DI service, so the plugin can call `gh auth token` for GitHub API calls when needed.

### 4.6 VS Code extension transport — Node binding + pipe fallback

The TS extension stops embedding the plan engine. The transport layer has **two** modes that can coexist:

```
src/typescript/transport/
├── nodeBindingClient.ts        # PRIMARY: in-proc N-API binding from AiOrchestrator.Bindings.Node (no handshake — see §4.1.1 H1)
├── pipeClient.ts               # FALLBACK: JSON-RPC over named pipe (handshake per H2)
├── nonceProvider.ts            # reads AI_ORCHESTRATORD_NONCE from process.env; never touches disk (H3)
├── eventStream.ts              # subscribes and re-emits as today's EventEmitter
├── transportSelector.ts        # picks binding vs pipe based on settings + binding availability
└── compatShim.ts               # adapts to existing IPlanRunner-shaped API for UI
```

The `compatShim` keeps the UI code unchanged: the Plan Sidebar, Plan Detail Panel, Job Detail Panel, Status Bar, and BulkPlanActions all keep their current consumption pattern (event emitter + method calls), but those calls are now serialized through whichever transport `transportSelector` chose.

#### How VS Code spawns and manages the daemon + MCP

The extension owns three child-process responsibilities. They are **independent**:

```mermaid
graph TB
    Ext[VS Code Extension Host - TypeScript]
    Daemon[ai-orchestratord]
    McpStdio[ai-orchestrator-mcp]
    Binding[AiOrchestrator.Bindings.Node - in-proc]
    Chat[Copilot Chat]

    Ext -->|spawn at activation if missing| Daemon
    Ext -->|loads N-API module| Binding
    Binding -.->|in-proc IAiOrchestrator handle| Daemon
    Ext -->|writes mcp.json pointing at| McpStdio
    Chat -->|spawns per its own lifecycle| McpStdio
    McpStdio -->|named-pipe client, nonce| Daemon
```

1. **Daemon lifecycle** (`ai-orchestratord`) — three scoping modes, in order of default preference:

   **Mode A — per-VS-Code-instance (default).** The daemon is scoped to the *VS Code instance* (process tree of the extension host), not to the user. Each VS Code window-group gets its own `ai-orchestratord` keyed by `<userSid>-<vscodeInstanceId>` where `vscodeInstanceId` is derived from `vscode.env.sessionId` (stable across window reloads of the same instance, distinct across separately-launched instances). Lock file lives at `$XDG_RUNTIME_DIR/ai-orchestratord-<userSid>-<vscodeInstanceId>.lock` / `%LOCALAPPDATA%\ai-orchestratord\<userSid>-<vscodeInstanceId>.lock`. This is the right default because:
   - Running plans, worktrees, and event subscribers are tied to the VS Code instance the user is looking at — sharing them across separate windows produces confusing UX (a plan paused in window A appears paused in window B).
   - Crash/exit blast radius is bounded to one window-group.
   - It survives **window reloads** (the only ambient-context change we care about preserving), but exits cleanly when the last extension host in the instance shuts down (idle-shutdown after N minutes with zero subscribers as a safety net).

   **Mode B — shared per-user (opt-in).** When `aiOrchestrator.daemon.scope: "user"` is set, all VS Code instances for the same user attach to a single daemon (lock file `…/ai-orchestratord-<userSid>.lock`). Useful for power users running multi-window workflows against the same plan set, and for headless/CI scenarios where the CLI and an editor share state. Trade-off: a daemon crash blocks every window until respawn.

   **Mode C — centralized / shared MCP surface (opt-in, multi-tenant).** When `aiOrchestrator.daemon.endpoint: "<uri>"` points at an externally-managed daemon (different host, sidecar container, team-shared service), the extension does not spawn anything — it just connects as a client over the configured transport. The daemon authenticates each client (nonce or token, see §5) and **scopes every subscription, mutation, and event to the caller's tenancy** (`tenantId` / `userId` carried in the auth context).

   In all three modes:
   - The daemon survives VS Code window reloads (reload no longer kills running plans).
   - Health-checked by the extension every 10 s; auto-respawned with backoff on crash (Modes A/B only — Mode C reconnects but never spawns).
   - Stopped by the extension only via `ai-orchestrator daemon stop` if the user explicitly invokes it (Modes A/B).

2. **MCP server lifecycle** (`ai-orchestrator-mcp`): NOT spawned by the extension. The extension instead **registers** `ai-orchestrator-mcp` in the user's `mcp.json` at activation (configurable / opt-in), so Copilot Chat (or any other MCP host) is the one that spawns it on demand. This decouples MCP from the extension lifecycle entirely — the extension can be uninstalled and Copilot Chat continues to drive the daemon over MCP.

   **MCP eventing across the three daemon modes — and how subscribers find each other:**

   The challenge: `ai-orchestrator-mcp` is spawned independently by the MCP host (Copilot Chat, Claude Desktop, CI), so it has no inherent way to know *which* daemon to attach to or *which* tenancy/instance it represents. Resolution is identical in shape across all three modes — only the discovery input differs:

   | Daemon mode | How `ai-orchestrator-mcp` discovers the right daemon |
   |---|---|
   | **A — per-VS-Code-instance** | The extension, when registering `ai-orchestrator-mcp` in `mcp.json`, injects two env vars into the entry: `AI_ORCHESTRATORD_PIPE=\\.\pipe\ai-orchestratord-<userSid>-<vscodeInstanceId>` (or the POSIX socket path) and `AI_ORCHESTRATORD_NONCE=<32-byte-hex>`. The MCP server reads both from its own `process.env` at startup and presents the nonce as the first frame on the connection. Each VS Code instance writes its own `mcp.json` entry (or namespaced server name like `ai-orchestrator-<instanceId>`) so multiple windows don't fight over the same MCP server identity. **No handshake file is ever written.** |
   | **B — shared per-user** | Same env-var injection mechanism, with the per-user pipe/socket address. All MCP clients (regardless of which window registered the entry) attach to the same daemon and see the same plan set. |
   | **C — centralized** | `mcp.json` carries `--endpoint <uri>` and `AI_ORCHESTRATOR_TOKEN` env (or the env name configured by `aiOrchestrator.daemon.authTokenEnv`, or an OIDC client config). The MCP server presents the token as the first frame and the daemon scopes everything by token-derived `tenantId`. |

   **The pub/sub flow itself is the same regardless of mode** (this is the part the question calls out): once `ai-orchestrator-mcp` has authenticated to the daemon, it opens a single long-lived `IEventBus.SubscribeAsync` stream per MCP client session. Each event the bus emits is forwarded to the MCP host as an MCP `notifications/ai-orchestrator.event` message tagged with the originating `planId` / `jobId` / `runId`. The MCP host (Copilot Chat) routes those notifications back into the agent's context per its own UX conventions. Key invariants:
   - **One subscription per MCP client session, not per tool call** — tool invocations like `plan.watch` return a *handle* that references the existing stream rather than opening N parallel streams.
   - **Backpressure is honored** via `SubscriptionOptions.MaxBufferedEvents` (§3.4.2); when an MCP host is slow, the daemon applies the configured `OverflowStrategy` (default `DropOldest`) and emits a `SubscriberLagged` event so the host can recover via `Replay(SinceSequence)` rather than missing state.
   - **Tenancy is enforced server-side** in Mode C — an MCP client can never subscribe to a `planId` outside its tenancy, even if it knows the id, because the filter is intersected with the auth context.
   - **Sequence + id are stable across modes** (W7), so a Mode-C centralized daemon serving multiple MCP clients still gives each one a deterministic, dedupable, replayable stream.

   **Defaulting and migration:** Mode A is the safe default and matches today's mental model (plans live with the window you started them in). Modes B and C are unlocked via explicit settings and require the user to understand they are sharing state — the extension surfaces a status-bar indicator and a one-time consent prompt when either is first enabled.

3. **Native binding** (`AiOrchestrator.Bindings.Node`): loaded in-process by the extension via `require()`. Gives synchronous-feeling RPC and zero-copy event delivery. If loading fails (RID mismatch, AV quarantine), the extension automatically falls back to the named-pipe client.

#### Transport selection settings

| Setting | Behavior |
|---|---|
| `aiOrchestrator.transport: "auto"` (default) | Try native binding → fall back to named pipe → fall back to in-proc legacy TS engine (only available during phases 1–6). |
| `aiOrchestrator.transport: "binding"` | Native binding only; error on failure. |
| `aiOrchestrator.transport: "pipe"` | Named pipe only — useful if the daemon is remote (future scenario). |
| `aiOrchestrator.daemon.autoStart: true` | Extension spawns the daemon at activation (Modes A/B only). |
| `aiOrchestrator.daemon.scope: "instance" \| "user"` (default `"instance"`) | Selects daemon Mode A (per-VS-Code-instance, default) vs Mode B (shared per-user). Ignored when `daemon.endpoint` is set. |
| `aiOrchestrator.daemon.endpoint: "<uri>"` | Selects Mode C — connect to an externally-managed daemon. Disables local spawn and `daemon.scope`. Requires `aiOrchestrator.daemon.authTokenEnv` (or OIDC config) for auth. |
| `aiOrchestrator.mcp.register: true` | Extension writes `ai-orchestrator-mcp` into the user's `mcp.json`. In Mode A the entry is namespaced per VS Code instance to avoid cross-window collisions. |
| `aiOrchestrator.mcp.bundled: true` | Use the `ai-orchestrator-mcp` binary shipped inside the VSIX rather than a globally installed one. |

### 4.7 Native Node.js binding (`AiOrchestrator.Bindings.Node`)

A prebuilt N-API native module that exposes the daemon's `IAiOrchestrator` and `IEventBus` to Node.js with **zero JSON-RPC overhead** when running in-process. Built once per RID using `Job.NET` / `NetCore.Job` interop or hand-rolled N-API + a managed bootstrapper, and shipped on npm as `@ai-orchestrator/native`.

```typescript
// What the extension code sees:
import { AiOrchestrator, EventStream } from '@ai-orchestrator/native';

const orch = await AiOrchestrator.connect({ mode: 'inproc' | 'pipe' });
const events: EventStream = orch.subscribe({ planId, categories: ['Job', 'Agent'] });
for await (const evt of events) { /* … */ }
await orch.pause(planId);
```

The binding:

- Hosts the .NET 10 runtime in-process via `hostfxr`.
- Translates events into JS objects using the same generated TS types as the pipe client.
- Honors backpressure with N-API's `napi_threadsafe_function` queue.
- Falls back to the named-pipe transport transparently if in-proc hosting is disabled.

#### Why coexisting projections matter

More than one UX can be live simultaneously against the same daemon:

- **Node binding** for VS Code's UI (low latency, native objects).
- **MCP stdio** for Copilot Chat tool invocations (separate process).
- **JSON-RPC pipe** for an open `ai-orchestrator plan watch <id>` terminal (third process).
- **OTel exporter** for telemetry.

All four subscribe to the same `IEventBus` with their own filters and backpressure policies; the daemon multiplexes.

### 4.7.1 N-API in-proc hosting — risk mitigation (Phase 0 spike required)

Hosting .NET 10 inside the VS Code extension host via `hostfxr` is the highest-risk piece of architecture in this plan. It is also the path that gives the UX its lowest event latency. We treat it as a **Phase 0 spike** that gates the in-proc path from becoming the primary VS Code transport — the named-pipe transport must be a first-class peer (not a degraded fallback) so that a failed spike is a re-prioritization, not a re-design.

#### 4.7.1.1 GC tuning for an interactive host

VS Code is single-process / multi-thread / interactive; throughput-tuned Server GC is the wrong choice. Daemon configuration when loaded in-proc:

- `<ServerGarbageCollection>false</ServerGarbageCollection>` — Workstation GC; smaller per-collection pauses than Server GC, with much smaller heap footprint.
- `<ConcurrentGarbageCollection>true</ConcurrentGarbageCollection>` — background gen-2 collection runs concurrently with user code; stop-the-world phases are limited to mark-roots and rendezvous.
- `<RetainVMGarbageCollection>false</RetainVMGarbageCollection>` — return committed memory to the OS aggressively so VS Code's working set doesn't bloat.
- `DOTNET_GCHeapHardLimit` set to a configurable cap (default 512 MiB for in-proc; 2 GiB for the standalone daemon) so a runaway leak hits a hard wall before the OS starts swapping.

When loaded in the standalone daemon (not in-proc), Server GC is appropriate and re-enabled.

#### 4.7.1.2 Pause-time budget (CI-gated)

The Phase 0 spike runs a BenchmarkDotNet harness that simulates the real DAG-update event flow (50 Hz event publish, 10 KB N-API JS object per event, 30-minute soak) and measures Gen2 pause distribution. The spike passes when:

- p99 Gen2 pause < **50 ms**
- p999 Gen2 pause < **200 ms**
- Sustained allocation rate < **10 MiB/s** (forces gen-2 frequency to < 1/min)

Failing any threshold demotes the in-proc path to Phase 5 stretch goal and the named-pipe transport becomes the primary VS Code path. The same benchmark runs in CI for every PR touching `AiOrchestrator.Bindings.Node` so regressions are caught immediately.

#### 4.7.1.3 Exception isolation boundary

.NET 10 has no `AppDomain` sandbox; we get isolation through three layered mechanisms:

1. **Managed exceptions** — every binding entry point wraps its body in a top-level `try/catch (Exception ex)` that converts the exception into a structured JS `Error` (with `name`, `message`, `code`, `stack`). The .NET runtime never sees an unhandled managed exception. Roslyn analyzer `OE0011` flags any binding-exported method whose body is not wrapped.
2. **Async unhandled-exception watchdog** — `TaskScheduler.UnobservedTaskException` and `AppDomain.CurrentDomain.UnhandledException` handlers signal the binding's `HostHealth` state to `Degraded`. The next call from JS observes `Degraded` and routes through the named-pipe fallback automatically; an `RuntimePressure { reason: "unobserved-exception", details: ... }` event surfaces on the bus.
3. **Process-fatal failures** (`AccessViolationException`, `StackOverflowException`, fast-fail) — these terminate the process by design; we cannot "catch" them. The mitigation is: **the standalone daemon is also running** as a fallback transport. The Node binding's health watchdog detects host-CLR death (loss of the in-proc handle) within one event-loop tick and the binding rebinds JS callers to the pipe transport. The user sees a one-time "Switched to pipe transport (in-proc CLR crashed)" status-bar message and an `OperatorAttention` event for telemetry. **No work is lost** — plans live in the standalone daemon, not in the binding.

#### 4.7.1.4 Coexistence with C# DevKit and other .NET-loading extensions

Multiple extensions loading .NET into the same process is a known footgun (type identity clashes, version-mismatched runtime selection):

- We load into a **named `AssemblyLoadContext`** (`"AiOrchestrator"`) so our types are identity-isolated from any other `.NET-in-Job` consumer (C# DevKit, future Razor extensions).
- `runtimeconfig.json` pins `"rollForward": "Disable"` and the exact major-minor of .NET 10 we tested against, so a newer runtime installed on the user's machine cannot transparently take over and silently break our ABI assumptions.
- The binding probes for an existing CLR host on first call; if one is found in a different ALC, we attach to the same `hostfxr` instance rather than instantiating a second one. (The hostfxr API supports this; the failure mode of two hostfxr instances in one process is undefined.)
- Integration test in CI installs `ms-dotnettools.csdevkit` alongside our extension and asserts both activate cleanly and survive a 30-minute mixed-workload soak.

#### 4.7.1.5 ThreadPool sharing with libuv

.NET's `ThreadPool` and Job's libuv pool are independent OS-thread pools competing for the same cores. Our defaults:

- `ThreadPool.SetMinThreads(Environment.ProcessorCount / 2, Environment.ProcessorCount / 2)` — leave half of available cores to libuv at minimum.
- `ThreadPool.SetMaxThreads` left at default but a periodic monitor publishes `RuntimePressure { kind: "threadpool-saturation" }` whenever `ThreadPool.PendingWorkItemCount > 100` for more than 1 s. Saturation events route to telemetry and to a status-bar indicator.
- All public binding methods that bridge to .NET call **`ConfigureAwait(false)`** religiously — the libuv thread that called us must not be captured for continuations.

#### 4.7.1.6 First-class pipe fallback

The pipe transport is **not** a degraded mode. The same `IAiOrchestrator` interface binds to either a `NativeBindingProxy` (in-proc N-API) or a `PipeClientProxy` (JSON-RPC over named pipe) via the extension's DI composition root. The UX layer (sidebar, panels, status bar) is unaware of which transport is active. CI runs the entire VS Code integration suite against both transports separately and asserts behavioral parity. If the Phase 0 spike fails, the only line of code that changes is the DI registration — every other line was already exercising the pipe path in CI.

### 4.8 Startup time budgets

Cold-start latency matters for the CLI (`ai-orchestrator …` should feel snappy in scripts) and for the extension activation event (anything > 200 ms shows up in VS Code's startup performance report). We set explicit budgets, measure them in CI, and fail the build on regression.

| Surface | Cold | Warm | Measurement |
|---|---|---|---|
| `ai-orchestrator <subcommand>` to first JSON byte | < **200 ms** | < **80 ms** | BenchmarkDotNet wrapper + CI smoke; single-file ReadyToRun, trimmed |
| `ai-orchestratord` from spawn to listening on pipe | < **1 s** | < **400 ms** | Acceptance test: spawn + `nc/tee` to pipe; measure round-trip on a noop ping |
| `ai-orchestrator-mcp` from spawn to first `tools/list` response | < **500 ms** | < **200 ms** | Acceptance test: pipe stdin/stdout; measure first response after `initialize` |
| VS Code extension activation contribution | < **250 ms** added | < **50 ms** added | `extension.ts` `activate()` start-to-return; logged via VS Code's built-in startup tracker |
| First `IEventBus` event delivery latency (in-proc binding) | < **2 ms** p99 | < **0.5 ms** p99 | BenchmarkDotNet + integration test |
| First plan listing for a 100-plan repo | < **300 ms** | < **100 ms** | Integration test against a fixture repo; reads from `.aio/p/` index |

#### 4.8.1 Build flags by surface

| Artifact | Flags |
|---|---|
| CLI (`ai-orchestrator`) | `PublishSingleFile=true`, `PublishTrimmed=true`, `PublishReadyToRun=true`, `InvariantGlobalization=true`. Investigated NativeAOT for Phase 4 (see §4.8.2). |
| Daemon (`ai-orchestratord`) | Same as CLI plus `ServerGC=true` (no in-proc concern). |
| MCP (`ai-orchestrator-mcp`) | Same as CLI; trim profile is more aggressive (no UX rendering code). |
| N-API binding (`@ai-orchestrator/native`) | Same as CLI; `ServerGC=false` per §4.7.1.1. |

#### 4.8.2 NativeAOT for the CLI fast-path (Phase 4 stretch)

Full NativeAOT for the CLI gets sub-100 ms cold start but is incompatible with libgit2sharp (P/Invoke + native deps + dynamic loading) and with our reflection-emit-using JSON contexts. The Phase 4 plan: AOT-compile a thin **fast-launcher binary** that handles the read-only commands (`--version`, `--help`, `plan list`, `plan show <id>`, `plan watch <id>` with no mutation). For everything else, the launcher `execve`s into the JIT binary. This gives 80% of users the snappy feel without sacrificing the full feature set.

#### 4.8.3 Trim safety

- `<TrimmerWarningsAsErrors>true</TrimmerWarningsAsErrors>` in CI for every shipped artifact.
- Every reflection-touching API has explicit `[DynamicallyAccessedMembers]` or `[RequiresUnreferencedCode]` annotations.
- The custom JSON `JsonSerializerContext` is the **only** sanctioned serializer entry point (E8 in §3.5.4); it is fully trim-safe by construction.
- Roslyn analyzer `OE0012` flags any reflection call (`Type.GetMethod`, `Activator.CreateInstance`, `Assembly.Load`) outside an allowlisted set of host-bootstrap files.

---

## 5. Security Model

### 5.1 Threat model summary

| Threat | Mitigation |
|--------|------------|
| Local user A spying on local user B's daemon | POSIX socket `0600` + per-user `XDG_RUNTIME_DIR`; Windows pipe `PipeSecurity` restricted to current SID |
| Replay / unauthorized client | 32-byte cryptographic nonce, single-use, bound to one connection, single-client acceptance, 5s auth timeout |
| Nonce leak via process list | Nonce never on argv; passed via env var to the spawned child only — the env block is private to the child process and gone at exit |
| Nonce leak via disk | **No handshake file is ever written.** No `0600` rendezvous file, no discovery directory, no `.lock` or `.json` containing the nonce. Eliminates TOCTOU, leftover-after-crash reuse, AV indexing, accidental commit, symlink-swap, and same-user reads as attack surfaces. (See §4.1.1 H3.) |
| Path traversal in plan specs | All user-provided paths resolved via `Path.GetFullPath` then validated against worktree root with `StartsWith` (matches current rule in `code-review.instructions.md`) |
| Command injection in agent prompts | Agent args are passed as argv arrays (never shell-interpolated); env-vars validated; no `cmd /c` / `bash -c` pass-through |
| Symlink escape from worktree | Worktree manager refuses to create symlinks outside the worktree; validated on `setup` phase |
| Untrusted plan YAML executes arbitrary commands | Plans are explicit DAGs of `WorkSpec` objects, not scripts; shell `WorkSpec` requires explicit `--allow-shell` flag at the daemon level |
| Daemon DoS via connection flood | Per-process listener accepts only one auth'd client at a time; failed auth attempts counted and pipe rotated after N |
| Logs leak secrets | Existing redaction filters ported; pipe responses go through the same `SecretRedactor` |

### 5.1.1 Per-mode threat model & blast-radius analysis

§4.6 introduces three daemon scoping modes (A per-VS-Code-instance, B per-user shared, C centralized). The threat model in §5.1 covers the connection-level attacks; this section covers the post-auth, multi-tenant-style concerns specific to Modes B and C, and codifies the rules that keep Mode A's strong default isolation when the user opts into the others.

| Concern | Mode A — per-VS-Code-instance (default) | Mode B — per-user shared (opt-in) | Mode C — centralized / multi-tenant |
|---|---|---|---|
| **Trust boundary** | Single workspace, single VS Code window-group. | All workspaces opened by one user. | Multi-tenant: daemon serves multiple authenticated clients/users. |
| **Workspace isolation after auth** | Trivial — only one workspace exists in this daemon. | **Required.** Every RPC carries a `WorkspaceContext` bound at handshake to the workspace path the client claimed. The daemon enforces all `PlanId`/`JobId` lookups against that context (deny if `plan.WorkspaceRoot ≠ context.WorkspaceRoot`). | **Required.** Every RPC carries a `TenantContext` derived from token claims. Per-tenant `IPlanRepository` instance; **no global plan registry** — cross-tenant access is structurally impossible. |
| **Credential lease scope (§3.3.1)** | Per-connection (= per-workspace). | Per-(connection, workspace-root) tuple. Leases acquired by Workspace A are inaccessible to Workspace B even though the daemon process holds both. | Per-(tenant, remote-origin, account); never reused across tenants; tenant-scoped LRU. |
| **Worktree lease scope (§3.3.2)** | Single workspace, single registry. | Workspace-keyed registry directories; reclaim-on-startup processes only the workspace contexts whose lock files match the current daemon. | Tenant-keyed registry on tenant-scoped storage volumes; never cross-tenant reclaim. |
| **Event subscription scope** | All events are visible to the sole client. | Subscribers' `EventFilter` is **augmented** server-side with `WorkspaceId = context.WorkspaceId` — clients cannot widen the filter past their context. | Same, with `TenantId` augmentation. Bus dispatcher rejects subscriptions whose filter would observe other tenants' events. |
| **Blast radius if one client is compromised** | One workspace's plans, agent runs, log files. | All workspaces opened by the same user (they share OS uid anyway) — but **not** other users (separate daemon process per user). | One tenant's data only; cross-tenant escape requires breaking the auth pipeline AND the per-tenant routing — two independent failures. |
| **Pipe / transport ACL** | Owner-SID restricted (Windows) / `0600` socket (POSIX). | Owner-SID restricted / `0600` — same as Mode A. | TLS+mTLS (TCP) or Unix-socket peercred + bearer token; no shared-FS ACL for cross-host case. |
| **Audit trail** | Local event log per workspace. | Per-(workspace, runId) tagged events; T2 segments per workspace. | Per-(tenant, workspace, runId); **mandatory** centralized event sink; events carry `prev_seq_hash` for tamper-evident chaining (Phase 5 hardening). |
| **Heartbeat / orphan policy** | Daemon exits when last client disconnects after `idleTimeout` (configurable; default 5 min). | Daemon stays up; per-(workspace) sessions cleaned on disconnect per §3.7.5. | Daemon stays up; per-tenant sessions cleaned; daemon-wide draining handled by orchestration tier (k8s, etc.). |
| **Telemetry leakage** | All telemetry is the user's own. | Workspace-tagged telemetry; `WorkspaceId` is a hash of the workspace root path, never the path itself. | Tenant-tagged; never includes workspace paths or user identifiers in exported metrics. |

**Rules that fall out of this and are non-negotiable:**

- **`WorkspaceContext` is set at auth time and immutable for the connection's life.** A reconnecting client gets a new connection and re-authenticates against its workspace; a single connection cannot "switch workspaces" mid-session. This is what makes Mode B safe — the rule is enforced by the auth pipeline, not by goodwill from RPC handlers.
- **`TenantContext` is bound to the auth credential, not the connection.** Tokens carry tenant claims (signed); pipe nonces in Modes A/B are workspace-bound by being scoped to the spawning VS Code instance.
- **Every plan-repository lookup, lease cache hit, and event subscription is filter-keyed by `WorkspaceContext`/`TenantContext`.** Roslyn analyzer `OE0008` (§3.6.8) flags any `IPlanRepository.LoadStateAsync(planId, …)` or `IEventBus.SubscribeAsync(…)` call site that does not also pass an `AuthContext` parameter; the bare overloads exist only inside `AiOrchestrator.Security` and are `[InternalsVisibleTo]`-restricted.
- **Mode B's documentation must spell out the trade-off explicitly.** "If any process you run as your user can read your file system, it can also drive your plans via this daemon." Mode A is the default precisely because per-instance scoping aligns with most users' mental model of "this VS Code window owns its work."
- **Mode C requires the auth pipeline AND the routing layer to be reviewed together.** A Mode C deployment without the per-tenant routing tests in CI is a misconfiguration; the daemon refuses to start in Mode C unless the routing self-test passes at startup.

### 5.2 Auth handshake (named pipe / socket)

**Pre-condition:** the parent process spawned the child with `AI_ORCHESTRATORD_PIPE` (or `AI_ORCHESTRATORD_SOCKET`) and `AI_ORCHESTRATORD_NONCE` set in the child's environment block. **Nothing is written to disk.**

```mermaid
sequenceDiagram
    autonumber
    participant Parent as Spawning Process - VSCode/CLI/MCP host
    participant Daemon as Ai-orchestratord
    participant Client as MCP/UI Client child process

    Parent->>Daemon: start with --pipe P (or auto-bind)
    Daemon-->>Daemon: generate nonce N - 32B random, store in memory only
    Daemon-->>Daemon: bind pipe P with restrictive ACL, listen
    Parent->>Parent: receive N from daemon stdout banner OR pre-share
    Parent->>Client: spawn with env AI_ORCHESTRATORD_PIPE=P, AI_ORCHESTRATORD_NONCE=N
    note over Parent,Client: env block is private to child; no disk artifact
    Client->>Client: read N and P from process.env at startup
    Client->>Daemon: connect to P
    Client->>Daemon: first frame {type auth, nonce N}
    alt nonce matches and within 5s timeout
        Daemon-->>Daemon: constant-time compare; mark nonce consumed
        Daemon-->>Daemon: zero in-memory nonce copy
        Daemon-->>Client: {type auth-ok, capabilities ...}
        Daemon-->>Daemon: refuse further connects until disconnect
    else mismatch, replay, or timeout
        Daemon-->>Daemon: increment failed-attempt counter
        Daemon-->>Client: close socket without response
        opt failed attempts > threshold
            Daemon-->>Daemon: rotate nonce, rebind pipe
        end
    end
    Client->>Daemon: JSON-RPC requests
    Daemon-->>Client: responses + event stream
```

**In-proc hosting skips this entirely** — see §4.1.1 H1. The CLI's short-lived commands, unit tests, and any future C#-embedded scenario resolve `IAiOrchestrator` directly from the DI container; there is no transport, no nonce, no auth message.

This is the same nonce-auth shape as today's `McpIpcServer` flow, **with the handshake file removed.** The previous design wrote the nonce to a `0600` file under `XDG_RUNTIME_DIR` so that the spawned client could read it; the new design passes it in the env block instead, eliminating an entire class of disk-based attacks (see §4.1.1 H3).

---

## 6. Sequence Diagrams

### 6.1 CLI: create plan, watch progress

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant CLI as ai-orchestrator CLI
    participant Host as InProcHost / Daemon
    participant Core as AiOrchestrator.Core
    participant Git as AiOrchestrator.Git
    participant Agent as IAgentExecutor

    User->>CLI: ai-orchestrator plan create --from-file plan.yaml --watch
    CLI->>Host: IAiOrchestrator.CreateAsync(spec)
    Host->>Core: PlanRunner.Create(spec)
    Core->>Git: prepare base branch / worktree skeleton
    Core-->>Host: PlanInstance
    Host-->>CLI: PlanInstance
    CLI->>Host: SubscribeAsync(planId)
    Host-->>CLI: JobTransition(pending->ready)
    Core->>Git: create worktree for job
    Core->>Agent: RunAsync(agent request)
    Agent-->>Core: stdout/stderr/stats via IProgress<AgentEvent>
    Core-->>Host: JobStdout, JobMetrics
    Host-->>CLI: events streamed
    Agent-->>Core: AgentRunResult success
    Core->>Git: commit + merge-RI
    Core-->>Host: JobTransition(running->succeeded)
    Host-->>CLI: JobTransition
    CLI-->>User: render progress and exit code
```

### 6.2 VS Code extension: existing UI consumes daemon

```mermaid
sequenceDiagram
    autonumber
    participant UI as VS Code Webview Sidebar/Panel
    participant Ext as Extension Host TS
    participant Pipe as Named Pipe
    participant Daemon as Ai-orchestratord
    participant Core as AiOrchestrator.Core

    Ext->>Daemon: spawn ai-orchestratord with env AI_ORCHESTRATORD_PIPE=P, AI_ORCHESTRATORD_NONCE=N
    Daemon-->>Daemon: bind pipe P with current-user ACL, listen
    Ext->>Pipe: connect to P
    Ext->>Pipe: first frame {type auth, nonce N}
    Pipe-->>Ext: auth-ok
    Ext->>Pipe: subscribe(filter all)
    UI->>Ext: user clicks "Pause Plan"
    Ext->>Pipe: plan.pause(planId)
    Pipe->>Daemon: forward
    Daemon->>Core: PlanRunner.Pause(planId)
    Core-->>Daemon: JobTransition events
    Daemon-->>Pipe: events
    Pipe-->>Ext: events
    Ext-->>UI: postMessage(stateUpdate)
    UI-->>UI: re-render unchanged
```

### 6.3 Copilot Chat / MCP: tool invocation (ai-orchestrator-mcp is a separate product)

```mermaid
sequenceDiagram
    autonumber
    participant Chat as Copilot Chat / Claude Desktop / any MCP host
    participant McpBin as ai-orchestrator-mcp binary
    participant Daemon as Ai-orchestratord
    participant Core as AiOrchestrator.Core

    Chat->>McpBin: spawn from mcp.json with env AI_ORCHESTRATORD_PIPE, AI_ORCHESTRATORD_NONCE
    McpBin->>Daemon: read env, connect to pipe, send first-frame auth
    Chat->>McpBin: initialize, tools/list, tools/call create_copilot_plan
    McpBin->>Daemon: plan.create JSON-RPC
    Daemon->>Core: CreateAsync
    Core-->>Daemon: PlanInstance + bus event PlanCreated
    Daemon-->>McpBin: response + notifications/ai-orchestrator.event stream
    McpBin-->>Chat: tool result + MCP notifications
```

### 6.5 Multi-UX coexistence: VS Code + MCP + CLI watch

```mermaid
sequenceDiagram
    autonumber
    participant Ext as VS Code Extension - via Node binding
    participant ChatMcp as Copilot Chat - via ai-orchestrator-mcp
    participant CliWatch as ai-orchestrator plan watch - via pipe
    participant Bus as IEventBus inside Daemon
    participant Core as AiOrchestrator.Core

    Ext->>Bus: Subscribe filter planId X categories all
    ChatMcp->>Bus: Subscribe filter planId X categories Job Plan
    CliWatch->>Bus: Subscribe filter planId X categories all
    Core-->>Bus: JobTransition pending to ready
    Bus-->>Ext: event - native object
    Bus-->>ChatMcp: event - MCP notification
    Bus-->>CliWatch: event - JSON line
```

### 6.4 Pluggable agent: switching from Copilot to Claude

```mermaid
sequenceDiagram
    autonumber
    participant Plan as PlanSpec YAML
    participant Core as AiOrchestrator.Core
    participant Reg as IAgentRegistry
    participant CExec as ClaudeAgentExecutor
    participant CCLI as claude CLI

    Plan-->>Core: job.work.executor = "claude"
    Core->>Reg: Resolve("claude")
    Reg-->>Core: ClaudeAgentExecutor
    Core->>CExec: RunAsync(request, observer)
    CExec->>CCLI: spawn claude --session ... --task ...
    CCLI-->>CExec: stdout / stderr stream
    CExec->>Core: AgentSpawned / AgentSessionId / AgentTaskComplete via IProgress
    CCLI-->>CExec: exit 0
    CExec-->>Core: AgentRunResult success
```

---

## 7. UX Surfaces (Front-End by Front-End)

### 7.1 VS Code extension UX

**No visible changes.** All current UI surfaces continue to work exactly as today:

- **Plans Sidebar** — same tree, same actions, same icons.
- **Plan Detail Panel** — same Mermaid graph, same job list.
- **Job Detail Panel** — same logs/attempts/metrics.
- **Status Bar** — same progress indicator.
- **Bulk Plan Actions** — same multi-select operations.

The only difference is plumbing: the events arriving from the daemon are translated by `compatShim.ts` into the same shape today's UI expects (`'planCreated'`, `'jobTransition'`, `'jobStarted'`, …).

### 7.2 CLI UX

- **Default text mode** for humans:

  ```
  $ ai-orchestrator plan list
  ID                                   NAME             STATUS    PROGRESS  STARTED
  9f3c…                                Build Pipeline    running    7/12      2m ago
  4e1a…                                Refactor DI       paused     3/8       12m ago
  ```

- **`--json`** for scripts and Copilot CLI integration.

- **`watch`** uses interactive TTY rendering (Spectre.Console) when `stdout.IsTerminal`, else line-mode events.

- **Exit codes**: 0 success, 2 plan failed, 3 job failed, 4 connection error, 5 auth error.

### 7.3 GitHub Copilot CLI plugin UX

Same surface as the standalone CLI but namespaced under `gh copilot ai-orchestrator`. Auth uses `gh auth token` for any GitHub-side calls (PR/branch protection lookups). Output format defaults to whatever Copilot CLI's plugin convention prefers (JSON-by-default).

### 7.4 MCP / Copilot Chat UX

Tools listed in `tools/list` are **byte-identical** to today's set (`scaffold_copilot_plan`, `add_copilot_plan_job`, `finalize_copilot_plan`, `create_copilot_plan`, `pause_copilot_plan`, `resume_copilot_plan`, `cancel_copilot_plan`, `delete_copilot_plan`, `retry_copilot_plan`, `recover_copilot_plan`, `archive_copilot_plan`, `clone_copilot_plan`, `reshape_copilot_plan`, `update_copilot_plan_job`, `bulk_update_copilot_plan_jobs`, `get_copilot_plan_status`, `get_copilot_plan_graph`, `list_copilot_plans`, `list_copilot_jobs`, `get_copilot_job`, `get_copilot_job_logs`, `get_copilot_job_attempts`, `get_copilot_job_failure_context`, `force_fail_copilot_job`, `run_copilot_integration_test`).

This guarantees no Copilot Chat user perceives a regression.

---

## 8. Repository, Worktree & Plan Lifecycle

This section nails down the operational contract: where state lives **per repository**, how `.gitignore` is managed, how worktrees are initialized, and what shapes plans and jobs are allowed to take. Everything in §3–§7 assumes these conventions; this is the source of truth.

### 8.1 Per-repo orchestrator state — what lives where

A single user can have many repos and many concurrent plans. The daemon (regardless of scope mode A/B/C from §4.6) keeps **all per-repo state inside the repo itself**, so:

- The repo is portable — clone it elsewhere and the orchestrator can still recover plan history.
- A user's home directory holds **no plan state** (only credential cache, daemon lock files, idempotency markers).
- `git clean -xfd` does **not** destroy plan state because the orchestrator's tracked metadata is committed; only ephemeral run artifacts are ignored.
- We do **not** write inside `.git/`. The git directory is for git, not for our state. Crashing a `git gc` or a third-party tool that touches `.git/` shouldn't risk our data; conversely, our crashes shouldn't risk the user's git state.
- **Path length matters.** On Windows, the legacy `MAX_PATH` of 260 characters and the de-facto build-tool ceiling (~248 for many compilers, ~200 for some Node.js tools that prepend `node_modules/`) means every byte of fixed overhead in the worktree path is a byte stolen from real source paths. We use **two** short top-level dirs (`.aio/`, `.wt/`) and short subpaths inside both.

#### Naming conventions

| Token | Stands for | Bytes |
|---|---|---|
| `.aio` | **A**I-agent **I**nfrastructure / **O**rchestrator (vendor-neutral; works for any AI agent runner, not just Copilot) | 4 |
| `.aio/.ps` | **P**lan **S**tate (gitignored runtime state — the dot-prefix nests the gitignored subset under the tracked root for tidy `dir`/`ls`) | 8 |
| `.wt` | **W**ork**T**rees (gitignored; root-level so worktree paths are as short as physically possible) | 3 |
| `<plan8>` | First 8 hex chars of the plan UUID (collision-safe within a single repo's plan set) | 8 |
| `<job8>` | First 8 hex chars of the job UUID (collision-safe within a plan) | 8 |

**Worktree path budget on Windows:** `C:\src\<repo>\.wt\<plan8>\<job8>\<attempt>\` consumes only ~30 bytes of fixed overhead beyond the repo root — e.g. `.wt\9f3c8a4b\6e1d77c0\1\` is 23 bytes. Compare to today's `.worktrees/<full-uuid>/<full-uuid>/` which alone burns 88 bytes.

#### Directory layout inside the repo

```
<repoRoot>/
├── .aio/                              ← committed; survives clean and clone ("AI orchestrator")
│   ├── config.yaml                    ← repo-level config (max parallelism, default base branch, allowed agents)
│   ├── README.md                      ← human-readable explanation of the directory
│   ├── p/                             ← plan definitions ("p" not "plans" to save 4 bytes per nested path)
│   │   ├── 9f3c8a4b/                  ← plan id, first 8 hex of UUID; full UUID in manifest.json
│   │   │   ├── plan.json              ← canonical immutable plan definition (post-finalize)
│   │   │   ├── manifest.json          ← name, owner, full id, schemaVersion, createdAt, finalizedAt, targetBranch, baseBranch
│   │   │   └── n/                     ← job specs ("n" not "jobs")
│   │   │       ├── 6e1d77c0/          ← job id, first 8 hex
│   │   │       │   ├── spec.json      ← JobSpec snapshot at finalize time
│   │   │       │   └── INSTRUCTIONS.md ← agent-readable instructions (if work.type == agent); SHOUTY for review visibility
│   │   │       └── …
│   │   └── …
│   ├── s/                             ← optional pinned plan snapshots for compliance review ("s" not "snapshots")
│   │   └── local/                     ← per-developer pinned snapshots (gitignored — see §8.2)
│   └── .ps/                           ← NOT committed; per-clone runtime state ("plan state")
│       ├── state/
│       │   ├── 9f3c8a4b.json          ← live mutable state (status, attempts, cursors); written via atomic rename
│       │   ├── 9f3c8a4b.json.bak      ← previous good state for crash recovery
│       │   └── 9f3c8a4b.lock          ← advisory lock; daemon-pid + start time
│       ├── log/                       ← raw stdout/stderr/native-log captures ("log" not "logs")
│       │   ├── 9f3c8a4b/6e1d77c0/<phase>/<attempt>.log
│       │   └── …
│       ├── rb/                        ← bounded event ring buffer (§3.4.2) for cross-process replay
│       └── lock                       ← daemon liveness lock file (PID + start time only — NEVER contains a nonce; see §4.1.1 H3)
│
└── .wt/                               ← .gitignored; root-level for shortest possible path to compiled artifacts (see §8.3)
    └── 9f3c8a4b/6e1d77c0/<attempt>/   ← <plan8>/<job8>/<attempt> — ~23 bytes overhead
```

> **Note on `.git/`.** Earlier drafts of this design parked runtime state under `.git/ai-orchestrator/`. We do not do that. `.git/` belongs to git and to git's tooling; layering our state inside it creates failure modes (`git gc`, `git maintenance`, `git clone --no-local`, third-party `.git/` writers) that are entirely avoidable. The `.aio/.ps/` location is gitignored via a managed block in `.gitignore` (see §8.2) and gives us the same "per-clone, not portable" lifecycle without the entanglement.

**Why split tracked vs `.aio/.ps/`?**

| Path | Tracked? | Purpose | Lifecycle |
|---|---|---|---|
| `.aio/p/<plan8>/plan.json` | **yes** | Immutable post-finalize definition | Lives forever in git history; reviewable in PRs; reproduces a plan exactly. |
| `.aio/p/<plan8>/manifest.json` | **yes** | Plan identity + provenance (author, finalize time, branches, full UUID) | Same as above; one source of truth for "what did we approve?" |
| `.aio/p/<plan8>/n/<job8>/INSTRUCTIONS.md` | **yes** | Agent instructions | Lets reviewers see exactly what each AI was told to do — **critical for security/audit review of agent-generated PRs.** |
| `.aio/.ps/state/*.json` | **no** | Live execution state (cursors, attempts, current job statuses) | Per-clone; not portable; recoverable via `Recover` from the immutable definition + git commits. |
| `.aio/.ps/log/**` | **no** | Raw stdout/stderr/native-log captures | Per-attempt; pruned by daemon retention policy. |
| `.aio/.ps/rb/` | **no** | Event ring buffer for late subscribers | Bounded; safe to delete (replay falls back to last persisted state). |
| `.aio/.ps/lock` | **no** | Daemon liveness marker (PID + start time — **never** a nonce; see §4.1.1 H3) | Re-created per daemon attach; deleted on graceful shutdown. |
| `.wt/**` | **no** (gitignored) | Active worktree checkouts | Created/destroyed per job execution. |

**Recovery contract:** if `.aio/.ps/` is deleted, `ai-orchestrator plan recover <planId>` rebuilds runtime state from `.aio/p/<plan8>/` plus the git commit graph (each job's commit references the planId/jobId in its trailer). This is the same `recover_copilot_plan` semantic that exists today, formalized.

#### Per-repo daemon attachment

The daemon attaches to a repo lazily on first request mentioning that repo's path. Attachment is keyed by **canonical repo root** (`git rev-parse --show-toplevel` resolved through symlinks). Multiple repos in one daemon process are isolated by:

- A separate `IPlanRepository` instance per repo (rooted at that repo's `.aio/`).
- A separate `IPlanStateStore` instance per repo (rooted at that repo's `.aio/.ps/`).
- A separate `IGitOperations` instance per repo (rooted at that repo's `.git/`, but we only **read** with libgit2 / git CLI — we never **write** files inside `.git/`).
- A shared `IEventBus` that **always tags events with `repoRoot`** so multi-UX subscribers (§4.6) can filter.

Detach happens when no plan in that repo has been touched for the daemon's idle-shutdown interval.

### 8.2 `.gitignore` management — automatic, idempotent, reviewable

The orchestrator owns a small, well-known set of paths that **must** be gitignored. We do not require users to remember to add them. Instead, on first attachment to a repo, the daemon runs an idempotent `.gitignore` install step.

**Algorithm:**

1. Read the repo's root `.gitignore` (create if missing).
2. Look for a delimited managed block:
   ```gitignore
   # >>> aio (managed v1) — do not edit between markers
   .aio/.ps/
   .aio/s/local/
   .aio.local.yaml
   .wt/
   # <<< aio
   ```
3. If absent, append it. If present, leave its contents alone unless the schema version (embedded in the start marker as `# >>> aio (managed v<N>)`) is older than current — then rewrite the block in-place.
4. Stage and commit the change as a one-line commit on a temporary branch and emit a `GitIgnoreUpdated` event. **Never auto-commit to a non-feature branch** — if the working branch is `main`/`master`/`trunk`, the daemon emits a warning event and refuses to write the change automatically; instead it surfaces a notification asking the user to add the block manually (we don't silently dirty protected branches).
5. Validate **after every plan execution** that no untracked file in `.aio/.ps/`, `.wt/`, or `.aio/s/local/` would be picked up by a subsequent `git add .` — emit `GitIgnoreDriftDetected` if drift is found.

**What the orchestrator deliberately does not gitignore:**

- `.aio/p/` (must be committable for review).
- `.aio/config.yaml` and `.aio/README.md` (must be committable; team-shared).
- `.aio/s/` non-`local/` contents (compliance snapshots intended for review).
- Worktree contents themselves — each worktree gets its own `.git` link and is its own checkout, so gitignoring `.wt/` covers everything underneath.

**Per-developer overrides** live in `.aio.local.yaml` at the repo root (gitignored). The daemon reads `<repoRoot>/.aio.local.yaml` first, merges it over `.aio/config.yaml`, and surfaces the effective config in `plan.show`. (Single root-level file rather than nested under `.aio/` so a developer can `git stash` config experiments without the stash touching tracked `.aio/` paths.)

**Migration from the older `.copilot-orchestrator/` layout** (if any user is on a pre-v1 build): the daemon detects the old block on first attach, moves `.copilot-orchestrator/plans/` → `.aio/p/` (with `git mv` so history is preserved), drops the old runtime location entirely, and rewrites the gitignore block. A one-time `MigrationCompleted` event is emitted with a diff summary.

### 8.3 Worktree initialization — phases, isolation, cleanup

Every job executes inside its own git worktree at `<repoRoot>/.wt/<plan8>/<job8>/<attempt>/`. The worktree is **never reused across attempts unless explicitly preserved**, which keeps each attempt's blast radius bounded.

#### Path-length budget

Worktrees hold *compiled artifacts* (object files, npm `node_modules`, .NET `obj/`, Cargo `target/`, gradle caches) where deep nesting is unavoidable. On Windows the practical compile-time path budget is the smaller of:

- **`MAX_PATH` = 260 chars** — still hit by some legacy tools (older MSBuild tasks, some Job CLIs that don't use `\\?\` long-path prefix even when the OS allows it).
- **~248 chars** — several .NET SDK paths derived from `obj/Debug/<tfm>/<assembly>.AssemblyInfo.cs`.
- **~200 chars** — deeply-nested `node_modules/<scoped>/<dep>/<sub>/index.js` chains under a top-level package.

Our fixed overhead from repo root must stay tiny. The `.wt/<plan8>/<job8>/<attempt>/` shape costs **23 bytes** (e.g. `.wt\9f3c8a4b\6e1d77c0\1\`). That leaves a developer who clones to `C:\src\<repo>\` (~14 bytes) with **~163 bytes** of room for source-tree paths before hitting the 200-char `node_modules` ceiling.

#### Worktree creation pipeline

The `setup` phase (one of the eight phases per job — see §6.1) runs this sequence:

```mermaid
flowchart LR
    A[Job ready] --> B[Compute base commit]
    B --> C[git worktree add --detach -b aio/plan8/job8/attempt]
    C --> D[Symlink read-only shared dirs<br/>node_modules, vendor, .venv when allowed]
    D --> E[Copy per-worktree config<br/>GIT_CONFIG_GLOBAL=&lt;wt&gt;/.gitconfig]
    E --> F[Run worktreeInit commands<br/>npm ci / dotnet restore / pip install]
    F --> G[Inject orchestrator hooks<br/>per IAgentHookInstaller]
    G --> H[Worktree ready -> phase prechecks]
```

**Steps in detail:**

1. **Base commit selection.** Root jobs branch from the plan's `baseBranch` (default `main`). Dependent jobs branch from the merge commit produced by the deepest successful ancestor (this is what gives the DAG its FI semantics — see §3.3).

2. **`git worktree add`** at `<repoRoot>/.wt/<plan8>/<job8>/<attempt>/` with a deterministic per-attempt branch name: `aio/<plan8>/<job8>/<attempt>`. The branch is **detached-style** (no upstream) so accidental pushes don't pollute the remote. The branch is deleted at cleanup unless preserved (see retention). The `aio/` ref namespace prefix (instead of the older `plan/`) avoids collision with user-authored `plan/*` branches and is short enough to fit in `git log --oneline` output without truncation.

3. **Shared-dir symlinks (opt-in).** When `worktreeInit` is **not** set in the plan, large gitignored caches (`node_modules`, `vendor/`, `.venv`, `target/`) are symlinked from the main repo to keep worktree creation under a second. When `worktreeInit` **is** set, no symlinks are created — each worktree gets its own isolated install (npm/yarn/pnpm/cargo/maven all use a global download cache, so subsequent installs are 5–10 s cache hits, not full installs).

4. **Per-worktree git config.** Every spawned process inside a worktree gets `GIT_CONFIG_GLOBAL=<worktreeRoot>/.gitconfig` injected so per-plan credential routing (§3.3.1) and per-plan `user.email` overrides do not leak into the user's global config.

5. **`worktreeInit` execution.** Plan-level `worktreeInit` (array of shell or process specs) runs sequentially in the worktree. If any step fails, the whole `setup` phase fails — auto-heal applies (§auto-heal in `auto-heal.instructions.md`). Auto-detected language defaults if no array is provided:
   - Job: `npm ci`
   - .NET: `dotnet restore --no-cache`
   - Python: `python -m venv .venv && .venv/bin/pip install -r requirements.txt`
   - Rust: `cargo fetch`
   - Go: (none — modules cache is global)
   - Java/Gradle: `./gradlew dependencies --no-daemon`

6. **Hook injection.** `IAgentHookInstaller.EnsureInstalledAsync` (§3.2.3) writes vendor-specific hook configuration into the worktree's CLI config dir (`<worktreeRoot>/.copilot/`, `<worktreeRoot>/.claude/`, etc.) — never touches the user's global CLI config.

#### Cleanup & retention

| Outcome | Default action |
|---|---|
| Job `succeeded` and `cleanUpSuccessfulWork: true` | Worktree removed via `git worktree remove --force`; branch `aio/<plan8>/<job8>/<attempt>` deleted; commit kept (already merged into snapshot). |
| Job `failed` (terminal) | Worktree **preserved** at `.wt/<plan8>/<job8>/<attempt>/` for debugging; branch preserved as `aio/failed/<plan8>/<job8>/<attempt>`; surfaced in `get_node_failure_context`. |
| Job `canceled` | Worktree preserved if it had any uncommitted changes; otherwise removed. |
| Plan `archived` (manual cleanup) | All worktrees under `.wt/<plan8>/**` and branches under `aio/<plan8>/**` removed; plan definition under `.aio/p/<plan8>/` stays committed. |

`git worktree prune` runs at daemon attach to clean up any worktrees orphaned by a previous crash (their lock files have stale daemon PIDs).

### 8.4 Plan and job shapes — the canonical schema

A plan is a **versioned, immutable, DAG of jobs**. We give plan authors three input shapes that all normalize to the same canonical schema before storage. This keeps the inner orchestrator logic simple while letting humans and agents pick the most natural authoring style.

#### 8.4.1 The canonical (post-finalize) shape

After `finalize_copilot_plan`, the on-disk `plan.json` always looks like this — regardless of how it was authored:

```jsonc
{
  "schemaVersion": 1,
  "id": "9f3c8a…",
  "name": "Refactor authentication",
  "baseBranch": "main",
  "targetBranch": "feat/refactor-auth",
  "createdAt": "2026-04-20T18:42:00.000Z",
  "finalizedAt": "2026-04-20T18:43:11.502Z",
  "maxParallel": 0,
  "env": { "DOTNET_NOLOGO": "1" },
  "worktreeInit": [{ "type": "shell", "command": "npm ci", "shell": "bash" }],
  "verifyRi": { "type": "shell", "command": "npm test", "shell": "bash" },
  "jobs": [
    {
      "producerId": "extract-auth-iface",        // unique within plan; lowercase a-z 0-9 hyphens; 3-64 chars
      "name": "Extract IAuthService",            // display name; defaults to producerId
      "task": "Define new IAuthService and route callers",
      "group": "phase1/setup",                   // visual grouping only — does NOT affect execution order
      "dependencies": [],                        // producerIds this job depends on
      "consumesFrom": [],                        // resolved at finalize from `dependencies`
      "expectsNoChanges": false,
      "autoHeal": true,
      "work": { "type": "agent", "instructions": "# Task\n…", "model": "claude-sonnet-4.6", "effort": "high" },
      "prechecks": null,
      "postchecks": { "type": "shell", "command": "npm run build", "shell": "bash" },
      "onFailure": { "noAutoHeal": false }
    },
    /* … */
    {
      "producerId": "__snapshot-validation__",  // auto-injected; cannot be authored by users
      "name": "Snapshot Validation",
      "dependencies": ["…all leaves…"],
      "work": { "type": "shell", "command": "npm test", "shell": "bash" },
      "expectsNoChanges": true
    }
  ]
}
```

**Invariants enforced at finalize and re-validated on every load:**

| Invariant | Rule |
|---|---|
| **Acyclicity** | The `(producerId → dependencies)` graph must be a DAG. Cycle detection runs in `O(V+E)`. |
| **Reachability** | Every job must be reachable from at least one root, and every job must reach the `__snapshot-validation__` job. |
| **ProducerId uniqueness** | Within a plan; case-sensitive; reserved prefix `__` only for orchestrator-managed jobs. |
| **Branch ownership** | `targetBranch` must not exist or must be owned by this plan (committed marker in branch description); auto-generated if not specified. |
| **Group syntax** | If `group` is set, must be a `/`-separated path of slugs (`[a-z0-9-]+`). Groups are visual only — jobs in the same group still execute per dependencies. |
| **Work spec validity** | Each work spec validated against §8.4.4 schema. |
| **Hooks reserved** | `worktreeInit`, `verifyRi`, `prechecks`, `postchecks` may not transitively spawn the orchestrator daemon (no infinite recursion). |
| **Size bounds** | ≤ 500 jobs per plan; ≤ 100 KB instructions per agent job; ≤ 50 KB any single work spec string. |

#### 8.4.2 Authoring shape A — single-shot `plan.create`

For small plans (typically ≤ 5 jobs), authored in one MCP call or one CLI invocation:

```yaml
name: Build Pipeline
baseBranch: main
verifyRi: dotnet test
jobs:
  - producerId: build
    task: Build the solution
    work: dotnet build --no-restore
    dependencies: []
  - producerId: pack
    task: Package artifacts
    work: dotnet pack
    dependencies: [build]
```

The `create` path validates and finalizes atomically — there is no scaffolding state.

#### 8.4.3 Authoring shape B — incremental `scaffold` → `addJob` → `finalize`

For plans with many jobs (≥ 5) or where the author needs to compute job specs progressively, the three-step flow keeps each call small (token-budget friendly, especially for AI-driven authoring):

```text
scaffold_copilot_plan(name=…)            → returns planId, status="scaffolding"
add_copilot_plan_job(planId, jobSpec)     → repeat N times; each call validates locally
finalize_copilot_plan(planId)             → validates DAG, injects __snapshot-validation__, transitions to pending
```

While in `scaffolding` status, the plan is **not visible** to the scheduler and can be freely mutated. Once finalized, mutation requires `reshape_copilot_plan` (which has stricter rules — only pending/ready jobs can be removed or have their dependencies changed).

#### 8.4.4 Work spec shapes (the union type at the heart of every job)

Every `work` / `prechecks` / `postchecks` / `verifyRi` / `worktreeInit[*]` slot accepts the same discriminated union:

```jsonc
// Shorthand string forms (sugar)
"npm run build"                        // → { type: "shell", command: "npm run build", shell: <platform default> }
"@agent Implement the feature"         // → { type: "agent", instructions: "Implement the feature" }

// Object forms (canonical)
{ "type": "shell",   "command": "Get-ChildItem", "shell": "powershell" }
{ "type": "process", "executable": "job", "args": ["build.js"], "env": { … } }
{ "type": "agent",   "instructions": "# Task\n1. …", "model": "claude-sonnet-4.6", "effort": "high",
                     "maxTurns": 30, "allowedFolders": ["src/", "test/"], "modelTier": "premium" }
```

Validation rules per type:

| Type | Required fields | Forbidden | Notes |
|---|---|---|---|
| `shell` | `command`, `shell` | inline `2>&1` redirect on PowerShell (orchestrator captures stderr separately) | `shell` ∈ `cmd \| powershell \| pwsh \| bash \| sh` |
| `process` | `executable`, `args` (array) | shell metacharacters in `executable` | No shell quoting needed; argv passed directly |
| `agent` | `instructions` **xor** `instructionsFile` | both `instructions` and `instructionsFile` | Instructions must be Markdown; ≤ 100 KB inline / file |

Common optional fields on every type: `env`, `cwd` (defaults to worktree root), `onFailure: { noAutoHeal, message, resumeFromPhase }`.

#### 8.4.5 Validation surface

`IPlanValidator` runs the same rules in three places:

1. **Authoring time** — `scaffold` / `addJob` / `create` reject obvious errors immediately (bad producerId, work spec missing required field, declared dependency does not exist).
2. **Finalize time** — `finalize` runs the full DAG check (cycles, reachability, snapshot-validation injection, size bounds, branch availability).
3. **Load time** — every time the daemon loads `plan.json` from disk, validation runs to catch on-disk corruption / schema drift; failures emit `PlanStateCorrupted` and refuse to schedule.

Validation results are themselves rich records: `ValidationResult { Errors: IReadOnlyList<ValidationError>, Warnings: …, Extensions: … }` — never throw for "this plan is invalid"; return the list so authoring tools can present every issue at once.

---

## 9. VS Code Extension Packaging, Installation & Update Lifecycle

The extension is the most user-visible distribution channel. It must reliably bundle native binaries (`ai-orchestratord`, `ai-orchestrator-mcp`), the N-API node binding, and the TS UI; install them per-platform; and update them without leaving stale daemon processes or stale MCP `mcp.json` entries behind.

### 9.1 What's inside the VSIX

```
copilot-orchestrator-<version>.vsix
├── extension.js                         ← bundled TS extension (esbuild)
├── package.json                         ← VS Code manifest + activation events
├── README.md, CHANGELOG.md, LICENSE
├── resources/                           ← icons, walkthrough media
├── ui/                                  ← compiled webview bundles
└── native/
    ├── ai-orchestratord/
    │   ├── win-x64/ai-orchestratord.exe
    │   ├── win-arm64/ai-orchestratord.exe
    │   ├── linux-x64/ai-orchestratord
    │   ├── linux-arm64/ai-orchestratord
    │   ├── osx-x64/ai-orchestratord
    │   ├── osx-arm64/ai-orchestratord
    │   └── manifest.json                ← per-RID SHA-256, version, signed-by
    ├── ai-orchestrator-mcp/                ← same per-RID layout
    └── bindings-job/
        ├── win-x64/ai-orchestrator.node
        ├── linux-x64/ai-orchestrator.node
        ├── … (one .node per RID)
        └── manifest.json
```

**Binary size budget.** Each self-contained .NET 10 binary is ~25–35 MB after trimming. Including all six RIDs for two binaries (`ai-orchestratord` + `ai-orchestrator-mcp`) plus the N-API module (~5 MB per RID) puts the unsplit VSIX at ~360 MB — too large for the marketplace's 100 MB limit and wasteful for a single user.

**The split-VSIX strategy:** ship **one VSIX per platform target** plus a thin `copilot-orchestrator` umbrella package. The marketplace already supports this via the `targetPlatform` field (`win32-x64`, `win32-arm64`, `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`). VS Code automatically downloads only the matching VSIX. Per-platform VSIX size lands at ~70–80 MB.

### 9.2 Installation flow (first install)

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant VsCode as VS Code
    participant MP as Marketplace
    participant Vsix as copilot-orchestrator.vsix
    participant Ext as Extension activate()
    participant Bin as Bundled binaries

    User->>VsCode: Install "Copilot Orchestrator"
    VsCode->>MP: query targetPlatform=<host RID>
    MP-->>VsCode: VSIX matching RID
    VsCode->>Vsix: extract to extensions dir
    User->>VsCode: Reload window
    VsCode->>Ext: activate (onView, onCommand, etc.)
    Ext->>Bin: verify SHA-256 of ai-orchestratord, ai-orchestrator-mcp, .node binding
    Ext->>Bin: chmod +x on POSIX (extracted bits drop the +x flag)
    Ext->>Ext: load AiOrchestrator.Bindings.Node via require()
    Ext->>Ext: spawn ai-orchestratord (Mode A default)
    Ext->>Ext: write/update mcp.json entry namespaced per VS Code instance
    Ext-->>User: status bar: "Orchestrator ready"
```

**Critical first-install steps:**

1. **SHA-256 verification** of each binary against `manifest.json`. Mismatch ⇒ refuse to start, surface error notification with "Reinstall extension" action.
2. **POSIX `+x`** restoration — VSIX extraction loses the executable bit; the activation code must `chmod +x` the binaries before first spawn.
3. **AV / Gatekeeper / SmartScreen unquarantine.** macOS may quarantine downloaded binaries (`xattr -d com.apple.quarantine`); Windows Defender may block first execution. The extension surfaces a one-time guidance notification with a link to the "first run" doc.
4. **No state migration on install** — first install creates `.git/ai-orchestrator/` lazily on first plan creation in any repo.

### 9.3 Update flow

VS Code auto-updates extensions in the background. The orchestrator extension treats updates as **a daemon-restart event**, not a transparent file swap, because the running daemon is loaded from the previous version's bytes.

```mermaid
sequenceDiagram
    autonumber
    participant VsCode as VS Code
    participant OldExt as Extension v1
    participant OldDaemon as ai-orchestratord v1 (running)
    participant NewExt as Extension v2 (extracted, not yet active)
    participant NewDaemon as ai-orchestratord v2

    VsCode->>OldExt: deactivate() on update
    OldExt->>OldDaemon: send "drain" RPC (stop accepting new plans)
    OldDaemon-->>OldExt: drain ack
    OldExt->>OldDaemon: persist all in-flight plan state
    OldExt->>OldDaemon: shutdown (graceful, with timeout)
    VsCode->>VsCode: swap extension files
    VsCode->>NewExt: activate()
    NewExt->>NewExt: verify new binaries
    NewExt->>NewExt: detect leftover daemon lock file with stale PID → if version mismatch, delete
    NewExt->>NewDaemon: spawn v2
    NewDaemon->>NewDaemon: load plan state from disk (forward-compatible schema)
    NewDaemon-->>NewExt: ready
    NewExt-->>VsCode: status bar: "Updated to vN"
```

**Forward-compatibility rules for the daemon binary update:**

- **On-disk plan schema** carries `schemaVersion` (§8.1). The new daemon must read every `schemaVersion` it shipped with N-1 minor versions; older versions trigger a one-time migration emitted as `PlanStateMigrated` events.
- **Wire schema** carries `schemaVersion` (W1). The new daemon talks the new wire schema; a stale CLI / MCP client connecting will be rejected with `unsupported_schema_version` and told to upgrade.
- **MCP `mcp.json` entry** is rewritten only if the binary path changed (post-update it now points at `…/extensions/copilot-orchestrator-vN/native/ai-orchestrator-mcp/<RID>/ai-orchestrator-mcp`). Copilot Chat picks this up on its next MCP server reconnect.

**Rollback handling:** if v2 fails its post-spawn health check three times, the extension automatically falls back to launching the v1 binary if it's still present in `extensions/copilot-orchestrator-v1/`, and surfaces a notification with the rollback reason and a "Report issue" action.

### 9.4 Multiple windows, single binary install

VS Code shares the extension installation across all windows, but each window-group activates its own extension host. With the default Mode A (per-VS-Code-instance daemon, §4.6):

- Each window-group spawns its **own** `ai-orchestratord` from the **same** binary path.
- Each window-group writes its **own** namespaced entry into `mcp.json` (`ai-orchestrator-<instanceId>`) so Copilot Chat in that window can find that window's daemon.
- All window-groups verify the binary SHA on their own activation — they don't trust each other.

With Mode B (shared per-user), only the first-activated window spawns the daemon; subsequent windows attach as clients.

### 9.5 Uninstall flow

```mermaid
flowchart LR
    A[User uninstalls extension] --> B[VS Code calls deactivate]
    B --> C[Extension drains and stops ai-orchestratord]
    C --> D[Remove mcp.json entries owned by this instance]
    D --> E[VS Code removes extension files]
    E --> F[.git/ai-orchestrator/ stays<br/>.copilot-orchestrator/ stays]
    F --> G[ai-orchestrator daemon stop --all<br/>cleans up lock files]
```

**What we deliberately do not delete on uninstall:**

- `.copilot-orchestrator/plans/**` — committed plan definitions belong to the repo, not the extension.
- `.git/ai-orchestrator/` runtime state — preserved for reattach if the user reinstalls; users can `git clean -xfd .git/ai-orchestrator/` if they want it gone.
- Per-user credential leases — managed by GCM, not by us.

The extension surfaces a one-time "About to uninstall" prompt with checkboxes for "also delete runtime state in this repo" and "also remove `.copilot-orchestrator/` from this repo (will need to be re-committed if you reinstall)".

### 9.6 Native dependency updates without extension update

`ai-orchestratord` and `ai-orchestrator-mcp` ship with the extension VSIX. We deliberately do **not** support out-of-band native binary updates from a different channel — that would create version-skew between the bundled `AiOrchestrator.Bindings.Node` (which is `dlopen`'d into the extension's Job process) and the daemon. All three move together as one VSIX.

**Exception:** when the user installs `ai-orchestrator-mcp` independently via `dotnet tool install -g AiOrchestrator.Mcp.Stdio`, the `mcp.json` entry can be configured (`aiOrchestrator.mcp.bundled: false`) to use that globally-installed version. The extension warns if the global version differs from the bundled version by more than one minor version — wire-compatibility is not guaranteed beyond N-1.

### 9.7 Where this design plan goes next

This design document is the predecessor to the v1.0.0 migration. The intended workflow:

1. Commit this doc to a branch named `features/v1.0.0-init` so it can be reviewed in a PR.
2. Once approved, the doc becomes the **input** to a Copilot Orchestrator plan that drives the migration itself — one `plan` per phase from §10.1, with jobs for each major component (`AiOrchestrator.Models` + `AiOrchestrator.Abstractions` extraction, `AiOrchestrator.Core` port, `AiOrchestrator.Git` hybridization, etc.). The plan will exercise the very orchestrator infrastructure being migrated, dogfooding the new design.
3. Post-finalize, the plan's `plan.json` lives in `.copilot-orchestrator/plans/` per §8.1 — it becomes a permanent, reviewable artifact of how v1.0.0 was built.

---

## 10. Migration Strategy

### 10.1 Phasing

| Phase | Scope | Outcome | Acceptance gate |
|-------|-------|---------|-----------------|
| **0. Spike** | Stand up `AiOrchestrator.Models` + `AiOrchestrator.Abstractions` + an empty named-pipe daemon. Prove nonce-auth handshake from a TS client. | Round-trip a `health` JSON-RPC. | TS shim authenticates and pings. |
| **1. Core port — read-only** | Port `IPlanRepository`, `IPlanDefinition`, `IFileSystem` to .NET. Stand up read-only `plan.list`, `plan.show`, `plan.logs`, `plan.subscribe`. | Daemon can serve UI for **observation** while TS still drives execution. | UI renders plans solely via daemon when settings.useDaemon=true. |
| **2. Core port — execution** | Port `PlanRunner`, `Scheduler`, `StateMachine`, `ExecutionPump`, `JobExecutionEngine`, phases. | Plans execute in .NET; TS engine becomes optional. | Integration test plan runs identically in both paths. |
| **3. Git layer** | Port `AiOrchestrator.Git`. | Worktree FI/RI semantics validated against snapshot tests. | Existing TS git tests ported and green. |
| **4. Agent executors** | Port `CopilotAgentExecutor`. Add `ClaudeAgentExecutor`. Add `ScriptedAgentExecutor` for tests. | All existing copilot tests pass; new claude tests pass. | Mixed-executor plans run successfully. |
| **5. MCP relocation** | Build `AiOrchestrator.Mcp` stdio shim. Migrate Copilot Chat to spawn the .NET shim instead of the TS one. | Copilot Chat workflows unchanged. | No tool surface diff. |
| **6. CLI GA** | Ship `ai-orchestrator` and `gh copilot ai-orchestrator`. | CLI parity with MCP tool surface. | `ai-orchestrator plan create … --watch` works end-to-end. |
| **7. TS engine retirement** | Delete the TS plan engine, scheduler, executors, git layer. Keep TS for UI + transport. | Repo size shrinks ~60%. | All e2e tests still green; extension functionality identical. |

Each phase is independently shippable and rollback-safe (a setting toggles daemon vs. in-proc TS).

### 10.2 Compatibility shims

- **Plan storage on disk** must remain readable by both the TS and .NET implementations during phases 1–6. We freeze the on-disk schema (`StoredPlanMetadata` JSON files in `.copilot-orchestrator/plans/`) before phase 1, then add a `schemaVersion` field. Both engines read v1; only one writes per session.
- **Event payload schema** is captured in `AiOrchestrator.Models` and a TS type-generation step (using `quicktype` or hand-mirrored types) keeps the TS UI types in sync.

---

## 11. Testability Strategy

### 11.1 Per-layer test approach

| Layer | Test approach |
|-------|---------------|
| `AiOrchestrator.Core` | Pure unit tests with `ScriptedAgentExecutor`, `InMemoryGit`, `InMemoryStorage`. No spawning, no fs, no git. |
| `AiOrchestrator.Git` | Unit tests with `IProcessSpawner` mock; integration tests in temp repos. |
| `AiOrchestrator.Agents.Copilot` | Unit tests with scripted process output; integration tests behind opt-in flag. |
| `AiOrchestrator.Hosting.NamedPipe` | Unit tests for handshake logic with `IPipeFactory`; integration tests over real pipes/sockets. |
| `AiOrchestrator.Cli` | `System.CommandLine` test host + in-proc orchestrator; snapshot text and JSON output. |
| `AiOrchestrator.Mcp` | Replay JSON-RPC fixtures against the shim, assert daemon round-trips. |
| **Cross-language e2e** | Dedicated suite spawns daemon + TS client + scripted agents; validates UI events match expected shape. |

The current TS `run_copilot_integration_test` MCP tool is preserved by routing it to a `ScriptedPlanRunner` in `AiOrchestrator.TestHarness`.

### 11.2 Test-Driven Development — mandatory discipline

Every production code path in `AiOrchestrator.*` is written test-first. This is not a stylistic preference — it is a contributor obligation enforced by code review and by CI. The TS codebase tolerated a "tests later" pattern in early phases and paid for it repeatedly with regressions in `executionEngine`, `commitPhase`, and `worktreeManager`; the .NET port does not repeat that mistake.

**The required Red → Green → Refactor cycle:**

1. **Red.** Write a failing test that names a single behavior the code does not yet exhibit. Run it; confirm the failure mode is the *expected* one (not a compile error masquerading as a failure).
2. **Green.** Write the *smallest* amount of production code that makes the test pass. No speculative generalization, no defensive code for scenarios the tests don't cover, no anticipatory abstractions. If the production code feels too narrow, write another test first.
3. **Refactor.** With the test green, remove duplication, rename for clarity, extract collaborators. Tests stay green throughout — refactor steps that break tests are reverted, not "fixed up later."

**Process rules that fall out and are non-negotiable:**

- Commits that add production code without a corresponding test commit (or test changes in the same commit) are rejected at review.
- Test files are **never written after** the code they cover, except for explicitly-tagged characterization tests on legacy TS-port code (Phase 1 only; tagged `[Trait("legacy", "characterization")]`; allowed for at most one minor-version window per file).
- Each test asserts **one behavior**. A test method name reads as a sentence (`AcquireAsync_Throws_When_Worktree_Path_Escapes_Repo_Root`).
- Tests use the Arrange/Act/Assert layout literally — three blocks separated by blank lines; no setup hidden in base classes beyond DI container construction.
- Mocking framework: **NSubstitute** (banned: Moq, due to its v4.20 telemetry incident; banned: hand-rolled reflection mocks). Fakes preferred over mocks where the substitute has nontrivial state (`InMemoryGit`, `FakeWorktreeManager`, `ScriptedAgentRunner`).
- Test data builders (`PlanInstanceBuilder`, `JobSpecBuilder`, `WorktreeAcquireRequestBuilder`) are mandatory for any record with ≥3 required fields. Inline `new RecordType { … }` is allowed only when every field is genuinely test-relevant.

### 11.3 Broad-then-thin implementation gates

TDD applied naively at the lowest level produces locally-correct components that compose into a globally-broken system. The .NET port uses an explicit **broad-then-thin** progression for every feature:

| Gate | What you write | What CI verifies |
|---|---|---|
| **G-Broad — acceptance/e2e** | One end-to-end test that exercises the new feature through the public API surface (`IAiOrchestrator`, MCP tool, or CLI command). It uses `ScriptedAgentRunner`, `InMemoryGit`, and the real `IEventBus` so that DAG/scheduler/lifecycle wiring is fully exercised. **This test is written first** and stays red until the entire feature lands. | Test exists and is in `tests/AiOrchestrator.AcceptanceTests`. |
| **G-Thin — unit** | Unit tests for each component the feature touches, written interleaved with the production code via the Red/Green/Refactor cycle. Each unit test is component-scoped (one type, often one method). | Each new/changed source file has unit tests in `tests/<Project>.Tests`; unit-test count grows with source-line count (analyzer `OE0016` enforces a minimum 1:5 test-to-source-line ratio per file). |
| **G-Property** | For any algorithm with a definable invariant (DAG ordering, lease idempotency, sequence-number monotonicity, cancellation cascade, JSON round-trip, segment file truncation), a **FsCheck** property-based test asserts the invariant across thousands of generated inputs. | Property tests in `tests/<Project>.PropertyTests`; new files in `Core`/`Git`/`Plan` repository code without corresponding property tests trigger a soft warning at PR review. |
| **G-Integration** | Tests that exercise real OS resources (pipes, sockets, processes, libgit2sharp against temp repos). Limited in count by design — most behavior is covered at G-Broad with fakes. | `tests/AiOrchestrator.IntegrationTests`; required to run on every PR but capped at 5 minutes wall-clock to keep CI feedback fast. |
| **G-Soak** | Long-running benchmarks and memory soak tests (BenchmarkDotNet harness, GC soak from §3.6.8). | Runs nightly + on release branches; PR runs only the smoke subset. |

The principle: **acceptance test first** ensures the team agrees on what "done" looks like before any production code is written. **Unit tests second** drive the implementation TDD-style. **Property tests third** lock in invariants that catch the long tail of mutation bugs unit tests miss.

### 11.4 Code coverage — 90% line + 85% branch, enforced

Coverage is measured by **Coverlet** (line + branch + method) and reported via **ReportGenerator**. Every PR computes coverage on the full `AiOrchestrator.*` solution and posts a Cobertura artifact + a markdown summary.

| Project category | Line coverage gate | Branch coverage gate |
|---|---|---|
| `AiOrchestrator.Core`, `AiOrchestrator.Git`, `AiOrchestrator.Agents.*`, `AiOrchestrator.Plan` | **90%** | **85%** |
| `AiOrchestrator.Models` (records-only DTO assembly) | **N/A** (excluded — no executable logic; analyzer `OE0017` enforces purity) | N/A |
| `AiOrchestrator.Abstractions` (interfaces + abstract bases) | **90%** (covers shared logic in abstract base classes; pure interface methods are excluded by being unimplementable) | **85%** |
| `AiOrchestrator.Hosting.*`, `AiOrchestrator.Mcp`, `AiOrchestrator.Cli` | **90%** | **80%** |
| `AiOrchestrator.Bindings.Node` (interop boundary, Phase 0/4) | **75%** | **70%** (much of the surface is JS-side, covered by Job tests) |
| Composition roots (`*/CompositionRoot.cs`, `*/Program.cs`) | **excluded by attribute** (`[ExcludeFromCodeCoverage("composition root: behavior covered by integration tests")]`) | excluded |
| Generated code (source generators, `*.g.cs`) | excluded | excluded |

**Per-file ratchet rule:** a PR cannot *decrease* coverage for any file it touches. If `FooService.cs` was 94% before, the PR's version of `FooService.cs` must be ≥94%. New files must enter at the gate floor for their category. The ratchet is enforced by a custom diff job that compares the PR's `coverage.cobertura.xml` against the base branch's last green run.

**No exclusion abuse.** The `[ExcludeFromCodeCoverage]` attribute is allowlisted to:
- Composition roots (one per host),
- DI extension methods that are pure registration (`services.AddSingleton<…>()` chains),
- `record` definitions that are pure data (no logic in `Equals`, `ToString`, etc., beyond compiler-generated members),
- Code marked `[Obsolete]` and slated for removal in the next minor (with a tracking issue link in the attribute message).

Any other use of `[ExcludeFromCodeCoverage]` requires a code-review approval from a maintainer and a comment explaining why the code is genuinely untestable. Reviewer rule: "untestable code is the wrong shape — make it testable instead."

**Mutation testing (Phase 2+):** Stryker.NET runs nightly against `Core` and `Plan` projects with a **75% mutation-score gate**. Mutation testing is not a per-PR gate (too slow), but a regression below 75% blocks the next release branch's tag.

### 11.5 PR pipeline — required quality gates

All gates below are **required status checks** on the GitHub branch protection rule for `main` and `release/*`. None can be bypassed by maintainers; the `--admin` merge flag is disabled at the org level for this repo.

```mermaid
flowchart LR
    PR[PR opened/updated] --> Build[dotnet build]
    Build --> Lint[dotnet format --verify-no-changes]
    Lint --> Analyze[Roslyn analyzers OE0001-OE0016]
    Analyze --> Unit[Unit tests + Coverlet]
    Unit --> Cov[Coverage gate 90% line / 85% branch + ratchet]
    Cov --> Property[Property tests FsCheck]
    Property --> Accept[Acceptance/e2e tests]
    Accept --> Integ[Integration tests 5min cap]
    Integ --> SecScan[CodeQL + dependency-review]
    SecScan --> Bench[Benchmark smoke startup-time + perf-regression check]
    Bench --> Trim[Trim/AOT compatibility check TrimmerWarningsAsErrors]
    Trim --> Pkg[Package: NuGet pack + single-file publish per RID]
    Pkg --> Done[All checks green - mergeable]

    classDef gate fill:#fef3c7,stroke:#d97706,stroke-width:2px
    class Cov,Property,Accept,SecScan,Bench gate
```

| # | Check | Tool | Failure condition |
|---|---|---|---|
| 1 | **Build** | `dotnet build -c Release` | Any compile error or warning (`TreatWarningsAsErrors=true`) |
| 2 | **Format** | `dotnet format --verify-no-changes` | Any formatting drift from `.editorconfig` |
| 3 | **Analyzers** | Roslyn analyzers `OE0001`–`OE0016` (this document) + standard CA rules | Any analyzer diagnostic at `Error` severity |
| 4 | **Unit tests** | `dotnet test` with Coverlet collector | Any test failure |
| 5 | **Coverage gate** | Custom diff job vs base branch | Any project below per-category floor; any touched file below its prior coverage |
| 6 | **Property tests** | FsCheck | Any falsified property |
| 7 | **Acceptance tests** | xUnit + scripted runners | Any acceptance test failure |
| 8 | **Integration tests** | xUnit, real pipes/git/processes | Any failure; > 5 min wall-clock cap exceeded |
| 9 | **Security scan** | CodeQL + `actions/dependency-review-action` | Any new alert at High or above; any dependency with a known CVE |
| 10 | **Benchmark smoke** | BenchmarkDotNet harness | Startup-time budget regression > 10% (§4.8); per-op allocation regression > 20% on byte-path benches (§3.6.8) |
| 11 | **Trim / AOT compatibility** | `<TrimmerWarningsAsErrors>true</TrimmerWarningsAsErrors>` | Any trim warning |
| 12 | **Package** | `dotnet pack` + `dotnet publish -r <RID>` for all 6 RIDs | Any pack/publish failure; any RID-specific binary > size budget (§2.2) |
| 13 | **Cross-platform unit tests** | Matrix: ubuntu-latest × windows-latest × macos-latest | Any platform-specific test failure |

**Pipeline ordering** is sequential for cheap checks (build/lint/analyzers) so failures abort early, parallel for the heavy checks (unit/property/acceptance/integration run on separate agents). Total wall-clock budget for a PR run: **15 minutes** for the cheap path, **30 minutes** including integration and packaging matrix.

### 11.6 Test infrastructure choices

| Concern | Choice | Rationale |
|---|---|---|
| Test framework | **xUnit v3** | Modern .NET 10 support, async-first, parallel by default, no `[Fact]`/`[Theory]` attribute proliferation in v3. |
| Assertion library | **Shouldly** | Diagnostic messages name the variable (`result.ShouldBe(expected)` produces "result should be 5 but was 4"). |
| Mocking | **NSubstitute** | Lambda-free syntax reads naturally; clean DI substitution. |
| Property testing | **FsCheck.Xunit** | Mature, generators compose, shrinks counterexamples automatically. |
| Mutation testing | **Stryker.NET** | Active maintenance, supports .NET 10, integrates with Coverlet. |
| Coverage | **Coverlet.Collector** + **ReportGenerator** | Runs in-process with `dotnet test`; Cobertura output; clean GitHub Actions integration. |
| Benchmarks | **BenchmarkDotNet** | Standard for .NET perf; statistical rigor; CI integration via `--exporters json` + custom diff job. |
| Snapshot testing (CLI text output, JSON) | **Verify.Xunit** | Inline approval; clean diff output; deterministic across platforms. |
| Test isolation | **xUnit collections + per-collection temp dirs** | No shared global state; every test that needs filesystem gets its own `TempPath` cleaned up by `IAsyncLifetime.DisposeAsync`. |

### 11.7 Anti-patterns explicitly forbidden

These are mechanically blocked at review (and most are caught by analyzers):

- ❌ Tests that hit the network (other than `localhost` in integration tests).
- ❌ Tests that hit `~/.config/`, `%LOCALAPPDATA%`, or any user-global path.
- ❌ Tests that depend on `Thread.Sleep` for synchronization (use `TaskCompletionSource`, `IClock` fake, or `BlockingCollection`).
- ❌ Tests that share mutable state with other tests in the same collection.
- ❌ `[Fact(Skip = "…")]` without a tracking issue link in the skip reason.
- ❌ `Assert.True(condition)` without a message — use Shouldly so the failure names the variable.
- ❌ Test methods longer than 30 lines (split or refactor — the test is doing too much).
- ❌ Helpers in test projects that wrap `Assert.*` — tests stay flat and obvious.

---

## 12. Open Questions / Risks

1. **.NET runtime distribution in VS Code extension** — Do we ship a self-contained `ai-orchestratord` binary per OS in the extension VSIX, or require `dotnet` SDK / runtime? Recommendation: self-contained single-file binaries (~30 MB each, three platforms), gated behind extension setup.
2. **Cross-platform named pipe semantics** — `System.IO.Pipes.NamedPipeServerStream` on POSIX uses Unix sockets but with quirks; we may need `Mono.Unix` or our own `Socket(UnixEndPoint)` shim for fine-grained ACL control.
3. **MCP stdio child startup latency** — Adding a .NET process between Copilot Chat and the daemon may add 100–300 ms cold start. Mitigation: keep stdio shim trivial (~500 LOC) and AOT-compile.
4. **Existing TS test suite re-use** — A meaningful fraction of plan-engine tests are TS Mocha. We will port the most valuable ones to xUnit; others run as black-box e2e against the daemon.
5. **Agent executor capability negotiation** — Different agents support different effort levels, models, max-turns semantics. Capabilities must be queryable so the daemon can validate `JobSpec` before scheduling.
6. **GitHub Copilot agent (the autonomous one) consumption** — If/when the GitHub Copilot agent gains MCP-over-network support, the daemon's named-pipe transport may need an HTTP/2 + mTLS sibling. Designed for, not built in phase 1.
7. **Telemetry / observability** — Today telemetry is via VS Code's API. The daemon needs an `ITelemetry` interface so CLI / Copilot CLI hosts can plug in their own sinks (or no-op).

---

## 13. Appendix — Component Responsibility Matrix

| Concern | Today (TS, in extension host) | After (project) |
|---------|------------------------------|-----------------|
| DAG topology, scheduling | `src/plan/scheduler.ts`, `executionPump.ts`, `dagUtils.ts` | `AiOrchestrator.Core` |
| State machine | `src/plan/stateMachine.ts` | `AiOrchestrator.Core` |
| Plan persistence | `src/plan/store/FileSystemPlanStore.ts`, `repository/` | `AiOrchestrator.Storage` |
| Git worktree lifecycle | `src/git/**` (CLI only) | `AiOrchestrator.Git` (libgit2sharp first, CLI fallback for worktree ops) |
| Phase pipeline (FI/setup/prechecks/work/commit/postchecks/RI) | `src/plan/phases/**`, `executionEngine.ts` | `AiOrchestrator.Core` (phases) + `AiOrchestrator.Git` (merges) |
| Agent execution | `src/agent/copilotCliRunner.ts`, `handlers/**`, `cliCheck*.ts`, `hookInstaller.ts` | `AiOrchestrator.Agents` (`IAgentRunner` + `AgentRunnerBase`) + `AiOrchestrator.Agents.Copilot` / `.Claude` |
| Managed process / deadlock / log tail / process tree | `src/process/**` | `AiOrchestrator.Core` (managed-process subsystem, projected on event bus) |
| MCP protocol & tools | `src/mcp/tools/**`, `mcpRegistration.ts`, `handler.ts` | `AiOrchestrator.Mcp` (library, no transport) |
| MCP stdio server | `src/mcp/stdio/**` | `AiOrchestrator.Mcp.Stdio` (`ai-orchestrator-mcp` standalone binary) |
| MCP IPC / nonce auth pattern | `src/mcp/ipc/server.ts` | `AiOrchestrator.Hosting.NamedPipe` (generalized, now used by daemon) |
| Eventing | `src/plan/planEvents.ts` (per-plan EventEmitter) | `AiOrchestrator.Events` (`IEventBus`, single bus, multi-dispatcher) |
| Webviews / VS Code UI | `src/ui/**` | **Unchanged** (still TS) |
| Extension activation, commands | `src/extension.ts`, `commands/**` | Calls go through `transport/transportSelector.ts` (Node binding or pipe) |
| CLI experience | (none) | `AiOrchestrator.Cli` (dotnet tool + self-contained binaries) |
| Copilot CLI plugin | (none) | `AiOrchestrator.Cli.Copilot` |
| Daemon process | (none — runs inside extension host) | `AiOrchestrator.Hosting.NamedPipe` (`ai-orchestratord`) |
| Native Node binding | (none) | `AiOrchestrator.Bindings.Node` (`@ai-orchestrator/native`) |

---

## 14. Approval Checklist

Before implementation begins, confirm:

- [ ] .NET 10 LTS target + self-contained / trimmed publish settings accepted.
- [ ] `dotnet tool` distribution + per-RID self-contained binary matrix approved.
- [ ] Pipe transport + nonce-auth model approved by security review.
- [ ] On-disk plan schema frozen and versioned.
- [ ] `ai-orchestrator-mcp` accepted as a standalone shipping artifact, decoupled from the VS Code extension and from the daemon library.
- [ ] `IAgentRunner` contract (with deadlock detection, log discovery, capability gating, hooks, sessions, token stats) approved.
- [ ] libgit2sharp-first git strategy approved with the CLI-fallback allowlist (worktree ops + credential-helper push).
- [ ] Rich `IEventBus` taxonomy approved as the single source of truth for all UX projections.
- [ ] Multi-UX coexistence model (Node binding + MCP + pipe + CLI watch concurrently) accepted.
- [ ] Native Node binding (`@ai-orchestrator/native`) distribution model decided.
- [ ] Compatibility window for TS engine ↔ .NET engine cohabitation (phases 1–6) accepted.
- [ ] Telemetry/observability strategy defined for non-VS Code hosts.
- [ ] Naming finalized (`ai-orchestratord`, `ai-orchestrator` CLI, `ai-orchestrator-mcp`, `gh copilot ai-orchestrator`).
- [ ] Phase 0 spike scoped and assigned.
