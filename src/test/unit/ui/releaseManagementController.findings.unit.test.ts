/**
 * @fileoverview Unit tests for ReleaseManagementController findings methods
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { ReleaseManagementController } from '../../../ui/panels/releaseManagementController';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function createMockDialogService(): any {
  return {
    showInfo: sinon.stub().resolves(),
    showError: sinon.stub().resolves(),
    showWarning: sinon.stub().resolves(),
    showQuickPick: sinon.stub().resolves(),
  };
}

function createMockDelegate(): any {
  return {
    executeCommand: sinon.stub().resolves(),
    postMessage: sinon.stub(),
    forceFullRefresh: sinon.stub(),
  };
}

function createMockReleaseManager(): any {
  return {
    on: sinon.stub().returnsThis(),
    transitionToState: sinon.stub().resolves(true),
    executePreparationTask: sinon.stub().resolves(),
    completePreparationTask: sinon.stub().resolves(),
    skipPreparationTask: sinon.stub().resolves(),
    getTaskLogFilePath: sinon.stub().returns(undefined),
    getRelease: sinon.stub().returns(undefined),
    getAllReleases: sinon.stub().returns([]),
    getReleasesByStatus: sinon.stub().returns([]),
    getReleaseProgress: sinon.stub().returns(undefined),
    createRelease: sinon.stub().resolves(),
    startRelease: sinon.stub().resolves(),
    cancelRelease: sinon.stub().resolves(true),
    deleteRelease: sinon.stub().returns(true),
    cleanupIsolatedRepos: sinon.stub().resolves(),
    addPlansToRelease: sinon.stub().resolves(),
    createPR: sinon.stub().resolves(),
    adoptPR: sinon.stub().resolves(),
    startMonitoring: sinon.stub().resolves(),
    stopMonitoring: sinon.stub().resolves(),
    updateFindingStatus: sinon.stub().resolves(),
  };
}

suite('ReleaseManagementController findings', () => {
  let quiet: { restore: () => void };
  let sandbox: sinon.SinonSandbox;
  let mockDialogService: any;
  let mockDelegate: any;
  let mockReleaseManager: any;
  let controller: ReleaseManagementController;

  setup(() => {
    quiet = silenceConsole();
    sandbox = sinon.createSandbox();
    mockDialogService = createMockDialogService();
    mockDelegate = createMockDelegate();
    mockReleaseManager = createMockReleaseManager();
  });

  teardown(() => {
    sandbox.restore();
    quiet.restore();
  });

  test('updateFinding calls updateFindingStatus and refreshes', async () => {
    controller = new ReleaseManagementController(
      'rel-1',
      mockDialogService,
      mockDelegate,
      mockReleaseManager,
    );

    // Wait a tick to let the message handler setup complete
    await new Promise((resolve) => setImmediate(resolve));

    controller.handleMessage({
      type: 'updateFinding',
      taskId: 'task-1',
      findingId: 'finding-1',
      status: 'acknowledged',
    });

    // Wait for async promise chain
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(
      mockReleaseManager.updateFindingStatus.calledOnce,
      'updateFindingStatus should be called once'
    );
    assert.strictEqual(
      mockReleaseManager.updateFindingStatus.firstCall.args[0],
      'rel-1',
      'should pass releaseId'
    );
    assert.strictEqual(
      mockReleaseManager.updateFindingStatus.firstCall.args[1],
      'task-1',
      'should pass taskId'
    );
    assert.strictEqual(
      mockReleaseManager.updateFindingStatus.firstCall.args[2],
      'finding-1',
      'should pass findingId'
    );
    assert.strictEqual(
      mockReleaseManager.updateFindingStatus.firstCall.args[3],
      'acknowledged',
      'should pass status'
    );

    // Wait for the promise resolution
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.ok(
      mockDelegate.forceFullRefresh.called,
      'forceFullRefresh should be called after update'
    );
  });

  test('openFindingFile opens file at line via executeCommand', async () => {
    // Mock vscode
    const vscode = require('vscode');
    const mockUri = { fsPath: '/repo/src/app.ts' };
    const mockRange = { start: { line: 41, character: 0 }, end: { line: 41, character: 0 } };
    sandbox.stub(vscode.Uri, 'file').returns(mockUri);
    
    // Create a constructor stub that returns mockRange
    const RangeStub = sandbox.stub().returns(mockRange);
    vscode.Range = RangeStub;

    mockReleaseManager.getRelease.returns({
      id: 'rel-1',
      repoPath: '/repo',
    });

    controller = new ReleaseManagementController(
      'rel-1',
      mockDialogService,
      mockDelegate,
      mockReleaseManager,
    );

    // Wait a tick
    await new Promise((resolve) => setImmediate(resolve));

    controller.handleMessage({
      type: 'openFindingFile',
      filePath: 'src/app.ts',
      line: 42,
    });

    // Wait for async promise chain
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(mockReleaseManager.getRelease.calledOnce, 'getRelease should be called');
    assert.strictEqual(
      mockReleaseManager.getRelease.firstCall.args[0],
      'rel-1',
      'should pass releaseId'
    );

    assert.ok(vscode.Uri.file.calledOnce, 'Uri.file should be called');
    // The path join happens with require('path').join - so it will be /repo/src/app.ts or \repo\src\app.ts
    const passedPath = vscode.Uri.file.firstCall.args[0];
    assert.ok(
      passedPath.includes('repo') && passedPath.includes('src') && passedPath.includes('app.ts'),
      'should include full file path'
    );

    assert.ok(RangeStub.calledOnce, 'Range should be created');
    assert.strictEqual(RangeStub.firstCall.args[0], 41, 'should use line - 1 (0-indexed)');
    assert.strictEqual(RangeStub.firstCall.args[1], 0, 'should use column 0');
    assert.strictEqual(RangeStub.firstCall.args[2], 41, 'should use same line for end');
    assert.strictEqual(RangeStub.firstCall.args[3], 0, 'should use column 0 for end');

    // Wait a bit for executeCommand to be called
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.ok(mockDelegate.executeCommand.called, 'executeCommand should be called');
    assert.strictEqual(
      mockDelegate.executeCommand.firstCall.args[0],
      'vscode.open',
      'should call vscode.open'
    );
    assert.strictEqual(
      mockDelegate.executeCommand.firstCall.args[1],
      mockUri,
      'should pass URI'
    );
    assert.deepStrictEqual(
      mockDelegate.executeCommand.firstCall.args[2],
      { selection: mockRange },
      'should pass selection option'
    );
  });

  test('openFindingFile handles missing filePath gracefully', async () => {
    controller = new ReleaseManagementController(
      'rel-1',
      mockDialogService,
      mockDelegate,
      mockReleaseManager,
    );

    // Wait a tick
    await new Promise((resolve) => setImmediate(resolve));

    // Call without filePath
    controller.handleMessage({
      type: 'openFindingFile',
    });

    // Wait for async operations
    await new Promise((resolve) => setImmediate(resolve));

    // Should not call getRelease or executeCommand
    assert.ok(!mockReleaseManager.getRelease.called, 'getRelease should not be called');
    assert.ok(!mockDelegate.executeCommand.called, 'executeCommand should not be called');
  });
});
