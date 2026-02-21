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
 * Result of CLI refresh operation.
 */
export type CliRefreshResult = 
  | { status: 'available' }
  | { status: 'not-found' }
  | { status: 'error'; error: string };

/**
 * Result of CLI setup operation.
 */
export type CliSetupResult =
  | { status: 'already-setup' }
  | { status: 'install-prompted' }
  | { status: 'login-prompted'; method: 'gh' | 'standalone' }
  | { status: 'error'; error: string };

/**
 * Service dependencies for utility command operations.
 */
export interface UtilityCommandServices {
  dialog: IDialogService;
}

/**
 * Service dependencies for CLI setup command.
 */
export interface CliSetupDeps {
  dialog: {
    showInfo: (msg: string) => void;
    showWarning: (msg: string, ...rest: any[]) => any;
  };
  openTerminal: (name: string, command: string) => void;
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

/**
 * Handle the refresh Copilot CLI command logic.
 * 
 * Resets the CLI cache and performs a fresh check for Copilot CLI availability.
 * Provides user feedback via dialogs based on the check result.
 * 
 * @param services - Injected service dependencies
 * @returns Result indicating CLI availability status
 */
export async function handleRefreshCopilotCli(
  services: UtilityCommandServices
): Promise<CliRefreshResult> {
  try {
    const { resetCliCache, checkCopilotCliAsync } = await import('../agent/cliCheckCore');
    resetCliCache();
    const available = await checkCopilotCliAsync();
    
    if (available) {
      await services.dialog.showInfo('Copilot CLI detected successfully.');
      return { status: 'available' };
    } else {
      await services.dialog.showWarning(
        'Copilot CLI not found. Install via "npm install -g @github/copilot" or "gh extension install github/gh-copilot".'
      );
      return { status: 'not-found' };
    }
  } catch (err: any) {
    const msg = err?.message || 'Unknown error';
    await services.dialog.showWarning(`Failed to check Copilot CLI: ${msg}`);
    return { status: 'error', error: msg };
  }
}

/**
 * Handle the setup Copilot CLI command logic.
 * 
 * Checks if CLI is installed and authenticated, guiding user through
 * installation or login as needed.
 * 
 * @param deps - Injected service dependencies
 * @returns Result containing status information
 */
export async function handleSetupCopilotCli(
  deps: CliSetupDeps
): Promise<CliSetupResult> {
  try {
    const { checkCopilotCliAsync, checkCopilotAuthAsync, resetCliCache } = await import('../agent/cliCheckCore');
    
    // Step 1: Check if CLI is installed
    resetCliCache();
    const cliAvailable = await checkCopilotCliAsync();
    
    if (!cliAvailable) {
      deps.dialog.showWarning(
        'Copilot CLI is not installed. Install via "npm install -g @github/copilot" or "gh extension install github/gh-copilot", then run this command again.'
      );
      return { status: 'install-prompted' };
    }
    
    // Step 2: Check auth status
    const auth = await checkCopilotAuthAsync();
    
    if (auth.authenticated) {
      deps.dialog.showInfo('Copilot CLI is installed and authenticated. Ready to use!');
      return { status: 'already-setup' };
    }
    
    // Step 3: Open terminal with login command
    const loginCmd = auth.method === 'gh'
      ? 'gh auth login --web -h github.com'
      : 'copilot auth login';
    
    deps.dialog.showInfo(
      `Copilot CLI detected but not authenticated. Opening terminal to log in via ${auth.method === 'gh' ? 'GitHub CLI' : 'Copilot CLI'}...`
    );
    deps.openTerminal('Copilot CLI Login', loginCmd);
    
    return { status: 'login-prompted', method: auth.method === 'unknown' ? 'gh' : auth.method };
  } catch (err: any) {
    const msg = err?.message || 'Unknown error';
    deps.dialog.showWarning(`Copilot CLI setup failed: ${msg}`);
    return { status: 'error', error: msg };
  }
}