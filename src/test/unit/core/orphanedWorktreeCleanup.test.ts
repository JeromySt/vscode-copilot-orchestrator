/**
 * @fileoverview Unit tests for orphaned worktree cleanup
 *
 * Tests cover:
 * - Detects orphaned directories not tracked by any plan
 * - Preserves worktrees tracked by active plans
 * - Handles mixed scenarios (orphaned + tracked)
 * - Gracefully handles missing .worktrees directory
 * - Reports errors but continues cleanup
 */

import * as assert from 'assert';
import { cleanupOrphanedWorktrees } from '../../../core/orphanedWorktreeCleanup';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as git from '../../../git';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AsyncFn = (...args: any[]) => Promise<any>;

/** Minimal stub that replaces a function on `obj` and restores it later. */
function stub<T extends Record<string, any>>(obj: T, method: keyof T, replacement: AsyncFn) {
  const original = obj[method];
  (obj as any)[method] = replacement;
  return { restore: () => { (obj as any)[method] = original; } };
}

/** Suppress Logger console output to avoid hanging test workers. */
function silenceConsole(): { restore: () => void } {
  const origLog = console.log;
  const origDebug = console.debug;
  const origWarn = console.warn;
  const origError = console.error;
  /* eslint-disable no-console */
  console.log = () => {};
  console.debug = () => {};
  console.warn = () => {};
  console.error = () => {};
  /* eslint-enable no-console */
  return {
    restore() {
      console.log = origLog;
      console.debug = origDebug;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

/**
 * Helper to initialize a directory as a git repository.
 */
async function execAsync(cmd: string, cwd: string): Promise<void> {
  const { spawn } = await import('child_process');
  return new Promise((resolve, reject) => {
    const [command, ...args] = cmd.split(' ');
    const proc = spawn(command, args, { cwd, shell: true });
    let stderr = '';
    proc.stderr?.on('data', (data) => { stderr += data; });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} failed: ${stderr}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('cleanupOrphanedWorktrees', () => {
  let tempDir: string;
  let worktreesDir: string;
  let quiet: { restore: () => void };
  let stubs: Array<{ restore: () => void }> = [];

  setup(async () => {
    quiet = silenceConsole();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'orphan-test-'));
    worktreesDir = path.join(tempDir, '.worktrees');
    await fs.promises.mkdir(worktreesDir, { recursive: true });
    
    // Initialize as git repo
    await execAsync('git init', tempDir);
    await execAsync('git config user.email "test@example.com"', tempDir);
    await execAsync('git config user.name "Test User"', tempDir);
  });

  teardown(async () => {
    quiet.restore();
    stubs.forEach(s => s.restore());
    stubs = [];
    if (tempDir && fs.existsSync(tempDir)) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // Basic orphan detection
  // =========================================================================

  test('detects orphaned worktree not tracked by any plan', async () => {
    // Create orphaned directory
    const orphanPath = path.join(worktreesDir, 'orphaned-uuid');
    await fs.promises.mkdir(orphanPath);
    await fs.promises.writeFile(path.join(orphanPath, 'test.txt'), 'test');
    
    // Stub git.worktrees.list to return empty (no git-registered worktrees)
    stubs.push(stub(git.worktrees, 'list', async () => []));
    
    // Stub git.worktrees.removeSafe to succeed but not actually remove
    stubs.push(stub(git.worktrees, 'removeSafe', async () => {}));
    
    const result = await cleanupOrphanedWorktrees({
      repoPaths: [tempDir],
      activePlans: new Map(),
      logger: () => {}
    });
    
    assert.strictEqual(result.orphanedFound, 1);
    assert.strictEqual(result.orphanedCleaned, 1);
    assert.ok(!fs.existsSync(orphanPath));
  });

  // =========================================================================
  // Preserving tracked worktrees
  // =========================================================================

  test('preserves worktrees tracked by active plans', async () => {
    // Create directory that's "tracked" by a plan
    const trackedPath = path.join(worktreesDir, 'tracked-uuid');
    await fs.promises.mkdir(trackedPath);
    
    // Create mock plan with this worktree
    const mockPlan = {
      id: 'plan-1',
      nodeStates: new Map([
        ['node-1', { worktreePath: trackedPath, worktreeCleanedUp: false }]
      ])
    } as any;
    
    // Stub git.worktrees.list to return empty
    stubs.push(stub(git.worktrees, 'list', async () => []));
    
    const result = await cleanupOrphanedWorktrees({
      repoPaths: [tempDir],
      activePlans: new Map([['plan-1', mockPlan]]),
      logger: () => {}
    });
    
    assert.strictEqual(result.orphanedFound, 0);
    assert.ok(fs.existsSync(trackedPath)); // Still exists
  });

  // =========================================================================
  // Mixed scenarios
  // =========================================================================

  test('cleans orphaned but preserves tracked', async () => {
    const orphanPath = path.join(worktreesDir, 'orphan-uuid');
    const trackedPath = path.join(worktreesDir, 'tracked-uuid');
    
    await fs.promises.mkdir(orphanPath);
    await fs.promises.mkdir(trackedPath);
    
    const mockPlan = {
      id: 'plan-1',
      nodeStates: new Map([
        ['node-1', { worktreePath: trackedPath, worktreeCleanedUp: false }]
      ])
    } as any;
    
    // Stub git.worktrees.list to return empty
    stubs.push(stub(git.worktrees, 'list', async () => []));
    
    // Stub git.worktrees.removeSafe to succeed
    stubs.push(stub(git.worktrees, 'removeSafe', async () => {}));
    
    const result = await cleanupOrphanedWorktrees({
      repoPaths: [tempDir],
      activePlans: new Map([['plan-1', mockPlan]]),
      logger: () => {}
    });
    
    assert.strictEqual(result.orphanedFound, 1);
    assert.strictEqual(result.orphanedCleaned, 1);
    assert.ok(!fs.existsSync(orphanPath)); // Cleaned
    assert.ok(fs.existsSync(trackedPath)); // Preserved
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  test('handles missing .worktrees directory gracefully', async () => {
    // Delete .worktrees dir
    await fs.promises.rm(worktreesDir, { recursive: true });
    
    const result = await cleanupOrphanedWorktrees({
      repoPaths: [tempDir],
      activePlans: new Map(),
      logger: () => {}
    });
    
    // Should not error, just skip
    assert.strictEqual(result.scannedRepos, 0);
    assert.strictEqual(result.errors.length, 0);
  });

  test('reports errors but continues cleanup', async () => {
    const orphan1 = path.join(worktreesDir, 'orphan-1');
    const orphan2 = path.join(worktreesDir, 'orphan-2');
    
    await fs.promises.mkdir(orphan1);
    await fs.promises.mkdir(orphan2);
    
    // Stub git.worktrees.list to return empty
    stubs.push(stub(git.worktrees, 'list', async () => []));
    
    // Stub git.worktrees.removeSafe to fail on first call, succeed on second
    let callCount = 0;
    stubs.push(stub(git.worktrees, 'removeSafe', async (repoPath: string, worktreePath: string) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Simulated removal failure');
      }
    }));
    
    const result = await cleanupOrphanedWorktrees({
      repoPaths: [tempDir],
      activePlans: new Map(),
      logger: () => {}
    });
    
    // Should still clean what it can
    assert.ok(result.orphanedFound >= 1);
    // One should fail, one should succeed
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0].includes('Failed to clean'));
  });

  // =========================================================================
  // Git-registered worktrees
  // =========================================================================

  test('does not clean git-registered worktrees', async () => {
    const registeredPath = path.join(worktreesDir, 'registered-uuid');
    await fs.promises.mkdir(registeredPath);
    
    // Stub git.worktrees.list to return this worktree as registered
    stubs.push(stub(git.worktrees, 'list', async () => [
      { path: registeredPath, branch: 'feature-branch', head: 'abc123', detached: false, locked: false, prunable: false }
    ]));
    
    const result = await cleanupOrphanedWorktrees({
      repoPaths: [tempDir],
      activePlans: new Map(),
      logger: () => {}
    });
    
    assert.strictEqual(result.orphanedFound, 0);
    assert.ok(fs.existsSync(registeredPath)); // Still exists
  });

  // =========================================================================
  // Case sensitivity
  // =========================================================================

  test('handles case-insensitive path matching on Windows', async () => {
    const trackedPath = path.join(worktreesDir, 'TrackedPath');
    await fs.promises.mkdir(trackedPath);
    
    // Create mock plan with lowercase path
    const mockPlan = {
      id: 'plan-1',
      nodeStates: new Map([
        ['node-1', { worktreePath: trackedPath.toLowerCase(), worktreeCleanedUp: false }]
      ])
    } as any;
    
    // Stub git.worktrees.list to return empty
    stubs.push(stub(git.worktrees, 'list', async () => []));
    
    const result = await cleanupOrphanedWorktrees({
      repoPaths: [tempDir],
      activePlans: new Map([['plan-1', mockPlan]]),
      logger: () => {}
    });
    
    // Should recognize the path as tracked despite case difference
    assert.strictEqual(result.orphanedFound, 0);
    assert.ok(fs.existsSync(trackedPath));
  });

  // =========================================================================
  // Worktree already cleaned up
  // =========================================================================

  test('ignores worktrees marked as already cleaned up', async () => {
    const cleanedPath = path.join(worktreesDir, 'cleaned-uuid');
    await fs.promises.mkdir(cleanedPath);
    
    // Create mock plan with worktreeCleanedUp = true
    const mockPlan = {
      id: 'plan-1',
      nodeStates: new Map([
        ['node-1', { worktreePath: cleanedPath, worktreeCleanedUp: true }]
      ])
    } as any;
    
    // Stub git.worktrees.list to return empty
    stubs.push(stub(git.worktrees, 'list', async () => []));
    
    // Stub git.worktrees.removeSafe
    stubs.push(stub(git.worktrees, 'removeSafe', async () => {}));
    
    const result = await cleanupOrphanedWorktrees({
      repoPaths: [tempDir],
      activePlans: new Map([['plan-1', mockPlan]]),
      logger: () => {}
    });
    
    // Should clean because worktreeCleanedUp = true means it's not tracked
    assert.strictEqual(result.orphanedFound, 1);
    assert.strictEqual(result.orphanedCleaned, 1);
  });

  // =========================================================================
  // Multiple repositories
  // =========================================================================

  test('scans multiple repositories', async () => {
    // Create second temp dir
    const tempDir2 = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'orphan-test2-'));
    const worktreesDir2 = path.join(tempDir2, '.worktrees');
    await fs.promises.mkdir(worktreesDir2, { recursive: true });
    await execAsync('git init', tempDir2);
    
    // Create orphaned worktrees in both
    const orphan1 = path.join(worktreesDir, 'orphan-1');
    const orphan2 = path.join(worktreesDir2, 'orphan-2');
    await fs.promises.mkdir(orphan1);
    await fs.promises.mkdir(orphan2);
    
    // Stub git.worktrees.list to return empty
    stubs.push(stub(git.worktrees, 'list', async () => []));
    
    // Stub git.worktrees.removeSafe
    stubs.push(stub(git.worktrees, 'removeSafe', async () => {}));
    
    try {
      const result = await cleanupOrphanedWorktrees({
        repoPaths: [tempDir, tempDir2],
        activePlans: new Map(),
        logger: () => {}
      });
      
      assert.strictEqual(result.scannedRepos, 2);
      assert.strictEqual(result.orphanedFound, 2);
      assert.strictEqual(result.orphanedCleaned, 2);
    } finally {
      // Cleanup second temp dir
      await fs.promises.rm(tempDir2, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // Empty .worktrees directory cleanup
  // =========================================================================

  test('removes empty .worktrees directory after cleanup', async () => {
    const orphanPath = path.join(worktreesDir, 'orphaned-uuid');
    await fs.promises.mkdir(orphanPath);
    
    // Stub git.worktrees.list to return empty
    stubs.push(stub(git.worktrees, 'list', async () => []));
    
    // Stub git.worktrees.removeSafe
    stubs.push(stub(git.worktrees, 'removeSafe', async () => {}));
    
    const result = await cleanupOrphanedWorktrees({
      repoPaths: [tempDir],
      activePlans: new Map(),
      logger: () => {}
    });
    
    assert.strictEqual(result.orphanedCleaned, 1);
    // .worktrees directory should be removed since it's empty
    assert.ok(!fs.existsSync(worktreesDir));
  });

  test('does not remove .worktrees directory if it still has content', async () => {
    const orphanPath = path.join(worktreesDir, 'orphaned-uuid');
    const trackedPath = path.join(worktreesDir, 'tracked-uuid');
    await fs.promises.mkdir(orphanPath);
    await fs.promises.mkdir(trackedPath);
    
    const mockPlan = {
      id: 'plan-1',
      nodeStates: new Map([
        ['node-1', { worktreePath: trackedPath, worktreeCleanedUp: false }]
      ])
    } as any;
    
    // Stub git.worktrees.list to return empty
    stubs.push(stub(git.worktrees, 'list', async () => []));
    
    // Stub git.worktrees.removeSafe
    stubs.push(stub(git.worktrees, 'removeSafe', async () => {}));
    
    const result = await cleanupOrphanedWorktrees({
      repoPaths: [tempDir],
      activePlans: new Map([['plan-1', mockPlan]]),
      logger: () => {}
    });
    
    assert.strictEqual(result.orphanedCleaned, 1);
    // .worktrees directory should still exist because trackedPath is still there
    assert.ok(fs.existsSync(worktreesDir));
    assert.ok(fs.existsSync(trackedPath));
  });
});
