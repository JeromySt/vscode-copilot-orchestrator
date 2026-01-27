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

export { isCopilotCliAvailable } from './cliCheckCore';
export { ensureCopilotCliInteractive, registerCopilotCliCheck } from './cliCheck';
