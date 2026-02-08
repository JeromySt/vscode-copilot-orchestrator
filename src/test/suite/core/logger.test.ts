/**
 * @fileoverview Unit tests for Logger and ComponentLogger.
 */

import * as assert from 'assert';
import { Logger, ComponentLogger } from '../../../core/logger';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

suite('Logger', () => {
  let quiet: { restore: () => void };

  setup(() => {
    quiet = silenceConsole();
  });

  teardown(() => {
    quiet.restore();
    // Reset singleton
    (Logger as any).instance = undefined;
  });

  suite('static methods', () => {
    test('initialize creates singleton', () => {
      const subs: any[] = [];
      const ctx = { subscriptions: { push: (d: any) => subs.push(d) } };
      const logger = Logger.initialize(ctx);
      assert.ok(logger);
    });

    test('initialize returns same instance on second call', () => {
      const ctx = { subscriptions: { push: () => {} } };
      const a = Logger.initialize(ctx);
      const b = Logger.initialize(ctx);
      assert.strictEqual(a, b);
    });

    test('for() returns ComponentLogger', () => {
      const cl = Logger.for('mcp');
      assert.ok(cl instanceof ComponentLogger);
    });

    test('show() does not throw', () => {
      assert.doesNotThrow(() => Logger.show());
    });
  });

  suite('instance methods', () => {
    test('log() writes at info level', () => {
      const ctx = { subscriptions: { push: () => {} } };
      const logger = Logger.initialize(ctx);
      assert.doesNotThrow(() => logger.log('info', 'mcp', 'test'));
    });

    test('log() skips debug when not enabled', () => {
      const ctx = { subscriptions: { push: () => {} } };
      const logger = Logger.initialize(ctx);
      assert.doesNotThrow(() => logger.log('debug', 'mcp', 'skipped'));
    });

    test('debug() delegates to log', () => {
      const ctx = { subscriptions: { push: () => {} } };
      const logger = Logger.initialize(ctx);
      assert.doesNotThrow(() => logger.debug('mcp', 'debug msg'));
    });

    test('info() delegates to log', () => {
      const ctx = { subscriptions: { push: () => {} } };
      const logger = Logger.initialize(ctx);
      assert.doesNotThrow(() => logger.info('mcp', 'info msg'));
    });

    test('warn() delegates to log', () => {
      const ctx = { subscriptions: { push: () => {} } };
      const logger = Logger.initialize(ctx);
      assert.doesNotThrow(() => logger.warn('mcp', 'warn msg'));
    });

    test('error() delegates to log', () => {
      const ctx = { subscriptions: { push: () => {} } };
      const logger = Logger.initialize(ctx);
      assert.doesNotThrow(() => logger.error('mcp', 'error msg'));
    });

    test('log() formats Error objects in data', () => {
      const ctx = { subscriptions: { push: () => {} } };
      const logger = Logger.initialize(ctx);
      assert.doesNotThrow(() => logger.log('info', 'mcp', 'with error', new Error('test')));
    });

    test('log() formats plain objects in data', () => {
      const ctx = { subscriptions: { push: () => {} } };
      const logger = Logger.initialize(ctx);
      assert.doesNotThrow(() => logger.log('info', 'mcp', 'with data', { key: 'value' }));
    });

    test('log() handles circular data gracefully', () => {
      const ctx = { subscriptions: { push: () => {} } };
      const logger = Logger.initialize(ctx);
      const circular: any = {};
      circular.self = circular;
      assert.doesNotThrow(() => logger.log('info', 'mcp', 'circular', circular));
    });

    test('isDebugEnabled returns false by default', () => {
      const ctx = { subscriptions: { push: () => {} } };
      const logger = Logger.initialize(ctx);
      assert.strictEqual(logger.isDebugEnabled('mcp'), false);
    });
  });
});

suite('ComponentLogger', () => {
  let quiet: { restore: () => void };

  setup(() => {
    quiet = silenceConsole();
  });

  teardown(() => {
    quiet.restore();
    (Logger as any).instance = undefined;
  });

  suite('without Logger instance (standalone mode)', () => {
    test('debug() falls back to console.debug', () => {
      const cl = new ComponentLogger('mcp' as any);
      assert.doesNotThrow(() => cl.debug('test'));
    });

    test('info() falls back to console.log', () => {
      const cl = new ComponentLogger('mcp' as any);
      assert.doesNotThrow(() => cl.info('test'));
    });

    test('warn() falls back to console.warn', () => {
      const cl = new ComponentLogger('mcp' as any);
      assert.doesNotThrow(() => cl.warn('test'));
    });

    test('error() falls back to console.error', () => {
      const cl = new ComponentLogger('mcp' as any);
      assert.doesNotThrow(() => cl.error('test'));
    });

    test('isDebugEnabled() returns false without instance', () => {
      const cl = new ComponentLogger('mcp' as any);
      assert.strictEqual(cl.isDebugEnabled(), false);
    });
  });

  suite('with Logger instance', () => {
    test('debug() delegates to Logger.debug', () => {
      const ctx = { subscriptions: { push: () => {} } };
      Logger.initialize(ctx);
      const cl = Logger.for('mcp');
      assert.doesNotThrow(() => cl.debug('test'));
    });

    test('info() delegates to Logger.info', () => {
      const ctx = { subscriptions: { push: () => {} } };
      Logger.initialize(ctx);
      const cl = Logger.for('mcp');
      assert.doesNotThrow(() => cl.info('test'));
    });

    test('warn() delegates to Logger.warn', () => {
      const ctx = { subscriptions: { push: () => {} } };
      Logger.initialize(ctx);
      const cl = Logger.for('mcp');
      assert.doesNotThrow(() => cl.warn('test'));
    });

    test('error() delegates to Logger.error', () => {
      const ctx = { subscriptions: { push: () => {} } };
      Logger.initialize(ctx);
      const cl = Logger.for('mcp');
      assert.doesNotThrow(() => cl.error('test'));
    });

    test('debug with data', () => {
      const ctx = { subscriptions: { push: () => {} } };
      Logger.initialize(ctx);
      const cl = Logger.for('mcp');
      assert.doesNotThrow(() => cl.debug('test', { key: 'val' }));
    });
  });
});
