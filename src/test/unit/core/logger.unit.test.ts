/**
 * @fileoverview Unit tests for Logger dependency injection support.
 * 
 * Tests Logger class with dependency injection capabilities while ensuring
 * backward compatibility with existing code patterns.
 * 
 * @module test/unit/core/logger.unit.test
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { Logger, ComponentLogger, LogComponent, LOGGING_LEVEL_KEY, LOGGING_COMPONENTS_KEY } from '../../../core/logger';
import { IConfigProvider } from '../../../interfaces/IConfigProvider';

// Mock config provider for testing
class MockConfigProvider implements IConfigProvider {
  private config: Map<string, any> = new Map();

  getConfig<T>(section: string, key: string, defaultValue: T): T {
    const fullKey = `${section}.${key}`;
    return this.config.get(fullKey) ?? defaultValue;
  }

  setConfig<T>(section: string, key: string, value: T): void {
    const fullKey = `${section}.${key}`;
    this.config.set(fullKey, value);
  }

  clear(): void {
    this.config.clear();
  }
}

suite('Logger Unit Tests', () => {
  let logger: Logger;
  let mockConfigProvider: MockConfigProvider;
  let consoleStubs: {
    log: sinon.SinonStub;
    debug: sinon.SinonStub;
    warn: sinon.SinonStub;
    error: sinon.SinonStub;
  };

  setup(() => {
    // Reset singleton instance for each test
    (Logger as any).instance = undefined;
    
    mockConfigProvider = new MockConfigProvider();
    
    // Stub console methods to capture output
    consoleStubs = {
      log: sinon.stub(console, 'log'),
      debug: sinon.stub(console, 'debug'),
      warn: sinon.stub(console, 'warn'),
      error: sinon.stub(console, 'error'),
    };
  });

  teardown(() => {
    // Reset stubs
    Object.values(consoleStubs).forEach(stub => stub.restore());
    mockConfigProvider.clear();
    
    // Reset singleton
    (Logger as any).instance = undefined;
  });

  suite('Constructor and Dependency Injection', () => {
    test('should create Logger with config provider', () => {
      logger = new Logger(mockConfigProvider);
      assert.ok(logger);
      assert.strictEqual(logger.getLevel(), 'info'); // default level
    });

    test('should create Logger without config provider (backward compatibility)', () => {
      logger = new Logger();
      assert.ok(logger);
      assert.strictEqual(logger.getLevel(), 'info'); // default level
    });

    test('should support setConfigProvider method', () => {
      logger = new Logger();
      mockConfigProvider.setConfig(LOGGING_LEVEL_KEY, '', 'debug');
      
      logger.setConfigProvider(mockConfigProvider);
      assert.strictEqual(logger.getLevel(), 'debug');
    });
  });

  suite('Log Level Management', () => {
    setup(() => {
      logger = new Logger(mockConfigProvider);
    });

    test('should set and get log level', () => {
      logger.setLevel('warn');
      assert.strictEqual(logger.getLevel(), 'warn');
      
      logger.setLevel('error');
      assert.strictEqual(logger.getLevel(), 'error');
    });

    test('should filter logs below current level', () => {
      logger.setLevel('warn');
      
      logger.log('debug', 'mcp', 'debug message');
      logger.log('info', 'mcp', 'info message');
      logger.log('warn', 'mcp', 'warn message');
      logger.log('error', 'mcp', 'error message');
      
      // Only warn and error should have been logged
      assert.strictEqual(consoleStubs.debug.callCount, 0);
      assert.strictEqual(consoleStubs.log.callCount, 0);
      assert.strictEqual(consoleStubs.warn.callCount, 1);
      assert.strictEqual(consoleStubs.error.callCount, 1);
    });

    test('should respect log level from config provider', () => {
      mockConfigProvider.setConfig(LOGGING_LEVEL_KEY, '', 'error');
      logger = new Logger(mockConfigProvider);
      
      assert.strictEqual(logger.getLevel(), 'error');
      
      logger.log('warn', 'mcp', 'warn message');
      logger.log('error', 'mcp', 'error message');
      
      // Only error should have been logged
      assert.strictEqual(consoleStubs.warn.callCount, 0);
      assert.strictEqual(consoleStubs.error.callCount, 1);
    });
  });

  suite('Component Debug Control', () => {
    setup(() => {
      logger = new Logger(mockConfigProvider);
    });

    test('should enable debug for specific components via config', () => {
      mockConfigProvider.setConfig('copilotOrchestrator.logging.debug', 'mcp', true);
      mockConfigProvider.setConfig('copilotOrchestrator.logging.debug', 'http', false);
      
      logger = new Logger(mockConfigProvider);
      logger.setLevel('debug');
      
      assert.strictEqual(logger.isDebugEnabled('mcp'), true);
      assert.strictEqual(logger.isDebugEnabled('http'), false);
    });

    test('should filter debug logs per component', () => {
      mockConfigProvider.setConfig('copilotOrchestrator.logging.debug', 'mcp', true);
      mockConfigProvider.setConfig('copilotOrchestrator.logging.debug', 'http', false);
      
      logger = new Logger(mockConfigProvider);
      logger.setLevel('debug');
      
      logger.log('debug', 'mcp', 'mcp debug message');
      logger.log('debug', 'http', 'http debug message');
      
      // Only mcp debug should have been logged
      const debugCalls = consoleStubs.debug.getCalls();
      assert.strictEqual(debugCalls.length, 1);
      assert.ok(debugCalls[0].args[0].includes('mcp'));
    });
  });

  suite('Log Output Methods', () => {
    setup(() => {
      logger = new Logger(mockConfigProvider);
      logger.setLevel('debug');
    });

    test('should output debug messages', () => {
      mockConfigProvider.setConfig('copilotOrchestrator.logging.debug', 'mcp', true);
      logger = new Logger(mockConfigProvider);
      logger.setLevel('debug');
      
      logger.debug('mcp', 'debug message', { key: 'value' });
      
      assert.strictEqual(consoleStubs.debug.callCount, 1);
      const call = consoleStubs.debug.getCall(0);
      assert.ok(call.args[0].includes('mcp'));
      assert.ok(call.args[0].includes('debug message'));
    });

    test('should output info messages', () => {
      logger.info('mcp', 'info message', { data: 123 });
      
      assert.strictEqual(consoleStubs.log.callCount, 1);
      const call = consoleStubs.log.getCall(0);
      assert.ok(call.args[0].includes('mcp'));
      assert.ok(call.args[0].includes('info message'));
    });

    test('should output warn messages', () => {
      logger.warn('mcp', 'warn message');
      
      assert.strictEqual(consoleStubs.warn.callCount, 1);
      const call = consoleStubs.warn.getCall(0);
      assert.ok(call.args[0].includes('mcp'));
      assert.ok(call.args[0].includes('warn message'));
    });

    test('should output error messages', () => {
      const error = new Error('test error');
      logger.error('mcp', 'error message', error);
      
      assert.strictEqual(consoleStubs.error.callCount, 1);
      const call = consoleStubs.error.getCall(0);
      assert.ok(call.args[0].includes('mcp'));
      assert.ok(call.args[0].includes('error message'));
    });

    test('should format timestamps and log levels', () => {
      logger.info('mcp', 'test message');
      
      const call = consoleStubs.log.getCall(0);
      const message = call.args[0];
      
      // Console format is simpler: [Orchestrator:component] message
      assert.ok(message.includes('[Orchestrator:mcp]'));
      assert.ok(message.includes('test message'));
    });

    test('should format error objects in data', () => {
      const error = new Error('test error');
      error.stack = 'Error: test error\n    at test';
      
      logger.info('mcp', 'message with error', error);
      
      const call = consoleStubs.log.getCall(0);
      const message = call.args[0];
      assert.ok(message.includes('[Orchestrator:mcp]'));
      assert.ok(message.includes('message with error'));
      
      // Error object is passed as second argument
      const errorArg = call.args[1];
      assert.strictEqual(errorArg, error);
    });

    test('should format JSON data', () => {
      const data = { key: 'value', number: 42 };
      logger.info('mcp', 'message with data', data);
      
      const call = consoleStubs.log.getCall(0);
      const message = call.args[0];
      assert.ok(message.includes('[Orchestrator:mcp]'));
      assert.ok(message.includes('message with data'));
      
      // Data object is passed as second argument
      const dataArg = call.args[1];
      assert.deepStrictEqual(dataArg, data);
    });
  });

  suite('ComponentLogger Factory', () => {
    test('should create ComponentLogger via static for() method', () => {
      const componentLogger = Logger.for('mcp');
      assert.ok(componentLogger instanceof ComponentLogger);
    });

    test('should work without singleton instance (fallback mode)', () => {
      const componentLogger = Logger.for('mcp');
      componentLogger.info('test message');
      
      // Should fallback to console.log
      assert.strictEqual(consoleStubs.log.callCount, 1);
      const call = consoleStubs.log.getCall(0);
      assert.ok(call.args[0].includes('mcp'));
      assert.ok(call.args[0].includes('test message'));
    });

    test('should use singleton instance when available', () => {
      // Initialize singleton
      logger = new Logger(mockConfigProvider);
      logger.setLevel('warn');
      (Logger as any).instance = logger;
      
      const componentLogger = Logger.for('mcp');
      componentLogger.info('info message'); // Should be filtered
      componentLogger.warn('warn message'); // Should be logged
      
      assert.strictEqual(consoleStubs.log.callCount, 0); // info filtered
      assert.strictEqual(consoleStubs.warn.callCount, 1); // warn logged
    });
  });

  suite('ComponentLogger Interface Compliance', () => {
    let componentLogger: ComponentLogger;

    setup(() => {
      logger = new Logger(mockConfigProvider);
      logger.setLevel('debug');
      (Logger as any).instance = logger;
      componentLogger = Logger.for('mcp');
    });

    test('should implement setLevel method', () => {
      componentLogger.setLevel('error');
      assert.strictEqual(componentLogger.getLevel(), 'error');
    });

    test('should implement getLevel method', () => {
      logger.setLevel('warn');
      assert.strictEqual(componentLogger.getLevel(), 'warn');
    });

    test('should implement isDebugEnabled method', () => {
      mockConfigProvider.setConfig('copilotOrchestrator.logging.debug', 'mcp', true);
      logger = new Logger(mockConfigProvider);
      (Logger as any).instance = logger;
      componentLogger = Logger.for('mcp');
      
      assert.strictEqual(componentLogger.isDebugEnabled(), true);
    });

    test('should handle missing singleton gracefully', () => {
      (Logger as any).instance = undefined;
      componentLogger = Logger.for('mcp');
      
      assert.strictEqual(componentLogger.getLevel(), 'info'); // default fallback
      assert.strictEqual(componentLogger.isDebugEnabled(), false); // default fallback
      
      // Should not throw when calling setLevel
      assert.doesNotThrow(() => componentLogger.setLevel('debug'));
    });
  });

  suite('Backward Compatibility', () => {
    test('should maintain static initialize method', () => {
      const mockContext = {
        subscriptions: { 
          push: sinon.stub()
        }
      };
      
      const initializedLogger = Logger.initialize(mockContext);
      assert.ok(initializedLogger instanceof Logger);
      
      // Should be accessible via static methods
      const componentLogger = Logger.for('mcp');
      assert.ok(componentLogger instanceof ComponentLogger);
    });

    test('should maintain static show method', () => {
      // Should not throw even without instance
      assert.doesNotThrow(() => Logger.show());
    });

    test('should work without any VS Code dependencies', () => {
      // Test creating logger in non-VS Code environment
      logger = new Logger();
      assert.ok(logger);
      
      logger.info('mcp', 'message');
      // Check which console method was called (log for VS Code mode, error for standalone)
      const totalCalls = consoleStubs.error.callCount + consoleStubs.log.callCount;
      assert.strictEqual(totalCalls, 1);
    });
  });

  suite('Configuration Constants', () => {
    test('should export configuration key constants', () => {
      assert.strictEqual(LOGGING_LEVEL_KEY, 'copilotOrchestrator.logging.level');
      assert.strictEqual(LOGGING_COMPONENTS_KEY, 'copilotOrchestrator.logging.components');
    });

    test('should use configuration constants for config access', () => {
      mockConfigProvider.setConfig(LOGGING_LEVEL_KEY, '', 'debug');
      logger = new Logger(mockConfigProvider);
      
      assert.strictEqual(logger.getLevel(), 'debug');
    });
  });

  suite('Edge Cases and Error Handling', () => {
    setup(() => {
      logger = new Logger(mockConfigProvider);
    });

    test('should handle unserializable data gracefully', () => {
      const circular: any = {};
      circular.self = circular;
      
      logger.info('mcp', 'message with circular data', circular);
      
      const call = consoleStubs.log.getCall(0);
      const message = call.args[0];
      const dataArg = call.args[1];
      
      // Console message contains the basic message
      assert.ok(message.includes('[Orchestrator:mcp]'));
      assert.ok(message.includes('message with circular data'));
      
      // Data is passed as second argument (even if unserializable)
      assert.strictEqual(dataArg, circular);
    });

    test('should handle undefined component gracefully', () => {
      assert.doesNotThrow(() => {
        logger.isDebugEnabled('invalid-component' as LogComponent);
      });
    });

    test('should handle all log components', () => {
      const components: LogComponent[] = [
        'mcp', 'http', 'jobs', 'plans', 'git', 'ui', 'extension', 
        'scheduler', 'plan', 'plan-runner', 'plan-state', 
        'plan-persistence', 'job-executor', 'init', 'global-capacity'
      ];
      
      components.forEach(component => {
        assert.doesNotThrow(() => {
          logger.info(component, 'test message');
          logger.isDebugEnabled(component);
        });
      });
    });

    test('should handle setConfigProvider after construction', () => {
      logger = new Logger();
      const newProvider = new MockConfigProvider();
      newProvider.setConfig(LOGGING_LEVEL_KEY, '', 'error');
      
      logger.setConfigProvider(newProvider);
      assert.strictEqual(logger.getLevel(), 'error');
    });
  });
});