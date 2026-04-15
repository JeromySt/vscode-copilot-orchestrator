/**
 * @fileoverview Agent module exports.
 * 
 * @module agent
 */

export { isCopilotCliAvailable, checkCopilotCliAsync, resetCliCache, isCliCachePopulated } from './cliCheckCore';
export { ensureCopilotCliInteractive, registerCopilotCliCheck, checkCopilotCliOnStartup } from './cliCheck';

export {
  CopilotCliRunner,
  CopilotRunOptions,
  CopilotRunResult,
  CopilotCliLogger,
  BuildCommandOptions,
  sanitizeUrl,
  buildCommand,
} from './copilotCliRunner';

export {
  ModelInfo,
  ModelDiscoveryResult,
  ModelDiscoveryDeps,
  classifyModel,
  parseModelChoices,
  discoverAvailableModels,
  discoverAvailableModelsLegacy,
  getCachedModels,
  refreshModelCache,
  isValidModel,
  suggestModel,
  resetModelCache,
  runCopilotHelp,
} from './modelDiscovery';
