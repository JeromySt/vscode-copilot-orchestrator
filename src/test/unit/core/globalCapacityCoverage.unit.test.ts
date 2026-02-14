/**
 * @fileoverview Unit tests for GlobalCapacityManager - coverage gaps (error paths)
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { GlobalCapacityManager } from '../../../core/globalCapacity';

let tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'global-capacity-coverage-test-'));
  tmpDirs.push(dir);
  return dir;
}

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

suite('GlobalCapacityManager Coverage - Error Paths', () => {
  let quiet: { restore: () => void };
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    quiet = silenceConsole();
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    quiet.restore();
    sandbox.restore();
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    tmpDirs = [];
  });

  test('isProcessAlive handles ESRCH error (process not found)', () => {
    const dir = makeTmpDir();
    const manager = new GlobalCapacityManager(dir);

    // Mock process.kill to throw ESRCH
    const killStub = sandbox.stub(process, 'kill');
    const error = new Error('Process not found') as any;
    error.code = 'ESRCH';
    killStub.throws(error);

    const result = (manager as any).isProcessAlive(12345);
    
    assert.strictEqual(result, false);
    assert.ok(killStub.calledWith(12345, 0));
  });

  test('isProcessAlive handles EPERM error (no permission, process exists)', () => {
    const dir = makeTmpDir();
    const manager = new GlobalCapacityManager(dir);

    // Mock process.kill to throw EPERM  
    const killStub = sandbox.stub(process, 'kill');
    const error = new Error('Permission denied') as any;
    error.code = 'EPERM';
    killStub.throws(error);

    const result = (manager as any).isProcessAlive(12345);
    
    assert.strictEqual(result, true);
    assert.ok(killStub.calledWith(12345, 0));
  });

  test('isProcessAlive handles other errors (assumes alive)', () => {
    const dir = makeTmpDir();
    const manager = new GlobalCapacityManager(dir);

    // Mock process.kill to throw unknown error
    const killStub = sandbox.stub(process, 'kill');
    const error = new Error('Unknown error') as any;
    error.code = 'EUNKNOWN';
    killStub.throws(error);

    const result = (manager as any).isProcessAlive(12345);
    
    assert.strictEqual(result, true);
    assert.ok(killStub.calledWith(12345, 0));
  });

  test('writeRegistry handles EPERM retry logic', async () => {
    const dir = makeTmpDir();
    const manager = new GlobalCapacityManager(dir);

    const testRegistry = {
      instances: [{
        instanceId: 'test-instance',
        pid: process.pid,
        runningJobs: 0,
        activePlans: 0,
        lastHeartbeat: Date.now()
      }],
      version: '1.0.0'
    };

    // Mock fs.promises.rename to fail with EPERM on first attempts, succeed on third
    let attemptCount = 0;
    const renameStub = sandbox.stub(fs.promises, 'rename');
    renameStub.callsFake(async () => {
      attemptCount++;
      if (attemptCount < 3) {
        const error = new Error('Permission denied') as any;
        error.code = 'EPERM';
        throw error;
      }
      // Success on third attempt
    });

    // Mock writeFile to succeed
    const writeFileStub = sandbox.stub(fs.promises, 'writeFile').resolves();
    
    // Should eventually succeed after retries
    await (manager as any).writeRegistry(testRegistry);
    
    assert.strictEqual(attemptCount, 3); // Failed twice, succeeded on third
    assert.strictEqual(renameStub.callCount, 3);
    assert.ok(writeFileStub.called); // writeFile called to create temp file
  });

  test('writeRegistry handles EBUSY retry logic', async () => {
    const dir = makeTmpDir();
    const manager = new GlobalCapacityManager(dir);

    const testRegistry = {
      instances: [{
        instanceId: 'test-instance', 
        pid: process.pid,
        runningJobs: 0,
        activePlans: 0,
        lastHeartbeat: Date.now()
      }],
      version: '1.0.0'
    };

    // Mock fs.promises.rename to fail with EBUSY on first two attempts
    let attemptCount = 0;
    const renameStub = sandbox.stub(fs.promises, 'rename');
    renameStub.callsFake(async () => {
      attemptCount++;
      if (attemptCount <= 2) {
        const error = new Error('Resource busy') as any;
        error.code = 'EBUSY';
        throw error;
      }
      // Success on third attempt
    });

    const writeFileStub = sandbox.stub(fs.promises, 'writeFile').resolves();
    
    await (manager as any).writeRegistry(testRegistry);
    
    assert.strictEqual(attemptCount, 3);
    assert.strictEqual(renameStub.callCount, 3);
  });

  test('writeRegistry falls back to direct write after retries exhausted', async () => {
    const dir = makeTmpDir();
    const manager = new GlobalCapacityManager(dir);

    const testRegistry = {
      instances: [{
        instanceId: 'test-instance',
        pid: process.pid,
        runningJobs: 0,
        activePlans: 0,
        lastHeartbeat: Date.now()
      }],
      version: '1.0.0'
    };

    // Mock fs.promises.rename to always fail with EPERM
    const renameStub = sandbox.stub(fs.promises, 'rename');
    const renameError = new Error('Permission denied') as any;
    renameError.code = 'EPERM';
    renameStub.rejects(renameError);

    // The initial writeFile for temp file, and final writeFile for direct write
    const writeFileStub = sandbox.stub(fs.promises, 'writeFile').resolves();

    await (manager as any).writeRegistry(testRegistry);
    
    // Should have tried 3 rename attempts and then fallen back to direct write
    assert.strictEqual(renameStub.callCount, 3);
    assert.ok(writeFileStub.called);
    // Should have been called at least twice - once for temp file, once for direct write fallback
    assert.ok(writeFileStub.callCount >= 2);
  });

  test('heartbeat failure is handled gracefully', async () => {
    const dir = makeTmpDir();
    const manager = new GlobalCapacityManager(dir);

    // Mock updateRegistry to fail
    sandbox.stub(manager as any, 'updateRegistry').rejects(new Error('Registry update failed'));

    // Should not throw when heartbeat fails
    await assert.doesNotReject(async () => {
      (manager as any).scheduleHeartbeat();
      
      // Wait a bit for the async heartbeat to attempt
      await new Promise(resolve => setTimeout(resolve, 50));
    });
  });

  test('unregisterInstance private method handles errors gracefully', async () => {
    const dir = makeTmpDir();
    const manager = new GlobalCapacityManager(dir);

    // Mock readRegistry to fail
    sandbox.stub(manager as any, 'readRegistry').rejects(new Error('Failed to read registry'));

    // Should not throw when unregisterInstance fails
    await assert.doesNotReject(async () => {
      await (manager as any).unregisterInstance();
    });
  });
});