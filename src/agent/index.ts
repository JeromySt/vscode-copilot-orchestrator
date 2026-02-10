/**
 * @fileoverview Agent module exports.
 * 
 * @module agent
 */

export { 
  AgentDelegator, 
  DelegateOptions, 
  DelegateResult, 
  DelegatorLogger,
  DelegatorCallbacks 
} from './agentDelegator';

export { isCopilotCliAvailable, checkCopilotCliAsync, resetCliCache, isCliCachePopulated } from './cliCheckCore';
export { ensureCopilotCliInteractive, registerCopilotCliCheck } from './cliCheck';

export {
  CopilotCliRunner,
  CopilotRunOptions,
  CopilotRunResult,
  CopilotCliLogger,
  getCopilotCliRunner,
  runCopilotCli,
} from './copilotCliRunner';

export {
  ModelInfo,
  ModelDiscoveryResult,
  classifyModel,
  parseModelChoices,
  discoverAvailableModels,
  getCachedModels,
  refreshModelCache,
  isValidModel,
  suggestModel,
  resetModelCache,
} from './modelDiscovery';
