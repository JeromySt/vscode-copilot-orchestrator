/**
 * @fileoverview Interface for clipboard operations abstraction.
 * 
 * Abstracts clipboard functionality to enable dependency injection
 * and unit testing without coupling to the VS Code API directly.
 * 
 * @module interfaces/IClipboardService
 */

/**
 * Interface for clipboard operations.
 * 
 * Provides methods to interact with the system clipboard.
 * Replaces direct calls to `vscode.env.clipboard` API.
 * 
 * @example
 * ```typescript
 * class DataExporter {
 *   constructor(private readonly clipboard: IClipboardService) {}
 *   
 *   async copyResult(data: string): Promise<void> {
 *     await this.clipboard.writeText(data);
 *     // Show notification that data was copied
 *   }
 * }
 * ```
 */
export interface IClipboardService {
  /**
   * Write text to the system clipboard.
   * 
   * @param text - Text content to write to clipboard
   */
  writeText(text: string): Promise<void>;
}