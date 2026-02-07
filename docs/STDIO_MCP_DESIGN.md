# stdio MCP Transport Design

## Status

**Proposal** — February 2026

## Problem Statement

The Copilot Orchestrator currently uses an HTTP server (default port 39219) to
expose MCP endpoints.  This causes two classes of problems:

1. **Port conflicts** — When multiple VS Code windows open in the same
   workspace (or different workspaces), each instance attempts to bind the same
   port.  The fallback to a dynamic port (`0`) changes the endpoint URL,
   breaking Copilot Chat's MCP registration until the user manually re-enables
   the server.

2. **Unnecessary complexity** — An HTTP server requires health-check polling
   (10 s intervals), CORS headers, body parsing, request timing, and
   in-flight-request tracking — none of which are needed when the MCP client
   lives in the same process.

Switching to **stdio transport** eliminates both issues.  VS Code manages the
server lifecycle, there is no port to conflict, and no network stack to
traverse.

## Background: How VS Code's MCP Definition Provider Works

VS Code 1.99+ provides an API for extensions to programmatically register MCP
servers:

```
contributes.mcpServerDefinitionProviders → package.json
vscode.lm.registerMcpServerDefinitionProvider → runtime API
```

### Registration flow

1. The extension declares a provider in `package.json`:

   ```jsonc
   {
     "contributes": {
       "mcpServerDefinitionProviders": [{
         "id": "copilot-orchestrator.mcp-server",
         "label": "Copilot Orchestrator",
         "enabledByDefault": true
       }]
     }
   }
   ```

2. At activation the extension calls:

   ```ts
   vscode.lm.registerMcpServerDefinitionProvider(
     'copilot-orchestrator.mcp-server',
     provider
   );
   ```

3. The provider implements `McpServerDefinitionProvider<T>`:

   | Member                            | Purpose                                   |
   |-----------------------------------|-------------------------------------------|
   | `onDidChangeMcpServerDefinitions` | Event VS Code listens to for re-query     |
   | `provideMcpServerDefinitions`     | Returns `McpServerDefinition[]`           |
   | `resolveMcpServerDefinition`      | Optional hook before server start (e.g. auth) |

4. The returned definition can be one of:

   | Class                         | Transport | When to use                              |
   |-------------------------------|-----------|------------------------------------------|
   | `McpStdioServerDefinition`    | stdio     | Local process; VS Code spawns & manages  |
   | `McpHttpServerDefinition`     | HTTP      | Remote or self-hosted HTTP endpoint      |

### `McpStdioServerDefinition` API

```ts
new vscode.McpStdioServerDefinition({
  label:   string,          // Human-readable name
  command: string,          // Executable (e.g. "node")
  args?:   string[],        // Arguments
  env?:    Record<string, string | number | null>,
  cwd?:    vscode.Uri,      // Working directory
  version?: string,         // Used for change detection
});
```

VS Code spawns this command as a child process and connects its
**stdin/stdout** as a JSON-RPC 2.0 transport.

### Current implementation (HTTP)

```
┌────────────────────────────────────────────────────┐
│  VS Code Extension Host                            │
│                                                    │
│  ┌──────────────┐    ┌───────────────────────────┐ │
│  │ McpDefinition│    │ HTTP Server (:39219)       │ │
│  │ Provider     │    │  POST /mcp → McpHandler    │ │
│  │ (registers   │    │  GET /health               │ │
│  │  HTTP URL)   │    └───────────────────────────┘ │
│  └──────────────┘                                  │
│                                                    │
│  ┌──────────────────┐                              │
│  │ McpServerManager │ ← health checks every 10s   │
│  │ (status bar)     │                              │
│  └──────────────────┘                              │
└────────────────────────────────────────────────────┘
        ↕ HTTP (localhost:39219)
┌────────────────────────────────────────────────────┐
│  Copilot Chat (MCP client)                         │
└────────────────────────────────────────────────────┘
```

## Design: Same-Process stdio Transport

### High-level idea

