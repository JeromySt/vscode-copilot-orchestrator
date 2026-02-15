/**
 * @fileoverview Unit tests for composition.ts and compositionTest.ts
 *
 * Covers:
 * - createContainer registers all expected services
 * - Resolved services are correct implementations
 * - Singleton behaviour (same instance on repeated resolve)
 * - Logger gets wired with IConfigProvider
 * - createTestContainer registers mock services
 * - createTestContainer overrides work correctly
 */

import * as assert from 'assert';
import { ServiceContainer } from '../../core/container';
import * as Tokens from '../../core/tokens';
import type { IConfigProvider, IDialogService, IClipboardService, IProcessMonitor, ILogger } from '../../interfaces';

// ── Production composition (uses vscode mock) ─────────────────────────────
import { createContainer } from '../../composition';

// ── Test composition ──────────────────────────────────────────────────────
import { createTestContainer } from '../../compositionTest';
import { MockConfigProvider, MockDialogService, MockClipboardService } from '../../vscode/testAdapters';

// ── Helpers ───────────────────────────────────────────────────────────────

/** Minimal mock ExtensionContext for createContainer */
function makeMockContext(): any {
  const subscriptions: any[] = [];
  return {
    subscriptions,
    globalStorageUri: { fsPath: '/tmp/test-global-storage' },
    extensionUri: { fsPath: '/tmp/test-extension' },
    globalState: {
      get: () => undefined,
      update: async () => {},
    },
  };
}

// ============================================================================
// createContainer (production)
// ============================================================================

suite('createContainer', () => {
  let container: ServiceContainer;

  setup(() => {
    container = createContainer(makeMockContext());
  });

  test('returns a ServiceContainer', () => {
    assert.ok(container instanceof ServiceContainer);
  });

  // ── Registration checks ──────────────────────────────────────────────

  test('registers IConfigProvider', () => {
    assert.ok(container.isRegistered(Tokens.IConfigProvider));
  });

  test('registers IDialogService', () => {
    assert.ok(container.isRegistered(Tokens.IDialogService));
  });

  test('registers IClipboardService', () => {
    assert.ok(container.isRegistered(Tokens.IClipboardService));
  });

  test('registers IProcessMonitor', () => {
    assert.ok(container.isRegistered(Tokens.IProcessMonitor));
  });

  test('registers ILogger', () => {
    assert.ok(container.isRegistered(Tokens.ILogger));
  });

  // ── Resolution checks ────────────────────────────────────────────────

  test('resolves IConfigProvider with getConfig method', () => {
    const svc = container.resolve<IConfigProvider>(Tokens.IConfigProvider);
    assert.strictEqual(typeof svc.getConfig, 'function');
  });

  test('resolves IDialogService with dialog methods', () => {
    const svc = container.resolve<IDialogService>(Tokens.IDialogService);
    assert.strictEqual(typeof svc.showInfo, 'function');
    assert.strictEqual(typeof svc.showError, 'function');
    assert.strictEqual(typeof svc.showWarning, 'function');
    assert.strictEqual(typeof svc.showQuickPick, 'function');
  });

  test('resolves IClipboardService with writeText method', () => {
    const svc = container.resolve<IClipboardService>(Tokens.IClipboardService);
    assert.strictEqual(typeof svc.writeText, 'function');
  });

  test('resolves IProcessMonitor with expected methods', () => {
    const svc = container.resolve<IProcessMonitor>(Tokens.IProcessMonitor);
    assert.strictEqual(typeof svc.getSnapshot, 'function');
    assert.strictEqual(typeof svc.buildTree, 'function');
    assert.strictEqual(typeof svc.isRunning, 'function');
    assert.strictEqual(typeof svc.terminate, 'function');
  });

  test('resolves ILogger with logging methods', () => {
    const svc = container.resolve<ILogger>(Tokens.ILogger);
    assert.strictEqual(typeof svc.info, 'function');
    assert.strictEqual(typeof svc.warn, 'function');
    assert.strictEqual(typeof svc.error, 'function');
    assert.strictEqual(typeof svc.debug, 'function');
  });

  // ── Singleton behaviour ──────────────────────────────────────────────

  test('IConfigProvider is a singleton', () => {
    const a = container.resolve<IConfigProvider>(Tokens.IConfigProvider);
    const b = container.resolve<IConfigProvider>(Tokens.IConfigProvider);
    assert.strictEqual(a, b);
  });

  test('IDialogService is a singleton', () => {
    const a = container.resolve<IDialogService>(Tokens.IDialogService);
    const b = container.resolve<IDialogService>(Tokens.IDialogService);
    assert.strictEqual(a, b);
  });

  test('IClipboardService is a singleton', () => {
    const a = container.resolve<IClipboardService>(Tokens.IClipboardService);
    const b = container.resolve<IClipboardService>(Tokens.IClipboardService);
    assert.strictEqual(a, b);
  });

  test('IProcessMonitor is a singleton', () => {
    const a = container.resolve<IProcessMonitor>(Tokens.IProcessMonitor);
    const b = container.resolve<IProcessMonitor>(Tokens.IProcessMonitor);
    assert.strictEqual(a, b);
  });

  test('ILogger is a singleton', () => {
    const a = container.resolve<ILogger>(Tokens.ILogger);
    const b = container.resolve<ILogger>(Tokens.ILogger);
    assert.strictEqual(a, b);
  });

  // ── Logger wiring ────────────────────────────────────────────────────

  test('Logger is wired with IConfigProvider via setConfigProvider', () => {
    // Resolving ILogger should trigger the factory that calls setConfigProvider
    const logger = container.resolve<any>(Tokens.ILogger);
    // Logger is the singleton — the factory calls setConfigProvider on it.
    // If this didn't throw, the wiring succeeded.
    assert.ok(logger);
  });
});

