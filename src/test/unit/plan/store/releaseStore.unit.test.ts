/**
 * @fileoverview Unit tests for FileSystemReleaseStore
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { FileSystemReleaseStore } from '../../../../plan/store/releaseStore';
import type { ReleaseDefinition, PRMonitorCycle } from '../../../../plan/types/release';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function createMockFileSystem(): any {
  return {
    existsAsync: sinon.stub().resolves(false),
    mkdirAsync: sinon.stub().resolves(),
    readFileAsync: sinon.stub().rejects({ code: 'ENOENT' }),
    writeFileAsync: sinon.stub().resolves(),
    renameAsync: sinon.stub().resolves(),
    unlinkAsync: sinon.stub().resolves(),
    rmAsync: sinon.stub().resolves(),
    readdirAsync: sinon.stub().resolves([]),
    realpathAsync: sinon.stub().callsFake((p: string) => Promise.resolve(p)),
  };
}

function createTestRelease(overrides?: Partial<ReleaseDefinition>): ReleaseDefinition {
  return {
    id: 'rel-1',
    name: 'Release v1.0',
    flowType: 'from-plans',
    planIds: ['plan-1', 'plan-2'],
    releaseBranch: 'release/v1.0',
    targetBranch: 'main',
    repoPath: '/repo',
    status: 'drafting',
    source: 'from-plans',
    stateHistory: [
      {
        from: 'drafting',
        to: 'drafting',
        timestamp: Date.now(),
        reason: 'Release created',
      },
    ],
    createdAt: Date.now(),
    ...overrides,
  };
}

suite('FileSystemReleaseStore', () => {
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

  test('saves under .orchestrator/release/<branch>/release.json', async () => {
    const fs = createMockFileSystem();
    const store = new FileSystemReleaseStore('/repo', fs);
    
    const release = createTestRelease();
    await store.saveRelease(release);
    
    assert.ok(fs.mkdirAsync.calledOnce);
    const mkdirPath = fs.mkdirAsync.firstCall.args[0];
    assert.ok(mkdirPath.includes('.orchestrator'));
    assert.ok(mkdirPath.includes('release'));
    
    assert.ok(fs.writeFileAsync.calledOnce);
    const writePath = fs.writeFileAsync.firstCall.args[0];
    assert.ok(writePath.includes('.release.json.tmp'));
    
    assert.ok(fs.renameAsync.calledOnce);
    const renameDest = fs.renameAsync.firstCall.args[1];
    assert.ok(renameDest.endsWith('release.json'));
  });

  test('loads release', async () => {
    const fs = createMockFileSystem();
    const release = createTestRelease();
    
    fs.existsAsync.resolves(true);
    fs.readdirAsync.resolves(['release-v1.0']);
    fs.readFileAsync.resolves(JSON.stringify(release));
    
    const store = new FileSystemReleaseStore('/repo', fs);
    
    const loaded = await store.loadRelease('rel-1');
    
    assert.ok(loaded);
    assert.strictEqual(loaded!.id, 'rel-1');
    assert.strictEqual(loaded!.name, 'Release v1.0');
  });

  test('loads all releases', async () => {
    const fs = createMockFileSystem();
    const release1 = createTestRelease({ id: 'rel-1', releaseBranch: 'release/v1.0' });
    const release2 = createTestRelease({ id: 'rel-2', releaseBranch: 'release/v2.0' });
    
    fs.existsAsync.resolves(true);
    fs.readdirAsync.resolves(['release-v1.0', 'release-v2.0']);
    fs.readFileAsync
      .onFirstCall().resolves(JSON.stringify(release1))
      .onSecondCall().resolves(JSON.stringify(release2));
    
    const store = new FileSystemReleaseStore('/repo', fs);
    
    const releases = await store.loadAllReleases();
    
    assert.strictEqual(releases.length, 2);
    assert.strictEqual(releases[0].id, 'rel-1');
    assert.strictEqual(releases[1].id, 'rel-2');
  });

  test('deletes directory', async () => {
    const fs = createMockFileSystem();
    const release = createTestRelease();
    
    fs.existsAsync.resolves(true);
    fs.readdirAsync.resolves(['release-v1.0']);
    fs.readFileAsync.resolves(JSON.stringify(release));
    
    const store = new FileSystemReleaseStore('/repo', fs);
    
    await store.deleteRelease('rel-1');
    
    assert.ok(fs.rmAsync.calledOnce);
    const rmPath = fs.rmAsync.firstCall.args[0];
    assert.ok(rmPath.includes('.orchestrator'));
    assert.ok(rmPath.includes('release'));
  });

  test('saves monitor cycles', async () => {
    const fs = createMockFileSystem();
    const release = createTestRelease();
    
    fs.existsAsync.resolves(true);
    fs.readdirAsync.resolves(['release-v1.0']);
    fs.readFileAsync.resolves(JSON.stringify(release));
    
    const store = new FileSystemReleaseStore('/repo', fs);
    
    const cycles: PRMonitorCycle[] = [
      {
        cycleNumber: 1,
        timestamp: Date.now(),
        checks: [],
        comments: [],
        securityAlerts: [],
        actions: [],
      },
    ];
    
    await store.saveMonitorCycles('rel-1', cycles);
    
    assert.ok(fs.writeFileAsync.calledOnce);
    const writePath = fs.writeFileAsync.firstCall.args[0];
    assert.ok(writePath.includes('monitor-cycles.json.tmp'));
    
    assert.ok(fs.renameAsync.calledOnce);
    const renameDest = fs.renameAsync.firstCall.args[1];
    assert.ok(renameDest.endsWith('monitor-cycles.json'));
  });

  test('loads monitor cycles', async () => {
    const fs = createMockFileSystem();
    const release = createTestRelease();
    
    const cycles: PRMonitorCycle[] = [
      {
        cycleNumber: 1,
        timestamp: Date.now(),
        checks: [],
        comments: [],
        securityAlerts: [],
        actions: [],
      },
    ];
    
    fs.existsAsync.resolves(true);
    fs.readdirAsync.resolves(['release-v1.0']);
    fs.readFileAsync
      .onFirstCall().resolves(JSON.stringify(release))
      .onSecondCall().resolves(JSON.stringify(cycles));
    
    const store = new FileSystemReleaseStore('/repo', fs);
    
    const loaded = await store.loadMonitorCycles('rel-1');
    
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].cycleNumber, 1);
  });

  test('handles missing files', async () => {
    const fs = createMockFileSystem();
    fs.existsAsync.resolves(false);
    
    const store = new FileSystemReleaseStore('/repo', fs);
    
    const loaded = await store.loadRelease('nonexistent');
    
    assert.strictEqual(loaded, undefined);
  });

  test('validates paths under .orchestrator/', async () => {
    const fs = createMockFileSystem();
    const store = new FileSystemReleaseStore('/repo', fs);
    
    // Normal branch should work
    const release = createTestRelease({ releaseBranch: 'release/v1.0' });
    await store.saveRelease(release);
    
    assert.ok(fs.mkdirAsync.calledOnce);
    const dirPath = fs.mkdirAsync.firstCall.args[0];
    const nodePath = require('path');
    assert.ok(dirPath.startsWith(nodePath.join('/repo')));
    assert.ok(dirPath.includes('.orchestrator'));
  });

  test('returns empty array when no releases exist', async () => {
    const fs = createMockFileSystem();
    fs.existsAsync.resolves(false);
    
    const store = new FileSystemReleaseStore('/repo', fs);
    
    const releases = await store.loadAllReleases();
    
    assert.strictEqual(releases.length, 0);
  });

  test('skips invalid release files', async () => {
    const fs = createMockFileSystem();
    const release = createTestRelease();
    
    fs.existsAsync.resolves(true);
    fs.readdirAsync.resolves(['release-v1.0', 'invalid-dir']);
    fs.readFileAsync
      .onFirstCall().resolves(JSON.stringify(release))
      .onSecondCall().rejects(new Error('Invalid JSON'));
    
    const store = new FileSystemReleaseStore('/repo', fs);
    
    const releases = await store.loadAllReleases();
    
    // Should only load the valid release, skip the invalid one
    assert.strictEqual(releases.length, 1);
    assert.strictEqual(releases[0].id, 'rel-1');
  });

  test('handles delete when release not found', async () => {
    const fs = createMockFileSystem();
    fs.existsAsync.resolves(false);
    
    const store = new FileSystemReleaseStore('/repo', fs);
    
    // Should not throw
    await store.deleteRelease('nonexistent');
    
    // Should not attempt to delete
    assert.ok(fs.rmAsync.notCalled);
  });

  test('returns empty cycles when release not found', async () => {
    const fs = createMockFileSystem();
    fs.existsAsync.resolves(false);
    
    const store = new FileSystemReleaseStore('/repo', fs);
    
    const cycles = await store.loadMonitorCycles('nonexistent');
    
    assert.strictEqual(cycles.length, 0);
  });

  test('returns empty cycles when file missing', async () => {
    const fs = createMockFileSystem();
    const release = createTestRelease();
    
    fs.existsAsync.resolves(true);
    fs.readdirAsync.resolves(['release-v1.0']);
    fs.readFileAsync
      .onFirstCall().resolves(JSON.stringify(release))
      .onSecondCall().rejects({ code: 'ENOENT' });
    
    const store = new FileSystemReleaseStore('/repo', fs);
    
    const cycles = await store.loadMonitorCycles('rel-1');
    
    assert.strictEqual(cycles.length, 0);
  });

  test('cleans up temp file on save error', async () => {
    const fs = createMockFileSystem();
    fs.renameAsync.rejects(new Error('Rename failed'));
    
    const store = new FileSystemReleaseStore('/repo', fs);
    
    const release = createTestRelease();
    
    await assert.rejects(
      async () => store.saveRelease(release),
      /Rename failed/
    );
    
    // Should attempt to clean up temp file
    assert.ok(fs.unlinkAsync.calledOnce);
  });

  test('cleans up temp file on monitor cycles save error', async () => {
    const fs = createMockFileSystem();
    const release = createTestRelease();
    
    fs.existsAsync.resolves(true);
    fs.readdirAsync.resolves(['release-v1.0']);
    fs.readFileAsync.resolves(JSON.stringify(release));
    fs.renameAsync.rejects(new Error('Rename failed'));
    
    const store = new FileSystemReleaseStore('/repo', fs);
    
    const cycles: PRMonitorCycle[] = [
      {
        cycleNumber: 1,
        timestamp: Date.now(),
        checks: [],
        comments: [],
        securityAlerts: [],
        actions: [],
      },
    ];
    
    await assert.rejects(
      async () => store.saveMonitorCycles('rel-1', cycles),
      /Rename failed/
    );
    
    // Should attempt to clean up temp file
    assert.ok(fs.unlinkAsync.calledOnce);
  });

  test('throws when monitor cycles save and release not found', async () => {
    const fs = createMockFileSystem();
    fs.existsAsync.resolves(false);
    const store = new FileSystemReleaseStore('/repo', fs);
    await assert.rejects(
      async () => store.saveMonitorCycles('nonexistent', []),
      /Release not found/
    );
  });

  test('deleteRelease does nothing when release not found', async () => {
    const fs = createMockFileSystem();
    fs.existsAsync.resolves(false);
    const store = new FileSystemReleaseStore('/repo', fs);
    await store.deleteRelease('nonexistent-id');
    assert.ok(fs.rmAsync.notCalled);
  });

  test('deleteRelease removes directory when found', async () => {
    const fs = createMockFileSystem();
    const release = createTestRelease();
    fs.existsAsync.resolves(true);
    fs.readdirAsync.resolves(['release-v1.0']);
    fs.readFileAsync.resolves(JSON.stringify(release));
    const store = new FileSystemReleaseStore('/repo', fs);
    await store.deleteRelease('rel-1');
    assert.ok(fs.rmAsync.calledOnce);
    assert.deepStrictEqual(fs.rmAsync.firstCall.args[1], { recursive: true, force: true });
  });

  test('deleteRelease propagates error from rmAsync', async () => {
    const fs = createMockFileSystem();
    const release = createTestRelease();
    fs.existsAsync.resolves(true);
    fs.readdirAsync.resolves(['release-v1.0']);
    fs.readFileAsync.resolves(JSON.stringify(release));
    fs.rmAsync.rejects(new Error('Permission denied'));
    const store = new FileSystemReleaseStore('/repo', fs);
    await assert.rejects(() => store.deleteRelease('rel-1'), /Permission denied/);
  });

  test('loadMonitorCycles throws on non-ENOENT error', async () => {
    const fs = createMockFileSystem();
    const release = createTestRelease();
    fs.existsAsync.resolves(true);
    fs.readdirAsync.resolves(['release-v1.0']);
    fs.readFileAsync
      .onFirstCall().resolves(JSON.stringify(release))
      .onSecondCall().rejects(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
    const store = new FileSystemReleaseStore('/repo', fs);
    await assert.rejects(() => store.loadMonitorCycles('rel-1'), /Permission denied/);
  });

  test('saveMonitorCycles unlinkAsync failure is swallowed', async () => {
    const fs = createMockFileSystem();
    const release = createTestRelease();
    fs.existsAsync.resolves(true);
    fs.readdirAsync.resolves(['release-v1.0']);
    fs.readFileAsync.resolves(JSON.stringify(release));
    fs.renameAsync.rejects(new Error('Rename failed'));
    fs.unlinkAsync.rejects(new Error('Cannot delete'));
    const store = new FileSystemReleaseStore('/repo', fs);
    await assert.rejects(() => store.saveMonitorCycles('rel-1', []), /Rename failed/);
  });

  test('loadAllReleases skips dot and .git entries', async () => {
    const fs = createMockFileSystem();
    const release = createTestRelease();
    fs.existsAsync.resolves(true);
    // Include . .. .git as well as a valid entry
    fs.readdirAsync.resolves(['.', '..', '.git', 'release-v1.0']);
    fs.readFileAsync.resolves(JSON.stringify(release));
    const store = new FileSystemReleaseStore('/repo', fs);
    const releases = await store.loadAllReleases();
    // Only the valid entry should be loaded
    assert.strictEqual(releases.length, 1);
    assert.strictEqual(releases[0].id, 'rel-1');
    // readFileAsync should only be called once (for the valid entry)
    assert.strictEqual(fs.readFileAsync.callCount, 1);
  });

  test('loadAllReleases skips entries with path traversal attempt', async () => {
    const fs = createMockFileSystem();
    fs.existsAsync.resolves(true);
    // A path-traversal attempt via readdirAsync result — validatePath should block it
    fs.readdirAsync.resolves(['../../etc']);
    const store = new FileSystemReleaseStore('/repo', fs);
    const releases = await store.loadAllReleases();
    // Path traversal entry is blocked and skipped
    assert.strictEqual(releases.length, 0);
  });

  test('loadRelease skips .git and dot entries in findReleaseDirectory', async () => {
    const fs = createMockFileSystem();
    const release = createTestRelease();
    fs.existsAsync.resolves(true);
    fs.readdirAsync.resolves(['.', '..', '.git', 'release-v1.0']);
    fs.readFileAsync.resolves(JSON.stringify(release));
    const store = new FileSystemReleaseStore('/repo', fs);
    const loaded = await store.loadRelease('rel-1');
    assert.ok(loaded);
    assert.strictEqual(loaded!.id, 'rel-1');
    // dot/.git entries skipped — only the valid entry should be attempted (per scan pass)
    // findReleaseDirectory reads once to find the id, loadRelease reads once more to get the data
    assert.ok(fs.readFileAsync.callCount <= 2);
  });
});