Instead of spawning a real child process, the extension registers a
`McpStdioServerDefinition` whose command re-launches the **same extension
entrypoint** as a thin Node.js script.  This "server process" communicates
with VS Code over stdin/stdout using newline-delimited JSON-RPC 2.0.

Inside the server process, a lightweight **stdio adapter** reads from
`process.stdin`, dispatches to the existing `McpHandler`, and writes
responses to `process.stdout`.

```
┌──────────────────────────────────────────────────────────┐
│  VS Code Extension Host                                  │
│                                                          │
│  ┌──────────────────┐                                    │
│  │ McpDefinition    │── McpStdioServerDefinition ──┐     │
│  │ Provider         │   command: "node"             │     │
│  └──────────────────┘   args: ["mcp-stdio.js"]     │     │
│                                                     │     │
│  ┌──────────────────┐                               │     │
│  │ McpServerManager │ ← no health checks needed     │     │
│  │ (status bar)     │   (VS Code manages lifecycle)  │     │
│  └──────────────────┘                               │     │
└─────────────────────────────────────────────────────│─────┘
                                                      │
          stdin/stdout (JSON-RPC 2.0)                 │
                                                      ▼
┌──────────────────────────────────────────────────────────┐
│  Node.js child process (spawned by VS Code)              │
│                                                          │
│  ┌────────────────┐    ┌──────────────────────────────┐  │
│  │ StdioTransport │───▶│ McpHandler                   │  │
│  │ (stdin→parse,  │    │ (initialize, tools/list,     │  │
│  │  write→stdout) │◀───│  tools/call → planHandlers)  │  │
│  └────────────────┘    └──────────────────────────────┘  │
│                                                          │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ IPC bridge (optional) → PlanRunner in host process   │ │
│  └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### Architecture option: In-process via IPC bridge

Because the extension already owns the `PlanRunner` instance in the host
process, the child process needs a way to call it.  Two strategies:

#### Option A: Thin child process + VS Code extension IPC (Recommended)

The child process is a minimal stdio adapter that forwards JSON-RPC messages
to the parent extension host via Node.js IPC (`process.send` / `process.on('message')`).

```
Child (stdio-server.js)                Extension Host
─────────────────────                  ──────────────
stdin → parse JSON-RPC  ──IPC──▶  McpHandler.handleRequest()
stdout ← write JSON-RPC ◀──IPC──  response
```

**Pros:**
- `McpHandler`, `PlanRunner`, and all handlers run in the host — no
  duplication, no state-sync issues.
- Child process is ~50 lines of boilerplate.
- Full access to VS Code API, workspace state, git operations.

**Cons:**
- Requires IPC channel between child and host (VS Code does not
  provide this automatically for `McpStdioServerDefinition` spawns).
- Adds latency for the IPC round-trip (~1–2 ms, negligible for MCP).

#### Option B: Self-contained child process (Simpler, Recommended for v1)

The child process bootstraps its own `McpHandler` + `PlanRunner` from the
same compiled source.  It reads configuration (workspace path, storage path)
from environment variables injected via the `McpStdioServerDefinition.env`.

```
Child (mcp-stdio-server.js)
─────────────────────────────
stdin → parse JSON-RPC
       ↓
  McpHandler.handleRequest()   (own PlanRunner instance)
       ↓
stdout ← write JSON-RPC
```

**Pros:**
- Fully self-contained; no IPC.
- Crash-isolated from the extension host.

**Cons:**
- Two `PlanRunner` instances if the host also needs one (for UI, commands).
- Must share persisted storage safely (file locks or single-writer).
- Cannot call VS Code API from the child.

#### Recommended approach

**Option B for the initial implementation**, with the child process owning its
own `PlanRunner`.  The extension host's `PlanRunner` (used by the TreeView and
commands) reads from the same persisted storage.  Write contention is avoided
because only the MCP server (child) creates/modifies plans, and the host's UI
polls for updates.

A future iteration can switch to Option A if tighter integration is needed.

---

## Interface Design

All new code follows the **single-responsibility principle** with
interfaces for dependency injection and testability.

### `IStdioTransport`

Abstracts reading/writing JSON-RPC messages over a byte stream pair.

```ts
/**
 * Reads and writes newline-delimited JSON-RPC 2.0 messages
 * over a pair of byte streams (typically process.stdin/stdout).
 */
