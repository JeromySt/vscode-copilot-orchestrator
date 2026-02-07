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

// Track in-flight requests for debugging
let inFlightRequests = 0;

/**
 * POST /mcp - MCP JSON-RPC endpoint
 */
export async function handleMcp(request: ParsedRequest, context: RouteContext): Promise<boolean> {
  const { req, res, method, pathname } = request;
  
  if (method !== 'POST' || pathname !== '/mcp') return false;
  
  inFlightRequests++;
  const requestId = `mcp-${Date.now()}-${inFlightRequests}`;
  const requestStart = Date.now();
  
  log.debug(`MCP request start [${requestId}]`, { inFlight: inFlightRequests });
  
  try {
    const body = await readBody(req);
    const bodyReadTime = Date.now() - requestStart;
    
    const parseStart = Date.now();
    const rpcRequest = JSON.parse(body);
    const parseTime = Date.now() - parseStart;
    
    log.debug(`MCP request [${requestId}]`, { 
      method: rpcRequest.method, 
      id: rpcRequest.id,
      bodyReadMs: bodyReadTime,
      parseMs: parseTime
    });
    
    const handleStart = Date.now();
    const response = await context.mcpHandler.handleRequest(rpcRequest);
    const handleTime = Date.now() - handleStart;
    
    const totalTime = Date.now() - requestStart;
    
    // Log timing for all requests, warn for slow ones
    if (totalTime > 100) {
      log.warn(`Slow MCP request [${requestId}]: ${rpcRequest.method} took ${totalTime}ms (body:${bodyReadTime}ms, parse:${parseTime}ms, handle:${handleTime}ms)`, {
        inFlight: inFlightRequests,
        hasError: !!response.error
      });
    } else {
      log.debug(`MCP response [${requestId}]`, { 
        method: rpcRequest.method, 
        totalMs: totalTime,
        hasError: !!response.error 
      });
    }
    
    sendJson(res, response);
  } catch (parseError: any) {
    log.error(`MCP parse error [${requestId}]`, { error: parseError.message });
    sendJson(res, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' }
    });
  } finally {
    inFlightRequests--;
    log.debug(`MCP request end [${requestId}]`, { inFlight: inFlightRequests });
  }
  
  return true;
}

/**
 * MCP route handlers.
 */
export const mcpRoutes = [handleMcp];
