/**
 * @fileoverview Well-known event-bus topic constants for webview controls.
 *
 * @module ui/webview/topics
 */

export const Topics = {
  PULSE: 'extension:pulse',
  NODE_STATE_CHANGE: 'node:state',
  PLAN_STATE_CHANGE: 'plan:state',
  STATUS_UPDATE: 'plan:status-update',
  PROCESS_STATS: 'node:process-stats',
  LOG_UPDATE: 'node:log',
  LOG_PHASE_CHANGE: 'node:log-phase',
  AI_USAGE_UPDATE: 'node:ai-usage',
  WORK_SUMMARY: 'node:work-summary',
  ATTEMPT_UPDATE: 'node:attempt',
  SUBSCRIPTION_DATA: 'subscription:data',
  SUBSCRIPTION_END: 'subscription:end',
  CONTEXT_PRESSURE_UPDATE: 'node:context-pressure',
  CONFIG_UPDATE: 'node:config-update',
  LAYOUT_CHANGE: 'layout:change',
  LAYOUT_COMPLETE: 'layout:complete',
  PLANS_SELECTION_CHANGED: 'plans:selection:changed',
  PLANS_BULK_ACTION: 'plans:bulk:action',
  CONTROL_PREFIX: 'control:',
  controlUpdate: (id: string) => `control:${id}:updated`,
} as const;
