/**
 * @fileoverview MCP Protocol Handler for HTTP transport.
 * 
 * This is the main entry point for MCP requests. It handles the JSON-RPC
 * protocol and delegates tool calls to the appropriate handlers.
 * 
 * MCP HTTP transport:
 * - POST /mcp with JSON-RPC 2.0 messages
 * - Supports: initialize, tools/list, tools/call
 * 
 * @module mcp/mcpHandler
 */

import { JobRunner } from '../core/jobRunner';
import { PlanRunner } from '../core/planRunner';
import { Logger, ComponentLogger } from '../core/logger';
import { JsonRpcRequest, JsonRpcResponse, ToolHandlerContext } from './types';
import { getAllToolDefinitions } from './tools';
import { handleToolCall } from './handlers';

/** MCP component logger */
const log: ComponentLogger = Logger.for('mcp');

/** MCP protocol version */
const PROTOCOL_VERSION = '2024-11-05';

/** Server info for initialize response */
const SERVER_INFO = {
  name: 'copilot-orchestrator',
  version: '0.5.0'
};

/**
 * MCP Handler class for processing MCP HTTP requests.
 * 
 * Handles the JSON-RPC protocol layer and delegates tool execution
 * to specialized handlers.
 */
export class McpHandler {
  private readonly context: ToolHandlerContext;

  /**
   * Create a new MCP handler.
   * 
   * @param runner - Job runner instance
   * @param plans - Plan runner instance
   * @param workspacePath - Workspace root path
   */
  constructor(runner: JobRunner, plans: PlanRunner, workspacePath: string) {
    this.context = { runner, plans, workspacePath };
    log.info('MCP Handler initialized', { workspacePath });
  }

  /**
   * Handle an MCP JSON-RPC request.
   * 
   * @param request - JSON-RPC request
   * @returns JSON-RPC response
   */
  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    log.debug('Request received', { method: request.method, id: request.id });
    
    try {
      switch (request.method) {
        case 'initialize':
          return this.handleInitialize(request);

        case 'notifications/initialized':
          return this.handleInitializedNotification(request);

        case 'tools/list':
          return this.handleToolsList(request);

        case 'tools/call':
          return this.handleToolsCall(request);

        default:
          log.warn('Unknown method', { method: request.method });
          return this.errorResponse(request.id, -32601, `Method not found: ${request.method}`);
      }
    } catch (error: any) {
      log.error('Request handling error', { 
        method: request.method, 
        error: error.message, 
        stack: error.stack 
      });
      return this.errorResponse(request.id, -32603, error.message || 'Internal error');
    }
  }

  /**
   * Handle initialize request.
   */
  private handleInitialize(request: JsonRpcRequest): JsonRpcResponse {
    log.info('Initialize request received');
    const result = {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO
    };
    log.debug('Initialize response', result);
    return this.successResponse(request.id, result);
  }

  /**
   * Handle initialized notification.
   */
  private handleInitializedNotification(request: JsonRpcRequest): JsonRpcResponse {
    log.info('Client initialized notification received');
    return this.successResponse(request.id, {});
  }

  /**
   * Handle tools/list request.
   */
  private handleToolsList(request: JsonRpcRequest): JsonRpcResponse {
    const tools = getAllToolDefinitions();
    log.info('Tools list requested', { toolCount: tools.length });
    log.debug('Tools list - tool names', { tools: tools.map(t => t.name) });
    
    // Log full schema for each tool for debugging
    for (const tool of tools) {
      log.debug(`Tool schema: ${tool.name}`, { 
        name: tool.name,
        description: tool.description.substring(0, 100) + '...',
        inputSchema: tool.inputSchema 
      });
    }
    
    log.debug('Tools list response sent', { toolCount: tools.length });
    return this.successResponse(request.id, { tools });
  }

  /**
   * Handle tools/call request.
   */
  private async handleToolsCall(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { name, arguments: args } = request.params || {};
    log.info('Tool call', { tool: name });
    log.debug('Tool call arguments', { tool: name, args });
    
    const result = await handleToolCall(name, args || {}, this.context);
    
    log.debug('Tool call result', { tool: name, result });
    return this.successResponse(request.id, {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    });
  }

  /**
   * Create a success response.
   */
  private successResponse(id: string | number, result: any): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  /**
   * Create an error response.
   */
  private errorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}
