/**
 * @fileoverview Core module exports.
 * 
 * Central exports for core business logic components.
 * 
 * @module core
 */

export { detectWorkspace, Detected } from './detector';
export { ensureDir, readJSON, writeJSON, cpuCountMinusOne } from './utils';
export * from './planInitialization';
export { Logger, ComponentLogger } from './logger';
export {
  GlobalCapacityManager,
  GlobalCapacityStats,
  GlobalCapacityEvents,
  InstanceRegistration,
  GlobalCapacityRegistry,
} from './globalCapacity';