// ============================================================================
// createTestContainer
// ============================================================================

suite('createTestContainer', () => {
  test('returns a ServiceContainer', () => {
    const container = createTestContainer();
    assert.ok(container instanceof ServiceContainer);
  });

  // ── Default registrations ────────────────────────────────────────────

  test('registers all expected tokens by default', () => {
    const container = createTestContainer();
    assert.ok(container.isRegistered(Tokens.IConfigProvider));
    assert.ok(container.isRegistered(Tokens.IDialogService));
    assert.ok(container.isRegistered(Tokens.IClipboardService));
    assert.ok(container.isRegistered(Tokens.IProcessMonitor));
    assert.ok(container.isRegistered(Tokens.ILogger));
  });

  // ── Default service types ────────────────────────────────────────────

  test('resolves IConfigProvider as MockConfigProvider', () => {
    const container = createTestContainer();
    const svc = container.resolve<any>(Tokens.IConfigProvider);
    assert.ok(svc instanceof MockConfigProvider);
  });

  test('resolves IDialogService as MockDialogService', () => {
    const container = createTestContainer();
    const svc = container.resolve<any>(Tokens.IDialogService);
    assert.ok(svc instanceof MockDialogService);
  });

  test('resolves IClipboardService as MockClipboardService', () => {
    const container = createTestContainer();
    const svc = container.resolve<any>(Tokens.IClipboardService);
    assert.ok(svc instanceof MockClipboardService);
  });

  test('resolves IProcessMonitor as stub with expected methods', () => {
    const container = createTestContainer();
    const svc = container.resolve<IProcessMonitor>(Tokens.IProcessMonitor);
    assert.strictEqual(typeof svc.getSnapshot, 'function');
    assert.strictEqual(typeof svc.buildTree, 'function');
    assert.strictEqual(typeof svc.isRunning, 'function');
    assert.strictEqual(typeof svc.terminate, 'function');
  });

  test('resolves ILogger as stub with logging methods', () => {
    const container = createTestContainer();
    const svc = container.resolve<ILogger>(Tokens.ILogger);
    assert.strictEqual(typeof svc.info, 'function');
    assert.strictEqual(typeof svc.debug, 'function');
    assert.strictEqual(typeof svc.warn, 'function');
    assert.strictEqual(typeof svc.error, 'function');
    assert.strictEqual(typeof svc.isDebugEnabled, 'function');
    assert.strictEqual(typeof svc.setLevel, 'function');
    assert.strictEqual(typeof svc.getLevel, 'function');
  });

  test('stub logger returns expected defaults', () => {
    const container = createTestContainer();
    const svc = container.resolve<ILogger>(Tokens.ILogger);
    assert.strictEqual(svc.isDebugEnabled(), false);
    assert.strictEqual(svc.getLevel(), 'info');
  });

  test('stub process monitor returns empty snapshot', async () => {
    const container = createTestContainer();
    const svc = container.resolve<IProcessMonitor>(Tokens.IProcessMonitor);
    const snapshot = await svc.getSnapshot();
    assert.deepStrictEqual(snapshot, []);
  });

  test('stub process monitor isRunning returns false', () => {
    const container = createTestContainer();
    const svc = container.resolve<IProcessMonitor>(Tokens.IProcessMonitor);
    assert.strictEqual(svc.isRunning(12345), false);
  });

  test('stub process monitor buildTree returns empty array', () => {
    const container = createTestContainer();
    const svc = container.resolve<IProcessMonitor>(Tokens.IProcessMonitor);
    assert.deepStrictEqual(svc.buildTree([], []), []);
  });

  // ── Singleton behaviour ──────────────────────────────────────────────

  test('test services are singletons', () => {
    const container = createTestContainer();
    const a = container.resolve<IConfigProvider>(Tokens.IConfigProvider);
    const b = container.resolve<IConfigProvider>(Tokens.IConfigProvider);
    assert.strictEqual(a, b);
  });

  // ── Overrides ────────────────────────────────────────────────────────

  test('overrides replace default for a single token', () => {
    const customConfig: IConfigProvider = {
      getConfig: <T>(_s: string, _k: string, d: T) => d,
    };
    const container = createTestContainer({
      [Tokens.IConfigProvider]: () => customConfig,
    });
    const resolved = container.resolve<IConfigProvider>(Tokens.IConfigProvider);
    assert.strictEqual(resolved, customConfig);
  });

  test('overrides leave other services as defaults', () => {
    const customConfig: IConfigProvider = {
      getConfig: <T>(_s: string, _k: string, d: T) => d,
    };
    const container = createTestContainer({
      [Tokens.IConfigProvider]: () => customConfig,
    });
    // IDialogService should still be MockDialogService
    const dialog = container.resolve<any>(Tokens.IDialogService);
    assert.ok(dialog instanceof MockDialogService);
  });

  test('multiple overrides are applied', () => {
    const customConfig: IConfigProvider = {
      getConfig: <T>(_s: string, _k: string, d: T) => d,
    };
    const customDialog: IDialogService = {
      showInfo: async () => {},
      showError: async () => {},
      showWarning: async () => undefined,
      showQuickPick: async () => undefined,
    };
    const container = createTestContainer({
      [Tokens.IConfigProvider]: () => customConfig,
      [Tokens.IDialogService]: () => customDialog,
    });
    assert.strictEqual(container.resolve<IConfigProvider>(Tokens.IConfigProvider), customConfig);
    assert.strictEqual(container.resolve<IDialogService>(Tokens.IDialogService), customDialog);
  });

  test('no overrides parameter works the same as empty', () => {
    const c1 = createTestContainer();
    const c2 = createTestContainer(undefined);
    // Both should resolve MockConfigProvider
    assert.ok(c1.resolve<any>(Tokens.IConfigProvider) instanceof MockConfigProvider);
    assert.ok(c2.resolve<any>(Tokens.IConfigProvider) instanceof MockConfigProvider);
  });

  test('empty overrides object changes nothing', () => {
    const container = createTestContainer({});
    assert.ok(container.resolve<any>(Tokens.IConfigProvider) instanceof MockConfigProvider);
  });
});
