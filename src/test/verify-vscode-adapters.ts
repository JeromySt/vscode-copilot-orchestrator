/**
 * @fileoverview Quick verification that VS Code adapters are correctly implemented.
 * This test verifies the adapters implement the correct interfaces.
 */

import type { IConfigProvider, IDialogService, IClipboardService } from '../interfaces';
import { MockConfigProvider, MockDialogService, MockClipboardService } from '../vscode/testAdapters';

// Type-level verification that mocks implement interfaces
const configProvider: IConfigProvider = new MockConfigProvider();
const dialogService: IDialogService = new MockDialogService();
const clipboardService: IClipboardService = new MockClipboardService();

async function verifyMockImplementations(): Promise<void> {
  console.log('Verifying mock implementations...');
  
  // Test MockConfigProvider
  configProvider.getConfig('test', 'key', 'default');
  console.log('✓ MockConfigProvider implements IConfigProvider');
  
  // Test MockDialogService  
  await dialogService.showInfo('Test info');
  await dialogService.showError('Test error');
  await dialogService.showWarning('Test warning', {}, 'OK');
  await dialogService.showQuickPick(['Option 1', 'Option 2']);
  console.log('✓ MockDialogService implements IDialogService');
  
  // Test MockClipboardService
  await clipboardService.writeText('Test text');
  console.log('✓ MockClipboardService implements IClipboardService');
  
  console.log('All mock implementations verified successfully!');
}

// Only run if this file is executed directly
if (require.main === module) {
  verifyMockImplementations().catch(console.error);
}