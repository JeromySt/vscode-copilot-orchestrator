/**
 * @fileoverview Test composition root — DI container with mock services.
 *
 * Provides {@link createTestContainer} which mirrors the production
 * {@link createContainer} but registers test doubles (from `vscode/testAdapters`)
 * by default.  Any service can be selectively overridden via the `overrides` map.
 *
 * @module compositionTest
 */

import { ServiceContainer } from './core/container';
import * as Tokens from './core/tokens';
import { MockConfigProvider, MockDialogService, MockClipboardService } from './vscode/testAdapters';

/**
 * Map of token → factory overrides accepted by {@link createTestContainer}.
 *
 * Only the tokens you provide will be overridden; all others keep their
 * mock defaults.
 */
export interface TestContainerOverrides {
  [Tokens.IConfigProvider]?: () => import('./interfaces').IConfigProvider;
  [Tokens.IDialogService]?: () => import('./interfaces').IDialogService;
  [Tokens.IClipboardService]?: () => import('./interfaces').IClipboardService;
  [Tokens.IProcessSpawner]?: () => import('./interfaces').IProcessSpawner;
  [Tokens.IProcessMonitor]?: () => import('./interfaces').IProcessMonitor;
  [Tokens.ILogger]?: () => import('./interfaces').ILogger;
}

/** Stub logger that satisfies ILogger without side-effects. */
function createStubLogger(): import('./interfaces').ILogger {
  const noop = () => {};
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    isDebugEnabled: () => false,
    setLevel: noop,
    getLevel: () => 'info',
  };
}

/** Stub process monitor that satisfies IProcessMonitor without OS calls. */
function createStubProcessMonitor(): import('./interfaces').IProcessMonitor {
  return {
    getSnapshot: async () => [],
    buildTree: () => [],
    isRunning: () => false,
    terminate: async () => {},
  };
}

/** Stub process spawner that satisfies IProcessSpawner without real processes. */
function createStubProcessSpawner(): import('./interfaces').IProcessSpawner {
  return {
    spawn: () => ({
      pid: 12345,
      exitCode: null,
      killed: false,
      stdout: null,
      stderr: null,
      kill: () => true,
      on: () => ({} as any),
    }),
  };
}

/**
 * Create a DI container pre-loaded with test doubles.
 *
 * Every service defaults to a lightweight mock/stub. Pass `overrides`
 * to replace specific services while keeping the rest as mocks.
 *
 * @param overrides - Optional map of token → factory to replace defaults
 * @returns A {@link ServiceContainer} ready for unit tests
 *
 * @example
 * ```typescript
 * const container = createTestContainer();
 * const config = container.resolve<IConfigProvider>(Tokens.IConfigProvider);
 * // config is a MockConfigProvider
 * ```
 *
 * @example Override a single service:
 * ```typescript
 * const container = createTestContainer({
 *   [Tokens.IConfigProvider]: () => myCustomConfigProvider,
 * });
 * ```
 */
export function createTestContainer(overrides?: Record<symbol, () => unknown>): ServiceContainer {
  const container = new ServiceContainer();

  // ─── Default mocks ───────────────────────────────────────────────────
  container.registerSingleton(Tokens.IConfigProvider, () => new MockConfigProvider());
  container.registerSingleton(Tokens.IDialogService, () => new MockDialogService());
  container.registerSingleton(Tokens.IClipboardService, () => new MockClipboardService());
  container.registerSingleton(Tokens.IProcessSpawner, () => createStubProcessSpawner());
  container.registerSingleton(Tokens.IProcessMonitor, () => createStubProcessMonitor());
  container.registerSingleton(Tokens.IPulseEmitter, () => ({ onPulse: () => ({ dispose: () => {} }), isRunning: false }));
  container.registerSingleton(Tokens.ILogger, () => createStubLogger());

  // ─── Apply overrides (symbol-keyed) ───────────────────────────────────
  if (overrides) {
    for (const sym of Object.getOwnPropertySymbols(overrides)) {
      const factory = (overrides as any)[sym];
      if (typeof factory === 'function') {
        container.registerSingleton(sym, factory as () => unknown);
      }
    }
  }

  return container;
}
