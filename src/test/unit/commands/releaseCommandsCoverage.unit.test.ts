/**
 * @fileoverview Coverage tests for releaseCommands.ts
 *
 * Tests command handlers not exercised by createReleaseFromBranch.unit.test.ts:
 * cancelRelease, startRelease, addPlanToRelease, removePlanFromRelease,
 * updateReleaseConfig, retryReleaseMerge, addressPRFeedback,
 * assignToRelease, createReleaseFromPlans, scaffoldReleaseTasks,
 * selectGitAccount, loginGitAccount, showPRCommentDecoration.
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

suite('releaseCommands coverage', () => {
  let sandbox: sinon.SinonSandbox;
  let quiet: { restore: () => void };
  let registeredCommands: Map<string, Function>;
  let mockWindow: any;
  let mockCommands: any;
  let mockExtensions: any;
  let mockReleaseManager: any;
  let mockPlanRunner: any;
  let mockProviderDetector: any;

  // Originals for safe teardown
  let origShowInputBox: any;
  let origShowErrorMessage: any;
  let origShowWarningMessage: any;
  let origShowInformationMessage: any;
  let origShowQuickPick: any;
  let origCreateTerminal: any;
  let origCreateTextEditorDecorationType: any;
  let origExtensions: any;
  let origExecuteCommand: any;
  let origRegisterCommand: any;
  let origVisibleTextEditors: any;
  let origOnDidChangeActiveTextEditor: any;
  let origOpenTextDocument: any;
  let origShowTextDocument: any;
  let origThemeColor: any;

  setup(async () => {
    sandbox = sinon.createSandbox();
    quiet = silenceConsole();

    // Provide ThemeColor constructor (not in the default vscode mock)
    origThemeColor = (vscode as any).ThemeColor;
    (vscode as any).ThemeColor = class ThemeColor { constructor(public readonly id: string) {} };
    registeredCommands = new Map();

    origShowInputBox = (vscode.window as any).showInputBox;
    origShowErrorMessage = (vscode.window as any).showErrorMessage;
    origShowWarningMessage = (vscode.window as any).showWarningMessage;
    origShowInformationMessage = (vscode.window as any).showInformationMessage;
    origShowQuickPick = (vscode.window as any).showQuickPick;
    origCreateTerminal = (vscode.window as any).createTerminal;
    origCreateTextEditorDecorationType = (vscode.window as any).createTextEditorDecorationType;
    origVisibleTextEditors = (vscode.window as any).visibleTextEditors;
    origOnDidChangeActiveTextEditor = (vscode.window as any).onDidChangeActiveTextEditor;
    origOpenTextDocument = (vscode.workspace as any).openTextDocument;
    origShowTextDocument = (vscode.window as any).showTextDocument;
    origExtensions = (vscode as any).extensions;
    origExecuteCommand = (vscode.commands as any).executeCommand;
    origRegisterCommand = (vscode.commands as any).registerCommand;

    mockWindow = {
      showInputBox: sandbox.stub().resolves(undefined),
      showErrorMessage: sandbox.stub().resolves(undefined),
      showWarningMessage: sandbox.stub().resolves(undefined),
      showInformationMessage: sandbox.stub().resolves(undefined),
      showQuickPick: sandbox.stub().resolves(undefined),
      createTerminal: sandbox.stub().returns({ sendText: sandbox.stub(), show: sandbox.stub() }),
      createTextEditorDecorationType: sandbox.stub().returns({ dispose: sandbox.stub() }),
      visibleTextEditors: [],
      onDidChangeActiveTextEditor: sandbox.stub().returns({ dispose: sandbox.stub() }),
      showTextDocument: sandbox.stub().resolves({}),
    };
    (vscode.window as any).showInputBox = mockWindow.showInputBox;
    (vscode.window as any).showErrorMessage = mockWindow.showErrorMessage;
    (vscode.window as any).showWarningMessage = mockWindow.showWarningMessage;
    (vscode.window as any).showInformationMessage = mockWindow.showInformationMessage;
    (vscode.window as any).showQuickPick = mockWindow.showQuickPick;
    (vscode.window as any).createTerminal = mockWindow.createTerminal;
    (vscode.window as any).createTextEditorDecorationType = mockWindow.createTextEditorDecorationType;
    (vscode.window as any).visibleTextEditors = mockWindow.visibleTextEditors;
    (vscode.window as any).onDidChangeActiveTextEditor = mockWindow.onDidChangeActiveTextEditor;
    (vscode.window as any).showTextDocument = mockWindow.showTextDocument;

    (vscode.workspace as any).openTextDocument = sandbox.stub().resolves({});

    mockCommands = { executeCommand: sandbox.stub() };
    (vscode.commands as any).executeCommand = mockCommands.executeCommand;

    mockExtensions = { getExtension: sandbox.stub().returns(undefined) };
    (vscode as any).extensions = mockExtensions;

    (vscode.commands as any).registerCommand = sandbox.stub().callsFake((name: string, cb: Function) => {
      registeredCommands.set(name, cb);
      return { dispose: () => {} };
    });

    mockReleaseManager = {
      createRelease: sandbox.stub().resolves({ id: 'rel-new', name: 'New Release' }),
      getReleasesByStatus: sandbox.stub().returns([]),
    };

    mockPlanRunner = {
      get: sandbox.stub().returns(undefined),
      getAll: sandbox.stub().returns([]),
      getStateMachine: sandbox.stub().returns({ computePlanStatus: () => 'succeeded' }),
    };

    mockProviderDetector = {
      detect: sandbox.stub().resolves({ type: 'github', owner: 'testorg', hostname: 'github.com' }),
      listAccounts: sandbox.stub().resolves([]),
    };

    const context = { subscriptions: [], extensionUri: { fsPath: '/ext' } } as any;
    // Use a fresh import each test suite run by using require (cached by Node)
    const { registerReleaseCommands } = require('../../../commands/releaseCommands');
    registerReleaseCommands(context, () => undefined, mockReleaseManager, mockPlanRunner, mockProviderDetector);
  });

  teardown(() => {
    quiet.restore();
    sandbox.restore();
    (vscode.window as any).showInputBox = origShowInputBox;
    (vscode.window as any).showErrorMessage = origShowErrorMessage;
    (vscode.window as any).showWarningMessage = origShowWarningMessage;
    (vscode.window as any).showInformationMessage = origShowInformationMessage;
    (vscode.window as any).showQuickPick = origShowQuickPick;
    (vscode.window as any).createTerminal = origCreateTerminal;
    (vscode.window as any).createTextEditorDecorationType = origCreateTextEditorDecorationType;
    (vscode.window as any).visibleTextEditors = origVisibleTextEditors;
    (vscode.window as any).onDidChangeActiveTextEditor = origOnDidChangeActiveTextEditor;
    (vscode.workspace as any).openTextDocument = origOpenTextDocument;
    (vscode.window as any).showTextDocument = origShowTextDocument;
    (vscode as any).extensions = origExtensions;
    (vscode.commands as any).executeCommand = origExecuteCommand;
    (vscode.commands as any).registerCommand = origRegisterCommand;
    (vscode as any).ThemeColor = origThemeColor;
    registeredCommands.clear();
  });

  // ── cancelRelease ──────────────────────────────────────────────────────────

  suite('cancelRelease', () => {
    test('does nothing when user says No', async () => {
      mockWindow.showWarningMessage.resolves('No');
      await registeredCommands.get('orchestrator.cancelRelease')?.('rel-1');
      assert.ok(mockWindow.showInformationMessage.notCalled);
    });

    test('shows canceled message when user confirms Yes', async () => {
      mockWindow.showWarningMessage.resolves('Yes');
      await registeredCommands.get('orchestrator.cancelRelease')?.('rel-1');
      assert.ok(mockWindow.showInformationMessage.calledOnce);
      assert.ok(mockWindow.showInformationMessage.firstCall.args[0].includes('canceled'));
    });

    test('does nothing when user dismisses warning dialog', async () => {
      mockWindow.showWarningMessage.resolves(undefined);
      await registeredCommands.get('orchestrator.cancelRelease')?.('rel-1');
      assert.ok(mockWindow.showInformationMessage.notCalled);
    });
  });

  // ── startRelease ───────────────────────────────────────────────────────────

  suite('startRelease', () => {
    test('shows not implemented message', async () => {
      await registeredCommands.get('orchestrator.startRelease')?.('rel-1');
      assert.ok(mockWindow.showInformationMessage.calledOnce);
      assert.ok(mockWindow.showInformationMessage.firstCall.args[0].includes('rel-1'));
    });
  });

  // ── addPlanToRelease / removePlanFromRelease / updateReleaseConfig / retryReleaseMerge / addressPRFeedback ──

  suite('stub commands', () => {
    test('addPlanToRelease shows message', async () => {
      await registeredCommands.get('orchestrator.addPlanToRelease')?.('rel-1', 'plan-1');
      assert.ok(mockWindow.showInformationMessage.calledOnce);
    });

    test('removePlanFromRelease shows message', async () => {
      await registeredCommands.get('orchestrator.removePlanFromRelease')?.('rel-1', 'plan-1');
      assert.ok(mockWindow.showInformationMessage.calledOnce);
    });

    test('updateReleaseConfig shows message', async () => {
      await registeredCommands.get('orchestrator.updateReleaseConfig')?.('rel-1', {});
      assert.ok(mockWindow.showInformationMessage.calledOnce);
    });

    test('retryReleaseMerge shows message', async () => {
      await registeredCommands.get('orchestrator.retryReleaseMerge')?.('rel-1', 'plan-1');
      assert.ok(mockWindow.showInformationMessage.calledOnce);
    });

    test('addressPRFeedback shows message', async () => {
      await registeredCommands.get('orchestrator.addressPRFeedback')?.('rel-1', 'feedback-1');
      assert.ok(mockWindow.showInformationMessage.calledOnce);
    });
  });

  // ── assignToRelease ────────────────────────────────────────────────────────

  suite('assignToRelease', () => {
    test('shows error when releaseManager missing', async () => {
      registeredCommands.clear();
      const context = { subscriptions: [] } as any;
      const { registerReleaseCommands } = require('../../../commands/releaseCommands');
      registerReleaseCommands(context, () => undefined /* no manager */);
      await registeredCommands.get('orchestrator.assignToRelease')?.(['plan-1']);
      assert.ok(mockWindow.showErrorMessage.calledOnce);
    });

    test('shows error when plans not in succeeded/partial status', async () => {
      mockPlanRunner.get.returns({ id: 'plan-1', name: 'P1' });
      mockPlanRunner.getStateMachine.returns({ computePlanStatus: () => 'running' });
      await registeredCommands.get('orchestrator.assignToRelease')?.(['plan-1']);
      assert.ok(mockWindow.showErrorMessage.calledOnce);
      assert.ok(mockWindow.showErrorMessage.firstCall.args[0].includes('Cannot assign'));
    });

    test('shows error for plan that does not exist', async () => {
      mockPlanRunner.get.returns(undefined); // plan not found
      await registeredCommands.get('orchestrator.assignToRelease')?.(['nonexistent-plan']);
      assert.ok(mockWindow.showErrorMessage.calledOnce);
    });

    test('returns without action when user cancels quick pick', async () => {
      mockPlanRunner.get.returns({ id: 'plan-1' });
      mockPlanRunner.getStateMachine.returns({ computePlanStatus: () => 'succeeded' });
      mockReleaseManager.getReleasesByStatus.returns([]);
      mockWindow.showQuickPick.resolves(undefined); // user cancelled
      await registeredCommands.get('orchestrator.assignToRelease')?.(['plan-1']);
      assert.ok(mockCommands.executeCommand.notCalled);
    });

    test('executes createReleaseFromPlans when user selects Create New', async () => {
      mockPlanRunner.get.returns({ id: 'plan-1' });
      mockPlanRunner.getStateMachine.returns({ computePlanStatus: () => 'succeeded' });
      mockReleaseManager.getReleasesByStatus.returns([]);
      mockWindow.showQuickPick.resolves({ label: '$(plus) Create New Release' });
      await registeredCommands.get('orchestrator.assignToRelease')?.(['plan-1']);
      assert.ok(mockCommands.executeCommand.calledWith('orchestrator.createReleaseFromPlans'));
    });

    test('shows info when user selects existing release', async () => {
      mockPlanRunner.get.returns({ id: 'plan-1' });
      mockPlanRunner.getStateMachine.returns({ computePlanStatus: () => 'succeeded' });
      const existingRelease = { id: 'rel-1', name: 'Release 1', planIds: [], releaseBranch: 'release/v1', targetBranch: 'main' };
      mockReleaseManager.getReleasesByStatus.returns([existingRelease]);
      mockWindow.showQuickPick.resolves({ label: 'Release 1' });
      await registeredCommands.get('orchestrator.assignToRelease')?.(['plan-1']);
      assert.ok(mockWindow.showInformationMessage.calledOnce);
    });
  });

  // ── createReleaseFromPlans ─────────────────────────────────────────────────

  suite('createReleaseFromPlans', () => {
    test('shows error when releaseManager missing', async () => {
      registeredCommands.clear();
      const context = { subscriptions: [] } as any;
      const { registerReleaseCommands } = require('../../../commands/releaseCommands');
      registerReleaseCommands(context, () => undefined /* no managers */);
      await registeredCommands.get('orchestrator.createReleaseFromPlans')?.(['plan-1']);
      assert.ok(mockWindow.showErrorMessage.calledOnce);
    });

    test('shows error when plans not in valid status', async () => {
      mockPlanRunner.get.returns({ id: 'plan-1' });
      mockPlanRunner.getStateMachine.returns({ computePlanStatus: () => 'failed' });
      await registeredCommands.get('orchestrator.createReleaseFromPlans')?.(['plan-1']);
      assert.ok(mockWindow.showErrorMessage.calledOnce);
      assert.ok(mockWindow.showErrorMessage.firstCall.args[0].includes('Cannot create release'));
    });

    test('shows error for nonexistent plan', async () => {
      mockPlanRunner.get.returns(undefined);
      await registeredCommands.get('orchestrator.createReleaseFromPlans')?.(['bad-plan']);
      assert.ok(mockWindow.showErrorMessage.calledOnce);
    });

    test('returns when name input cancelled', async () => {
      mockPlanRunner.get.returns({ id: 'plan-1' });
      mockPlanRunner.getStateMachine.returns({ computePlanStatus: () => 'succeeded' });
      mockWindow.showInputBox.resolves(undefined); // cancel
      await registeredCommands.get('orchestrator.createReleaseFromPlans')?.(['plan-1']);
      assert.ok(mockReleaseManager.createRelease.notCalled);
    });

    test('returns when branch input cancelled', async () => {
      mockPlanRunner.get.returns({ id: 'plan-1' });
      mockPlanRunner.getStateMachine.returns({ computePlanStatus: () => 'succeeded' });
      mockWindow.showInputBox.onFirstCall().resolves('v1.0.0');
      mockWindow.showInputBox.onSecondCall().resolves(undefined); // cancel branch
      await registeredCommands.get('orchestrator.createReleaseFromPlans')?.(['plan-1']);
      assert.ok(mockReleaseManager.createRelease.notCalled);
    });

    test('returns when target branch input cancelled', async () => {
      mockPlanRunner.get.returns({ id: 'plan-1' });
      mockPlanRunner.getStateMachine.returns({ computePlanStatus: () => 'succeeded' });
      mockWindow.showInputBox.onFirstCall().resolves('v1.0.0');
      mockWindow.showInputBox.onSecondCall().resolves('release/v1.0.0');
      mockWindow.showInputBox.onThirdCall().resolves(undefined); // cancel target
      await registeredCommands.get('orchestrator.createReleaseFromPlans')?.(['plan-1']);
      assert.ok(mockReleaseManager.createRelease.notCalled);
    });

    test('creates release and shows success message', async () => {
      mockPlanRunner.get.returns({ id: 'plan-1' });
      mockPlanRunner.getStateMachine.returns({ computePlanStatus: () => 'succeeded' });
      mockWindow.showInputBox.onFirstCall().resolves('v1.0.0');
      mockWindow.showInputBox.onSecondCall().resolves('release/v1.0.0');
      mockWindow.showInputBox.onThirdCall().resolves('main');
      mockReleaseManager.createRelease.resolves({ id: 'rel-new', name: 'v1.0.0' });
      await registeredCommands.get('orchestrator.createReleaseFromPlans')?.(['plan-1']);
      assert.ok(mockReleaseManager.createRelease.calledOnce);
      assert.ok(mockWindow.showInformationMessage.calledOnce);
    });

    test('shows error when createRelease throws', async () => {
      mockPlanRunner.get.returns({ id: 'plan-1' });
      mockPlanRunner.getStateMachine.returns({ computePlanStatus: () => 'succeeded' });
      mockWindow.showInputBox.onFirstCall().resolves('v1.0.0');
      mockWindow.showInputBox.onSecondCall().resolves('release/v1.0.0');
      mockWindow.showInputBox.onThirdCall().resolves('main');
      mockReleaseManager.createRelease.rejects(new Error('DB error'));
      await registeredCommands.get('orchestrator.createReleaseFromPlans')?.(['plan-1']);
      assert.ok(mockWindow.showErrorMessage.calledOnce);
    });
  });

  // ── scaffoldReleaseTasks ───────────────────────────────────────────────────

  suite('scaffoldReleaseTasks', () => {
    test('shows error when no git repo found', async () => {
      mockExtensions.getExtension.returns(undefined);
      await registeredCommands.get('orchestrator.scaffoldReleaseTasks')?.();
      assert.ok(mockWindow.showErrorMessage.calledOnce);
    });

    test('returns when user cancels confirmation', async () => {
      const mockGit = { repositories: [{ rootUri: { fsPath: '/repo' } }] };
      mockExtensions.getExtension.returns({ exports: { getAPI: () => mockGit } });
      mockWindow.showInformationMessage.resolves('Cancel');
      await registeredCommands.get('orchestrator.scaffoldReleaseTasks')?.();
      // Should not proceed to scaffold
    });
  });

  // ── selectGitAccount ──────────────────────────────────────────────────────

  suite('selectGitAccount', () => {
    test('shows error when providerDetector not available', async () => {
      registeredCommands.clear();
      const context = { subscriptions: [] } as any;
      const { registerReleaseCommands } = require('../../../commands/releaseCommands');
      registerReleaseCommands(context, () => undefined, mockReleaseManager, mockPlanRunner /* no providerDetector */);
      await registeredCommands.get('orchestrator.selectGitAccount')?.();
      assert.ok(mockWindow.showErrorMessage.calledOnce);
      assert.ok(mockWindow.showErrorMessage.firstCall.args[0].includes('Provider detector'));
    });

    test('shows error when no git repo found', async () => {
      mockExtensions.getExtension.returns(undefined);
      await registeredCommands.get('orchestrator.selectGitAccount')?.();
      assert.ok(mockWindow.showErrorMessage.calledOnce);
    });

    test('shows error when no accounts found', async () => {
      const mockGit = { repositories: [{ rootUri: { fsPath: '/repo' } }] };
      mockExtensions.getExtension.returns({ exports: { getAPI: () => mockGit } });
      mockProviderDetector.listAccounts.resolves([]);
      await registeredCommands.get('orchestrator.selectGitAccount')?.();
      assert.ok(mockWindow.showErrorMessage.calledOnce);
      assert.ok(mockWindow.showErrorMessage.firstCall.args[0].includes('No accounts'));
    });

    test('returns when user cancels account selection', async () => {
      const mockGit = { repositories: [{ rootUri: { fsPath: '/repo' } }] };
      mockExtensions.getExtension.returns({ exports: { getAPI: () => mockGit } });
      mockProviderDetector.listAccounts.resolves(['user1', 'user2']);
      mockWindow.showQuickPick.resolves(undefined); // cancelled
      await registeredCommands.get('orchestrator.selectGitAccount')?.();
      assert.ok(mockWindow.createTerminal.notCalled);
    });

    test('sets git config when user selects account', async () => {
      const mockGit = { repositories: [{ rootUri: { fsPath: '/repo' } }] };
      mockExtensions.getExtension.returns({ exports: { getAPI: () => mockGit } });
      mockProviderDetector.listAccounts.resolves(['testuser']);
      mockWindow.showQuickPick.resolves({ label: 'testuser' });
      await registeredCommands.get('orchestrator.selectGitAccount')?.();
      assert.ok(mockWindow.createTerminal.calledOnce);
      assert.ok(mockWindow.showInformationMessage.calledOnce);
    });

    test('handles detect error gracefully', async () => {
      const mockGit = { repositories: [{ rootUri: { fsPath: '/repo' } }] };
      mockExtensions.getExtension.returns({ exports: { getAPI: () => mockGit } });
      mockProviderDetector.detect.rejects(new Error('detect failed'));
      await registeredCommands.get('orchestrator.selectGitAccount')?.();
      assert.ok(mockWindow.showErrorMessage.calledOnce);
    });

    test('shows recommended account hint for github-enterprise', async () => {
      const mockGit = { repositories: [{ rootUri: { fsPath: '/repo' } }] };
      mockExtensions.getExtension.returns({ exports: { getAPI: () => mockGit } });
      mockProviderDetector.detect.resolves({ type: 'github-enterprise', owner: 'myorg', hostname: 'github.mycompany.com' });
      mockProviderDetector.listAccounts.resolves(['myorg_user', 'other_user']);
      mockWindow.showQuickPick.resolves({ label: 'myorg_user' });
      await registeredCommands.get('orchestrator.selectGitAccount')?.();
      const pickArgs = mockWindow.showQuickPick.firstCall.args[0];
      const recommendedItem = pickArgs.find((i: any) => i.label === 'myorg_user');
      assert.ok(recommendedItem);
    });
  });

  // ── loginGitAccount ────────────────────────────────────────────────────────

  suite('loginGitAccount', () => {
    test('shows error when providerDetector not available', async () => {
      registeredCommands.clear();
      const context = { subscriptions: [] } as any;
      const { registerReleaseCommands } = require('../../../commands/releaseCommands');
      registerReleaseCommands(context, () => undefined, mockReleaseManager, mockPlanRunner /* no providerDetector */);
      await registeredCommands.get('orchestrator.loginGitAccount')?.();
      assert.ok(mockWindow.showErrorMessage.calledOnce);
    });

    test('shows error when no git repo found', async () => {
      mockExtensions.getExtension.returns(undefined);
      await registeredCommands.get('orchestrator.loginGitAccount')?.();
      assert.ok(mockWindow.showErrorMessage.calledOnce);
    });

    test('runs gh login for github provider', async () => {
      const mockGit = { repositories: [{ rootUri: { fsPath: '/repo' } }] };
      mockExtensions.getExtension.returns({ exports: { getAPI: () => mockGit } });
      mockProviderDetector.detect.resolves({ type: 'github', owner: 'testorg', hostname: 'github.com' });
      await registeredCommands.get('orchestrator.loginGitAccount')?.();
      const terminal = mockWindow.createTerminal.returnValues[0];
      assert.ok(terminal.sendText.calledWith('git credential-manager github login'));
      assert.ok(terminal.show.calledOnce);
    });

    test('runs gh login with hostname for github-enterprise', async () => {
      const mockGit = { repositories: [{ rootUri: { fsPath: '/repo' } }] };
      mockExtensions.getExtension.returns({ exports: { getAPI: () => mockGit } });
      mockProviderDetector.detect.resolves({ type: 'github-enterprise', owner: 'org', hostname: 'github.corp.com' });
      await registeredCommands.get('orchestrator.loginGitAccount')?.();
      const terminal = mockWindow.createTerminal.returnValues[0];
      assert.ok(terminal.sendText.firstCall.args[0].includes('github.corp.com'));
    });

    test('runs az login for azure-devops provider', async () => {
      const mockGit = { repositories: [{ rootUri: { fsPath: '/repo' } }] };
      mockExtensions.getExtension.returns({ exports: { getAPI: () => mockGit } });
      mockProviderDetector.detect.resolves({ type: 'azure-devops', owner: 'org', hostname: 'dev.azure.com' });
      await registeredCommands.get('orchestrator.loginGitAccount')?.();
      const terminal = mockWindow.createTerminal.returnValues[0];
      assert.ok(terminal.sendText.calledWith('az login'));
    });

    test('shows error for unsupported provider type', async () => {
      const mockGit = { repositories: [{ rootUri: { fsPath: '/repo' } }] };
      mockExtensions.getExtension.returns({ exports: { getAPI: () => mockGit } });
      mockProviderDetector.detect.resolves({ type: 'bitbucket', owner: 'org' });
      await registeredCommands.get('orchestrator.loginGitAccount')?.();
      assert.ok(mockWindow.showErrorMessage.calledOnce);
    });

    test('handles detect error gracefully', async () => {
      const mockGit = { repositories: [{ rootUri: { fsPath: '/repo' } }] };
      mockExtensions.getExtension.returns({ exports: { getAPI: () => mockGit } });
      mockProviderDetector.detect.rejects(new Error('network error'));
      await registeredCommands.get('orchestrator.loginGitAccount')?.();
      assert.ok(mockWindow.showErrorMessage.calledOnce);
    });
  });

  // ── showPRCommentDecoration ────────────────────────────────────────────────

  suite('showPRCommentDecoration', () => {
    test('creates decoration type and sets decorations on visible editor', async () => {
      const mockEditor = {
        document: { uri: { fsPath: '/repo/src/file.ts' } },
        setDecorations: sandbox.stub(),
      };
      (vscode.window as any).visibleTextEditors = [mockEditor];

      const mockDecoType = { dispose: sandbox.stub() };
      mockWindow.createTextEditorDecorationType.returns(mockDecoType);

      const handler = registeredCommands.get('orchestrator.showPRCommentDecoration');
      handler?.('/repo/src/file.ts', 10, 'reviewer', 'Fix this bug', 'review');

      assert.ok(mockWindow.createTextEditorDecorationType.calledOnce);
    });

    test('uses codeql theme colors for codeql source', async () => {
      const mockEditor = {
        document: { uri: { fsPath: '/repo/src/file.ts' } },
        setDecorations: sandbox.stub(),
      };
      (vscode.window as any).visibleTextEditors = [mockEditor];
      mockWindow.createTextEditorDecorationType.returns({ dispose: sandbox.stub() });

      const handler = registeredCommands.get('orchestrator.showPRCommentDecoration');
      handler?.('/repo/src/file.ts', 5, 'bot', 'Security issue', 'codeql');

      assert.ok(mockWindow.createTextEditorDecorationType.calledOnce);
    });

    test('truncates long comment body to 100 chars', async () => {
      (vscode.window as any).visibleTextEditors = [];
      mockWindow.onDidChangeActiveTextEditor.returns({ dispose: sandbox.stub() });
      mockWindow.createTextEditorDecorationType.returns({ dispose: sandbox.stub() });

      const longBody = 'A'.repeat(150);
      const handler = registeredCommands.get('orchestrator.showPRCommentDecoration');
      handler?.('/repo/src/file.ts', 1, 'reviewer', longBody, 'review');

      const decoArgs = mockWindow.createTextEditorDecorationType.firstCall.args[0];
      assert.ok(decoArgs.after.contentText.includes('...'));
    });
  });

  // ── showReleasePanel ───────────────────────────────────────────────────────

  suite('showReleasePanel', () => {
    test('shows error when releaseManager not initialized', async () => {
      registeredCommands.clear();
      const context = { subscriptions: [], extensionUri: { fsPath: '/ext' } } as any;
      const { registerReleaseCommands } = require('../../../commands/releaseCommands');
      registerReleaseCommands(context, () => undefined /* no releaseManager */);
      await registeredCommands.get('orchestrator.showReleasePanel')?.('rel-1');
      assert.ok(mockWindow.showErrorMessage.calledOnce);
    });
  });
});
