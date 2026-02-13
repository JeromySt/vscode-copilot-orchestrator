/**
 * @fileoverview Mock implementations of service interfaces for unit testing.
 * 
 * These mock classes replace the need to mock the vscode module directly,
 * providing configurable test doubles that record method calls and return
 * predictable responses for testing.
 * 
 * @module vscode/testAdapters
 */

import type { IConfigProvider, IDialogService, IClipboardService } from '../interfaces';

/**
 * Configuration value storage for mock config provider.
 */
interface MockConfigValue {
  section: string;
  key: string;
  value: any;
}

/**
 * Recorded method call information for mock services.
 */
interface MockCall {
  method: string;
  args: any[];
  timestamp: number;
}

/**
 * Mock implementation of configuration provider for unit testing.
 * 
 * Allows pre-configuring return values and records all method calls
 * for verification in tests.
 * 
 * @example
 * ```typescript
 * const mockConfig = new MockConfigProvider();
 * mockConfig.setConfigValue('myExt', 'timeout', 1000);
 * 
 * const timeout = mockConfig.getConfig('myExt', 'timeout', 500);
 * // Returns 1000 (configured value), not 500 (default)
 * 
 * expect(mockConfig.getCalls()).to.have.length(1);
 * expect(mockConfig.getConfigValue('myExt', 'timeout')).to.equal(1000);
 * ```
 */
export class MockConfigProvider implements IConfigProvider {
  private readonly configValues: MockConfigValue[] = [];
  private readonly calls: MockCall[] = [];

  /**
   * Get a configuration value with a fallback default.
   * 
   * Returns pre-configured value if available, otherwise returns the default.
   * Records the method call for test verification.
   * 
   * @template T - Type of the configuration value
   * @param section - Configuration section (extension name)
   * @param key - Configuration key within the section
   * @param defaultValue - Default value if configuration is not set
   * @returns Configured value or default
   */
  getConfig<T>(section: string, key: string, defaultValue: T): T {
    this.recordCall('getConfig', [section, key, defaultValue]);
    
    const configValue = this.configValues.find(
      cv => cv.section === section && cv.key === key
    );
    
    return configValue ? configValue.value : defaultValue;
  }

  /**
   * Set a configuration value for testing.
   * 
   * @param section - Configuration section
   * @param key - Configuration key
   * @param value - Value to return for this section/key combination
   */
  setConfigValue(section: string, key: string, value: any): void {
    // Remove existing value if present
    const existingIndex = this.configValues.findIndex(
      cv => cv.section === section && cv.key === key
    );
    
    if (existingIndex >= 0) {
      this.configValues[existingIndex].value = value;
    } else {
      this.configValues.push({ section, key, value });
    }
  }

  /**
   * Get the configured value for a specific section/key (for test verification).
   * 
   * @param section - Configuration section
   * @param key - Configuration key
   * @returns Configured value or undefined if not set
   */
  getConfigValue(section: string, key: string): any {
    const configValue = this.configValues.find(
      cv => cv.section === section && cv.key === key
    );
    return configValue?.value;
  }

  /**
   * Get all recorded method calls for test verification.
   * 
   * @returns Array of recorded method calls
   */
  getCalls(): readonly MockCall[] {
    return [...this.calls];
  }

  /**
   * Clear all recorded calls and configured values.
   */
  reset(): void {
    this.calls.length = 0;
    this.configValues.length = 0;
  }

  private recordCall(method: string, args: any[]): void {
    this.calls.push({
      method,
      args: [...args],
      timestamp: Date.now()
    });
  }
}

/**
 * Mock implementation of dialog service for unit testing.
 * 
 * Records all method calls and allows configuring return values
 * for different dialog operations.
 * 
 * @example
 * ```typescript
 * const mockDialogs = new MockDialogService();
 * mockDialogs.setWarningResponse('Yes');
 * 
 * const result = await mockDialogs.showWarning('Continue?', {}, 'Yes', 'No');
 * // Returns 'Yes' (configured response)
 * 
 * expect(mockDialogs.getCalls()).to.have.length(1);
 * expect(mockDialogs.getCalls()[0].method).to.equal('showWarning');
 * ```
 */