export interface IStdioTransport {
  /**
   * Start listening for incoming messages.
   * Resolves when the transport is closed (input stream ends).
   */
  start(): Promise<void>;

  /** Send a JSON-RPC response back to the client. */
  send(message: JsonRpcResponse): void;

  /** Register a handler for incoming requests. */
  onRequest(handler: (request: JsonRpcRequest) => Promise<JsonRpcResponse>): void;

  /** Gracefully shut down the transport. */
  close(): void;
}
```

### `IStdioTransportFactory`

Allows tests to inject mock streams.

```ts
export interface IStdioTransportFactory {
  create(
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
  ): IStdioTransport;
}
```

### `IMcpRequestRouter`

Decouples routing from transport.  The existing `McpHandler` already fills
this role; this interface formalizes it for testing.

```ts
/**
 * Routes a JSON-RPC request to the appropriate handler
 * and returns a JSON-RPC response.
 */
export interface IMcpRequestRouter {
  handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse>;
}
```

`McpHandler` implements `IMcpRequestRouter` without modification — its
`handleRequest` method already has this exact signature.

### `IMcpServerLifecycle`

Replaces the health-check-centric `IMcpManager` with a transport-agnostic
lifecycle interface.

```ts
export type McpTransportKind = 'stdio' | 'http';

export interface IMcpServerLifecycle {
  /** Current transport in use. */
  readonly transport: McpTransportKind;

  /** Start the MCP server (stdio listener or HTTP server). */
  start(): void;

  /** Stop the MCP server. */
  stop(): void;

  /** Whether the server is ready to accept requests. */
  isRunning(): boolean;

  /** Subscribe to status changes. */
  onStatusChange(
    callback: (status: 'connected' | 'available' | 'stopped' | 'error') => void,
  ): () => void;
}
```

### Updated `IMcpManager`

Extend the existing interface to remain backward-compatible:

```ts
export interface IMcpManager extends IMcpServerLifecycle {
  /** Get a display-friendly endpoint identifier (URL or "stdio"). */
  getEndpoint(): string;
}
```

---

## Implementation Plan

### New files

| File                          | Purpose                                    |
|-------------------------------|--------------------------------------------|
| `src/mcp/stdio/transport.ts`          | `StdioTransport` implements `IStdioTransport` |
| `src/mcp/stdio/index.ts`              | Barrel export                              |
| `src/mcp/stdio/server.ts`             | Entry-point for the stdio child process    |
| `resources/mcp-stdio-server.js`       | Compiled JS entry-point bundled with the extension |

### Modified files

| File                              | Change                                     |
|-----------------------------------|--------------------------------------------|
| `src/mcp/mcpDefinitionProvider.ts`| Return `McpStdioServerDefinition` instead of `McpHttpServerDefinition` |
| `src/mcp/mcpServerManager.ts`    | Remove health-check polling; infer status from VS Code lifecycle |
| `src/mcp/handler.ts`             | Extract `IMcpRequestRouter` interface      |
| `src/interfaces/index.ts`        | Export new interfaces                      |
| `src/interfaces/IMcpManager.ts`  | Add `IMcpServerLifecycle`, update `IMcpManager` |
| `src/extension.ts`               | Remove HTTP server init when stdio enabled |
| `src/core/planInitialization.ts`  | Add `initializeStdioMcpServer` function    |
| `package.json`                    | Keep `mcpServerDefinitionProviders` (already correct) |

### Detailed component changes

#### 1. `StdioTransport` (`src/mcp/stdio/transport.ts`)

```ts
import { Readable, Writable } from 'stream';
import { JsonRpcRequest, JsonRpcResponse } from '../types';

export class StdioTransport implements IStdioTransport {
  private handler?: (req: JsonRpcRequest) => Promise<JsonRpcResponse>;
  private buffer = '';

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {}

