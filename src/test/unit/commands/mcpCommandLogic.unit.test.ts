/**
 * @fileoverview Unit tests for MCP command logic.
 * 
 * Tests the pure business logic for MCP server management and configuration
 * using mock service adapters for dependency injection.
 * 
 * @module test/unit/commands/mcpCommandLogic.unit.test
 */

import * as assert from 'assert';
import { suite, test, setup, teardown } from 'mocha';
import * as sinon from 'sinon';
import { 
  generateMcpConnectionInfo, 
  handleHowToConnect, 
  handlePromptMcpStart,
  type CommandExecutor,
  type HowToConnectChoice,
  type McpStartChoice
} from '../../../commands/mcpCommandLogic';
import { 
  MockDialogService, 
  MockClipboardService, 
  MockConfigProvider 
} from '../../../vscode/testAdapters';

suite('MCP Command Logic Unit Tests', () => {
  let mockDialog: MockDialogService;
  let mockClipboard: MockClipboardService;
  let mockConfig: MockConfigProvider;
  let mockCommandExecutor: sinon.SinonStubbedInstance<CommandExecutor>;

  setup(() => {
    mockDialog = new MockDialogService();
    mockClipboard = new MockClipboardService();
    mockConfig = new MockConfigProvider();
    mockCommandExecutor = {
      executeCommand: sinon.stub()
    };
  });

  teardown(() => {
    mockDialog.reset();
    mockClipboard.reset();
    mockConfig.reset();
    sinon.restore();
  });

  suite('generateMcpConnectionInfo', () => {
    test('should generate connection info with correct content', () => {
      const result = generateMcpConnectionInfo();
      
      assert.ok(result.includes('Copilot Orchestrator MCP Server'));
      assert.ok(result.includes('stdio transport'));
      assert.ok(result.includes('create_copilot_plan'));
      assert.ok(result.includes('get_copilot_plan_status'));
      assert.ok(result.includes('list_copilot_plans'));
      assert.ok(result.includes('cancel_copilot_plan'));
      assert.ok(result.includes('MCP: List Servers'));
    });

    test('should handle optional endpoint parameter', () => {
      const result = generateMcpConnectionInfo('test-endpoint');
      
      // Should still return standard template regardless of endpoint
      assert.ok(result.includes('Copilot Orchestrator MCP Server'));
    });

    test('should return consistent multiline format', () => {
      const result = generateMcpConnectionInfo();
      
      assert.ok(/^Copilot Orchestrator MCP Server\n\n/.test(result));
      assert.ok(result.includes('\n- create_copilot_plan'));
      assert.ok(result.includes('\n- cancel_copilot_plan'));
    });
  });

  suite('handleHowToConnect', () => {
    test('should handle undefined choice (user cancelled)', async () => {
      await handleHowToConnect(undefined, { 
        dialog: mockDialog, 
        clipboard: mockClipboard, 
        config: mockConfig 
      });

      assert.strictEqual(mockDialog.getCalls().length, 0);
      assert.strictEqual(mockClipboard.getCalls().length, 0);
    });

    test('should handle "Start Server" choice successfully', async () => {
      await handleHowToConnect('Start Server', { 
        dialog: mockDialog, 
        clipboard: mockClipboard, 
        config: mockConfig 
      }, mockCommandExecutor);

      const dialogCalls = mockDialog.getCalls();
      assert.strictEqual(dialogCalls.length, 1);
      assert.strictEqual(dialogCalls[0].method, 'showInfo');
      assert.ok(dialogCalls[0].args[0].includes('MCP server started!'));

      assert.ok(mockCommandExecutor.executeCommand.calledOnce);
      assert.strictEqual(mockCommandExecutor.executeCommand.firstCall.args[0], 'workbench.action.chat.startMcpServer');
      assert.strictEqual(mockCommandExecutor.executeCommand.firstCall.args[1], 'copilot-orchestrator.mcp-server');
    });

    test('should handle "Start Server" choice with command failure', async () => {
      mockCommandExecutor.executeCommand.onFirstCall().rejects(new Error('Command failed'));

      await handleHowToConnect('Start Server', { 
        dialog: mockDialog, 
        clipboard: mockClipboard, 
        config: mockConfig 
      }, mockCommandExecutor);

      assert.ok(mockCommandExecutor.executeCommand.calledTwice);
      assert.strictEqual(mockCommandExecutor.executeCommand.firstCall.args[0], 'workbench.action.chat.startMcpServer');
      assert.strictEqual(mockCommandExecutor.executeCommand.secondCall.args[0], 'workbench.action.chat.listMcpServers');
    });

    test('should handle "Start Server" choice without command executor', async () => {
      await handleHowToConnect('Start Server', { 
        dialog: mockDialog, 
        clipboard: mockClipboard, 
        config: mockConfig 
      });

      const dialogCalls = mockDialog.getCalls();
      assert.strictEqual(dialogCalls.length, 1);
      assert.strictEqual(dialogCalls[0].method, 'showInfo');
      assert.ok(dialogCalls[0].args[0].includes('MCP server started!'));
    });

    test('should handle "Start Server" choice command failure without executor', async () => {
      // This test specifically covers the fallback dialog call at lines 110-112
      // when there's an error and no command executor
      // Mock dialog.showInfo to throw an error to trigger the catch block
      const originalShowInfo = mockDialog.showInfo.bind(mockDialog);
      let callCount = 0;
      mockDialog.showInfo = async (message: string) => {
        callCount++;
        if (callCount === 1) {
          // First call (line 103) throws an error
          throw new Error('Dialog failed');
        }
        // Second call (line 111) succeeds
        return originalShowInfo(message);
      };

      await handleHowToConnect('Start Server', { 
        dialog: mockDialog, 
        clipboard: mockClipboard, 
        config: mockConfig 
      });

      // Should have called showInfo twice: first failed, second succeeded in catch block
      assert.strictEqual(callCount, 2);
    });

    test('should handle "List Servers" choice', async () => {
      await handleHowToConnect('List Servers', { 
        dialog: mockDialog, 
        clipboard: mockClipboard, 
        config: mockConfig 
      }, mockCommandExecutor);

      assert.ok(mockCommandExecutor.executeCommand.calledOnce);
      assert.strictEqual(mockCommandExecutor.executeCommand.firstCall.args[0], 'workbench.action.chat.listMcpServers');
    });

    test('should handle "List Servers" choice without command executor', async () => {
      await handleHowToConnect('List Servers', { 
        dialog: mockDialog, 
        clipboard: mockClipboard, 
        config: mockConfig 
      });

      const dialogCalls = mockDialog.getCalls();
      assert.strictEqual(dialogCalls.length, 1);
      assert.strictEqual(dialogCalls[0].method, 'showInfo');
      assert.ok(dialogCalls[0].args[0].includes('Opening MCP server list'));
    });

    test('should handle "Copy Info" choice', async () => {
      await handleHowToConnect('Copy Info', { 
        dialog: mockDialog, 
        clipboard: mockClipboard, 
        config: mockConfig 
      });

      const clipboardCalls = mockClipboard.getCalls();
      assert.strictEqual(clipboardCalls.length, 1);
      assert.strictEqual(clipboardCalls[0].method, 'writeText');
      assert.ok(clipboardCalls[0].args[0].includes('Copilot Orchestrator MCP Server'));

      const dialogCalls = mockDialog.getCalls();
      assert.strictEqual(dialogCalls.length, 1);
      assert.strictEqual(dialogCalls[0].method, 'showInfo');
      assert.ok(dialogCalls[0].args[0].includes('copied to clipboard'));
    });

    test('should handle unknown choice gracefully', async () => {
      const consoleSpy = sinon.spy(console, 'warn');

      await handleHowToConnect('Unknown Choice' as HowToConnectChoice, { 
        dialog: mockDialog, 
        clipboard: mockClipboard, 
        config: mockConfig 
      });

      assert.ok(consoleSpy.calledOnce);
      assert.ok(consoleSpy.firstCall.args[0].includes('Unknown choice'));
      assert.strictEqual(mockDialog.getCalls().length, 0);
    });
  });

  suite('handlePromptMcpStart', () => {
    test('should show warning when MCP is disabled', async () => {
      mockConfig.setConfigValue('copilotOrchestrator.mcp', 'enabled', false);

      await handlePromptMcpStart({ dialog: mockDialog, config: mockConfig });

      const dialogCalls = mockDialog.getCalls();
      assert.strictEqual(dialogCalls.length, 1);
      assert.strictEqual(dialogCalls[0].method, 'showWarning');
      assert.ok(dialogCalls[0].args[0].includes('MCP server is disabled'));
    });

    test('should proceed when MCP is enabled (default true)', async () => {
      mockDialog.setWarningResponse('Start Server');

      await handlePromptMcpStart({ dialog: mockDialog, config: mockConfig }, mockCommandExecutor);

      const dialogCalls = mockDialog.getCalls();
      assert.strictEqual(dialogCalls.length, 2); // First for prompt, second for success
      assert.strictEqual(dialogCalls[0].method, 'showWarning');
      assert.ok(dialogCalls[0].args[0].includes('Start the Copilot Orchestrator MCP server'));
      assert.strictEqual(dialogCalls[1].method, 'showInfo');
      assert.ok(dialogCalls[1].args[0].includes('MCP server started'));
    });

    test('should handle "Start Server" choice successfully', async () => {
      mockDialog.setWarningResponse('Start Server');

      await handlePromptMcpStart({ dialog: mockDialog, config: mockConfig }, mockCommandExecutor);

      assert.ok(mockCommandExecutor.executeCommand.calledOnce);
      assert.strictEqual(mockCommandExecutor.executeCommand.firstCall.args[0], 'workbench.action.chat.startMcpServer');
      assert.strictEqual(mockCommandExecutor.executeCommand.firstCall.args[1], 'copilot-orchestrator.mcp-server');
    });

    test('should handle "Start Server" choice with command failure', async () => {
      mockDialog.setWarningResponse('Start Server');
      mockCommandExecutor.executeCommand.onFirstCall().rejects(new Error('Start failed'));

      await handlePromptMcpStart({ dialog: mockDialog, config: mockConfig }, mockCommandExecutor);

      assert.ok(mockCommandExecutor.executeCommand.calledTwice);
      assert.strictEqual(mockCommandExecutor.executeCommand.secondCall.args[0], 'workbench.action.chat.listMcpServers');
    });

    test('should handle "Open MCP List" choice', async () => {
      mockDialog.setWarningResponse('Open MCP List');

      await handlePromptMcpStart({ dialog: mockDialog, config: mockConfig }, mockCommandExecutor);

      assert.ok(mockCommandExecutor.executeCommand.calledOnce);
      assert.strictEqual(mockCommandExecutor.executeCommand.firstCall.args[0], 'workbench.action.chat.listMcpServers');
    });

    test('should handle user cancellation', async () => {
      mockDialog.setWarningResponse(undefined);

      await handlePromptMcpStart({ dialog: mockDialog, config: mockConfig });

      const dialogCalls = mockDialog.getCalls();
      assert.strictEqual(dialogCalls.length, 1); // Only the prompt dialog
    });

    test('should handle unknown choice gracefully', async () => {
      mockDialog.setWarningResponse('Unknown Choice' as McpStartChoice);
      const consoleSpy = sinon.spy(console, 'warn');

      await handlePromptMcpStart({ dialog: mockDialog, config: mockConfig });

      assert.ok(consoleSpy.calledOnce);
      assert.ok(consoleSpy.firstCall.args[0].includes('Unknown choice'));
    });

    test('should work without command executor in test mode', async () => {
      mockDialog.setWarningResponse('Start Server');

      await handlePromptMcpStart({ dialog: mockDialog, config: mockConfig });

      const dialogCalls = mockDialog.getCalls();
      assert.strictEqual(dialogCalls.length, 2); // Prompt and success message
      assert.strictEqual(dialogCalls[1].method, 'showInfo');
      assert.ok(dialogCalls[1].args[0].includes('MCP server started'));
    });

    test('should handle "Start Server" choice command failure without executor', async () => {
      // This test specifically covers the fallback dialog call at lines 195-197
      // when there's an error and no command executor in prompt MCP start
      mockDialog.setWarningResponse('Start Server');

      // Mock dialog.showInfo to throw an error to trigger the catch block
      const originalShowInfo = mockDialog.showInfo.bind(mockDialog);
      let callCount = 0;
      mockDialog.showInfo = async (message: string) => {
        callCount++;
        if (callCount === 1) {
          // First call (line 185) throws an error
          throw new Error('Dialog failed');
        }
        // Second call (line 196) succeeds
        return originalShowInfo(message);
      };

      await handlePromptMcpStart({ dialog: mockDialog, config: mockConfig });

      // Should have called showInfo twice: first failed, second succeeded in catch block
      assert.strictEqual(callCount, 2);
    });

    test('should handle "Open MCP List" choice without executor', async () => {
      // This test specifically covers lines 205-207
      mockDialog.setWarningResponse('Open MCP List');

      await handlePromptMcpStart({ dialog: mockDialog, config: mockConfig });

      const dialogCalls = mockDialog.getCalls();
      assert.strictEqual(dialogCalls.length, 2); // Prompt and success message
      assert.strictEqual(dialogCalls[0].method, 'showWarning');
      assert.strictEqual(dialogCalls[1].method, 'showInfo');
      assert.ok(dialogCalls[1].args[0].includes('Opening MCP server list'));
    });
  });

  suite('Integration Tests', () => {
    test('should preserve configured MCP enabled state', async () => {
      mockConfig.setConfigValue('copilotOrchestrator.mcp', 'enabled', true);
      mockDialog.setWarningResponse('Start Server');

      await handlePromptMcpStart({ dialog: mockDialog, config: mockConfig });

      const configCalls = mockConfig.getCalls();
      assert.strictEqual(configCalls.length, 1);
      assert.strictEqual(configCalls[0].args[0], 'copilotOrchestrator.mcp');
      assert.strictEqual(configCalls[0].args[1], 'enabled');
      assert.strictEqual(configCalls[0].args[2], true); // default value
    });

    test('should handle all clipboard operations correctly', async () => {
      const connectionInfo = generateMcpConnectionInfo();
      
      await handleHowToConnect('Copy Info', { 
        dialog: mockDialog, 
        clipboard: mockClipboard, 
        config: mockConfig 
      });

      assert.strictEqual(mockClipboard.getWrittenText(), connectionInfo);
      assert.ok(mockClipboard.getWrittenText().includes('Available tools:'));
    });
  });
});