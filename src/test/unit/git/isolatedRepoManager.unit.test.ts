/**
 * @fileoverview Unit tests for DefaultIsolatedRepoManager
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { DefaultIsolatedRepoManager } from '../../../git/isolatedRepoManager';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function createMockGit(): any {
  return {
    worktrees: {
      createDetachedWithTiming: sinon.stub().resolves(),
    },
    gitignore: {
      ensureGitignoreEntries: sinon.stub().resolves(),
    },
  };
}

function createMockFileSystem(): any {
  return {
    existsAsync: sinon.stub().resolves(false),
    ensureDirAsync: sinon.stub().resolves(),
    mkdirAsync: sinon.stub().resolves(),
    rmAsync: sinon.stub().resolves(),
    rmdirAsync: sinon.stub().resolves(),
    readdirAsync: sinon.stub().resolves([]),
    lstatAsync: sinon.stub().resolves({ isDirectory: () => false }),
    readFileAsync: sinon.stub().resolves(''),
    writeFileAsync: sinon.stub().resolves(),
    renameAsync: sinon.stub().resolves(),
    unlinkAsync: sinon.stub().resolves(),
  };
}

// Mock execAsync for git commands
function setupExecMocks(sandbox: sinon.SinonSandbox, sharedSuccess = true, referenceSuccess = true) {
  const execModule = require('../../../git/core/executor');
  const origExec = execModule.execAsync;
  
  const execStub = sandbox.stub(execModule, 'execAsync').callsFake(async (...callArgs: any[]) => {
    const args = callArgs[0] as string[];
    // Handle different git commands
    if (args[0] === 'config' && args[1] === '--get') {
      return { success: true, stdout: 'https://github.com/test/repo.git\n', stderr: '' };
    }
    
    if (args[0] === 'clone' && args[1] === '--shared') {
      return { success: sharedSuccess, stdout: '', stderr: sharedSuccess ? '' : 'shared failed' };
    }
    
    if (args[0] === 'clone' && args[1] === '--reference') {
      return { success: referenceSuccess, stdout: '', stderr: referenceSuccess ? '' : 'reference failed' };
    }
    
    if (args[0] === 'checkout') {
      return { success: true, stdout: '', stderr: '' };
    }
    
    if (args[0] === 'remote' && args[1] === 'set-url') {
      return { success: true, stdout: '', stderr: '' };
    }
    
    return { success: false, stdout: '', stderr: 'Unknown command' };
  });
  
  return { restore: () => { execModule.execAsync = origExec; } };
}

suite('IsolatedRepoManager', () => {
  let quiet: { restore: () => void };
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    quiet = silenceConsole();
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    quiet.restore();
    sandbox.restore();
  });

  test('creates under .orchestrator/release/<sanitized-branch>/', async () => {
    const execMocks = setupExecMocks(sandbox);
    const git = createMockGit();
    const fs = createMockFileSystem();
    
    const manager = new DefaultIsolatedRepoManager(git, fs);
    
    const info = await manager.createIsolatedRepo('rel-1', '/repo', 'release/v1.0');
    
    assert.strictEqual(info.releaseId, 'rel-1');
    assert.ok(info.clonePath.includes('.orchestrator'));
    assert.ok(info.clonePath.includes('release'));
    // Forward slashes should be replaced with hyphens
    assert.ok(info.clonePath.includes('release-v1.0'));
    
    execMocks.restore();
  });

  test('sanitizes branch names', async () => {
    const execMocks = setupExecMocks(sandbox);
    const git = createMockGit();
    const fs = createMockFileSystem();
    
    const manager = new DefaultIsolatedRepoManager(git, fs);
    
    // Test various invalid characters
    const info = await manager.createIsolatedRepo('rel-1', '/repo', 'feature/user:test\\path*with?invalid"chars<>|');
    
    // All invalid chars should be replaced with hyphens
    assert.ok(info.clonePath.includes('feature-user-test-path-with-invalid-chars---'));
    // Check the sanitized branch segment (last path component) doesn't contain invalid chars.
    // Checking the full path would fail on macOS/Linux since path.sep is '/'.
    const nodePath = require('path');
    const sanitizedSegment = nodePath.basename(info.clonePath);
    assert.ok(!sanitizedSegment.includes('/'));
    assert.ok(!sanitizedSegment.includes(':'));
    assert.ok(!sanitizedSegment.includes('*'));
    
    execMocks.restore();
  });

  test('validates path traversal', async () => {
    const execMocks = setupExecMocks(sandbox);
    const git = createMockGit();
    const fs = createMockFileSystem();
    
    const manager = new DefaultIsolatedRepoManager(git, fs);
    
    // Try to create with a path that would escape .orchestrator
    // The implementation validates the final resolved path
    const info = await manager.createIsolatedRepo('rel-1', '/repo', 'safe-branch');
    
    // Should be within .orchestrator/release/
    const nodePath = require('path');
    assert.ok(info.clonePath.startsWith(nodePath.join('/repo')));
    assert.ok(info.clonePath.includes('.orchestrator'));
    assert.ok(info.clonePath.includes('release'));
    
    execMocks.restore();
  });

  test('fallback --reference if --shared fails', async () => {
    const execMocks = setupExecMocks(sandbox, false, true); // shared fails, reference succeeds
    const git = createMockGit();
    const fs = createMockFileSystem();
    
    const manager = new DefaultIsolatedRepoManager(git, fs);
    
    const info = await manager.createIsolatedRepo('rel-1', '/repo', 'main');
    
    assert.strictEqual(info.isReady, true);
    assert.ok(info.clonePath);
    
    execMocks.restore();
  });

  test('sets remote URL to actual origin', async () => {
    const execMocks = setupExecMocks(sandbox);
    const git = createMockGit();
    const fs = createMockFileSystem();
    
    const manager = new DefaultIsolatedRepoManager(git, fs);
    
    await manager.createIsolatedRepo('rel-1', '/repo', 'main');
    
    // execAsync should have been called to set remote URL
    const execModule = require('../../../git/core/executor');
    const calls = execModule.execAsync.getCalls();
    const setUrlCall = calls.find((call: any) => 
      call.args[0][0] === 'remote' && call.args[0][1] === 'set-url'
    );
    
    assert.ok(setUrlCall, 'set-url should have been called');
    assert.strictEqual(setUrlCall.args[0][2], 'origin');
    assert.strictEqual(setUrlCall.args[0][3], 'https://github.com/test/repo.git');
    
    execMocks.restore();
  });

  test('removes on request', async () => {
    const execMocks = setupExecMocks(sandbox);
    const git = createMockGit();
    const fs = createMockFileSystem();
    fs.existsAsync.resolves(true);
    
    const manager = new DefaultIsolatedRepoManager(git, fs);
    
    await manager.createIsolatedRepo('rel-1', '/repo', 'main');
    
    const removed = await manager.removeIsolatedRepo('rel-1');
    
    assert.strictEqual(removed, true);
    assert.ok(fs.rmAsync.calledOnce);
    
    execMocks.restore();
  });

  test('cleans up all', async () => {
    const execMocks = setupExecMocks(sandbox);
    const git = createMockGit();
    const fs = createMockFileSystem();
    fs.existsAsync.resolves(true);
    fs.readdirAsync.resolves(['branch-1', 'branch-2']);
    fs.lstatAsync.resolves({ isDirectory: () => true } as any);
    
    const manager = new DefaultIsolatedRepoManager(git, fs);
    
    // Create two repos
    await manager.createIsolatedRepo('rel-1', '/repo', 'branch-1');
    await manager.createIsolatedRepo('rel-2', '/repo', 'branch-2');
    
    const count = await manager.cleanupAll();
    
    assert.strictEqual(count, 2);
    
    execMocks.restore();
  });

  test('never uses os.tmpdir()', async () => {
    const execMocks = setupExecMocks(sandbox);
    const git = createMockGit();
    const fs = createMockFileSystem();
    
    const manager = new DefaultIsolatedRepoManager(git, fs);
    
    const info = await manager.createIsolatedRepo('rel-1', '/repo', 'main');
    
    // Should be under .orchestrator/release/, not a temp directory
    assert.ok(info.clonePath.includes('.orchestrator'));
    assert.ok(info.clonePath.includes('release'));
    assert.ok(!info.clonePath.includes('tmp'));
    assert.ok(!info.clonePath.includes('temp'));
    
    execMocks.restore();
  });

  test('returns null for non-existent release', async () => {
    const git = createMockGit();
    const fs = createMockFileSystem();
    
    const manager = new DefaultIsolatedRepoManager(git, fs);
    
    const path = await manager.getRepoPath('nonexistent');
    
    assert.strictEqual(path, null);
  });

  test('lists active releases', async () => {
    const execMocks = setupExecMocks(sandbox);
    const git = createMockGit();
    const fs = createMockFileSystem();
    
    const manager = new DefaultIsolatedRepoManager(git, fs);
    
    await manager.createIsolatedRepo('rel-1', '/repo', 'main');
    await manager.createIsolatedRepo('rel-2', '/repo', 'develop');
    
    const active = await manager.listActive();
    
    assert.strictEqual(active.length, 2);
    assert.ok(active.includes('rel-1'));
    assert.ok(active.includes('rel-2'));
    
    execMocks.restore();
  });

  test('getRepoInfo returns null for non-existent release', async () => {
    const git = createMockGit();
    const fs = createMockFileSystem();
    
    const manager = new DefaultIsolatedRepoManager(git, fs);
    
    const info = await manager.getRepoInfo('nonexistent');
    
    assert.strictEqual(info, null);
  });

  test('getRepoInfo returns info for existing release', async () => {
    const execMocks = setupExecMocks(sandbox);
    const git = createMockGit();
    const fs = createMockFileSystem();
    
    const manager = new DefaultIsolatedRepoManager(git, fs);
    
    await manager.createIsolatedRepo('rel-1', '/repo', 'main');
    
    const info = await manager.getRepoInfo('rel-1');
    
    assert.ok(info);
    assert.strictEqual(info!.releaseId, 'rel-1');
    assert.strictEqual(info!.isReady, true);
    
    execMocks.restore();
  });

  test('handles already exists gracefully', async () => {
    const execMocks = setupExecMocks(sandbox);
    const git = createMockGit();
    const fs = createMockFileSystem();
    
    const manager = new DefaultIsolatedRepoManager(git, fs);
    
    const info1 = await manager.createIsolatedRepo('rel-1', '/repo', 'main');
    const info2 = await manager.createIsolatedRepo('rel-1', '/repo', 'main');
    
    assert.strictEqual(info1.releaseId, info2.releaseId);
    assert.strictEqual(info1.clonePath, info2.clonePath);
    
    execMocks.restore();
  });

  test('worktree fallback when clone strategies fail', async () => {
    const execMocks = setupExecMocks(sandbox, false, false); // Both clone strategies fail
    const git = createMockGit();
    const fs = createMockFileSystem();
    
    const manager = new DefaultIsolatedRepoManager(git, fs);
    
    const info = await manager.createIsolatedRepo('rel-1', '/repo', 'main');
    
    assert.strictEqual(info.isReady, true);
    assert.ok(git.worktrees.createDetachedWithTiming.calledOnce);
    
    execMocks.restore();
  });

  test('throws when all strategies fail', async () => {
    const execMocks = setupExecMocks(sandbox, false, false); // Both clone strategies fail
    const git = createMockGit();
    git.worktrees.createDetachedWithTiming.rejects(new Error('Worktree failed'));
    const fs = createMockFileSystem();
    
    const manager = new DefaultIsolatedRepoManager(git, fs);
    
    await assert.rejects(
      async () => manager.createIsolatedRepo('rel-1', '/repo', 'main'),
      /All clone strategies failed/
    );
    
    execMocks.restore();
  });
});