  onRequest(handler: (req: JsonRpcRequest) => Promise<JsonRpcResponse>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.input.setEncoding('utf-8');
      this.input.on('data', (chunk: string) => this.onData(chunk));
      this.input.on('end', () => resolve());
    });
  }

  send(message: JsonRpcResponse): void {
    const json = JSON.stringify(message);
    this.output.write(json + '\n');
  }

  close(): void {
    this.input.destroy();
  }

  // --- private ---

  private async onData(chunk: string): Promise<void> {
    this.buffer += chunk;
    // Split on newlines; each line is one JSON-RPC message
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const request: JsonRpcRequest = JSON.parse(trimmed);
        const response = await this.handler?.(request);
        if (response) this.send(response);
      } catch (err: any) {
        this.send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
      }
    }
  }
}
```

#### 2. stdio server entry-point (`src/mcp/stdio/server.ts`)

```ts
/**
 * Entry-point for the stdio MCP child process.
 *
 * VS Code spawns this as:
 *   node mcp-stdio-server.js
 *
 * Environment variables (injected via McpStdioServerDefinition.env):
 *   ORCHESTRATOR_WORKSPACE  — absolute workspace path
 *   ORCHESTRATOR_STORAGE    — absolute path to .orchestrator/plans
 */
import { StdioTransport } from './transport';
import { McpHandler } from '../handler';
import { PlanRunner, PlanRunnerConfig, DefaultJobExecutor } from '../../plan';

async function main(): Promise<void> {
  const workspacePath = process.env.ORCHESTRATOR_WORKSPACE || process.cwd();
  const storagePath = process.env.ORCHESTRATOR_STORAGE
    || require('path').join(workspacePath, '.orchestrator', 'plans');

  // Bootstrap PlanRunner
  const config: PlanRunnerConfig = {
    storagePath,
    defaultRepoPath: workspacePath,
    maxParallel: 4,
    pumpInterval: 1000,
  };
  const runner = new PlanRunner(config);
  const executor = new DefaultJobExecutor();
  runner.setExecutor(executor);
  await runner.initialize();

  // Create handler + transport
  const handler = new McpHandler(runner, workspacePath);
  const transport = new StdioTransport(process.stdin, process.stdout);

  transport.onRequest((req) => handler.handleRequest(req));

  // Redirect any accidental console.log to stderr so it doesn't
  // corrupt the JSON-RPC stream on stdout.
  const origLog = console.log;
  console.log = (...args: any[]) => console.error('[mcp-stdio]', ...args);

  // Block until stdin closes (VS Code killed us)
  await transport.start();

  // Persist before exit
  runner.persistSync();
}

main().catch((err) => {
  console.error('Fatal error in MCP stdio server:', err);
  process.exit(1);
});
```

#### 3. Updated `McpDefinitionProvider`

```ts
// Before (HTTP):
const server = new vscode.McpHttpServerDefinition(
  'Copilot Orchestrator',
  mcpUrl,
  context.extension.packageJSON.version,
);

// After (stdio):
const extensionPath = context.extensionPath;
const serverScript = path.join(extensionPath, 'resources', 'mcp-stdio-server.js');

const server = new vscode.McpStdioServerDefinition({
  label: 'Copilot Orchestrator',
  command: 'node',
  args: [serverScript],
  cwd: vscode.Uri.file(workspacePath),
  env: {
    ORCHESTRATOR_WORKSPACE: workspacePath,
    ORCHESTRATOR_STORAGE: storagePath,
  },
  version: context.extension.packageJSON.version,
});
```

#### 4. Simplified `McpServerManager`

With stdio, VS Code owns the process lifecycle.  The manager becomes a thin
status tracker:

```ts
export class StdioMcpServerManager implements IMcpManager {
  readonly transport: McpTransportKind = 'stdio';
  private status: McpStatus = 'stopped';

  start(): void  { this.setStatus('connected'); }
  stop(): void   { this.setStatus('stopped');   }

