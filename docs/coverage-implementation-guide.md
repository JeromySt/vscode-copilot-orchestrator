# Code Coverage Implementation Guide

## Objective

Implement 95% line coverage enforcement in CI for `vscode-copilot-orchestrator`, matching the quality bar of `vscode-cbor-viewer`. This requires extracting pure-logic unit tests from the VS Code integration test harness so that `c8` can instrument them directly.

---

## Problem Statement

All 22 test files currently run inside `@vscode/test-electron`, which spawns a VS Code Electron process. Standard coverage tools (`c8`, `nyc`) cannot instrument code running in a child Electron process. However, **19 of 22 test files have zero `vscode` API imports** — they are pure unit tests that don't need VS Code at all. By running those directly with mocha + c8, we get reliable coverage metrics.

---

## Architecture: Dual Test Runner

After this work, the repo should have two test modes:

| Mode | Command | Runner | Coverage |
|------|---------|--------|----------|
| **Unit tests** | `npm run test:unit` | mocha (direct) | ✅ c8 instrumented |
| **Integration tests** | `npm run test` | @vscode/test-electron | ❌ No coverage (runs in Electron) |
| **Coverage enforcement** | `npm run test:coverage` | mocha (direct) + c8 | ✅ 95% line threshold |

This matches the pattern used in `vscode-cbor-viewer`.

---

## Step 1: Install Coverage Tooling

```bash
npm install --save-dev c8
```

`c8` is preferred over `nyc` because it uses V8's built-in coverage (faster, no source transformation needed, works with sourcemaps natively).

---

## Step 2: Restructure Test Files

### Current structure
```
src/test/
├── runTest.ts                    # @vscode/test-electron launcher
├── suite/
│   ├── index.ts                  # Mocha runner (inside VS Code)
│   ├── extension.test.ts         # ⚡ Uses vscode API
│   ├── agent/cliCheck.test.ts
│   ├── core/scheduler.test.ts
│   ├── git/worktrees.test.ts
│   ├── git/merge.test.ts
│   ├── git/orchestrator.test.ts
│   ├── mcp/handler.test.ts
│   ├── mcp/handlers.test.ts
│   ├── mcp/planTools.test.ts
│   ├── mcp/nodeTools.test.ts
│   ├── mcp/stdioServerManager.test.ts  # ⚡ Uses vscode API
│   ├── mcp/stdioTransport.test.ts
│   ├── mcp/validation.test.ts
│   ├── plan/cleanup.test.ts
│   ├── plan/evidenceValidator.test.ts
│   ├── plan/interfaces.test.ts
│   ├── plan/nodeBuilder.test.ts
│   ├── plan/nodeTypes.test.ts
│   ├── plan/persistence.test.ts
│   ├── plan/stateMachine.test.ts
│   └── process/processMonitor.test.ts
```

### Target structure
```
src/test/
├── runTest.ts                         # @vscode/test-electron launcher (unchanged)
├── suite/                             # Integration tests (run in VS Code)
│   ├── index.ts                       # Mocha runner (unchanged)
│   ├── extension.test.ts              # ⚡ Stays here (needs vscode)
│   └── mcp/stdioServerManager.test.ts # ⚡ Stays here (needs vscode)
├── unit/                              # Unit tests (run directly with mocha)
│   ├── agent/cliCheck.unit.test.ts
│   ├── core/scheduler.unit.test.ts
│   ├── git/worktrees.unit.test.ts
│   ├── git/merge.unit.test.ts
│   ├── git/orchestrator.unit.test.ts
│   ├── mcp/handler.unit.test.ts
│   ├── mcp/handlers.unit.test.ts
│   ├── mcp/planTools.unit.test.ts
│   ├── mcp/nodeTools.unit.test.ts
│   ├── mcp/stdioTransport.unit.test.ts
│   ├── mcp/validation.unit.test.ts
│   ├── plan/cleanup.unit.test.ts
│   ├── plan/evidenceValidator.unit.test.ts
│   ├── plan/interfaces.unit.test.ts
│   ├── plan/nodeBuilder.unit.test.ts
│   ├── plan/nodeTypes.unit.test.ts
│   ├── plan/persistence.unit.test.ts
│   ├── plan/stateMachine.unit.test.ts
│   └── process/processMonitor.unit.test.ts
```

