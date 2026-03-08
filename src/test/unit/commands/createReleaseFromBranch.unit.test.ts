/**
 * @fileoverview Unit tests for createReleaseFromBranch command
 * 
 * @module test/unit/commands/createReleaseFromBranch
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

suite('createReleaseFromBranch command', () => {
  let sandbox: sinon.SinonSandbox;
  let mockReleaseManager: any;
  let mockGitExtension: any;
  let mockGitApi: any;
  let mockRepo: any;
  let mockExtensions: any;
  let mockWindow: any;
  let mockCommands: any;
  let registeredCommands: Map<string, Function>;
  let commandHandler: Function;

  // Save originals so teardown can restore them (prevents sinon stub leakage)
  let origShowInputBox: any;
  let origShowErrorMessage: any;
  let origShowWarningMessage: any;
  let origShowInformationMessage: any;
  let origExtensions: any;
  let origExecuteCommand: any;
  let origRegisterCommand: any;

  setup(async () => {
    sandbox = sinon.createSandbox();
    registeredCommands = new Map();

    // Save originals before replacing
    origShowInputBox = (vscode.window as any).showInputBox;
    origShowErrorMessage = (vscode.window as any).showErrorMessage;
    origShowWarningMessage = (vscode.window as any).showWarningMessage;
    origShowInformationMessage = (vscode.window as any).showInformationMessage;
    origExtensions = (vscode as any).extensions;
    origExecuteCommand = (vscode.commands as any).executeCommand;
    origRegisterCommand = (vscode.commands as any).registerCommand;
    
    // Mock release manager
    mockReleaseManager = {
      createRelease: sandbox.stub(),
      getReleasesByStatus: sandbox.stub().returns([]),
    };
    
    // Mock git repository state
    mockRepo = {
      state: {
        HEAD: { name: 'feature/test-branch' }
      },
      rootUri: {
        fsPath: 'c:\\test\\repo'
      }
    };
    
    // Mock git API
    mockGitApi = {
      repositories: [mockRepo]
    };
    
    // Mock git extension
    mockGitExtension = {
      exports: {
        getAPI: sandbox.stub().returns(mockGitApi)
      }
    };
    
    // Mock vscode.extensions
    mockExtensions = {
      getExtension: sandbox.stub()
    };
    (vscode.extensions as any) = mockExtensions;
    mockExtensions.getExtension.withArgs('vscode.git').returns(mockGitExtension);
    
    // Mock vscode.window
    mockWindow = {
      showInputBox: sandbox.stub(),
      showErrorMessage: sandbox.stub(),
      showWarningMessage: sandbox.stub(),
      showInformationMessage: sandbox.stub(),
    };
    (vscode.window as any).showInputBox = mockWindow.showInputBox;
    (vscode.window as any).showErrorMessage = mockWindow.showErrorMessage;
    (vscode.window as any).showWarningMessage = mockWindow.showWarningMessage;
    (vscode.window as any).showInformationMessage = mockWindow.showInformationMessage;
    
    // Mock vscode.commands.registerCommand to capture command handlers
    (vscode.commands as any).registerCommand = sandbox.stub().callsFake((name: string, callback: Function) => {
      registeredCommands.set(name, callback);
      return { dispose: () => {} };
    });
    
    // Mock vscode.commands.executeCommand
    mockCommands = {
      executeCommand: sandbox.stub(),
    };
    (vscode.commands as any).executeCommand = mockCommands.executeCommand;
    
    // Register commands once
    const { registerReleaseCommands } = await import('../../../commands/releaseCommands');
    const context = { subscriptions: [] } as any;
    registerReleaseCommands(context, () => undefined, mockReleaseManager);
    
    // Get the command handler
    commandHandler = registeredCommands.get('orchestrator.createReleaseFromBranch')!;
    assert.ok(commandHandler, 'Command should be registered');
  });

  teardown(() => {
    sandbox.restore();
    // Restore vscode mock properties to originals (prevents leaking stubs to subsequent test files)
    (vscode.window as any).showInputBox = origShowInputBox;
    (vscode.window as any).showErrorMessage = origShowErrorMessage;
    (vscode.window as any).showWarningMessage = origShowWarningMessage;
    (vscode.window as any).showInformationMessage = origShowInformationMessage;
    (vscode as any).extensions = origExtensions;
    (vscode.commands as any).executeCommand = origExecuteCommand;
    (vscode.commands as any).registerCommand = origRegisterCommand;
    registeredCommands.clear();
  });

  suite('happy path', () => {
    test('creates release from feature branch with default name', async () => {
      const mockRelease = { id: 'release-1', name: 'test-branch' };
      mockReleaseManager.createRelease.resolves(mockRelease);
      mockWindow.showInputBox.resolves('test-branch');
      
      await commandHandler();
      
      assert.ok(mockReleaseManager.createRelease.calledOnce);
      const createArgs = mockReleaseManager.createRelease.getCall(0).args[0];
      assert.strictEqual(createArgs.name, 'test-branch');
      assert.strictEqual(createArgs.releaseBranch, 'feature/test-branch');
      assert.strictEqual(createArgs.targetBranch, 'main');
      assert.deepStrictEqual(createArgs.planIds, []);
      
      assert.ok(mockCommands.executeCommand.calledWith('orchestrator.showReleasePanel', 'release-1'));
      assert.ok(mockWindow.showInformationMessage.calledOnce);
    });

    test('creates release with custom name', async () => {
      sandbox.resetHistory();
      const mockRelease = { id: 'release-2', name: 'custom-name' };
      mockReleaseManager.createRelease.resolves(mockRelease);
      mockWindow.showInputBox.resolves('custom-name');
      
      await commandHandler();
      
      assert.ok(mockReleaseManager.createRelease.calledOnce);
      const createArgs = mockReleaseManager.createRelease.getCall(0).args[0];
      assert.strictEqual(createArgs.name, 'custom-name');
    });

    test('strips release/ prefix from branch name for default', async () => {
      sandbox.resetHistory();
      mockRepo.state.HEAD.name = 'release/v1.0.0';
      const mockRelease = { id: 'release-3', name: 'v1.0.0' };
      mockReleaseManager.createRelease.resolves(mockRelease);
      mockWindow.showInputBox.resolves('v1.0.0');
      
      await commandHandler();
      
      // Verify that the input box was called with the stripped name
      assert.ok(mockWindow.showInputBox.calledOnce);
      const inputBoxOptions = mockWindow.showInputBox.getCall(0).args[0];
      assert.strictEqual(inputBoxOptions.value, 'v1.0.0');
    });
  });

  suite('error cases', () => {
    test('shows error when release manager not available', async () => {
      sandbox.resetHistory();
      // Need to re-register with no release manager
      registeredCommands.clear();
      const { registerReleaseCommands } = await import('../../../commands/releaseCommands');
      const context = { subscriptions: [] } as any;
      registerReleaseCommands(context, () => undefined, undefined); // No release manager
      
      const handler = registeredCommands.get('orchestrator.createReleaseFromBranch');
      assert.ok(handler);
      
      await handler();
      
      assert.ok(mockWindow.showErrorMessage.calledWith('Release manager is not available.'));
    });

    test('shows error when git extension not available', async () => {
      sandbox.resetHistory();
      mockExtensions.getExtension.withArgs('vscode.git').returns(undefined);
      
      await commandHandler();
      
      assert.ok(mockWindow.showErrorMessage.calledWith('No git repository found.'));
      assert.ok(!mockReleaseManager.createRelease.called);
    });

    test('shows error when no repositories found', async () => {
      sandbox.resetHistory();
      mockGitApi.repositories = [];
      
      await commandHandler();
      
      assert.ok(mockWindow.showErrorMessage.calledWith('No git repository found.'));
      assert.ok(!mockReleaseManager.createRelease.called);
    });

    test('shows error when current branch cannot be detected', async () => {
      sandbox.resetHistory();
      mockRepo.state.HEAD = undefined;
      
      await commandHandler();
      
      assert.ok(mockWindow.showErrorMessage.calledWith('Could not detect current branch.'));
      assert.ok(!mockReleaseManager.createRelease.called);
    });

    test('shows warning when on main branch', async () => {
      sandbox.resetHistory();
      mockRepo.state.HEAD = { name: 'main' };
      
      await commandHandler();
      
      assert.ok(mockWindow.showWarningMessage.calledWith('Switch to a release branch first.'));
      assert.ok(!mockReleaseManager.createRelease.called);
    });

    test('exits when user cancels name input', async () => {
      sandbox.resetHistory();
      mockRepo.state.HEAD = { name: 'feature/test-branch' };
      mockGitApi.repositories = [mockRepo];
      mockWindow.showInputBox.resolves(undefined); // User cancelled
      
      await commandHandler();
      
      assert.ok(!mockReleaseManager.createRelease.called);
      assert.ok(!mockWindow.showErrorMessage.called);
      assert.ok(!mockWindow.showInformationMessage.called);
    });

    test('shows error when release creation fails', async () => {
      sandbox.resetHistory();
      mockRepo.state.HEAD = { name: 'feature/test-branch' };
      mockGitApi.repositories = [mockRepo];
      mockWindow.showInputBox.resolves('test-name');
      mockReleaseManager.createRelease.rejects(new Error('Creation failed'));
      
      await commandHandler();
      
      assert.ok(mockWindow.showErrorMessage.calledOnce);
      const errorMsg = mockWindow.showErrorMessage.getCall(0).args[0];
      assert.ok(errorMsg.includes('Failed to create release'));
      assert.ok(errorMsg.includes('Creation failed'));
    });
  });

  suite('validation', () => {
    test('validates non-empty release name', async () => {
      sandbox.resetHistory();
      mockRepo.state.HEAD = { name: 'feature/test-branch' };
      mockGitApi.repositories = [mockRepo];
      const mockRelease = { id: 'release-4', name: 'valid-name' };
      mockReleaseManager.createRelease.resolves(mockRelease);
      mockWindow.showInputBox.resolves('valid-name');
      
      await commandHandler();
      
      // Check that input box was called with validation function
      assert.ok(mockWindow.showInputBox.calledOnce);
      const inputBoxOptions = mockWindow.showInputBox.getCall(0).args[0];
      assert.ok(inputBoxOptions.validateInput);
      
      // Test validation function
      const validator = inputBoxOptions.validateInput;
      assert.strictEqual(validator(''), 'Release name is required');
      assert.strictEqual(validator('   '), 'Release name is required');
      assert.strictEqual(validator('valid'), null);
    });

    test('trims whitespace from release name', async () => {
      sandbox.resetHistory();
      mockRepo.state.HEAD = { name: 'feature/test-branch' };
      mockGitApi.repositories = [mockRepo];
      const mockRelease = { id: 'release-5', name: 'trimmed' };
      mockReleaseManager.createRelease.resolves(mockRelease);
      mockWindow.showInputBox.resolves('  trimmed  ');
      
      await commandHandler();
      
      assert.ok(mockReleaseManager.createRelease.calledOnce);
      const createArgs = mockReleaseManager.createRelease.getCall(0).args[0];
      assert.strictEqual(createArgs.name, 'trimmed');
    });
  });

  suite('integration', () => {
    test('opens release panel with correct ID', async () => {
      sandbox.resetHistory();
      mockRepo.state.HEAD = { name: 'feature/test-branch' };
      mockGitApi.repositories = [mockRepo];
      const mockRelease = { id: 'unique-release-id', name: 'test' };
      mockReleaseManager.createRelease.resolves(mockRelease);
      mockWindow.showInputBox.resolves('test');
      
      await commandHandler();
      
      assert.ok(mockCommands.executeCommand.calledOnce);
      assert.ok(mockCommands.executeCommand.calledWith('orchestrator.showReleasePanel', 'unique-release-id'));
    });

    test('displays success message with branch name', async () => {
      sandbox.resetHistory();
      mockRepo.state.HEAD = { name: 'feature/my-feature' };
      mockGitApi.repositories = [mockRepo];
      const mockRelease = { id: 'release-6', name: 'my-feature' };
      mockReleaseManager.createRelease.resolves(mockRelease);
      mockWindow.showInputBox.resolves('my-feature');
      
      await commandHandler();
      
      assert.ok(mockWindow.showInformationMessage.calledOnce);
      const successMsg = mockWindow.showInformationMessage.getCall(0).args[0];
      assert.ok(successMsg.includes('my-feature'));
      assert.ok(successMsg.includes('feature/my-feature'));
    });
  });
});
