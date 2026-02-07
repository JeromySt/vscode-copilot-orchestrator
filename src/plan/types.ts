/**
 * @fileoverview Plan Core Types
 * 
 * Re-exports all plan types from their individual modules under ./types/.
 * This file is kept for backward compatibility - all existing imports
 * from './types' or '../plan/types' continue to work unchanged.
 * 
 * Types are organized into:
 * - specs.ts: Work specification types (ProcessSpec, ShellSpec, AgentSpec)
 * - nodes.ts: Node types, status, and specifications
 * - plan.ts: Plan types, execution state, events, and executor types
 * 
 * @module plan/types
 */

export * from './types/index';
