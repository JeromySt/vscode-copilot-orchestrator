/**
 * @fileoverview VS Code-specific implementations of core service interfaces.
 * 
 * This module provides thin wrapper classes that delegate to the VS Code API,
 * enabling dependency injection and testability while maintaining direct
 * integration with VS Code's native functionality.
 * 
 * @module vscode/adapters
 */

import * as vscode from 'vscode';
import type { IConfigProvider, IDialogService, IClipboardService } from '../interfaces';

/**
 * VS Code implementation of configuration provider interface.
 * 
 * Wraps `vscode.workspace.getConfiguration()` to provide type-safe
 * configuration access with default value fallbacks.
 * 
 * @example
 * ```typescript
 * const config = new VsCodeConfigProvider();
 * const timeout = config.getConfig('myExtension', 'timeout', 5000);
 * ```
 */
export class VsCodeConfigProvider implements IConfigProvider {
  /**
   * Get a configuration value with a fallback default.
   * 
   * @template T - Type of the configuration value
   * @param section - Configuration section (extension name)
   * @param key - Configuration key within the section
   * @param defaultValue - Default value if configuration is not set
   * @returns Configuration value or default
   */
  getConfig<T>(section: string, key: string, defaultValue: T): T {
    const config = vscode.workspace.getConfiguration(section);
    return config.get<T>(key, defaultValue);
  }
}

/**
 * VS Code implementation of dialog service interface.
 * 
 * Wraps VS Code's window dialog APIs (`vscode.window.show*`) to provide
 * a consistent interface for user interactions.
 * 
 * @example
 * ```typescript
 * const dialogs = new VsCodeDialogService();
 * await dialogs.showInfo('Operation completed');
 * const choice = await dialogs.showWarning('Continue?', {}, 'Yes', 'No');
 * ```
 */
export class VsCodeDialogService implements IDialogService {
  /**
   * Show an information message to the user.
   * 
   * @param message - Information message to display
   */
  async showInfo(message: string): Promise<void> {
    await vscode.window.showInformationMessage(message);
  }

  /**
   * Show an error message to the user.
   * 
   * @param message - Error message to display
   */
  async showError(message: string): Promise<void> {
    await vscode.window.showErrorMessage(message);
  }

  /**
   * Show a warning message with optional action buttons.
   * 
   * @param message - Warning message to display
   * @param options - Dialog options (e.g., modal behavior)
   * @param actions - Action button labels to show
   * @returns Selected action label, or undefined if dismissed
   */
  async showWarning(
    message: string, 
    options?: { modal?: boolean }, 
    ...actions: string[]
  ): Promise<string | undefined> {
    if (options) {
      return await vscode.window.showWarningMessage(message, options, ...actions);
    } else {
      return await vscode.window.showWarningMessage(message, ...actions);
    }
  }

  /**
   * Show a quick pick dialog for selecting from a list of options.
   * 
   * @param items - Array of selectable items
   * @param options - Quick pick options (placeholder text, etc.)
   * @returns Selected item, or undefined if cancelled
   */
  async showQuickPick(items: string[], options?: any): Promise<string | undefined> {
    const result = await vscode.window.showQuickPick(items, { ...options, canPickMany: false });
    return Array.isArray(result) ? result[0] : result;
  }
}

/**
 * VS Code implementation of clipboard service interface.
 * 
 * Wraps `vscode.env.clipboard` to provide clipboard operations
 * through the dependency injection container.
 * 
 * @example
 * ```typescript
 * const clipboard = new VsCodeClipboardService();
 * await clipboard.writeText('Copy this text');
 * ```
 */
export class VsCodeClipboardService implements IClipboardService {
  /**
   * Write text to the system clipboard.
   * 
   * @param text - Text content to write to clipboard
   */
  async writeText(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
  }
}