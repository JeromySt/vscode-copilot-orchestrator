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
  
  const body = await readBody(req);
  
  try {
    const rpcRequest = JSON.parse(body);
    log.debug('MCP request', { method: rpcRequest.method, id: rpcRequest.id });
    
    const response = await context.mcpHandler.handleRequest(rpcRequest);
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
