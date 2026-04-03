/**
 * @fileoverview Extra unit tests for FileSystemPlanStore covering:
 * - Lines 316-317: ensureNodeSpecDir when currentLink is already a symlink
 * - Line 323: ensureNodeSpecDir when existing dir is a real directory
 * - Lines 268-282: migrateLegacy with attemptHistory
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as path from 'path';
import { FileSystemPlanStore } from '../../../plan/store/FileSystemPlanStore';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function makeMockFs(overrides?: Record<string, any>): any {
  return {
    readFileAsync: sinon.stub().resolves('{}'),
    writeFileAsync: sinon.stub().resolves(),
    renameAsync: sinon.stub().resolves(),
    mkdirAsync: sinon.stub().resolves(),
    unlinkAsync: sinon.stub().resolves(),
    rmAsync: sinon.stub().resolves(),
    rmdirAsync: sinon.stub().resolves(),
    readdirAsync: sinon.stub().resolves([]),
    existsAsync: sinon.stub().resolves(false),
    existsSync: sinon.stub().returns(false),
    lstatAsync: sinon.stub().resolves({ isSymbolicLink: () => false, isDirectory: () => false }),
    symlinkAsync: sinon.stub().resolves(),
    accessAsync: sinon.stub().rejects(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    readlinkAsync: sinon.stub().resolves('target'),
    copyFileAsync: sinon.stub().resolves(),
    readFileSync: sinon.stub().returns('{}'),
    writeFileSync: sinon.stub(),
    mkdirSync: sinon.stub(),
    renameSync: sinon.stub(),
    unlinkSync: sinon.stub(),
    readJSON: sinon.stub().returns({ plans: {} }),
    writeJSON: sinon.stub(),
    ...overrides,
  };
}

function makeStore(mockFs?: any): FileSystemPlanStore {
  return new FileSystemPlanStore('/storage', '/workspace', mockFs || makeMockFs());
}

suite('FileSystemPlanStore - extra coverage', () => {
  let sandbox: sinon.SinonSandbox;
  let silence: ReturnType<typeof silenceConsole>;

  setup(() => {
    sandbox = sinon.createSandbox();
    silence = silenceConsole();
  });

  teardown(() => {
    sandbox.restore();
    silence.restore();
  });

  suite('ensureNodeSpecDir - symlink detection (lines 316-317)', () => {
    test('returns early when currentLink is already a symlink', async () => {
      const mockFs = makeMockFs({
        lstatAsync: sinon.stub().resolves({
          isSymbolicLink: () => true,
          isDirectory: () => false,
        }),
        writeFileAsync: sinon.stub().resolves(),
      });
      const store = makeStore(mockFs);

      // writeNodeSpec calls ensureNodeSpecDir internally
      await store.writeNodeSpec('plan-1', 'node-1', 'work', { type: 'shell', command: 'echo test' });

      // symlinkAsync should NOT be called since the current dir is already a symlink
      assert.ok(mockFs.symlinkAsync.notCalled, 'symlinkAsync should not be called for existing symlink');
      // writeFileAsync SHOULD be called for the spec
      assert.ok(mockFs.writeFileAsync.called, 'writeFileAsync should be called for the spec content');
    });

    test('continues to create structure when lstatAsync throws ENOENT', async () => {
      let lstatCallCount = 0;
      const mockFs = makeMockFs({
        lstatAsync: sinon.stub().callsFake(() => {
          lstatCallCount++;
          // First call (in ensureNodeSpecDir) - throw ENOENT
          // Second call (to check if it's a directory) - throw (expected, so catch runs)
          const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return Promise.reject(err);
        }),
        writeFileAsync: sinon.stub().resolves(),
      });
      const store = makeStore(mockFs);

      await store.writeNodeSpec('plan-2', 'node-2', 'work', { type: 'shell', command: 'echo test' });

      // symlinkAsync should be called to create the current link
      assert.ok(mockFs.symlinkAsync.calledOnce, 'symlinkAsync should be called to create new link');
      assert.ok(mockFs.mkdirAsync.calledOnce, 'mkdirAsync should be called to create attempt dir');
    });

    test('ensureNodeSpecDir migrates existing directory to attempt structure (line 323)', async () => {
      let lstatCallCount = 0;
      const mockFs = makeMockFs({
        lstatAsync: sinon.stub().callsFake((_path: string) => {
          lstatCallCount++;
          if (lstatCallCount === 1) {
            // First call - the currentLink doesn't look like a symlink (non-symlink dir)
            // isSymbolicLink=false, isDirectory=false → fall through to catch, create structure
            return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
          } else {
            // Second call (inside try/catch block) - return isDirectory=true
            return Promise.resolve({
              isSymbolicLink: () => false,
              isDirectory: () => true,
            });
          }
        }),
        readdirAsync: sinon.stub().resolves(['work.json', 'prechecks.json']),
        writeFileAsync: sinon.stub().resolves(),
      });
      const store = makeStore(mockFs);

      await store.writeNodeSpec('plan-3', 'node-3', 'work', { type: 'shell', command: 'echo test' });

      // Should have tried to read directory contents and move them
      assert.ok(mockFs.readdirAsync.called, 'readdirAsync should be called to list existing files');
      // renameAsync called to move existing files to attempt dir
      assert.ok(mockFs.renameAsync.called, 'renameAsync should be called to move files');
      // rmdirAsync called to remove old directory  
      assert.ok(mockFs.rmdirAsync.called, 'rmdirAsync should be called to remove old dir');
      // symlinkAsync called to create new link
      assert.ok(mockFs.symlinkAsync.called, 'symlinkAsync should be called');
    });
  });

  suite('pointCurrentToAttempt - cleanup of existing link (lines 332-336)', () => {
    test('removes existing symlink before creating new one', async () => {
      const mockFs = makeMockFs({
        lstatAsync: sinon.stub().callsFake(() => {
          return Promise.resolve({
            isSymbolicLink: () => true,
            isDirectory: () => false,
          });
        }),
        writeFileAsync: sinon.stub().resolves(),
      });
      const store = makeStore(mockFs);

      // Access private method directly to test pointCurrentToAttempt
      const pointCurrent = (store as any).pointCurrentToAttempt.bind(store);
      await pointCurrent('plan-x', 'node-x', 2);

      // On non-win32, unlinkAsync is called to remove existing symlink
      if (process.platform !== 'win32') {
        assert.ok(mockFs.unlinkAsync.called, 'unlinkAsync should remove existing symlink');
      } else {
        assert.ok(mockFs.rmAsync.called, 'rmAsync should remove existing symlink on Windows');
      }
      // symlinkAsync called to create the new link
      assert.ok(mockFs.symlinkAsync.calledOnce, 'symlinkAsync should create new link');
    });

    test('creates new symlink even when lstatAsync throws for non-existent current link', async () => {
      const mockFs = makeMockFs({
        lstatAsync: sinon.stub().rejects(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
        writeFileAsync: sinon.stub().resolves(),
      });
      const store = makeStore(mockFs);

      const pointCurrent = (store as any).pointCurrentToAttempt.bind(store);
      await pointCurrent('plan-y', 'node-y', 1);

      // symlinkAsync should still create the link
      assert.ok(mockFs.symlinkAsync.calledOnce);
    });
  });

  suite('migrateLegacy - attemptHistory path (lines 268-282)', () => {
    test('processes nodes with attemptHistory in migration', async () => {
      const legacyPlan = {
        id: 'plan-legacy',
        spec: {
          name: 'Legacy Plan',
          baseBranch: 'main',
          jobs: [{ producerId: 'n1', name: 'Node 1', task: 'test', work: '@agent test' }],
        },
        nodes: [
          { id: 'n1', producerId: 'n1', name: 'Node 1', task: 'test', dependencies: [] },
        ],
        nodeStates: {
          'n1': {
            status: 'failed',
            attempts: 2,
            attemptHistory: [
              { attemptNumber: 1, startTime: Date.now() - 2000, endTime: Date.now() - 1000, workUsed: '@agent first attempt' },
              { attemptNumber: 2, startTime: Date.now() - 500, endTime: Date.now(), workUsed: '@agent second attempt' },
            ],
          },
        },
        roots: ['n1'], leaves: ['n1'],
        repoPath: '/repo', baseBranch: 'main',
        worktreeRoot: '/worktrees', createdAt: Date.now(),
        producerIdToNodeId: { 'n1': 'n1' },
      };

      const legacyContent = JSON.stringify(legacyPlan);

      const mkdirCalls: string[] = [];
      const writeFileCalls: Array<{ path: string; content: string }> = [];

      const mockFs = makeMockFs({
        readFileAsync: sinon.stub().callsFake((filePath: string) => {
          if (filePath.includes('plan-legacy.json')) {
            return Promise.resolve(legacyContent);
          }
          return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        }),
        mkdirAsync: sinon.stub().callsFake((p: string) => {
          mkdirCalls.push(p);
          return Promise.resolve();
        }),
        writeFileAsync: sinon.stub().callsFake((p: string, content: string) => {
          writeFileCalls.push({ path: p, content });
          return Promise.resolve();
        }),
        lstatAsync: sinon.stub().callsFake(() => {
          // For pointCurrentToAttempt, return non-symlink (so no cleanup needed)
          return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        }),
        existsSync: sinon.stub().returns(false),
      });

      const store = new FileSystemPlanStore('/storage', '/workspace', mockFs);

      await store.migrateLegacy('plan-legacy');

      // Verify that mkdirAsync was called for attempt directories
      const attemptDirCalls = mkdirCalls.filter(p => p.includes('attempts'));
      assert.ok(attemptDirCalls.length > 0, 'Should create attempt directories');

      // Verify that work specs were written for attempts
      const workSpecCalls = writeFileCalls.filter(c => c.path.includes('work.json'));
      assert.ok(workSpecCalls.length > 0, 'Should write work spec files for attempts');

      // Verify writePlanMetadata was called
      const planJsonCalls = writeFileCalls.filter(c => c.path.includes('plan.json') || c.path.includes('.plan.json.tmp'));
      assert.ok(planJsonCalls.length > 0, 'Should write plan metadata');
    });

    test('handles migration with no attemptHistory', async () => {
      const legacyPlan = {
        id: 'plan-simple',
        spec: {
          name: 'Simple Plan',
          baseBranch: 'main',
          jobs: [],
        },
        nodes: [
          { id: 'n1', producerId: 'n1', name: 'Node 1', task: 'test', dependencies: [] },
        ],
        nodeStates: {
          'n1': { status: 'succeeded', attempts: 1 },
        },
        roots: ['n1'], leaves: ['n1'],
        repoPath: '/repo', baseBranch: 'main',
        worktreeRoot: '/worktrees', createdAt: Date.now(),
        producerIdToNodeId: { 'n1': 'n1' },
      };

      const mockFs = makeMockFs({
        readFileAsync: sinon.stub().callsFake((filePath: string) => {
          if (filePath.includes('plan-simple.json')) {
            return Promise.resolve(JSON.stringify(legacyPlan));
          }
          return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        }),
        lstatAsync: sinon.stub().rejects(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
        existsSync: sinon.stub().returns(false),
      });

      const store = new FileSystemPlanStore('/storage', '/workspace', mockFs);

      // Should complete without error
      await assert.doesNotReject(() => store.migrateLegacy('plan-simple'));
      // unlinkAsync called to remove legacy file
      assert.ok(mockFs.unlinkAsync.called, 'Should delete legacy plan file after migration');
    });

    test('migration throws on file read error', async () => {
      const mockFs = makeMockFs({
        readFileAsync: sinon.stub().rejects(new Error('disk read error')),
      });
      const store = new FileSystemPlanStore('/storage', '/workspace', mockFs);

      await assert.rejects(
        () => store.migrateLegacy('plan-fail'),
        (err: any) => {
          assert.ok(err.message.includes('disk read error'));
          return true;
        }
      );
    });
  });

  suite('snapshotSpecsForAttempt - directory migration (lines 207-210)', () => {
    test('migrates existing plain directory to attempt structure on attempt 1', async () => {
      const mockFs = makeMockFs({
        lstatAsync: sinon.stub().resolves({
          isSymbolicLink: () => false,
          isDirectory: () => true,
        }),
        readdirAsync: sinon.stub().resolves(['work.md', 'prechecks.json']),
        writeFileAsync: sinon.stub().resolves(),
      });
      const store = makeStore(mockFs);

      await store.snapshotSpecsForAttempt('plan-1', 'node-1', 1);

      assert.ok(mockFs.readdirAsync.called, 'readdirAsync should list files in directory');
      assert.ok(mockFs.renameAsync.called, 'renameAsync should move files to attempt dir');
      assert.ok(mockFs.rmdirAsync.called, 'rmdirAsync should remove old plain directory');
    });

    test('skips directory migration when lstatAsync throws on attempt 1', async () => {
      const mockFs = makeMockFs({
        lstatAsync: sinon.stub().rejects(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
        writeFileAsync: sinon.stub().resolves(),
      });
      const store = makeStore(mockFs);

      // Should not throw — the catch block handles it
      await assert.doesNotReject(() => store.snapshotSpecsForAttempt('plan-2', 'node-2', 1));
      assert.ok(mockFs.mkdirAsync.called, 'mkdirAsync should still be called for attempt dir');
    });
  });

  suite('readNodeSpecForAttempt - non-ENOENT error (lines 234-236)', () => {
    test('throws on non-ENOENT read error', async () => {
      const mockFs = makeMockFs({
        readFileAsync: sinon.stub().rejects(Object.assign(new Error('permission denied'), { code: 'EACCES' })),
      });
      const store = makeStore(mockFs);

      await assert.rejects(
        () => store.readNodeSpecForAttempt('plan-1', 'node-1', 'work', 1),
        /permission denied/
      );
    });

    test('returns undefined on ENOENT when reading spec', async () => {
      const mockFs = makeMockFs({
        readFileAsync: sinon.stub().rejects(Object.assign(new Error('not found'), { code: 'ENOENT' })),
      });
      const store = makeStore(mockFs);

      const result = await store.readNodeSpecForAttempt('plan-1', 'node-1', 'prechecks', 1);
      assert.strictEqual(result, undefined);
    });
  });

  suite('deletePlan – index cleanup and error paths (lines 184-192)', () => {
    test('removes plan from plans-index.json when it exists (lines 184-187)', async () => {
      const mockFs = makeMockFs({
        rmAsync: sinon.stub().resolves(),
        existsSync: sinon.stub().returns(true),
        readJSON: sinon.stub().returns({ plans: { 'plan-1': { id: 'plan-1' } } }),
        writeJSON: sinon.stub(),
      });
      const store = makeStore(mockFs);

      await store.deletePlan('plan-1');

      assert.ok(mockFs.rmAsync.called, 'rmAsync should be called to delete plan dir');
      assert.ok(mockFs.readJSON.called, 'readJSON should read the index file');
      assert.ok(mockFs.writeJSON.called, 'writeJSON should update the index file');
    });

    test('skips index update when existsSync returns false', async () => {
      const mockFs = makeMockFs({
        rmAsync: sinon.stub().resolves(),
        existsSync: sinon.stub().returns(false),
        readJSON: sinon.stub().returns({ plans: {} }),
        writeJSON: sinon.stub(),
      });
      const store = makeStore(mockFs);

      await store.deletePlan('plan-1');

      assert.ok(mockFs.rmAsync.called, 'rmAsync should be called');
      assert.ok(mockFs.readJSON.notCalled, 'readJSON should NOT be called when index does not exist');
    });

    test('throws when rmAsync fails (lines 189-192)', async () => {
      const mockFs = makeMockFs({
        rmAsync: sinon.stub().rejects(new Error('delete failed')),
      });
      const store = makeStore(mockFs);

      await assert.rejects(
        () => store.deletePlan('plan-1'),
        /delete failed/
      );
    });
  });

  suite('writeNodeSpec – error path (lines 126-129)', () => {
    test('throws and logs when writeFileAsync fails', async () => {
      const mockFs = makeMockFs({
        lstatAsync: sinon.stub().resolves({ isSymbolicLink: () => false, isDirectory: () => false }),
        mkdirAsync: sinon.stub().resolves(),
        writeFileAsync: sinon.stub().rejects(new Error('write failed')),
      });
      const store = makeStore(mockFs);

      await assert.rejects(
        () => store.writeNodeSpec('plan-1', 'node-1', 'work', { type: 'shell', command: 'echo hello' } as any),
        /write failed/
      );
    });
  });

  suite('listPlanIds – readdirAsync error path (lines 172-175)', () => {
    test('throws and logs when readdirAsync fails', async () => {
      const mockFs = makeMockFs({
        existsAsync: sinon.stub().resolves(true),
        readdirAsync: sinon.stub().rejects(new Error('readdir failed')),
      });
      const store = makeStore(mockFs);

      await assert.rejects(
        () => store.listPlanIds(),
        /readdir failed/
      );
    });
  });

  suite('readPlanMetadata – non-ENOENT error path (lines 36-38)', () => {
    test('throws and logs when readFileAsync fails with non-ENOENT error', async () => {
      const mockFs = makeMockFs({
        readFileAsync: sinon.stub().rejects(Object.assign(new Error('permission denied'), { code: 'EACCES' })),
      });
      const store = makeStore(mockFs);

      await assert.rejects(
        () => store.readPlanMetadata('plan-1'),
        /permission denied/
      );
    });

    test('returns undefined for ENOENT in readPlanMetadata', async () => {
      const mockFs = makeMockFs({
        readFileAsync: sinon.stub().rejects(Object.assign(new Error('not found'), { code: 'ENOENT' })),
      });
      const store = makeStore(mockFs);

      const result = await store.readPlanMetadata('plan-1');
      assert.strictEqual(result, undefined);
    });
  });

  suite('readPlanMetadataSync (lines 42-50)', () => {
    test('returns parsed metadata when file exists', () => {
      const metadata = { id: 'plan-1', name: 'Test Plan' };
      const mockFs = makeMockFs({
        readFileSync: sinon.stub().returns(JSON.stringify(metadata)),
      });
      const store = makeStore(mockFs);

      const result = store.readPlanMetadataSync('plan-1');
      assert.deepStrictEqual(result, metadata);
    });

    test('returns undefined when readFileSync throws ENOENT', () => {
      const mockFs = makeMockFs({
        readFileSync: sinon.stub().throws(Object.assign(new Error('not found'), { code: 'ENOENT' })),
      });
      const store = makeStore(mockFs);

      const result = store.readPlanMetadataSync('plan-1');
      assert.strictEqual(result, undefined);
    });

    test('returns undefined when readFileSync throws non-ENOENT error', () => {
      const mockFs = makeMockFs({
        readFileSync: sinon.stub().throws(Object.assign(new Error('permission denied'), { code: 'EACCES' })),
      });
      const store = makeStore(mockFs);

      const result = store.readPlanMetadataSync('plan-1');
      assert.strictEqual(result, undefined);
    });
  });

  suite('readNodeSpec – non-ENOENT error path (lines 107-109)', () => {
    test('throws and logs when readFileAsync fails with non-ENOENT, non-work error', async () => {
      const mockFs = makeMockFs({
        readFileAsync: sinon.stub().rejects(Object.assign(new Error('disk error'), { code: 'EIO' })),
      });
      const store = makeStore(mockFs);

      await assert.rejects(
        () => store.readNodeSpec('plan-1', 'node-1', 'prechecks'),
        /disk error/
      );
    });
  });
});
