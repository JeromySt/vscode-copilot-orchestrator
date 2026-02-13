/**
 * @fileoverview Unit tests for mock adapter implementations
 */

import * as assert from 'assert';
import { MockConfigProvider, MockDialogService, MockClipboardService } from '../../../vscode/testAdapters';

suite('MockConfigProvider', () => {
  let mockConfig: MockConfigProvider;

  setup(() => {
    mockConfig = new MockConfigProvider();
  });

  test('returns default value when no configuration is set', () => {
    const result = mockConfig.getConfig('myExt', 'timeout', 5000);
    
    assert.strictEqual(result, 5000);
    assert.strictEqual(mockConfig.getCalls().length, 1);
    
    const call = mockConfig.getCalls()[0];
    assert.strictEqual(call.method, 'getConfig');
    assert.deepStrictEqual(call.args, ['myExt', 'timeout', 5000]);
  });

  test('returns configured value when available', () => {
    mockConfig.setConfigValue('myExt', 'timeout', 1000);
    
    const result = mockConfig.getConfig('myExt', 'timeout', 5000);
    
    assert.strictEqual(result, 1000);
    assert.strictEqual(mockConfig.getConfigValue('myExt', 'timeout'), 1000);
  });

  test('overwrites existing configuration values', () => {
    mockConfig.setConfigValue('myExt', 'timeout', 1000);
    mockConfig.setConfigValue('myExt', 'timeout', 2000);
    
    const result = mockConfig.getConfig('myExt', 'timeout', 5000);
    
    assert.strictEqual(result, 2000);
    assert.strictEqual(mockConfig.getConfigValue('myExt', 'timeout'), 2000);
  });

  test('handles different data types correctly', () => {
    mockConfig.setConfigValue('myExt', 'enabled', true);
    mockConfig.setConfigValue('myExt', 'name', 'test-name');
    mockConfig.setConfigValue('myExt', 'options', { key: 'value' });
    
    assert.strictEqual(mockConfig.getConfig('myExt', 'enabled', false), true);
    assert.strictEqual(mockConfig.getConfig('myExt', 'name', 'default'), 'test-name');
    assert.deepStrictEqual(mockConfig.getConfig('myExt', 'options', {}), { key: 'value' });
  });

  test('records all method calls with timestamps', () => {
    const startTime = Date.now();
    
    mockConfig.getConfig('ext1', 'key1', 'default1');
    mockConfig.getConfig('ext2', 'key2', 42);
    
    const calls = mockConfig.getCalls();
    assert.strictEqual(calls.length, 2);
    
    assert.strictEqual(calls[0].method, 'getConfig');
    assert.deepStrictEqual(calls[0].args, ['ext1', 'key1', 'default1']);
    assert.ok(calls[0].timestamp >= startTime);
    
    assert.strictEqual(calls[1].method, 'getConfig');
    assert.deepStrictEqual(calls[1].args, ['ext2', 'key2', 42]);
    assert.ok(calls[1].timestamp >= calls[0].timestamp);
  });

  test('reset clears all calls and configuration values', () => {
    mockConfig.setConfigValue('myExt', 'timeout', 1000);
    mockConfig.getConfig('myExt', 'timeout', 5000);
    
    assert.strictEqual(mockConfig.getCalls().length, 1);
    assert.strictEqual(mockConfig.getConfigValue('myExt', 'timeout'), 1000);
    
    mockConfig.reset();
    
    assert.strictEqual(mockConfig.getCalls().length, 0);
    assert.strictEqual(mockConfig.getConfigValue('myExt', 'timeout'), undefined);
  });

  test('getConfigValue returns undefined for unset values', () => {
    assert.strictEqual(mockConfig.getConfigValue('nonexistent', 'key'), undefined);
  });

  test('supports multiple sections and keys', () => {
    mockConfig.setConfigValue('ext1', 'key1', 'value1');
    mockConfig.setConfigValue('ext1', 'key2', 'value2');
    mockConfig.setConfigValue('ext2', 'key1', 'value3');
    
    assert.strictEqual(mockConfig.getConfig('ext1', 'key1', 'default'), 'value1');
    assert.strictEqual(mockConfig.getConfig('ext1', 'key2', 'default'), 'value2');
    assert.strictEqual(mockConfig.getConfig('ext2', 'key1', 'default'), 'value3');
    assert.strictEqual(mockConfig.getConfig('ext2', 'key2', 'default'), 'default');
  });
});

