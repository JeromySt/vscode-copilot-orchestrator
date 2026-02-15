/**
 * @fileoverview Pure logic for Copilot CLI availability checking and installation guidance.
 * 
 * This module contains testable business logic extracted from cliCheck.ts,
 * with zero dependencies on VS Code APIs.
 * 
 * @module agent/cliCheckLogic
 */

/**
 * Decision outcome for CLI availability checking.
 */
export type CliCheckDecision = 'available' | 'not-required' | 'prompt-install';

/**
 * Configuration interface for CLI availability evaluation.
 */
export interface CliCheckConfig {
  required: boolean;
  preferredInstall: 'gh' | 'npm' | 'auto';
}

/**
 * Install instruction details.
 */
export interface InstallInstructions {
  label: string;
  commands: string[];
}

/**
 * Evaluates what action to take based on CLI configuration and availability.
 * 
 * @param config - CLI configuration settings
 * @param isAvailable - Whether the CLI is currently available
 * @returns Decision on what action to take
 */
export function evaluateCliAvailability(config: CliCheckConfig, isAvailable: boolean): CliCheckDecision {
  if (!config.required) {
    return 'not-required';
  }
  
  if (isAvailable) {
    return 'available';
  }
  
  return 'prompt-install';
}

/**
 * Gets installation instructions for a given install method.
 * 
 * @param method - Installation method ('gh', 'npm', or other)
 * @returns Installation instructions with label and commands
 */
export function getInstallInstructions(method: string): InstallInstructions {
  switch (method) {
    case 'gh':
      return {
        label: 'Install via gh',
        commands: [
          'gh extension install github/gh-copilot',
          '# When complete, run: gh copilot --help'
        ]
      };
    
    case 'npm':
      return {
        label: 'Install via npm', 
        commands: [
          'npm i -g @githubnext/github-copilot-cli',
          '# When complete, run: copilot --help'
        ]
      };
    
    default:
      return {
        label: 'Install via npm',
        commands: [
          'npm i -g @githubnext/github-copilot-cli',
          '# When complete, run: copilot --help'
        ]
      };
  }
}

/**
 * Determines the preferred installation method based on configuration and gh availability.
 * 
 * @param preferredInstall - User's preferred install method setting
 * @param hasGh - Whether gh CLI is available
 * @returns The recommended installation method
 */
export function determineInstallMethod(preferredInstall: 'gh' | 'npm' | 'auto', hasGh: boolean): 'gh' | 'npm' {
  if (preferredInstall === 'gh') {
    return 'gh';
  }
  
  if (preferredInstall === 'npm') {
    return 'npm';
  }
  
  // Auto mode: prefer gh if available, otherwise npm
  return hasGh ? 'gh' : 'npm';
}