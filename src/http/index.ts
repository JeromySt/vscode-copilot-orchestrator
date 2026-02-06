/**
 * @fileoverview HTTP Module Index
 * 
 * Central export for HTTP server functionality.
 * NOTE: The primary HTTP server is now in planInitialization.ts.
 * This module is retained for the legacy server and type definitions.
 * 
 * @module http
 */

export { startHttpServer, startHttpServerAsync } from './server';
export type { RouteContext, ParsedRequest, RouteHandler } from './types';
