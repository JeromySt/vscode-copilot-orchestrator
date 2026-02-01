/**
 * @fileoverview MCP HTTP route handler.
 * 
 * Handles POST /mcp endpoint for MCP JSON-RPC requests.
 * 
 * @module http/routes/mcp
 */

import { Logger } from '../../core/logger';
import { RouteContext, ParsedRequest, readBody, sendJson } from '../types';

const log = Logger.for('http');

/**
 * POST /mcp - MCP JSON-RPC endpoint
 */
export async function handleMcp(request: ParsedRequest, context: RouteContext): Promise<boolean> {
  const { req, res, method, pathname } = request;
  
  if (method !== 'POST' || pathname !== '/mcp') return false;
  
  const requestStart = Date.now();
  const body = await readBody(req);
  const bodyReadTime = Date.now() - requestStart;
  
  try {
    const parseStart = Date.now();
    const rpcRequest = JSON.parse(body);
    const parseTime = Date.now() - parseStart;
    
    log.debug('MCP request', { method: rpcRequest.method, id: rpcRequest.id });
    
    const handleStart = Date.now();
    const response = await context.mcpHandler.handleRequest(rpcRequest);
    const handleTime = Date.now() - handleStart;
    
    const totalTime = Date.now() - requestStart;
    if (totalTime > 50) {
      console.warn(`[MCP] Request ${rpcRequest.method} took ${totalTime}ms (body:${bodyReadTime}ms, parse:${parseTime}ms, handle:${handleTime}ms)`);
    }
    
    log.debug('MCP response', { method: rpcRequest.method, hasError: !!response.error });
    
    sendJson(res, response);
  } catch (parseError: any) {
    log.error('MCP parse error', parseError);
    sendJson(res, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' }
    });
  }
  
  return true;
}

/**
 * MCP route handlers.
 */
export const mcpRoutes = [handleMcp];
