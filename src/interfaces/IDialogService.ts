/**
 * @fileoverview Interface for VS Code dialog operations abstraction.
 * 
 * Abstracts VS Code's window dialog APIs to enable dependency injection
 * and unit testing without coupling to the VS Code API directly.
 * 
 * @module interfaces/IDialogService
 */

/**
 * Interface for VS Code dialog operations.
 * 
 * Provides methods to show information, warning, and error messages,
 * as well as quick pick dialogs. Replaces direct calls to `vscode.window.show*()`.
 * 
 * @example
 * ```typescript
 * class UserInteraction {
 *   constructor(private readonly dialogs: IDialogService) {}
 *   
 *   async confirmAction(): Promise<boolean> {
 *     const choice = await this.dialogs.showWarning(
 *       'Are you sure?', 
 *       { modal: true }, 
 *       'Yes', 'No'
 *     );
 *     return choice === 'Yes';
 *   }
 *   
 *   async selectOption(): Promise<string | undefined> {
 *     return await this.dialogs.showQuickPick(['Option 1', 'Option 2']);
 *   }
 * }
 * ```
 */
export interface IDialogService {
  /**
   * Show an information message to the user.
   * 
   * @param message - Information message to display
   */
  showInfo(message: string): Promise<void>;

  /**
   * Show an error message to the user.
   * 
   * @param message - Error message to display
   */
  showError(message: string): Promise<void>;

  /**
   * Show a warning message with optional action buttons.
   * 
   * @param message - Warning message to display
   * @param options - Dialog options (e.g., modal behavior)
   * @param actions - Action button labels to show
   * @returns Selected action label, or undefined if dismissed
   */
  showWarning(
    message: string, 
    options?: { modal?: boolean }, 
    ...actions: string[]
  ): Promise<string | undefined>;

  /**
   * Show a quick pick dialog for selecting from a list of options.
   * 
   * @param items - Array of selectable items
   * @param options - Quick pick options (placeholder text, etc.)
   * @returns Selected item, or undefined if cancelled
   */
  showQuickPick(items: string[], options?: any): Promise<string | undefined>;
}