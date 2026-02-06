/**
 * @fileoverview HTTP Server Module (LEGACY)
 * 
 * NOTE: This file is being phased out in favor of the inline HTTP server
 * in dagInitialization.ts. It exists here for backward compatibility
 * during the transition period.
 * 
 * @module http/server
 * @deprecated Use the DAG-based HTTP server in dagInitialization.ts
 */

import * as http from 'http';
// Legacy imports - commented out during DAG transition
// import { JobRunner } from '../core/jobRunner';
// import { PlanRunner } from '../core/planRunner';
import { McpHandler } from '../mcp/handler';
import { Logger } from '../core/logger';
import { RouteContext, ParsedRequest, RouteHandler, sendJson, sendError } from './types';
import { mcpRoutes } from './routes/mcp';
import { DagRunner } from '../dag';

const log = Logger.for('http');

/**
 * All registered route handlers.
 * NOTE: Legacy job/plan routes removed - only MCP endpoint remains.
 */
const allRoutes: RouteHandler[] = [
  ...mcpRoutes,
];

/**
 * API info response for GET /
 */
const API_INFO = {
  name: 'Copilot Orchestrator MCP Server',
  version: '0.5.0',
  endpoints: {
    'GET /copilot_jobs': 'List all jobs',
    'POST /copilot_job': 'Create a new job',
    'POST /copilot_jobs/status': 'Get batch status for multiple job IDs',
    'GET /copilot_job/:id/status': 'Get simplified job status',
    'GET /copilot_job/:id': 'Get full job details',
    'GET /copilot_job/:id/log/:section': 'Get job log section',
    'POST /copilot_job/:id/cancel': 'Cancel a job',
    'POST /copilot_job/:id/continue': 'Continue work on existing job',
    'POST /copilot_job/:id/retry': 'Retry failed job',
    'POST /plan': 'Create a plan',
    'GET /plan/:id': 'Get plan status',
    'POST /plan/:id/cancelPlan': 'Cancel a plan',
    'POST /mcp': 'MCP JSON-RPC endpoint'
  }
};

/**
 * Create the HTTP request handler.
 */
function createRequestHandler(context: RouteContext) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const startTime = Date.now();
    
    log.debug('Request received', { method: req.method, path: url.pathname });
    
    // Set standard headers
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.end();
      return;
    }
    
    // Fast health check endpoint - returns immediately without any processing
    if (req.method === 'GET' && url.pathname === '/health') {
      res.statusCode = 200;
      res.end('{"status":"ok"}');
      return;
    }
    
    const request: ParsedRequest = {
      req,
      res,
      url,
      method: req.method || 'GET',
      pathname: url.pathname
    };
    
    try {
      // Handle root endpoint
      if (req.method === 'GET' && url.pathname === '/') {
        sendJson(res, API_INFO);
        return;
      }
      
      // Try each route handler
      for (const handler of allRoutes) {
        const handled = await handler(request, context);
        if (handled) {
          const duration = Date.now() - startTime;
          log.debug('Request handled', { path: url.pathname, duration: `${duration}ms` });
          return;
        }
      }
      
      // No handler matched
      sendError(res, 'Not found', 404, { path: url.pathname });
      
    } catch (e: any) {
      log.error('Request handling error', { path: url.pathname, error: e.message });
      sendError(res, String(e), 500, { message: e.message });
    }
  };
}

/**
 * Start the HTTP server.
 * 
 * @deprecated Use initializeHttpServer in dagInitialization.ts instead
 * @param dagRunner - DAG runner instance
 * @param host - Host to bind to
 * @param port - Port to listen on
 * @returns HTTP server instance
 */
export function startHttpServer(
  dagRunner: DagRunner,
  host: string,
  port: number
): http.Server {
  log.info('Starting HTTP server', { host, port });
  
  // Get workspace path for MCP handler
  const vscode = require('vscode');
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  
  // Create context
  const mcpHandler = new McpHandler(dagRunner, workspacePath);
  const context: RouteContext = { dagRunner, mcpHandler };
  
  // Create server
  const server = http.createServer(createRequestHandler(context));
  
  server.listen(port, host, () => {
    log.info('HTTP server started', { 
      url: `http://${host}:${port}`,
      mcpEndpoint: `http://${host}:${port}/mcp`
    });
  });
  
  return server;
}

/**
 * Start HTTP server and return a promise that resolves when listening.
 * @deprecated Use initializeHttpServer in dagInitialization.ts instead
 */
export function startHttpServerAsync(
  dagRunner: DagRunner,
  host: string,
  port: number
): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    log.info('Starting HTTP server (async)', { host, port });
    
    const vscode = require('vscode');
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    
    const mcpHandler = new McpHandler(dagRunner, workspacePath);
    const context: RouteContext = { dagRunner, mcpHandler };
    
    const server = http.createServer(createRequestHandler(context));
    
    server.on('error', (err) => {
      log.error('HTTP server error', err);
      reject(err);
    });
    
    server.listen(port, host, () => {
      log.info('HTTP server started', {
        url: `http://${host}:${port}`,
        mcpEndpoint: `http://${host}:${port}/mcp`
      });
      resolve(server);
    });
  });
}
