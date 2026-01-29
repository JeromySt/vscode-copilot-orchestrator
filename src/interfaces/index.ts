/**
 * @fileoverview Central export for all interfaces.
 * 
 * Import interfaces from this module for convenience:
 * ```typescript
 * import { IJobRunner, IGitOperations } from './interfaces';
 * ```
 * 
 * @module interfaces
 */

export * from './IJobRunner';
export * from './IJobPersistence';
export * from './IGitOperations';
export * from './IProcessMonitor';
export * from './IMcpManager';
export * from './IAgentDelegator';
