/**
 * @fileoverview Unit tests for ReleaseManagementController
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { ReleaseManagementController } from '../../../ui/panels/releaseManagementController';
import type { ReleaseManagementDelegate } from '../../../ui/panels/releaseManagementController';

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
  };
}

suite('ReleaseManagementController', () => {
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

  suite('viewTaskLog', () => {
    test('should call getTaskLogFilePath with correct args', () => {
      controller = new ReleaseManagementController(
        'rel-1',
        mockDialogService,
        mockDelegate,
        mockReleaseManager,
      );

      mockReleaseManager.getTaskLogFilePath.returns('/logs/task-1.log');

      controller.handleMessage({ type: 'viewTaskLog', taskId: 'task-1' });

      assert.ok(mockReleaseManager.getTaskLogFilePath.calledOnce, 'getTaskLogFilePath should be called once');
      assert.strictEqual(
        mockReleaseManager.getTaskLogFilePath.firstCall.args[0],
        'rel-1',
        'should pass releaseId',
      );
      assert.strictEqual(
        mockReleaseManager.getTaskLogFilePath.firstCall.args[1],
        'task-1',
        'should pass taskId',
      );
    });

    test('should call executeCommand with vscode.open when path exists', async () => {
      controller = new ReleaseManagementController(
        'rel-1',
        mockDialogService,
        mockDelegate,
        mockReleaseManager,
      );

      const logPath = '/logs/task-1.log';
      mockReleaseManager.getTaskLogFilePath.returns(logPath);

      controller.handleMessage({ type: 'viewTaskLog', taskId: 'task-1' });

      // Wait for async execution
      await new Promise((resolve) => setImmediate(resolve));

      assert.ok(mockDelegate.executeCommand.calledOnce, 'executeCommand should be called once');
      const executeCall = mockDelegate.executeCommand.firstCall;
      assert.strictEqual(executeCall.args[0], 'vscode.open', 'should call vscode.open command');
      assert.ok(executeCall.args[1], 'should pass URI as second argument');
      assert.strictEqual(executeCall.args[1].fsPath, logPath, 'URI should have correct fsPath');
    });

    test('should call showInfo when no path', () => {
      controller = new ReleaseManagementController(
        'rel-1',
        mockDialogService,
        mockDelegate,
        mockReleaseManager,
      );

      mockReleaseManager.getTaskLogFilePath.returns(undefined);

      controller.handleMessage({ type: 'viewTaskLog', taskId: 'task-1' });

      assert.ok(mockDialogService.showInfo.calledOnce, 'showInfo should be called once');
      assert.strictEqual(
        mockDialogService.showInfo.firstCall.args[0],
        'No log available for this task',
        'should show correct message',
      );
    });

    test('should not call executeCommand when no path', () => {
      controller = new ReleaseManagementController(
        'rel-1',
        mockDialogService,
        mockDelegate,
        mockReleaseManager,
      );

      mockReleaseManager.getTaskLogFilePath.returns(undefined);

      controller.handleMessage({ type: 'viewTaskLog', taskId: 'task-1' });

      assert.ok(mockDelegate.executeCommand.notCalled, 'executeCommand should not be called');
    });

    test('should handle missing taskId gracefully', () => {
      controller = new ReleaseManagementController(
        'rel-1',
        mockDialogService,
        mockDelegate,
        mockReleaseManager,
      );

      controller.handleMessage({ type: 'viewTaskLog' });

      assert.ok(mockReleaseManager.getTaskLogFilePath.notCalled, 'getTaskLogFilePath should not be called');
      assert.ok(mockDelegate.executeCommand.notCalled, 'executeCommand should not be called');
      assert.ok(mockDialogService.showInfo.notCalled, 'showInfo should not be called');
    });

    test('should show error if executeCommand fails', async () => {
      controller = new ReleaseManagementController(
        'rel-1',
        mockDialogService,
        mockDelegate,
        mockReleaseManager,
      );

      const logPath = '/logs/task-1.log';
      mockReleaseManager.getTaskLogFilePath.returns(logPath);
      mockDelegate.executeCommand.rejects(new Error('Failed to open file'));

      controller.handleMessage({ type: 'viewTaskLog', taskId: 'task-1' });

      // Wait for async execution and error handling
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.ok(mockDialogService.showError.called, 'showError should be called');
      const errorCall = mockDialogService.showError.firstCall;
      assert.ok(
        errorCall.args[0].includes('Failed to open log file'),
        'should show error message',
      );
    });
  });
});
