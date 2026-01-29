/**
 * @fileoverview Plan HTTP route handlers.
 * 
 * Handles all /plan* endpoints.
 * 
 * @module http/routes/plans
 */

import { RouteContext, ParsedRequest, readBody, sendJson, sendError } from '../types';

/**
 * POST /plan - Create plan
 */
export async function createPlan(request: ParsedRequest, context: RouteContext): Promise<boolean> {
  const { req, res, method, pathname } = request;
  
  if (method !== 'POST' || pathname !== '/plan') return false;
  
  const body = await readBody(req);
  const spec = JSON.parse(body);
  context.plans.enqueue(spec);
  sendJson(res, { ok: true, id: spec.id, message: 'Plan created successfully' });
  return true;
}

/**
 * GET /plan/:id - Get plan status
 */
export async function getPlan(request: ParsedRequest, context: RouteContext): Promise<boolean> {
  const { res, method, pathname } = request;
  
  if (method !== 'GET' || !pathname.startsWith('/plan/')) return false;
  if (pathname.endsWith('/cancelPlan')) return false;
  
  const id = pathname.split('/')[2];
  const plan = context.plans.get(id);
  
  if (!plan) {
    sendError(res, 'Plan not found', 404, { id });
    return true;
  }
  
  sendJson(res, plan);
  return true;
}

/**
 * POST /plan/:id/cancelPlan - Cancel plan
 */
export async function cancelPlan(request: ParsedRequest, context: RouteContext): Promise<boolean> {
  const { res, method, pathname } = request;
  
  if (method !== 'POST' || !pathname.endsWith('/cancelPlan')) return false;
  
  const id = pathname.split('/')[2];
  context.plans.cancel(id);
  sendJson(res, { ok: true, id, message: 'Plan cancelled' });
  return true;
}

/**
 * All plan route handlers.
 */
export const planRoutes = [
  createPlan,
  getPlan,
  cancelPlan
];