  isRunning(): boolean { return this.status === 'connected'; }
  getEndpoint(): string { return 'stdio'; }

  // No health checks — VS Code manages the process.
  // Status bar still shown for user awareness.
}
```

---

## Migration Strategy

The migration proceeds in three phases, keeping HTTP operational throughout.

### Phase 1 — Add stdio transport (non-breaking)

1. Implement `StdioTransport`, `IStdioTransport`, `IMcpRequestRouter`.
2. Create the stdio child-process entry-point.
3. Add a **configuration setting** to choose transport:

   ```jsonc
   // settings.json
   "copilotOrchestrator.mcp.transport": "stdio"   // or "http"
   ```

   Default: `"http"` (no change for existing users).

4. Update `McpDefinitionProvider` to return the appropriate definition type
   based on the setting.
5. Ship with both transports available; internal users test stdio.

### Phase 2 — Default to stdio

1. Change the default to `"stdio"`.
2. Show a one-time notification:
   > *"Copilot Orchestrator now uses stdio for MCP communication.
   >  No port configuration is needed."*
3. HTTP remains available via setting.
4. Deprecation warning in logs when HTTP is active.

### Phase 3 — Remove HTTP transport

1. Remove the HTTP server code (`src/http/`), the `McpServerManager`
   health-check logic, and HTTP-specific configuration settings.
2. Remove `copilotOrchestrator.http.*` settings (or keep `enabled: false`).
3. Final cleanup of `McpRegistration` prompts (no URL to copy).

### Timeline guidance

| Phase   | Milestone                       | Breaking? |
|---------|---------------------------------|-----------|
| Phase 1 | stdio available, HTTP default   | No        |
| Phase 2 | stdio default, HTTP opt-in      | No        |
| Phase 3 | HTTP removed                    | Yes (major) |

---

## Backward Compatibility Considerations

### 1. Users with manual `mcp.json` configuration

Users who added the HTTP endpoint to `.vscode/mcp.json`:

```json
{
  "mcpServers": {
    "copilot-orchestrator": {
      "type": "http",
      "url": "http://localhost:39219/mcp"
    }
  }
}
```

**Mitigation:**
- Phase 1–2: HTTP still works alongside stdio, so existing `mcp.json`
  entries continue to function.
- Phase 3: Show a migration notification with instructions to remove the
  manual entry (the stdio provider auto-registers, no manual config needed).

### 2. VS Code version requirements

`McpStdioServerDefinition` requires VS Code ≥ 1.99.  The existing
`vscode.engines` field is `^1.85.0`.

**Mitigation:**
- The definition provider already guards against missing APIs with a
  runtime check (`typeof vscode.lm.registerMcpServerDefinitionProvider`).
- On older VS Code, fall back to HTTP transport automatically.
- Log a warning recommending upgrade.

### 3. Multiple VS Code windows

Each window activates the extension independently.  With HTTP, this caused
port conflicts.  With stdio, each window gets its own child process — **no
conflict**.

However, each child process runs its own `PlanRunner`, so plans created in
one window are only visible in others after the data is persisted and
re-loaded.  This is acceptable because:
- Plans are persisted to disk on creation.
- The TreeView polls for updates.
- A future `FileSystemWatcher` can trigger instant refresh.

### 4. Remote / Codespaces / WSL

stdio transport works in all VS Code remote scenarios because the child
process runs wherever the extension host runs.  This is an improvement over
HTTP, which required the port to be forwarded.

### 5. Extension API stability

`McpStdioServerDefinition` is currently a proposed API.  If VS Code changes
its shape:
- The definition provider is isolated in `mcpDefinitionProvider.ts` — a
  single file to update.
- The `IStdioTransport` interface is transport-agnostic and unaffected.

---

## Testing Strategy

### Unit tests

| Component             | Test approach                                      |
|-----------------------|----------------------------------------------------|
| `StdioTransport`      | Inject `PassThrough` streams; assert parse + send  |
| `McpHandler` (router) | Already tested; unchanged                          |
| `StdioMcpServerManager` | Verify status transitions without health checks  |
| Definition provider   | Mock `vscode.lm`; assert correct definition type   |

### Integration tests

| Scenario                          | How                                             |
|-----------------------------------|-------------------------------------------------|
| Full round-trip                   | Spawn `mcp-stdio-server.js`, write JSON-RPC to stdin, assert stdout |
| Plan creation via stdio           | Send `tools/call` for `create_copilot_plan`, verify plan persisted |
| Graceful shutdown                 | Close stdin, assert `persistSync` called        |
| Fallback to HTTP on old VS Code   | Mock `vscode.lm` as undefined, assert HTTP used |

### Example: Unit testing `StdioTransport`

```ts
import { PassThrough } from 'stream';
import { StdioTransport } from './transport';