suite('MockDialogService', () => {
  let mockDialogs: MockDialogService;

  setup(() => {
    mockDialogs = new MockDialogService();
  });

  test('showInfo records call correctly', async () => {
    await mockDialogs.showInfo('Test info message');
    
    const calls = mockDialogs.getCalls();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'showInfo');
    assert.deepStrictEqual(calls[0].args, ['Test info message']);
  });

  test('showError records call correctly', async () => {
    await mockDialogs.showError('Test error message');
    
    const calls = mockDialogs.getCalls();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'showError');
    assert.deepStrictEqual(calls[0].args, ['Test error message']);
  });

  test('showWarning returns undefined by default', async () => {
    const result = await mockDialogs.showWarning('Test warning', {}, 'Yes', 'No');
    
    assert.strictEqual(result, undefined);
    
    const calls = mockDialogs.getCalls();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'showWarning');
    assert.deepStrictEqual(calls[0].args, ['Test warning', {}, 'Yes', 'No']);
  });

  test('showWarning returns configured response', async () => {
    mockDialogs.setWarningResponse('Yes');
    
    const result = await mockDialogs.showWarning('Test warning', { modal: true }, 'Yes', 'No');
    
    assert.strictEqual(result, 'Yes');
    
    const calls = mockDialogs.getCalls();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'showWarning');
    assert.deepStrictEqual(calls[0].args, ['Test warning', { modal: true }, 'Yes', 'No']);
  });

  test('showQuickPick returns undefined by default', async () => {
    const result = await mockDialogs.showQuickPick(['Option 1', 'Option 2'], { placeholder: 'Select' });
    
    assert.strictEqual(result, undefined);
    
    const calls = mockDialogs.getCalls();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'showQuickPick');
    assert.deepStrictEqual(calls[0].args, [['Option 1', 'Option 2'], { placeholder: 'Select' }]);
  });

  test('showQuickPick returns configured response', async () => {
    mockDialogs.setQuickPickResponse('Option 2');
    
    const result = await mockDialogs.showQuickPick(['Option 1', 'Option 2']);
    
    assert.strictEqual(result, 'Option 2');
    
    const calls = mockDialogs.getCalls();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'showQuickPick');
    assert.deepStrictEqual(calls[0].args, [['Option 1', 'Option 2'], undefined]);
  });

  test('reset clears all calls and responses', async () => {
    mockDialogs.setWarningResponse('Yes');
    mockDialogs.setQuickPickResponse('Option 1');
    await mockDialogs.showInfo('Test');
    
    assert.strictEqual(mockDialogs.getCalls().length, 1);
    assert.strictEqual(await mockDialogs.showWarning('Test', {}, 'Yes'), 'Yes');
    assert.strictEqual(await mockDialogs.showQuickPick(['Option 1']), 'Option 1');
    
    mockDialogs.reset();
    
    assert.strictEqual(mockDialogs.getCalls().length, 0);
    assert.strictEqual(await mockDialogs.showWarning('Test', {}, 'Yes'), undefined);
    assert.strictEqual(await mockDialogs.showQuickPick(['Option 1']), undefined);
  });

  test('records multiple calls with timestamps', async () => {
    const startTime = Date.now();
    
    await mockDialogs.showInfo('Message 1');
    await mockDialogs.showError('Message 2');
    await mockDialogs.showWarning('Message 3', {}, 'OK');
    
    const calls = mockDialogs.getCalls();
    assert.strictEqual(calls.length, 3);
    
    assert.strictEqual(calls[0].method, 'showInfo');
    assert.strictEqual(calls[1].method, 'showError');
    assert.strictEqual(calls[2].method, 'showWarning');
    
    // Verify timestamps are in order
    assert.ok(calls[0].timestamp >= startTime);
    assert.ok(calls[1].timestamp >= calls[0].timestamp);
    assert.ok(calls[2].timestamp >= calls[1].timestamp);
  });

  test('handles empty action arrays in showWarning', async () => {
    await mockDialogs.showWarning('Test message', {});
    
    const calls = mockDialogs.getCalls();
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].args, ['Test message', {}]);
  });
});

