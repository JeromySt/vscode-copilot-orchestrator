/**
 * @fileoverview MCP type definitions.
 * 
 * Shared types for the MCP module.
 * 
 * @module mcp/types
 */

/**
 * MCP Tool definition for tools/list response
 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

/**
 * JSON-RPC 2.0 request format
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: any;
}

/**
 * JSON-RPC 2.0 response format
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

/**
 * Tool handler context - dependencies passed to tool handlers
 */
export interface ToolHandlerContext {
  runner: import('../core/jobRunner').JobRunner;
  plans: import('../core/planRunner').PlanRunner;
  workspacePath: string;
}

/**
 * Tool handler function signature
 */
export type ToolHandler = (args: any, context: ToolHandlerContext) => Promise<any>;