suite('StdioTransport', () => {
  test('routes a JSON-RPC request and writes response', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new StdioTransport(input, output);

    transport.onRequest(async (req) => ({
      jsonrpc: '2.0' as const,
      id: req.id,
      result: { tools: [] },
    }));

    // Start listening (non-blocking for PassThrough)
    const done = transport.start();

    // Write a request
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    input.write(request + '\n');

    // Read response
    const responseRaw = await new Promise<string>((resolve) => {
      output.once('data', (chunk) => resolve(chunk.toString()));
    });
    const response = JSON.parse(responseRaw.trim());

    assert.strictEqual(response.id, 1);
    assert.deepStrictEqual(response.result, { tools: [] });

    input.end();
    await done;
  });
});
```

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `McpStdioServerDefinition` API changes before stable | Provider breaks | Isolated in one file; runtime feature check |
| Child process crash loses in-flight plan mutations | Data loss | `persistSync` on every plan state change (already done) |
| `console.log` in dependencies leaks to stdout | Corrupted JSON-RPC | Redirect `console.log` → `stderr` at startup |
| PlanRunner in child cannot call VS Code API | Limited UI feedback | Host polls persisted state; events via `FileSystemWatcher` |
| Large JSON-RPC messages split across chunks | Parse failure | Buffer-and-split logic in `StdioTransport.onData` |

---

## Decision Log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Use `McpStdioServerDefinition` (child process), not in-process streams | VS Code API expects a spawnable command; in-process stdio is not supported by the registration API |
| 2 | Child process owns its own `PlanRunner` | Avoids IPC complexity; shared file-based persistence is sufficient |
| 3 | Default to HTTP in Phase 1 | Non-breaking rollout; gather feedback before switching default |
| 4 | Redirect `console.log` → `stderr` in child | stdout is reserved for JSON-RPC; any stray log corrupts the stream |
| 5 | Keep `IMcpManager` interface backward-compatible | Existing consumers (`extension.ts`, commands) don't break |
| 6 | Transport selection via user setting | Gives users control; enables gradual migration |

---

## Appendix: File-by-File Diff Summary

```
src/
├── interfaces/
│   ├── IMcpManager.ts          MODIFIED  — add IMcpServerLifecycle
│   └── index.ts                MODIFIED  — re-export new types
├── mcp/
│   ├── handler.ts              MODIFIED  — extract IMcpRequestRouter
│   ├── mcpDefinitionProvider.ts MODIFIED  — stdio definition support
│   ├── mcpServerManager.ts     MODIFIED  — add StdioMcpServerManager
│   ├── types.ts                (unchanged)
│   ├── stdio/
│   │   ├── transport.ts        NEW       — StdioTransport
│   │   ├── server.ts           NEW       — child process entry-point
│   │   └── index.ts            NEW       — barrel export
│   ├── handlers/               (unchanged)
│   └── tools/                  (unchanged)
├── core/
│   └── planInitialization.ts   MODIFIED  — stdio init path
├── extension.ts                MODIFIED  — conditional HTTP/stdio
├── http/                       (unchanged in Phase 1–2; removed Phase 3)
resources/
└── mcp-stdio-server.js         NEW       — compiled entry-point
package.json                    (unchanged — existing provider ID works)
```
