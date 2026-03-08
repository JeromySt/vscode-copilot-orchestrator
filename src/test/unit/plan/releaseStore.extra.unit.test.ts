/**
 * @fileoverview Extra coverage tests for FileSystemReleaseStore error paths.
 *
 * Covers:
 * - loadAllReleases error when readdirAsync throws (lines 173-176)
 * - deleteRelease not-found path (line 185)
 * - deleteRelease error path (lines 192-194)
 * - saveMonitorCycles cleanup on write failure (lines 213-217)
 * - loadMonitorCycles non-ENOENT error path (lines 236-238)
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { FileSystemReleaseStore } from '../../../plan/store/releaseStore';
import type { ReleaseDefinition } from '../../../plan/types/release';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function createMockFS(): any {
  return {
    existsAsync: sinon.stub().resolves(false),
    ensureDirAsync: sinon.stub().resolves(),
    mkdirAsync: sinon.stub().resolves(),
    rmAsync: sinon.stub().resolves(),
    rmdirAsync: sinon.stub().resolves(),
    readdirAsync: sinon.stub().resolves([]),
    lstatAsync: sinon.stub().resolves({ isDirectory: () => true, isFile: () => false }),
    readFileAsync: sinon.stub().resolves('{}'),
    writeFileAsync: sinon.stub().resolves(),
    renameAsync: sinon.stub().resolves(),
    unlinkAsync: sinon.stub().resolves(),
    existsSync: sinon.stub().returns(false),
    copyFileAsync: sinon.stub().resolves(),
  };
}

function buildRelease(id: string): ReleaseDefinition {
  return {
    id,
    name: `Release ${id}`,
    flowType: 'from-branch',
    planIds: [],
    releaseBranch: `release/${id}`,
    targetBranch: 'main',
    status: 'drafting',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as any;
}

function buildReleaseJson(id: string): string {
  return JSON.stringify(buildRelease(id));
}

const REPO = '/repo';

suite('FileSystemReleaseStore – extra coverage', () => {
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

  suite('loadAllReleases', () => {
    test('throws when readdirAsync fails', async () => {
      const fs = createMockFS();
      fs.existsAsync.resolves(true);
      fs.readdirAsync.rejects(new Error('disk error'));

      const store = new FileSystemReleaseStore(REPO, fs);

      await assert.rejects(() => store.loadAllReleases(), /disk error/);
    });

    test('returns empty array when release root does not exist', async () => {
      const fs = createMockFS();
      fs.existsAsync.resolves(false);

      const store = new FileSystemReleaseStore(REPO, fs);
      const releases = await store.loadAllReleases();

      assert.deepStrictEqual(releases, []);
    });

    test('skips invalid JSON release files without throwing', async () => {
      const fs = createMockFS();
      fs.existsAsync.resolves(true);
      fs.readdirAsync.resolves(['branch-1', 'branch-2']);
      // First returns invalid JSON, second returns valid
      fs.readFileAsync
        .onFirstCall().resolves('not valid json {{{{')
        .onSecondCall().resolves(buildReleaseJson('release-2'));

      const store = new FileSystemReleaseStore(REPO, fs);
      const releases = await store.loadAllReleases();

      // Only the valid one should be returned
      assert.strictEqual(releases.length, 1);
      assert.strictEqual(releases[0].id, 'release-2');
    });
  });

  suite('deleteRelease', () => {
    test('returns without error when release not found', async () => {
      const fs = createMockFS();
      fs.existsAsync.resolves(false);

      const store = new FileSystemReleaseStore(REPO, fs);

      // Should not throw
      await store.deleteRelease('nonexistent-id');
      assert.ok(true);
    });

    test('throws when rmAsync fails on delete', async () => {
      const fs = createMockFS();
      // findReleaseDirectory scans .orchestrator/release
      fs.existsAsync.resolves(true);
      fs.readdirAsync.resolves(['release-branch']);
      // readFileAsync for the release.json inside that branch directory
      fs.readFileAsync.resolves(buildReleaseJson('release-1'));
      fs.rmAsync.rejects(new Error('permission denied'));

      const store = new FileSystemReleaseStore(REPO, fs);

      await assert.rejects(() => store.deleteRelease('release-1'), /permission denied/);
    });
  });

  suite('saveMonitorCycles', () => {
    test('throws and cleans up temp file on writeFileAsync failure', async () => {
      const fs = createMockFS();
      // findReleaseDirectory scans the release root
      fs.existsAsync.resolves(true);
      fs.readdirAsync.resolves(['release-branch']);
      fs.readFileAsync.resolves(buildReleaseJson('release-1'));
      // writeFileAsync fails
      fs.writeFileAsync.rejects(new Error('write error'));

      const store = new FileSystemReleaseStore(REPO, fs);

      await assert.rejects(() => store.saveMonitorCycles('release-1', []), /write error/);
      // unlinkAsync should have been called to clean up the temp file
      assert.ok(fs.unlinkAsync.called);
    });

    test('still throws original error even if unlinkAsync cleanup fails', async () => {
      const fs = createMockFS();
      fs.existsAsync.resolves(true);
      fs.readdirAsync.resolves(['release-branch']);
      fs.readFileAsync.resolves(buildReleaseJson('release-1'));
      fs.writeFileAsync.rejects(new Error('write error'));
      fs.unlinkAsync.rejects(new Error('unlink failed'));

      const store = new FileSystemReleaseStore(REPO, fs);

      await assert.rejects(() => store.saveMonitorCycles('release-1', []), /write error/);
    });

    test('throws when release is not found', async () => {
      const fs = createMockFS();
      fs.existsAsync.resolves(false);

      const store = new FileSystemReleaseStore(REPO, fs);

      await assert.rejects(() => store.saveMonitorCycles('nonexistent', []), /not found/);
    });
  });

  suite('loadMonitorCycles', () => {
    test('throws on non-ENOENT error when reading cycles file', async () => {
      const fs = createMockFS();
      fs.existsAsync.resolves(true);
      fs.readdirAsync.resolves(['release-branch']);
      // First call is for the release.json (inside findReleaseDirectory),
      // second call is for the cycles file
      fs.readFileAsync
        .onFirstCall().resolves(buildReleaseJson('release-1'))
        .onSecondCall().rejects(Object.assign(new Error('access denied'), { code: 'EACCES' }));

      const store = new FileSystemReleaseStore(REPO, fs);

      await assert.rejects(() => store.loadMonitorCycles('release-1'), /access denied/);
    });

    test('returns empty array when cycles file is not found (ENOENT)', async () => {
      const fs = createMockFS();
      fs.existsAsync.resolves(true);
      fs.readdirAsync.resolves(['release-branch']);
      fs.readFileAsync
        .onFirstCall().resolves(buildReleaseJson('release-1'))
        .onSecondCall().rejects(Object.assign(new Error('file not found'), { code: 'ENOENT' }));

      const store = new FileSystemReleaseStore(REPO, fs);
      const cycles = await store.loadMonitorCycles('release-1');

      assert.deepStrictEqual(cycles, []);
    });

    test('returns empty array when release is not found', async () => {
      const fs = createMockFS();
      fs.existsAsync.resolves(false);

      const store = new FileSystemReleaseStore(REPO, fs);
      const cycles = await store.loadMonitorCycles('nonexistent');

      assert.deepStrictEqual(cycles, []);
    });
  });

  suite('findReleaseDirectory – error paths (lines 100-108)', () => {
    test('skips branches whose release.json cannot be parsed (inner catch, line 100)', async () => {
      const fs = createMockFS();
      fs.existsAsync.resolves(true);
      fs.readdirAsync.resolves(['bad-branch', 'good-branch']);
      // First readFileAsync call: invalid JSON → inner catch → continue
      // Second readFileAsync call: valid JSON with matching id
      fs.readFileAsync
        .onFirstCall().rejects(new Error('read error'))
        .onSecondCall().resolves(buildReleaseJson('release-1'));

      const store = new FileSystemReleaseStore(REPO, fs);

      // deleteRelease calls findReleaseDirectory
      // Should find release-1 in good-branch and delete it
      await store.deleteRelease('release-1');
      assert.ok(fs.rmAsync.called, 'rmAsync should have been called after finding release in good-branch');
    });

    test('returns undefined when outer scan (readdirAsync) throws in findReleaseDirectory (lines 103-105)', async () => {
      const fs = createMockFS();
      fs.existsAsync.resolves(true);
      // readdirAsync throws inside findReleaseDirectory outer try → outer catch logs and returns undefined
      fs.readdirAsync.rejects(new Error('scan failed'));

      const store = new FileSystemReleaseStore(REPO, fs);

      // deleteRelease with not-found release should just return (no throw)
      await store.deleteRelease('any-release-id');
      assert.ok(fs.rmAsync.notCalled, 'rmAsync should not have been called (release not found)');
    });
  });

  suite('saveRelease – error paths (lines 120-128)', () => {
    test('throws and cleans up temp file when writeFileAsync fails', async () => {
      const fs = createMockFS();
      fs.mkdirAsync.resolves();
      fs.writeFileAsync.rejects(new Error('write failure'));

      const store = new FileSystemReleaseStore(REPO, fs);

      await assert.rejects(() => store.saveRelease(buildRelease('release-1')), /write failure/);
      assert.ok(fs.unlinkAsync.called, 'unlinkAsync should clean up temp file');
    });

    test('still throws write error even if unlinkAsync cleanup also fails (lines 125-126)', async () => {
      const fs = createMockFS();
      fs.mkdirAsync.resolves();
      fs.writeFileAsync.rejects(new Error('write failure'));
      fs.unlinkAsync.rejects(new Error('unlink failure'));

      const store = new FileSystemReleaseStore(REPO, fs);

      // The original write error should be rethrown, not the unlink error
      await assert.rejects(() => store.saveRelease(buildRelease('release-1')), /write failure/);
    });
  });

  suite('loadRelease – error paths (lines 142-147)', () => {
    test('returns undefined when readFileAsync throws ENOENT', async () => {
      const fs = createMockFS();
      fs.existsAsync.resolves(true);
      fs.readdirAsync.resolves(['release-branch']);
      // findReleaseDirectory reads the file → finds release-1
      // loadRelease then reads the file again → ENOENT
      fs.readFileAsync
        .onFirstCall().resolves(buildReleaseJson('release-1'))
        .onSecondCall().rejects(Object.assign(new Error('not found'), { code: 'ENOENT' }));

      const store = new FileSystemReleaseStore(REPO, fs);
      const result = await store.loadRelease('release-1');

      assert.strictEqual(result, undefined);
    });

    test('throws when readFileAsync throws non-ENOENT error in loadRelease (lines 145-147)', async () => {
      const fs = createMockFS();
      fs.existsAsync.resolves(true);
      fs.readdirAsync.resolves(['release-branch']);
      fs.readFileAsync
        .onFirstCall().resolves(buildReleaseJson('release-1'))
        .onSecondCall().rejects(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

      const store = new FileSystemReleaseStore(REPO, fs);

      await assert.rejects(() => store.loadRelease('release-1'), /permission denied/);
    });
  });
});
