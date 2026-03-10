/**
 * @fileoverview Unit tests for scaffoldReleaseTasksHandler module
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as path from 'path';

suite('scaffoldReleaseTasksHandler', () => {
  let sandbox: sinon.SinonSandbox;
  let validateStub: sinon.SinonStub;
  let scaffoldStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    
    // Stub the validator
    const validator = require('../../../mcp/validation/validator');
    validateStub = sandbox.stub(validator, 'validateInput').returns({ valid: true });
    
    // Stub the scaffoldDefaultTaskFiles function
    const releaseTaskLoader = require('../../../plan/releaseTaskLoader');
    scaffoldStub = sandbox.stub(releaseTaskLoader, 'scaffoldDefaultTaskFiles');
  });

  teardown(() => {
    sandbox.restore();
  });

  function makeCtx(workspacePath?: string): any {
    return {
      workspacePath,
    };
  }

  suite('handleScaffoldReleaseTasks', () => {
    test('should call scaffoldDefaultTaskFiles with correct repoPath', async () => {
      scaffoldStub.resolves([
        '/test/repo/.orchestrator/release/tasks/01-changelog.md',
        '/test/repo/.orchestrator/release/tasks/02-version.md',
      ]);

      const { handleScaffoldReleaseTasks } = require('../../../mcp/handlers/plan/scaffoldReleaseTasksHandler');
      const result = await handleScaffoldReleaseTasks(
        { repoPath: '/test/repo' },
        makeCtx()
      );

      assert.strictEqual(result.success, true);
      assert.ok(scaffoldStub.calledOnce);
      assert.ok(scaffoldStub.calledWith(path.resolve('/test/repo')));
    });

    test('should return created file list', async () => {
      const createdFiles = [
        '/test/repo/.orchestrator/release/tasks/01-changelog.md',
        '/test/repo/.orchestrator/release/tasks/02-version.md',
        '/test/repo/.orchestrator/release/tasks/03-compile.md',
      ];
      scaffoldStub.resolves(createdFiles);

      const { handleScaffoldReleaseTasks } = require('../../../mcp/handlers/plan/scaffoldReleaseTasksHandler');
      const result = await handleScaffoldReleaseTasks(
        { repoPath: '/test/repo' },
        makeCtx()
      );

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.created, createdFiles);
      assert.strictEqual(result.created.length, 3);
      assert.ok(result.message.includes('3'));
    });

    test('should use workspace root when repoPath not provided', async () => {
      scaffoldStub.resolves(['/workspace/.orchestrator/release/tasks/01-changelog.md']);

      const { handleScaffoldReleaseTasks } = require('../../../mcp/handlers/plan/scaffoldReleaseTasksHandler');
      const result = await handleScaffoldReleaseTasks(
        {},
        makeCtx('/workspace')
      );

      assert.strictEqual(result.success, true);
      assert.ok(scaffoldStub.calledOnce);
      assert.ok(scaffoldStub.calledWith(path.resolve('/workspace')));
    });

    test('should return error when repoPath not provided and no workspace root', async () => {
      const { handleScaffoldReleaseTasks } = require('../../../mcp/handlers/plan/scaffoldReleaseTasksHandler');
      const result = await handleScaffoldReleaseTasks(
        {},
        makeCtx()
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('No repository path provided'));
    });

    test('should return error for invalid input', async () => {
      validateStub.returns({ valid: false, error: 'Invalid repoPath' });

      const { handleScaffoldReleaseTasks } = require('../../../mcp/handlers/plan/scaffoldReleaseTasksHandler');
      const result = await handleScaffoldReleaseTasks(
        { repoPath: 123 },
        makeCtx()
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Invalid'));
    });

    test('should return success with message when no new files created', async () => {
      scaffoldStub.resolves([]);

      const { handleScaffoldReleaseTasks } = require('../../../mcp/handlers/plan/scaffoldReleaseTasksHandler');
      const result = await handleScaffoldReleaseTasks(
        { repoPath: '/test/repo' },
        makeCtx()
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.created.length, 0);
      assert.ok(result.message.includes('No new task files'));
      assert.ok(result.message.includes('already exist'));
    });

    test('should return error when scaffolding fails', async () => {
      scaffoldStub.rejects(new Error('Permission denied'));

      const { handleScaffoldReleaseTasks } = require('../../../mcp/handlers/plan/scaffoldReleaseTasksHandler');
      const result = await handleScaffoldReleaseTasks(
        { repoPath: '/test/repo' },
        makeCtx()
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Permission denied'));
    });

    test('should return all 6 created files when starting fresh', async () => {
      const allFiles = [
        '/test/repo/.orchestrator/release/tasks/01-changelog.md',
        '/test/repo/.orchestrator/release/tasks/02-version.md',
        '/test/repo/.orchestrator/release/tasks/03-compile.md',
        '/test/repo/.orchestrator/release/tasks/04-tests.md',
        '/test/repo/.orchestrator/release/tasks/05-docs.md',
        '/test/repo/.orchestrator/release/tasks/06-ai-review.md',
      ];
      scaffoldStub.resolves(allFiles);

      const { handleScaffoldReleaseTasks } = require('../../../mcp/handlers/plan/scaffoldReleaseTasksHandler');
      const result = await handleScaffoldReleaseTasks(
        { repoPath: '/test/repo' },
        makeCtx()
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.created.length, 6);
      assert.ok(result.message.includes('6'));
    });
  });
});
