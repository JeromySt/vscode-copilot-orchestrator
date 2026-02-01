/**
 * @fileoverview Handlers module - aggregates all MCP tool handlers.
 * 
 * @module mcp/handlers
 */

export * from './jobHandlers';
export * from './planHandlers';

import { Logger } from '../../core/logger';
import { ToolHandlerContext, ToolHandler } from '../types';
import {
  handleCreateJob,
  handleGetJobStatus,
  handleGetJobsBatchStatus,
  handleGetJobDetails,
  handleGetJobLogSection,
  handleListJobs,
  handleCancelJob,
  handleRetryJob,
  handleContinueJobWork,
  handleDeleteJob,
  handleDeleteJobs
} from './jobHandlers';
import {
  handleCreatePlan,
  handleGetPlanStatus,
  handleListPlans,
  handleCancelPlan,
  handleDeletePlan,
  handleRetryPlan
} from './planHandlers';

/**
 * Registry of all tool handlers by name.
 */
const toolHandlers: Record<string, ToolHandler> = {
  // Job tools
  'create_copilot_job': handleCreateJob,
  'get_copilot_job_status': handleGetJobStatus,
  'get_copilot_jobs_batch_status': handleGetJobsBatchStatus,
  'get_copilot_job_details': handleGetJobDetails,
  'get_copilot_job_log_section': handleGetJobLogSection,
  'list_copilot_jobs': handleListJobs,
  'cancel_copilot_job': handleCancelJob,
  'retry_copilot_job': handleRetryJob,
  'continue_copilot_job_work': handleContinueJobWork,
  'delete_copilot_job': handleDeleteJob,
  'delete_copilot_jobs': handleDeleteJobs,
  
  // Plan tools
  'create_copilot_plan': handleCreatePlan,
  'get_copilot_plan_status': handleGetPlanStatus,
  'list_copilot_plans': handleListPlans,
  'cancel_copilot_plan': handleCancelPlan,
  'delete_copilot_plan': handleDeletePlan,
  'retry_copilot_plan': handleRetryPlan
};

const log = Logger.for('mcp');

/**
 * Handle an MCP tool call by routing to the appropriate handler.
 * 
 * @param name - Tool name
 * @param args - Tool arguments
 * @param context - Handler context with dependencies
 * @returns Tool result or error
 */
export async function handleToolCall(
  name: string,
  args: any,
  context: ToolHandlerContext
): Promise<any> {
  const startTime = Date.now();
  const handler = toolHandlers[name];
  if (!handler) {
    return { error: `Unknown tool: ${name}` };
  }
  
  try {
    const result = await handler(args, context);
    const elapsed = Date.now() - startTime;
    if (elapsed > 100) {
      // Log slow tool calls for debugging
      log.warn(`Slow tool call: ${name} took ${elapsed}ms`);
    }
    return result;
  } catch (e: any) {
    // Ensure errors are returned as structured responses, not thrown
    return { error: e.message || String(e) };
  }
}