### How to migrate each test file

For each of the **19 pure-logic test files** (those without `import * as vscode from 'vscode'`):

1. **Copy** the file from `src/test/suite/<path>/<name>.test.ts` to `src/test/unit/<path>/<name>.unit.test.ts`
2. **Remove** the original from `src/test/suite/` (it will only run as a unit test now)
3. **Verify** the file has NO `vscode` imports. If it does, either:
   - Mock the vscode module (see Step 3)
   - Leave it in `suite/` as an integration test
4. **Verify** relative import paths are correct for the new location

### Files that MUST stay in `suite/` (they use VS Code APIs):
- `extension.test.ts` — imports `vscode` directly
- `mcp/stdioServerManager.test.ts` — imports `vscode` directly

---

## Step 3: Handle `vscode` Module Mocking (if needed)

Some source files under test may `import * as vscode from 'vscode'` even though the test file itself doesn't. When running outside VS Code, `require('vscode')` will fail.

### Solution: Create a vscode mock module

Create `src/test/unit/mocks/vscode.ts`:

```typescript
// Minimal vscode API mock for unit tests
export const window = {
    showInformationMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    createOutputChannel: () => ({
        appendLine: () => {},
        append: () => {},
        show: () => {},
        dispose: () => {},
        clear: () => {},
    }),
    withProgress: (_opts: any, task: any) => task({ report: () => {} }),
};

export const workspace = {
    getConfiguration: () => ({
        get: () => undefined,
        update: () => Promise.resolve(),
    }),
    workspaceFolders: [],
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
};

export const commands = {
    registerCommand: () => ({ dispose: () => {} }),
    executeCommand: () => Promise.resolve(),
};

export const Uri = {
    file: (path: string) => ({ fsPath: path, scheme: 'file', path }),
    parse: (str: string) => ({ fsPath: str, scheme: 'file', path: str }),
};

export enum ProgressLocation {
    Notification = 15,
    SourceControl = 1,
    Window = 10,
}

export class EventEmitter {
    event = () => ({ dispose: () => {} });
    fire() {}
    dispose() {}
}

export class Disposable {
    static from(...disposables: any[]) { return { dispose: () => {} }; }
    dispose() {}
}

// Add more as needed based on which vscode APIs the source files use
```

### Register the mock in mocha

Option A: Use `tsconfig` paths (preferred):

In `tsconfig.json`, add a path mapping (or create a separate `tsconfig.test.json`):
```json
{
  "compilerOptions": {
    "paths": {
      "vscode": ["./src/test/unit/mocks/vscode"]
    }
  }
}
```

Option B: Use `--require` with a module alias register script:

Create `src/test/unit/register-vscode-mock.js`:
```javascript
const Module = require('module');
const path = require('path');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...args) {
    if (request === 'vscode') {
        return path.join(__dirname, '..', '..', '..', 'out', 'test', 'unit', 'mocks', 'vscode.js');
    }
    return originalResolve.call(this, request, parent, ...args);
};
```

Then in the mocha command: `mocha --require out/test/unit/register-vscode-mock.js ...`

**Recommendation:** Use Option B (module alias) — it's simpler and doesn't require tsconfig changes that could affect production builds.

---

## Step 4: Update `package.json` Scripts

```json
{
  "scripts": {
    "test": "npm run compile && node ./out/test/runTest.js",
    "test:unit": "npm run compile && mocha --ui tdd \"out/test/unit/**/*.unit.test.js\" --require out/test/unit/register-vscode-mock.js",
    "test:coverage": "npm run compile && c8 --reporter=text --reporter=lcov --check-coverage --lines 95 --all --include=out/**/*.js --exclude=out/test/** mocha --ui tdd \"out/test/unit/**/*.unit.test.js\" --require out/test/unit/register-vscode-mock.js",
    "test:watch": "tsc -watch -p ./ & mocha --watch --ui tdd \"out/test/unit/**/*.unit.test.js\" --require out/test/unit/register-vscode-mock.js"
  }
}
```

