/**
 * @fileoverview Unit tests for ReleaseConfigManager
 *
 * Tests configuration reading and default value handling for release management settings.
 *
 * @module test/unit/plan/releaseConfigManager.unit.test
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { ReleaseConfigManager } from '../../../plan/releaseConfigManager';
import type { IConfigProvider } from '../../../interfaces/IConfigProvider';

suite('ReleaseConfigManager', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('getConfig', () => {
    test('should return defaults when no config provider', () => {
      const manager = new ReleaseConfigManager(undefined);
      const config = manager.getConfig();

      assert.strictEqual(config.pollIntervalMs, 120000, 'pollIntervalMs should be 120 seconds * 1000');
      assert.strictEqual(config.maxMonitoringMs, 2400000, 'maxMonitoringMs should be 40 minutes * 60000');
      assert.strictEqual(config.resetTimerOnPush, true);
      assert.strictEqual(config.createPRAsDraft, false);
      assert.strictEqual(config.autoAddressComments, true);
      assert.strictEqual(config.autoFixCI, true);
      assert.strictEqual(config.autoResolveSecurityAlerts, true);
      assert.strictEqual(config.mergeStrategy, 'merge');
      assert.strictEqual(config.isolatedCloneStrategy, 'shared');
      assert.strictEqual(config.cleanupOnComplete, true);
    });

    test('should read all settings from config provider', () => {
      const mockProvider: any = {
        getConfig: sandbox.stub().callsFake((section: string, key: string, defaultValue: any) => {
          const values: Record<string, any> = {
            pollIntervalSeconds: 60,
            maxMonitoringMinutes: 20,
            resetTimerOnPush: false,
            createPRAsDraft: true,
            autoAddressComments: false,
            autoFixCI: false,
            autoResolveSecurityAlerts: false,
            mergeStrategy: 'squash',
            isolatedCloneStrategy: 'reference',
            cleanupOnComplete: false,
          };
          return values[key] ?? defaultValue;
        }),
      };

      const manager = new ReleaseConfigManager(mockProvider);
      const config = manager.getConfig();

      assert.strictEqual(config.pollIntervalMs, 60000, 'should convert 60 seconds to milliseconds');
      assert.strictEqual(config.maxMonitoringMs, 1200000, 'should convert 20 minutes to milliseconds');
      assert.strictEqual(config.resetTimerOnPush, false);
      assert.strictEqual(config.createPRAsDraft, true);
      assert.strictEqual(config.autoAddressComments, false);
      assert.strictEqual(config.autoFixCI, false);
      assert.strictEqual(config.autoResolveSecurityAlerts, false);
      assert.strictEqual(config.mergeStrategy, 'squash');
      assert.strictEqual(config.isolatedCloneStrategy, 'reference');
      assert.strictEqual(config.cleanupOnComplete, false);
    });

    test('should request correct config section and keys', () => {
      const mockProvider: any = {
        getConfig: sandbox.stub().returns('default'),
      };

      const manager = new ReleaseConfigManager(mockProvider);
      manager.getConfig();

      // Verify the config provider was called with the correct section
      const calls = mockProvider.getConfig.getCalls();
      calls.forEach((call: any) => {
        assert.strictEqual(
          call.args[0],
          'copilotOrchestrator.releaseManagement',
          'should use correct config section'
        );
      });

      // Verify all expected keys were requested
      const requestedKeys = calls.map((call: any) => call.args[1]);
      assert.ok(requestedKeys.includes('pollIntervalSeconds'));
      assert.ok(requestedKeys.includes('maxMonitoringMinutes'));
      assert.ok(requestedKeys.includes('resetTimerOnPush'));
      assert.ok(requestedKeys.includes('createPRAsDraft'));
      assert.ok(requestedKeys.includes('autoAddressComments'));
      assert.ok(requestedKeys.includes('autoFixCI'));
      assert.ok(requestedKeys.includes('autoResolveSecurityAlerts'));
      assert.ok(requestedKeys.includes('mergeStrategy'));
      assert.ok(requestedKeys.includes('isolatedCloneStrategy'));
      assert.ok(requestedKeys.includes('cleanupOnComplete'));
    });

    test('should handle boundary values correctly', () => {
      const mockProvider: any = {
        getConfig: sandbox.stub().callsFake((section: string, key: string, defaultValue: any) => {
          if (key === 'pollIntervalSeconds') return 30; // minimum
          if (key === 'maxMonitoringMinutes') return 180; // maximum
          return defaultValue;
        }),
      };

      const manager = new ReleaseConfigManager(mockProvider);
      const config = manager.getConfig();

      assert.strictEqual(config.pollIntervalMs, 30000, 'minimum 30 seconds');
      assert.strictEqual(config.maxMonitoringMs, 10800000, 'maximum 180 minutes');
    });

    test('should support all merge strategies', () => {
      const strategies: Array<'merge' | 'squash' | 'rebase'> = ['merge', 'squash', 'rebase'];

      strategies.forEach((strategy) => {
        const mockProvider: any = {
          getConfig: sandbox.stub().callsFake((section: string, key: string, defaultValue: any) => {
            return key === 'mergeStrategy' ? strategy : defaultValue;
          }),
        };

        const manager = new ReleaseConfigManager(mockProvider);
        const config = manager.getConfig();

        assert.strictEqual(config.mergeStrategy, strategy);
      });
    });

    test('should support all clone strategies', () => {
      const strategies: Array<'shared' | 'reference' | 'full'> = ['shared', 'reference', 'full'];

      strategies.forEach((strategy) => {
        const mockProvider: any = {
          getConfig: sandbox.stub().callsFake((section: string, key: string, defaultValue: any) => {
            return key === 'isolatedCloneStrategy' ? strategy : defaultValue;
          }),
        };

        const manager = new ReleaseConfigManager(mockProvider);
        const config = manager.getConfig();

        assert.strictEqual(config.isolatedCloneStrategy, strategy);
      });
    });
  });
});
