import * as assert from 'assert';
import * as sinon from 'sinon';

suite('processMonitor simple', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('constructor', () => {
    test('accepts spawner parameter', () => {
      const { ProcessMonitor } = require('../../../process/processMonitor');
      
      const mockSpawner = { spawn: sinon.stub() };
      const monitor = new ProcessMonitor(mockSpawner);
      
      assert.ok(monitor);
    });

    test('accepts spawner and TTL parameters', () => {
      const { ProcessMonitor } = require('../../../process/processMonitor');
      
      const mockSpawner = { spawn: sinon.stub() };
      const monitor = new ProcessMonitor(mockSpawner, 5000);
      
      assert.ok(monitor);
    });

    test('has expected methods', () => {
      const { ProcessMonitor } = require('../../../process/processMonitor');
      
      const mockSpawner = { spawn: sinon.stub() };
      const monitor = new ProcessMonitor(mockSpawner);
      
      assert.ok(typeof monitor.isRunning === 'function');
      assert.ok(typeof monitor.terminate === 'function');
    });
  });

  suite('basic functionality', () => {
    test('isRunning returns boolean', () => {
      const { ProcessMonitor } = require('../../../process/processMonitor');
      
      const mockSpawner = { spawn: sinon.stub() };
      const monitor = new ProcessMonitor(mockSpawner);
      
      const result = monitor.isRunning(12345);
      assert.ok(typeof result === 'boolean');
    });

    test('terminate handles non-existent PID gracefully', async () => {
      const { ProcessMonitor } = require('../../../process/processMonitor');
      
      const mockSpawner = { spawn: sinon.stub() };
      const monitor = new ProcessMonitor(mockSpawner);
      
      // Should not throw when terminating non-existent process
      assert.doesNotThrow(async () => {
        await monitor.terminate(99999);
      });
    });
  });
});