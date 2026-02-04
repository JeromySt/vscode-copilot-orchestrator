/**
 * @fileoverview Plan HTTP route handlers.
 * 
 * DEPRECATED: These routes are from the old PlanRunner system.
 * The DAG system uses the MCP endpoint directly.
 * 
 * @module http/routes/plans
 * @deprecated Use MCP tools via /mcp endpoint instead
 */

import { Logger } from '../../core/logger';
import { RouteContext, ParsedRequest, sendJson } from '../types';

const log = Logger.for('http');

/**
 * @deprecated Legacy route - returns empty list
 */
async function listPlans(request: ParsedRequest, context: RouteContext): Promise<boolean> {
  const { res, method, pathname } = request;
  
  if (method !== 'GET' || pathname !== '/plans') return false;
  
  sendJson(res, { 
    plans: [], 
    count: 0, 
    message: 'DEPRECATED: Use MCP tools via /mcp endpoint' 
  });
  return true;
}

/**
 * Plan routes - all deprecated
 */
export const planRoutes = [
  listPlans,
];
