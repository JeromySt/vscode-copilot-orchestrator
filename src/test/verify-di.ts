/**
 * Quick verification script to test the DI container implementation
 */

import { ServiceContainer } from '../core/container';
import { ILogger, IConfigProvider, IDialogService, IClipboardService } from '../interfaces';
import * as tokens from '../core/tokens';

// Mock implementations for testing
class MockLogger implements ILogger {
  private level: string = 'info';
  
  debug(message: string): void { console.log(`DEBUG: ${message}`); }
  info(message: string): void { console.log(`INFO: ${message}`); }
  warn(message: string): void { console.log(`WARN: ${message}`); }
  error(message: string): void { console.log(`ERROR: ${message}`); }
  isDebugEnabled(): boolean { return true; }
  setLevel(level: 'debug' | 'info' | 'warn' | 'error'): void { this.level = level; }
  getLevel(): string { return this.level; }
}

class MockConfigProvider implements IConfigProvider {
  getConfig<T>(section: string, key: string, defaultValue: T): T {
    console.log(`Config request: ${section}.${key} -> ${defaultValue}`);
    return defaultValue;
  }
}

class MockDialogService implements IDialogService {
  async showInfo(message: string): Promise<void> {
    console.log(`Info: ${message}`);
  }
  
  async showError(message: string): Promise<void> {
    console.log(`Error: ${message}`);
  }
  
  async showWarning(message: string, options?: { modal?: boolean }, ...actions: string[]): Promise<string | undefined> {
    console.log(`Warning: ${message}, Actions: ${actions.join(', ')}`);
    return actions[0]; // Return first action for testing
  }
  
  async showQuickPick(items: string[], options?: any): Promise<string | undefined> {
    console.log(`QuickPick: ${items.join(', ')}`);
    return items[0]; // Return first item for testing
  }
}

class MockClipboardService implements IClipboardService {
  async writeText(text: string): Promise<void> {
    console.log(`Clipboard: ${text}`);
  }
}

// Verification function
export function verifyDIContainer(): void {
  console.log('=== DI Container Verification ===');
  
  // Create container
  const container = new ServiceContainer();
  
  // Register services
  container.registerSingleton(tokens.ILogger, () => new MockLogger());
  container.register(tokens.IConfigProvider, () => new MockConfigProvider());
  container.register(tokens.IDialogService, () => new MockDialogService());
  container.register(tokens.IClipboardService, () => new MockClipboardService());
  
  // Resolve and test services
  const logger = container.resolve<ILogger>(tokens.ILogger);
  logger.info('DI Container is working!');
  
  const config = container.resolve<IConfigProvider>(tokens.IConfigProvider);
  const timeoutValue = config.getConfig('test', 'timeout', 5000);
  
  const dialogs = container.resolve<IDialogService>(tokens.IDialogService);
  dialogs.showInfo('Test info message');
  
  const clipboard = container.resolve<IClipboardService>(tokens.IClipboardService);
  clipboard.writeText('Test clipboard content');
  
  // Test singleton behavior
  const logger2 = container.resolve<ILogger>(tokens.ILogger);
  console.log('Singleton test:', logger === logger2 ? 'PASS' : 'FAIL');
  
  // Test scoped container
  const childContainer = container.createScope();
  const childLogger = childContainer.resolve<ILogger>(tokens.ILogger);
  console.log('Scope inheritance test:', childLogger === logger ? 'PASS' : 'FAIL');
  
  console.log('=== Verification Complete ===');
}