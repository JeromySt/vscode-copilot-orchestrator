/**
 * @fileoverview Utility command logic abstracted from VS Code dependencies.
 * 
 * Contains pure business logic for utility operations like model discovery
 * without direct VS Code API coupling. Uses dependency injection for
 * testability and clean separation of concerns.
 * 
 * @module commands/utilityCommandLogic
 */

import type { IDialogService } from '../interfaces';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Result of model refresh operation.
 */
export type ModelRefreshResult = 
  | { count: number; error?: never }
  | { error: string; count?: never };

/**
 * Service dependencies for utility command operations.
 */
export interface UtilityCommandServices {
  dialog: IDialogService;
}

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

/**
 * Handle the refresh models command logic.
 * 
 * Refreshes the model cache by calling the model discovery service
 * and displays appropriate feedback to the user.
 * 
 * @param services - Injected service dependencies
 * @returns Result containing count or error information
 */
export async function handleRefreshModels(
  services: UtilityCommandServices
): Promise<ModelRefreshResult> {
  try {
    // Dynamic import to avoid circular dependencies and reduce bundle size
    const { refreshModelCache } = await import('../agent/modelDiscovery');
    const result = await refreshModelCache();
    
    if (result.models.length > 0) {
      await services.dialog.showInfo(
        `Discovered ${result.models.length} models from Copilot CLI`
      );
      return { count: result.models.length };
    } else {
      await services.dialog.showWarning(
        'Could not discover models. Is Copilot CLI installed?'
      );
      return { error: 'No models discovered' };
    }
  } catch (error) {
    let errorMessage: string;
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'string') {
      errorMessage = error;
    } else {
      errorMessage = 'Unknown error during model refresh';
    }
    
    await services.dialog.showError(
      `Failed to refresh models: ${errorMessage}`
    );
    
    return { error: errorMessage };
  }
}