suite('MockClipboardService', () => {
  let mockClipboard: MockClipboardService;

  setup(() => {
    mockClipboard = new MockClipboardService();
  });

  test('writeText stores text and records call', async () => {
    await mockClipboard.writeText('Test clipboard content');
    
    assert.strictEqual(mockClipboard.getWrittenText(), 'Test clipboard content');
    
    const calls = mockClipboard.getCalls();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'writeText');
    assert.deepStrictEqual(calls[0].args, ['Test clipboard content']);
  });

  test('writeText overwrites previous text', async () => {
    await mockClipboard.writeText('First text');
    await mockClipboard.writeText('Second text');
    
    assert.strictEqual(mockClipboard.getWrittenText(), 'Second text');
    
    const calls = mockClipboard.getCalls();
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[0].args, ['First text']);
    assert.deepStrictEqual(calls[1].args, ['Second text']);
  });

  test('getWrittenText returns empty string initially', () => {
    assert.strictEqual(mockClipboard.getWrittenText(), '');
    assert.strictEqual(mockClipboard.getCalls().length, 0);
  });

  test('reset clears written text and calls', async () => {
    await mockClipboard.writeText('Test content');
    
    assert.strictEqual(mockClipboard.getWrittenText(), 'Test content');
    assert.strictEqual(mockClipboard.getCalls().length, 1);
    
    mockClipboard.reset();
    
    assert.strictEqual(mockClipboard.getWrittenText(), '');
    assert.strictEqual(mockClipboard.getCalls().length, 0);
  });

  test('records multiple writeText calls with timestamps', async () => {
    const startTime = Date.now();
    
    await mockClipboard.writeText('Content 1');
    await mockClipboard.writeText('Content 2');
    
    const calls = mockClipboard.getCalls();
    assert.strictEqual(calls.length, 2);
    
    assert.strictEqual(calls[0].method, 'writeText');
    assert.strictEqual(calls[1].method, 'writeText');
    
    assert.ok(calls[0].timestamp >= startTime);
    assert.ok(calls[1].timestamp >= calls[0].timestamp);
  });

  test('handles empty and whitespace text correctly', async () => {
    await mockClipboard.writeText('');
    assert.strictEqual(mockClipboard.getWrittenText(), '');
    
    await mockClipboard.writeText('   \n\t   ');
    assert.strictEqual(mockClipboard.getWrittenText(), '   \n\t   ');
    
    const calls = mockClipboard.getCalls();
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[0].args, ['']);
    assert.deepStrictEqual(calls[1].args, ['   \n\t   ']);
  });
});

suite('Mock Services Integration', () => {
  test('all mock services can be used together', async () => {
    const config = new MockConfigProvider();
    const dialogs = new MockDialogService();
    const clipboard = new MockClipboardService();
    
    // Configure mock responses
    config.setConfigValue('myExt', 'feature', true);
    dialogs.setWarningResponse('Proceed');
    
    // Use all services
    const featureEnabled = config.getConfig('myExt', 'feature', false);
    assert.strictEqual(featureEnabled, true);
    
    if (featureEnabled) {
      const response = await dialogs.showWarning('Feature is enabled. Continue?', {}, 'Proceed', 'Cancel');
      assert.strictEqual(response, 'Proceed');
      
      if (response === 'Proceed') {
        await clipboard.writeText('Feature operation completed');
        assert.strictEqual(clipboard.getWrittenText(), 'Feature operation completed');
      }
    }
    
    // Verify all services recorded their calls
    assert.strictEqual(config.getCalls().length, 1);
    assert.strictEqual(dialogs.getCalls().length, 1);
    assert.strictEqual(clipboard.getCalls().length, 1);
  });

  test('reset operations work independently', async () => {
    const config = new MockConfigProvider();
    const dialogs = new MockDialogService();
    const clipboard = new MockClipboardService();
    
    // Use all services
    config.getConfig('test', 'key', 'default');
    await dialogs.showInfo('Test message');
    await clipboard.writeText('Test content');
    
    // Reset only one service
    config.reset();
    
    assert.strictEqual(config.getCalls().length, 0);
    assert.strictEqual(dialogs.getCalls().length, 1);
    assert.strictEqual(clipboard.getCalls().length, 1);
    
    // Reset all others
    dialogs.reset();
    clipboard.reset();
    
    assert.strictEqual(dialogs.getCalls().length, 0);
    assert.strictEqual(clipboard.getCalls().length, 0);
    assert.strictEqual(clipboard.getWrittenText(), '');
  });
});