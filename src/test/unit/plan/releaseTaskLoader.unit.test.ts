/**
 * @fileoverview Unit Tests for Release Task Loader
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as path from 'path';

suite('releaseTaskLoader', () => {
  let sandbox: sinon.SinonSandbox;
  let fsModule: any;
  let origReadFileSync: any;
  let origReaddirSync: any;
  let origExistsSync: any;
  let origWriteFileSync: any;
  let origMkdirSync: any;

  setup(() => {
    sandbox = sinon.createSandbox();
    fsModule = require('fs');
    origReadFileSync = fsModule.readFileSync;
    origReaddirSync = fsModule.readdirSync;
    origExistsSync = fsModule.existsSync;
    origWriteFileSync = fsModule.writeFileSync;
    origMkdirSync = fsModule.mkdirSync;
  });

  teardown(() => {
    fsModule.readFileSync = origReadFileSync;
    fsModule.readdirSync = origReaddirSync;
    fsModule.existsSync = origExistsSync;
    fsModule.writeFileSync = origWriteFileSync;
    fsModule.mkdirSync = origMkdirSync;
    sandbox.restore();
  });

  suite('loadReleaseTasks', () => {
    test('should return empty array when tasks directory does not exist', async () => {
      fsModule.existsSync = sandbox.stub().returns(false);

      const { loadReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = await loadReleaseTasks('/test/repo');

      assert.strictEqual(tasks.length, 0);
    });

    test('should return empty array when directory read fails', async () => {
      fsModule.existsSync = sandbox.stub().returns(true);
      fsModule.readdirSync = sandbox.stub().throws(new Error('Permission denied'));

      const { loadReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = await loadReleaseTasks('/test/repo');

      assert.strictEqual(tasks.length, 0);
    });

    test('should return empty array when no .md files found', async () => {
      fsModule.existsSync = sandbox.stub().returns(true);
      fsModule.readdirSync = sandbox.stub().returns(['readme.txt', 'config.json']);

      const { loadReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = await loadReleaseTasks('/test/repo');

      assert.strictEqual(tasks.length, 0);
    });

    test('should skip file when readFile fails', async () => {
      fsModule.existsSync = sandbox.stub().returns(true);
      fsModule.readdirSync = sandbox.stub().returns(['task1.md', 'task2.md']);
      fsModule.readFileSync = sandbox.stub()
        .onFirstCall().throws(new Error('Read error'))
        .onSecondCall().returns('---\nid: task2\ntitle: Task 2\n---\nDescription 2');

      const { loadReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = await loadReleaseTasks('/test/repo');

      assert.strictEqual(tasks.length, 1);
      assert.strictEqual(tasks[0].id, 'task2');
    });

    test('should skip file with missing id', async () => {
      fsModule.existsSync = sandbox.stub().returns(true);
      fsModule.readdirSync = sandbox.stub().returns(['invalid.md']);
      fsModule.readFileSync = sandbox.stub().returns('---\ntitle: No ID\n---\nDescription');

      const { loadReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = await loadReleaseTasks('/test/repo');

      assert.strictEqual(tasks.length, 0);
    });

    test('should skip file with missing title', async () => {
      fsModule.existsSync = sandbox.stub().returns(true);
      fsModule.readdirSync = sandbox.stub().returns(['invalid.md']);
      fsModule.readFileSync = sandbox.stub().returns('---\nid: test\n---\nDescription');

      const { loadReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = await loadReleaseTasks('/test/repo');

      assert.strictEqual(tasks.length, 0);
    });

    test('should parse valid task file with all fields', async () => {
      fsModule.existsSync = sandbox.stub().returns(true);
      fsModule.readdirSync = sandbox.stub().returns(['task.md']);
      fsModule.readFileSync = sandbox.stub().returns(
        '---\nid: changelog\ntitle: Update CHANGELOG\nrequired: true\nautoSupported: true\norder: 1\n---\nAdd release notes'
      );

      const { loadReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = await loadReleaseTasks('/test/repo');

      assert.strictEqual(tasks.length, 1);
      assert.strictEqual(tasks[0].id, 'changelog');
      assert.strictEqual(tasks[0].title, 'Update CHANGELOG');
      assert.strictEqual(tasks[0].description, 'Add release notes');
      assert.strictEqual(tasks[0].required, true);
      assert.strictEqual(tasks[0].autoSupported, true);
      assert.strictEqual(tasks[0].status, 'pending');
    });

    test('should use default values for optional fields', async () => {
      fsModule.existsSync = sandbox.stub().returns(true);
      fsModule.readdirSync = sandbox.stub().returns(['task.md']);
      fsModule.readFileSync = sandbox.stub().returns('---\nid: test\ntitle: Test Task\n---\nTest description');

      const { loadReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = await loadReleaseTasks('/test/repo');

      assert.strictEqual(tasks.length, 1);
      assert.strictEqual(tasks[0].required, false);
      assert.strictEqual(tasks[0].autoSupported, true);
    });

    test('should sort tasks by order field', async () => {
      fsModule.existsSync = sandbox.stub().returns(true);
      fsModule.readdirSync = sandbox.stub().returns(['a.md', 'b.md', 'c.md']);
      fsModule.readFileSync = sandbox.stub()
        .onCall(0).returns('---\nid: task-a\ntitle: A\norder: 3\n---\nA')
        .onCall(1).returns('---\nid: task-b\ntitle: B\norder: 1\n---\nB')
        .onCall(2).returns('---\nid: task-c\ntitle: C\norder: 2\n---\nC');

      const { loadReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = await loadReleaseTasks('/test/repo');

      assert.strictEqual(tasks.length, 3);
      assert.strictEqual(tasks[0].id, 'task-b');
      assert.strictEqual(tasks[1].id, 'task-c');
      assert.strictEqual(tasks[2].id, 'task-a');
    });

    test('should sort by filename when order not specified', async () => {
      fsModule.existsSync = sandbox.stub().returns(true);
      fsModule.readdirSync = sandbox.stub().returns(['03-task.md', '01-task.md', '02-task.md']);
      fsModule.readFileSync = sandbox.stub()
        .onCall(0).returns('---\nid: task-3\ntitle: Task 3\n---\nTask 3')
        .onCall(1).returns('---\nid: task-1\ntitle: Task 1\n---\nTask 1')
        .onCall(2).returns('---\nid: task-2\ntitle: Task 2\n---\nTask 2');

      const { loadReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = await loadReleaseTasks('/test/repo');

      assert.strictEqual(tasks.length, 3);
      assert.strictEqual(tasks[0].id, 'task-1');
      assert.strictEqual(tasks[1].id, 'task-2');
      assert.strictEqual(tasks[2].id, 'task-3');
    });

    test('should prioritize order over filename', async () => {
      fsModule.existsSync = sandbox.stub().returns(true);
      fsModule.readdirSync = sandbox.stub().returns(['02-task.md', '01-task.md']);
      fsModule.readFileSync = sandbox.stub()
        .onCall(0).returns('---\nid: task-b\ntitle: B\norder: 2\n---\nB')
        .onCall(1).returns('---\nid: task-a\ntitle: A\norder: 1\n---\nA');

      const { loadReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = await loadReleaseTasks('/test/repo');

      assert.strictEqual(tasks.length, 2);
      assert.strictEqual(tasks[0].id, 'task-a');
      assert.strictEqual(tasks[1].id, 'task-b');
    });

    test('should parse file without frontmatter', async () => {
      fsModule.existsSync = sandbox.stub().returns(true);
      fsModule.readdirSync = sandbox.stub().returns(['plain.md']);
      fsModule.readFileSync = sandbox.stub().returns('Just plain markdown content');

      const { loadReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = await loadReleaseTasks('/test/repo');

      // Should be skipped due to missing id/title
      assert.strictEqual(tasks.length, 0);
    });

    test('should parse boolean values in frontmatter', async () => {
      fsModule.existsSync = sandbox.stub().returns(true);
      fsModule.readdirSync = sandbox.stub().returns(['task.md']);
      fsModule.readFileSync = sandbox.stub().returns(
        '---\nid: test\ntitle: Test\nrequired: false\nautoSupported: false\n---\nContent'
      );

      const { loadReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = await loadReleaseTasks('/test/repo');

      assert.strictEqual(tasks[0].required, false);
      assert.strictEqual(tasks[0].autoSupported, false);
    });

    test('should parse numeric values in frontmatter', async () => {
      fsModule.existsSync = sandbox.stub().returns(true);
      fsModule.readdirSync = sandbox.stub().returns(['task.md']);
      fsModule.readFileSync = sandbox.stub().returns(
        '---\nid: test\ntitle: Test\norder: 42\n---\nContent'
      );

      const { loadReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = await loadReleaseTasks('/test/repo');

      assert.strictEqual(tasks.length, 1);
    });
  });

  suite('getDefaultReleaseTasks', () => {
    test('should return 6 default tasks', async () => {
      const { getDefaultReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = getDefaultReleaseTasks();

      assert.strictEqual(tasks.length, 6);
    });

    test('should include changelog task', async () => {
      const { getDefaultReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = getDefaultReleaseTasks();

      const changelog = tasks.find((t) => t.id === 'changelog');
      assert.ok(changelog);
      assert.strictEqual(changelog!.title, 'Update CHANGELOG');
      assert.strictEqual(changelog!.required, true);
      assert.strictEqual(changelog!.autoSupported, true);
      assert.strictEqual(changelog!.status, 'pending');
    });

    test('should include version task', async () => {
      const { getDefaultReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = getDefaultReleaseTasks();

      const version = tasks.find((t) => t.id === 'version');
      assert.ok(version);
      assert.strictEqual(version!.title, 'Bump Version');
    });

    test('should include compile task', async () => {
      const { getDefaultReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = getDefaultReleaseTasks();

      const compile = tasks.find((t) => t.id === 'compile');
      assert.ok(compile);
      assert.strictEqual(compile!.required, true);
    });

    test('should include tests task', async () => {
      const { getDefaultReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = getDefaultReleaseTasks();

      const tests = tasks.find((t) => t.id === 'tests');
      assert.ok(tests);
    });

    test('should include optional docs task', async () => {
      const { getDefaultReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = getDefaultReleaseTasks();

      const docs = tasks.find((t) => t.id === 'docs');
      assert.ok(docs);
      assert.strictEqual(docs!.required, false);
      assert.strictEqual(docs!.autoSupported, false);
    });

    test('should include ai-review task', async () => {
      const { getDefaultReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = getDefaultReleaseTasks();

      const aiReview = tasks.find((t) => t.id === 'ai-review');
      assert.ok(aiReview);
      assert.strictEqual(aiReview!.autoSupported, true);
    });

    test('should return all tasks with pending status', async () => {
      const { getDefaultReleaseTasks } = await import('../../../plan/releaseTaskLoader');
      const tasks = getDefaultReleaseTasks();

      assert.ok(tasks.every((t) => t.status === 'pending'));
    });
  });

  suite('scaffoldDefaultTaskFiles', () => {
    test('should create directory and 6 files', async () => {
      fsModule.existsSync = sandbox.stub().returns(false);
      fsModule.mkdirSync = sandbox.stub();
      fsModule.writeFileSync = sandbox.stub();

      const { scaffoldDefaultTaskFiles } = await import('../../../plan/releaseTaskLoader');
      const created = await scaffoldDefaultTaskFiles('/test/repo');

      assert.strictEqual(created.length, 6);
      assert.ok(fsModule.mkdirSync.calledOnce);
      assert.ok(fsModule.mkdirSync.calledWith(
        path.join('/test/repo', '.orchestrator', 'release', 'tasks'),
        { recursive: true }
      ));
      assert.strictEqual(fsModule.writeFileSync.callCount, 6);
    });

    test('should not overwrite existing files', async () => {
      // Simulate 2 files already exist by throwing EEXIST on those writeFileSync calls.
      // The production code uses the atomic 'wx' flag (create-exclusive) — no existsSync check.
      const eexist = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      fsModule.mkdirSync = sandbox.stub();
      fsModule.writeFileSync = sandbox.stub()
        .onCall(0).throws(eexist)       // 01-changelog.md already exists
        .onCall(1).returns(undefined)   // 02-version.md created
        .onCall(2).throws(eexist)       // 03-compile.md already exists
        .onCall(3).returns(undefined)   // 04-tests.md created
        .onCall(4).returns(undefined)   // 05-docs.md created
        .onCall(5).returns(undefined);  // 06-ai-review.md created

      const { scaffoldDefaultTaskFiles } = await import('../../../plan/releaseTaskLoader');
      const created = await scaffoldDefaultTaskFiles('/test/repo');

      // Should only report 4 newly created files (2 EEXIST skipped)
      assert.strictEqual(created.length, 4);
      assert.strictEqual(fsModule.writeFileSync.callCount, 6);
    });

    test('should return only newly created file paths', async () => {
      // Simulate first file already exists; production code detects this via 'wx' flag EEXIST.
      const eexist = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      fsModule.mkdirSync = sandbox.stub();
      fsModule.writeFileSync = sandbox.stub()
        .onCall(0).throws(eexist)       // 01-changelog.md already exists
        .onCall(1).returns(undefined)   // 02-version.md created
        .onCall(2).returns(undefined)   // 03-compile.md created
        .onCall(3).returns(undefined)   // 04-tests.md created
        .onCall(4).returns(undefined)   // 05-docs.md created
        .onCall(5).returns(undefined);  // 06-ai-review.md created

      const { scaffoldDefaultTaskFiles } = await import('../../../plan/releaseTaskLoader');
      const created = await scaffoldDefaultTaskFiles('/test/repo');

      // Should return 5 paths (excluding the one that threw EEXIST)
      assert.strictEqual(created.length, 5);
      
      // Check that first file is not in created list
      const hasChangelogFile = created.some((p: string) => p.includes('01-changelog.md'));
      assert.strictEqual(hasChangelogFile, false);
    });

    test('should generate file content with valid frontmatter', async () => {
      fsModule.mkdirSync = sandbox.stub();
      fsModule.writeFileSync = sandbox.stub();

      const { scaffoldDefaultTaskFiles } = await import('../../../plan/releaseTaskLoader');
      await scaffoldDefaultTaskFiles('/test/repo');

      // Production code calls writeFileSync with options object { encoding, flag }
      assert.ok(fsModule.writeFileSync.calledWith(
        sinon.match.string,
        sinon.match(/^---\nid: changelog\ntitle: Update CHANGELOG\nrequired: true/),
        { encoding: 'utf-8', flag: 'wx' }
      ));
    });

    test('should create files numbered 01-06 with correct names', async () => {
      fsModule.existsSync = sandbox.stub().returns(false);
      fsModule.mkdirSync = sandbox.stub();
      fsModule.writeFileSync = sandbox.stub();

      const { scaffoldDefaultTaskFiles } = await import('../../../plan/releaseTaskLoader');
      const created = await scaffoldDefaultTaskFiles('/test/repo');

      assert.strictEqual(created.length, 6);
      assert.ok(created[0].includes('01-changelog.md'));
      assert.ok(created[1].includes('02-version.md'));
      assert.ok(created[2].includes('03-compile.md'));
      assert.ok(created[3].includes('04-tests.md'));
      assert.ok(created[4].includes('05-docs.md'));
      assert.ok(created[5].includes('06-ai-review.md'));
    });

    test('should throw error when directory creation fails', async () => {
      fsModule.existsSync = sandbox.stub().returns(false);
      fsModule.mkdirSync = sandbox.stub().throws(new Error('Permission denied'));

      const { scaffoldDefaultTaskFiles } = await import('../../../plan/releaseTaskLoader');
      
      await assert.rejects(
        async () => await scaffoldDefaultTaskFiles('/test/repo'),
        { message: /Failed to create tasks directory/ }
      );
    });

    test('should continue with other files if one write fails', async () => {
      fsModule.existsSync = sandbox.stub().returns(false);
      fsModule.mkdirSync = sandbox.stub();
      fsModule.writeFileSync = sandbox.stub()
        .onFirstCall().throws(new Error('Write error'))  // First file fails
        .onSecondCall().returns(undefined)               // Rest succeed
        .onThirdCall().returns(undefined)
        .onCall(3).returns(undefined)
        .onCall(4).returns(undefined)
        .onCall(5).returns(undefined);

      const { scaffoldDefaultTaskFiles } = await import('../../../plan/releaseTaskLoader');
      const created = await scaffoldDefaultTaskFiles('/test/repo');

      // Should return 5 paths (one failed to write)
      assert.strictEqual(created.length, 5);
    });
  });
});
