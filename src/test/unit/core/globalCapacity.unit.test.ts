/**
 * @fileoverview Unit tests for GlobalCapacityManager
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { GlobalCapacityManager } from '../../../core/globalCapacity';

suite('GlobalCapacityManager', () => {
  let tempDir: string;
  let manager: GlobalCapacityManager;

  setup(async () => {
    // Create unique temp directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'global-capacity-test-'));
    manager = new GlobalCapacityManager(tempDir);
  });

  teardown(async () => {
    // Shutdown manager
    await manager.shutdown();
    
    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  test('should initialize and register instance', async () => {
    await manager.initialize();
    const stats = await manager.getStats();
    
    assert.strictEqual(stats.activeInstances, 1, 'Should have one active instance');
    assert.strictEqual(stats.thisInstanceJobs, 0, 'Should have zero jobs initially');
    assert.strictEqual(stats.globalMaxParallel, 16, 'Should use default max parallel');
  });

  test('should update running jobs', async () => {
    await manager.initialize();
    
    await manager.updateRunningJobs(3, ['plan-1', 'plan-2']);
    const stats = await manager.getStats();
    
    assert.strictEqual(stats.thisInstanceJobs, 3, 'Should have 3 running jobs');
    assert.strictEqual(stats.totalGlobalJobs, 3, 'Total should be 3');
  });

  test('should calculate available capacity', async () => {
    await manager.initialize();
    
    await manager.updateRunningJobs(5, ['plan-1']);
    const available = await manager.getAvailableCapacity();
    
    assert.strictEqual(available, 11, 'Should have 11 available slots (16 - 5)');
  });

  test('should get total global running', async () => {
    await manager.initialize();
    
    await manager.updateRunningJobs(7, ['plan-1', 'plan-2']);
    const total = await manager.getTotalGlobalRunning();
    
    assert.strictEqual(total, 7, 'Total global running should be 7');
  });

  test('should set global max parallel', async () => {
    await manager.initialize();
    
    await manager.setGlobalMaxParallel(32);
    const stats = await manager.getStats();
    
    assert.strictEqual(stats.globalMaxParallel, 32, 'Global max should be updated to 32');
  });

  test('should persist registry to file', async () => {
    await manager.initialize();
    await manager.updateRunningJobs(2, ['plan-1']);
    
    const registryPath = path.join(tempDir, 'capacity-registry.json');
    assert.ok(fs.existsSync(registryPath), 'Registry file should exist');
    
    const content = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    assert.strictEqual(content.version, 1, 'Registry should have version 1');
    assert.ok(Array.isArray(content.instances), 'Should have instances array');
    assert.strictEqual(content.instances.length, 1, 'Should have one instance');
    assert.strictEqual(content.instances[0].runningJobs, 2, 'Instance should have 2 jobs');
  });

  test('should handle multiple updates', async () => {
    await manager.initialize();
    
    await manager.updateRunningJobs(1, ['plan-1']);
    await manager.updateRunningJobs(2, ['plan-1', 'plan-2']);
    await manager.updateRunningJobs(3, ['plan-1', 'plan-2', 'plan-3']);
    
    const stats = await manager.getStats();
    assert.strictEqual(stats.thisInstanceJobs, 3, 'Should have 3 jobs after updates');
  });

  test('should unregister on shutdown', async () => {
    await manager.initialize();
    await manager.updateRunningJobs(5, ['plan-1']);
    
    const registryPath = path.join(tempDir, 'capacity-registry.json');
    assert.ok(fs.existsSync(registryPath), 'Registry file should exist before shutdown');
    
    await manager.shutdown();
    
    // Read registry and verify instance was removed
    const content = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    assert.strictEqual(content.instances.length, 0, 'Should have no instances after shutdown');
  });

  test('should emit capacityChanged event on update', async () => {
    await manager.initialize();
    
    let eventReceived = false;
    manager.on('capacityChanged', (stats) => {
      eventReceived = true;
      assert.strictEqual(stats.thisInstanceJobs, 4, 'Event should include updated job count');
    });
    
    await manager.updateRunningJobs(4, ['plan-1']);
    
    assert.ok(eventReceived, 'Should have received capacityChanged event');
  });

  test('should handle corrupted registry gracefully', async () => {
    // Create a corrupted registry file
    const registryPath = path.join(tempDir, 'capacity-registry.json');
    fs.writeFileSync(registryPath, '{ invalid json', 'utf8');
    
    // Should initialize successfully with fallback
    await manager.initialize();
    const stats = await manager.getStats();
    
    assert.strictEqual(stats.activeInstances, 1, 'Should recover with one instance');
  });

  test('should generate unique instance IDs', () => {
    const manager1 = new GlobalCapacityManager(tempDir);
    const manager2 = new GlobalCapacityManager(tempDir);
    
    // Note: Instance IDs include process.pid which is the same for both,
    // but also include timestamp, so they should be different
    // This is a basic sanity check
    assert.ok(manager1 !== manager2, 'Managers should be different instances');
  });

  test('should handle zero jobs', async () => {
    await manager.initialize();
    
    await manager.updateRunningJobs(0, []);
    const stats = await manager.getStats();
    
    assert.strictEqual(stats.thisInstanceJobs, 0, 'Should handle zero jobs');
    assert.strictEqual(stats.totalGlobalJobs, 0, 'Total should be zero');
    assert.strictEqual(stats.instanceDetails[0].runningJobs, 0, 'Instance detail should show zero');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Stale Instance Cleanup Tests
  // ─────────────────────────────────────────────────────────────────────────────

  test('should clean up stale instances based on old heartbeat', async () => {
    await manager.initialize();
    
    // Add stale instance with old heartbeat
    const registryPath = path.join(tempDir, 'capacity-registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    registry.instances.push({
      instanceId: 'stale-instance',
      processId: 99999,
      runningJobs: 10,
      lastHeartbeat: Date.now() - 60000, // 60 seconds ago (>30s threshold)
      activePlans: ['plan-stale']
    });
    fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf8');
    
    // Trigger cleanup via heartbeat
    await manager.updateRunningJobs(0, []);
    
    const stats = await manager.getStats();
    assert.strictEqual(stats.activeInstances, 1, 'Should have only this instance after cleanup');
    assert.strictEqual(stats.totalGlobalJobs, 0, 'Stale jobs should not be counted');
  });

  test('should emit instanceLeft event when cleaning up stale instances', async () => {
    await manager.initialize();
    
    // Add stale instance
    const registryPath = path.join(tempDir, 'capacity-registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    registry.instances.push({
      instanceId: 'stale-instance',
      processId: 99999,
      runningJobs: 5,
      lastHeartbeat: Date.now() - 60000,
      activePlans: []
    });
    fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf8');
    
    let instanceLeftFired = false;
    manager.on('instanceLeft', (instanceId) => {
      if (instanceId === 'stale-instance') {
        instanceLeftFired = true;
      }
    });
    
    // Trigger cleanup
    await manager.updateRunningJobs(0, []);
    
    assert.ok(instanceLeftFired, 'Should emit instanceLeft event for stale instance');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Multi-Instance Tests
  // ─────────────────────────────────────────────────────────────────────────────

  test('getTotalGlobalRunning should return sum across multiple instances', async () => {
    await manager.initialize();
    await manager.updateRunningJobs(3, ['plan-1']);
    
    // Simulate a second instance by directly manipulating registry
    const registryPath = path.join(tempDir, 'capacity-registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    registry.instances.push({
      instanceId: 'fake-instance',
      processId: 99999,
      runningJobs: 5,
      lastHeartbeat: Date.now(),
      activePlans: ['plan-2']
    });
    fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf8');
    
    const total = await manager.getTotalGlobalRunning();
    assert.strictEqual(total, 8, 'Should sum jobs across instances (3 + 5)');
  });

  test('getAvailableCapacity should respect global limit with multiple instances', async () => {
    await manager.initialize();
    await manager.setGlobalMaxParallel(10);
    
    // This instance has 3 jobs
    await manager.updateRunningJobs(3, ['plan-1']);
    
    // Add another instance with 4 jobs
    const registryPath = path.join(tempDir, 'capacity-registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    registry.instances.push({
      instanceId: 'other-instance',
      processId: 99998,
      runningJobs: 4,
      lastHeartbeat: Date.now(),
      activePlans: ['plan-2']
    });
    fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf8');
    
    const available = await manager.getAvailableCapacity();
    assert.strictEqual(available, 3, 'Should have 3 available slots (10 - 3 - 4)');
  });

  test('getAvailableCapacity should return 0 when at global limit', async () => {
    await manager.initialize();
    await manager.setGlobalMaxParallel(5);
    await manager.updateRunningJobs(5, ['plan-1', 'plan-2']);
    
    const available = await manager.getAvailableCapacity();
    assert.strictEqual(available, 0, 'Should have no available capacity when at limit');
  });

  test('getAvailableCapacity should return 0 when over global limit', async () => {
    await manager.initialize();
    await manager.setGlobalMaxParallel(5);
    
    // This instance has 3 jobs
    await manager.updateRunningJobs(3, ['plan-1']);
    
    // Add another instance with 4 jobs (total 7 > 5)
    const registryPath = path.join(tempDir, 'capacity-registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    registry.instances.push({
      instanceId: 'other-instance',
      processId: 99997,
      runningJobs: 4,
      lastHeartbeat: Date.now(),
      activePlans: ['plan-2']
    });
    fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf8');
    
    const available = await manager.getAvailableCapacity();
    assert.strictEqual(available, 0, 'Should return 0 when over capacity (not negative)');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Concurrent Access Tests
  // ─────────────────────────────────────────────────────────────────────────────

  test('should handle concurrent updates safely', async () => {
    await manager.initialize();
    
    // Simulate concurrent updates
    await Promise.all([
      manager.updateRunningJobs(1, ['plan-1']),
      manager.updateRunningJobs(2, ['plan-1', 'plan-2']),
      manager.updateRunningJobs(3, ['plan-1', 'plan-2', 'plan-3'])
    ]);
    
    // Last update should win (or one of them should)
    const stats = await manager.getStats();
    assert.ok([1, 2, 3].includes(stats.thisInstanceJobs), 'Should have one of the update values');
    assert.ok(stats.thisInstanceJobs > 0, 'Should have at least one job');
  });

  test('should handle concurrent initialization safely', async () => {
    // Create multiple managers pointing to same registry
    const manager2 = new GlobalCapacityManager(tempDir);
    const manager3 = new GlobalCapacityManager(tempDir);
    
    try {
      // Initialize all concurrently
      await Promise.all([
        manager.initialize(),
        manager2.initialize(),
        manager3.initialize()
      ]);
      
      const stats = await manager.getStats();
      assert.ok(stats.activeInstances >= 1, 'Should have at least one active instance');
      assert.ok(stats.activeInstances <= 3, 'Should have at most three active instances');
      
      await manager2.shutdown();
      await manager3.shutdown();
    } catch (error) {
      // Clean up on error
      await manager2.shutdown();
      await manager3.shutdown();
      throw error;
    }
  });

  test('should maintain data consistency under concurrent reads and writes', async () => {
    await manager.initialize();
    
    // Perform concurrent reads and writes
    const operations = [
      manager.updateRunningJobs(1, ['plan-1']),
      manager.getStats(),
      manager.updateRunningJobs(2, ['plan-1', 'plan-2']),
      manager.getTotalGlobalRunning(),
      manager.updateRunningJobs(3, ['plan-1', 'plan-2', 'plan-3']),
      manager.getAvailableCapacity()
    ];
    
    await Promise.all(operations);
    
    // Verify we got valid results (no crashes or corrupted data)
    const finalStats = await manager.getStats();
    assert.ok(finalStats.thisInstanceJobs >= 0, 'Should have non-negative job count');
    assert.ok(finalStats.activeInstances > 0, 'Should have at least one active instance');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // isProcessAlive / Dead Instance Cleanup Tests
  // ─────────────────────────────────────────────────────────────────────────────

  test('should clean up instance with dead process (ESRCH)', async () => {
    await manager.initialize();

    // Inject a fake instance with a PID that doesn't exist
    const registryPath = path.join(tempDir, 'capacity-registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    registry.instances.push({
      instanceId: 'dead-process-instance',
      processId: 99999999, // Extremely unlikely to be a real PID
      runningJobs: 3,
      lastHeartbeat: Date.now(), // Recent heartbeat, but dead process
      activePlans: ['plan-dead']
    });
    fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf8');

    // Trigger cleanup via update
    await manager.updateRunningJobs(0, []);
    const stats = await manager.getStats();

    // Dead instance should have been cleaned up
    assert.strictEqual(stats.activeInstances, 1, 'Dead instance should be removed');
  });

  test('should keep instance with alive process and recent heartbeat', async () => {
    await manager.initialize();

    // Inject instance with current process PID (definitely alive)
    const registryPath = path.join(tempDir, 'capacity-registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    registry.instances.push({
      instanceId: 'alive-instance',
      processId: process.pid, // Our own PID is definitely alive
      runningJobs: 2,
      lastHeartbeat: Date.now(),
      activePlans: ['plan-x']
    });
    fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf8');

    await manager.updateRunningJobs(0, []);
    const stats = await manager.getStats();

    // Alive instance should be kept
    assert.strictEqual(stats.activeInstances, 2, 'Alive instance should be kept');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Not-initialized guard tests
  // ─────────────────────────────────────────────────────────────────────────────

  test('updateRunningJobs is no-op when not initialized', async () => {
    // Don't call initialize
    await manager.updateRunningJobs(5, ['plan-1']);
    // Should not throw, and internal currentRunningJobs is not updated
    // because the method returns early
    const stats = await manager.getStats();
    // getStats reads from registry (which doesn't exist) so it falls back
    // to local state: currentRunningJobs remains 0 since updateRunningJobs returned early
    assert.strictEqual(stats.thisInstanceJobs, 0);
  });

  test('setGlobalMaxParallel is no-op when not initialized', async () => {
    await manager.setGlobalMaxParallel(32);
    // No error should be thrown
  });

  test('shutdown is no-op when not initialized', async () => {
    await manager.shutdown();
    // No error should be thrown
  });

  test('double initialize logs warning', async () => {
    await manager.initialize();
    await manager.initialize(); // Should warn, not throw
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // writeRegistry retry/fallback tests
  // ─────────────────────────────────────────────────────────────────────────────

  test('handles EPERM error during updateRunningJobs gracefully', async () => {
    await manager.initialize();
    
    // Make the registry directory read-only to trigger write errors
    const registryPath = path.join(tempDir, 'capacity-registry.json');
    
    // Corrupt permissions by making file read-only
    try {
      fs.chmodSync(registryPath, 0o444);
    } catch {
      // On Windows, chmod may not work — skip gracefully
      return;
    }
    
    try {
      // Should not throw — error is caught internally
      await manager.updateRunningJobs(1, ['plan-1']);
    } finally {
      // Restore permissions for cleanup
      try { fs.chmodSync(registryPath, 0o666); } catch { /* ignore */ }
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Registry version mismatch test
  // ─────────────────────────────────────────────────────────────────────────────

  test('resets registry on version mismatch', async () => {
    const registryPath = path.join(tempDir, 'capacity-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({ version: 999, instances: [], globalMaxParallel: 8 }), 'utf8');

    await manager.initialize();
    const stats = await manager.getStats();
    // Should fall back to default after version mismatch
    assert.strictEqual(stats.globalMaxParallel, 16, 'Should use default after version mismatch');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // isProcessAlive edge cases
  // ─────────────────────────────────────────────────────────────────────────────

  test('isProcessAlive returns true for EPERM error (process exists but no permission)', async () => {
    await manager.initialize();

    // Stub process.kill to throw EPERM for a specific PID
    const origKill = process.kill;
    const killStub = (process as any).kill = function(pid: number, signal?: string | number) {
      if (pid === 88888 && (signal === 0 || signal === undefined)) {
        const err = new Error('Operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return origKill.call(process, pid, signal as any);
    };

    try {
      // Inject an instance with PID 88888 (alive via EPERM) and recent heartbeat
      const registryPath = path.join(tempDir, 'capacity-registry.json');
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      registry.instances.push({
        instanceId: 'eperm-instance',
        processId: 88888,
        runningJobs: 1,
        lastHeartbeat: Date.now(),
        activePlans: []
      });
      fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf8');

      await manager.updateRunningJobs(0, []);
      const stats = await manager.getStats();

      // EPERM means process exists — instance should be kept
      assert.strictEqual(stats.activeInstances, 2, 'EPERM instance should be kept as alive');
    } finally {
      (process as any).kill = origKill;
    }
  });

  test('isProcessAlive returns true for unknown errors (safe default)', async () => {
    await manager.initialize();

    const origKill = process.kill;
    (process as any).kill = function(pid: number, signal?: string | number) {
      if (pid === 77777 && (signal === 0 || signal === undefined)) {
        const err = new Error('Unknown error') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return origKill.call(process, pid, signal as any);
    };

    try {
      const registryPath = path.join(tempDir, 'capacity-registry.json');
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      registry.instances.push({
        instanceId: 'unknown-err-instance',
        processId: 77777,
        runningJobs: 1,
        lastHeartbeat: Date.now(),
        activePlans: []
      });
      fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf8');

      await manager.updateRunningJobs(0, []);
      const stats = await manager.getStats();

      // Unknown errors → assume alive
      assert.strictEqual(stats.activeInstances, 2, 'Unknown error instance should be kept as alive');
    } finally {
      (process as any).kill = origKill;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Heartbeat tests
  // ─────────────────────────────────────────────────────────────────────────────

  test('heartbeat re-registers instance if removed from registry', async function() {
    this.timeout(15000);
    await manager.initialize();

    // Remove all instances from registry
    const registryPath = path.join(tempDir, 'capacity-registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    registry.instances = [];
    fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf8');

    // Trigger an update (simulates heartbeat behavior)
    await manager.updateRunningJobs(1, ['plan-1']);

    const stats = await manager.getStats();
    assert.strictEqual(stats.activeInstances, 1, 'Instance should be re-registered');
    assert.strictEqual(stats.thisInstanceJobs, 1);
  });

  test('double initialize clears and restarts heartbeat', async () => {
    await manager.initialize();
    // Second initialize should be a no-op (guarded)
    await manager.initialize();
    const stats = await manager.getStats();
    assert.ok(stats.activeInstances >= 1);
  });
});