### Key flags explained:
- `--check-coverage --lines 95` — Fails CI if line coverage drops below 95%
- `--all` — Reports coverage for ALL source files, not just those touched by tests
- `--include=out/**/*.js` — Only measure coverage on compiled source
- `--exclude=out/test/**` — Exclude test files from coverage metrics
- `--reporter=text` — Console output
- `--reporter=lcov` — For CI tools and coverage badge services

---

## Step 5: Update CI Workflow (`.github/workflows/ci.yml`)

Add a new `unit_coverage` job that runs on PRs:

```yaml
  unit_coverage:
    name: Unit tests + coverage (PR)
    if: github.event_name == 'pull_request'
    permissions:
      contents: read
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0
    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '20.x'
        cache: 'npm'
    - name: Install dependencies
      run: npm ci
    - name: Run unit tests + enforce coverage
      run: npm run test:coverage
```

Also consider making lint a hard failure:

```yaml
    - name: Run lint
      run: npm run lint
      # Remove continue-on-error: true
```

---

## Step 6: Add Coverage to `.gitignore`

```
# Coverage
coverage/
.nyc_output/
```

---

## Step 7: Verification Checklist

After implementing all steps, verify:

- [ ] `npm run compile` — TypeScript compiles without errors
- [ ] `npm run test:unit` — All 19 unit test files run directly via mocha (no VS Code)
- [ ] `npm run test` — Integration tests still run in VS Code (extension.test.ts + stdioServerManager.test.ts)
- [ ] `npm run test:coverage` — Coverage report shows 95%+ lines and the command exits 0
- [ ] Removing a test causes coverage to drop and `test:coverage` exits non-zero
- [ ] `npm run lint` — No lint errors (or fix them)
- [ ] CI passes on a test PR

---

## Step 8: Coverage Gap Analysis

After running `npm run test:coverage` for the first time, you'll see a coverage report. Identify files with low coverage and write additional unit tests. Common gaps:

1. **Error handling branches** — Add tests that trigger `catch` blocks
2. **Edge cases** — Empty inputs, null values, boundary conditions
3. **Untested source files** — Files with 0% coverage need new test files
4. **UI code** (`src/ui/`) — These files import `vscode` heavily and likely can't be unit tested. They should be excluded from coverage with `--exclude=out/ui/**` or their logic should be extracted into testable helper functions.

### Likely exclusions from coverage measurement

Some files are inherently untestable outside VS Code. Add these to the c8 `--exclude` flags:

```
--exclude=out/test/**
--exclude=out/ui/**
--exclude=out/extension.js
```

Adjust the `--lines` threshold accordingly if UI code is a significant portion. You may start at 80% and ramp up to 95% as you extract more logic into testable modules.

---

## Step 9: Recommended Coverage Ramp-Up Plan

Rather than requiring 95% immediately (which may be unreachable with UI-heavy code excluded):

1. **Phase 1**: Extract unit tests, add c8, set threshold at **70%** → get CI green
2. **Phase 2**: Write missing tests for pure-logic modules → reach **80%**
3. **Phase 3**: Extract testable logic from UI modules into helpers → reach **90%**
4. **Phase 4**: Comprehensive edge-case testing → reach **95%**

Update the `--lines` threshold in `package.json` as you progress through each phase.

---

## Reference: vscode-cbor-viewer Implementation

For a working example of this exact pattern, see `vscode-cbor-viewer`:

- **Unit tests**: `src/test/unit/**/*.unit.test.ts` (run directly with mocha)
- **Coverage script**: `package.json` → `test:coverage` uses c8 with `--check-coverage --lines 95`
- **CI job**: `.github/workflows/ci.yml` → `unit_coverage` job runs on PRs
- **Result**: 174 tests, 95.12% line coverage, enforced on every PR