export class MockDialogService implements IDialogService {
  private readonly calls: MockCall[] = [];
  private warningResponse: string | undefined = undefined;
  private quickPickResponse: string | undefined = undefined;

  /**
   * Show an information message to the user.
   * 
   * Records the call but does not display anything.
   * 
   * @param message - Information message to display
   */
  async showInfo(message: string): Promise<void> {
    this.recordCall('showInfo', [message]);
  }

  /**
   * Show an error message to the user.
   * 
   * Records the call but does not display anything.
   * 
   * @param message - Error message to display
   */
  async showError(message: string): Promise<void> {
    this.recordCall('showError', [message]);
  }

  /**
   * Show a warning message with optional action buttons.
   * 
   * Returns the configured response or undefined.
   * 
   * @param message - Warning message to display
   * @param options - Dialog options (e.g., modal behavior)
   * @param actions - Action button labels to show
   * @returns Configured response or undefined
   */
  async showWarning(
    message: string, 
    options?: { modal?: boolean }, 
    ...actions: string[]
  ): Promise<string | undefined> {
    this.recordCall('showWarning', [message, options, ...actions]);
    return this.warningResponse;
  }

  /**
   * Show a quick pick dialog for selecting from a list of options.
   * 
   * Returns the configured response or undefined.
   * 
   * @param items - Array of selectable items
   * @param options - Quick pick options (placeholder text, etc.)
   * @returns Configured response or undefined
   */
  async showQuickPick(items: string[], options?: any): Promise<string | undefined> {
    this.recordCall('showQuickPick', [items, options]);
    return this.quickPickResponse;
  }

  /**
   * Set the response for warning dialogs.
   * 
   * @param response - Response to return from showWarning calls
   */
  setWarningResponse(response: string | undefined): void {
    this.warningResponse = response;
  }

  /**
   * Set the response for quick pick dialogs.
   * 
   * @param response - Response to return from showQuickPick calls
   */
  setQuickPickResponse(response: string | undefined): void {
    this.quickPickResponse = response;
  }

  /**
   * Get all recorded method calls for test verification.
   * 
   * @returns Array of recorded method calls
   */
  getCalls(): readonly MockCall[] {
    return [...this.calls];
  }

  /**
   * Clear all recorded calls and configured responses.
   */
  reset(): void {
    this.calls.length = 0;
    this.warningResponse = undefined;
    this.quickPickResponse = undefined;
  }

  private recordCall(method: string, args: any[]): void {
    this.calls.push({
      method,
      args: [...args],
      timestamp: Date.now()
    });
  }
}

/**
 * Mock implementation of clipboard service for unit testing.
 * 
 * Records all writeText calls and stores the written text
 * for test verification.
 * 
 * @example
 * ```typescript
 * const mockClipboard = new MockClipboardService();
 * 
 * await mockClipboard.writeText('Test content');
 * 
 * expect(mockClipboard.getWrittenText()).to.equal('Test content');
 * expect(mockClipboard.getCalls()).to.have.length(1);
 * ```
 */
export class MockClipboardService implements IClipboardService {
  private readonly calls: MockCall[] = [];
  private writtenText: string = '';

  /**
   * Write text to the system clipboard.
   * 
   * Records the call and stores the text for verification.
   * 
   * @param text - Text content to write to clipboard
   */
  async writeText(text: string): Promise<void> {
    this.recordCall('writeText', [text]);
    this.writtenText = text;
  }

  /**
   * Get the last text written to the clipboard.
   * 
   * @returns Last written text or empty string if none
   */
  getWrittenText(): string {
    return this.writtenText;
  }

  /**
   * Get all recorded method calls for test verification.
   * 
   * @returns Array of recorded method calls
   */
  getCalls(): readonly MockCall[] {
    return [...this.calls];
  }

  /**
   * Clear all recorded calls and written text.
   */
  reset(): void {
    this.calls.length = 0;
    this.writtenText = '';
  }

  private recordCall(method: string, args: any[]): void {
    this.calls.push({
      method,
      args: [...args],
      timestamp: Date.now()
    });
  }
}