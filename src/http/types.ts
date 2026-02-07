/**
 * @fileoverview HTTP Server Types
 * 
 * Shared types for HTTP route handlers.
 * 
 * @module http/types
 */

import { IncomingMessage, ServerResponse } from 'http';
import { PlanRunner } from '\.\./plan';
import { McpHandler } from '../mcp/handler';

/**
 * Context passed to all route handlers.
 */
export interface RouteContext {
  PlanRunner: PlanRunner;
  mcpHandler: McpHandler;
}

/**
 * Request with parsed URL.
 */
export interface ParsedRequest {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  pathname: string;
}

/**
 * Route handler function signature.
 */
export type RouteHandler = (
  request: ParsedRequest,
  context: RouteContext
) => Promise<boolean>;

/**
 * Helper to read request body.
 */
export async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => body += chunk.toString());
    req.on('end', () => resolve(body));
  });
}

/**
 * Helper to send JSON response.
 * Explicitly sets Content-Length to ensure client knows response is complete.
 */
export function sendJson(res: ServerResponse, data: unknown, statusCode = 200): void {
  const body = JSON.stringify(data);
  res.statusCode = statusCode;
  res.setHeader('Content-Length', Buffer.byteLength(body, 'utf-8'));
  res.setHeader('Connection', 'close');
  res.end(body);
}

/**
 * Helper to send error response.
 */
export function sendError(res: ServerResponse, error: string, statusCode = 400, details?: Record<string, unknown>): void {
  res.statusCode = statusCode;
  res.end(JSON.stringify({ error, ...details }));
}
