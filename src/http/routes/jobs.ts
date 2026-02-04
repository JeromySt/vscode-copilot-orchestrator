/**
 * @fileoverview Job HTTP route handlers.
 * 
 * DEPRECATED: These routes are from the old JobRunner system.
 * The DAG system uses the MCP endpoint directly.
 * 
 * @module http/routes/jobs
 * @deprecated Use MCP tools via /mcp endpoint instead
 */

import { Logger } from '../../core/logger';
import { RouteContext, ParsedRequest, sendJson } from '../types';

const log = Logger.for('http');

/**
 * @deprecated Legacy route - returns empty list
 */
async function listJobs(request: ParsedRequest, context: RouteContext): Promise<boolean> {
  const { res, method, pathname } = request;
  
  if (method !== 'GET' || pathname !== '/copilot_jobs') return false;
  
  // Return empty - use MCP tools instead
  sendJson(res, { 
    jobs: [], 
    count: 0, 
    message: 'DEPRECATED: Use MCP tools via /mcp endpoint' 
  });
  return true;
}

/**
 * @deprecated Legacy route - not implemented
 */
async function batchJobStatus(request: ParsedRequest, context: RouteContext): Promise<boolean> {
  const { res, method, pathname } = request;
  
  if (method !== 'POST' || pathname !== '/copilot_jobs/status') return false;
  
  sendJson(res, { 
    statuses: [], 
    message: 'DEPRECATED: Use MCP tools via /mcp endpoint' 
  });
  return true;
}

/**
 * Job routes - all deprecated
 */
export const jobRoutes = [
  listJobs,
  batchJobStatus,
];
