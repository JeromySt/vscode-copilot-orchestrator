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

import { DagRunner } from '../dag/runner';
import { Logger, ComponentLogger } from '../core/logger';
import { JsonRpcRequest, JsonRpcResponse, ToolHandlerContext } from './types';
import { getDagToolDefinitions } from './tools/dagTools';
import {
  handleCreateDag,
  handleCreateJob,
  handleGetDagStatus,
  handleListDags,
  handleGetNodeDetails,
  handleGetNodeLogs,
  handleCancelDag,
  handleDeleteDag,
} from './handlers/dagHandlers';

/** MCP component logger */
const log: ComponentLogger = Logger.for('mcp');

/** MCP protocol version */
const PROTOCOL_VERSION = '2024-11-05';

/** Server info for initialize response */
const SERVER_INFO = {
  name: 'copilot-orchestrator',
  version: '0.6.0'  // Bumped for DAG rewrite
};

/**
 * Extended context for DAG handlers
 */
interface DagHandlerContext extends ToolHandlerContext {
  dagRunner: DagRunner;
}

/**
 * MCP Handler class for processing MCP HTTP requests.
 * 
 * Handles the JSON-RPC protocol layer and delegates tool execution
 * to specialized handlers.
 */
export class McpHandler {
  private readonly context: DagHandlerContext;

  /**
   * Create a new MCP handler.
   * 
   * @param dagRunner - DAG runner instance
   * @param workspacePath - Workspace root path
   */
  constructor(dagRunner: DagRunner, workspacePath: string) {
    this.context = { 
      dagRunner, 
      workspacePath,
      // Legacy fields - kept for type compatibility
      runner: null as any,
      plans: null as any,
    };
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
    const tools = getDagToolDefinitions();
    log.info('Tools list requested', { toolCount: tools.length });
    log.debug('Tools list - tool names', { tools: tools.map(t => t.name) });
    
    return this.successResponse(request.id, { tools });
  }

  /**
   * Handle tools/call request.
   */
  private async handleToolsCall(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { name, arguments: args } = request.params || {};
    log.info('Tool call', { tool: name });
    log.debug('Tool call arguments', { tool: name, args });
    
    let result: any;
    
    // Route to appropriate handler
    switch (name) {
      case 'create_copilot_dag':
        result = await handleCreateDag(args || {}, this.context);
        break;
        
      case 'create_copilot_job':
        result = await handleCreateJob(args || {}, this.context);
        break;
        
      case 'get_copilot_dag_status':
        result = await handleGetDagStatus(args || {}, this.context);
        break;
        
      case 'list_copilot_dags':
        result = await handleListDags(args || {}, this.context);
        break;
        
      case 'get_copilot_node_details':
        result = await handleGetNodeDetails(args || {}, this.context);
        break;
        
      case 'get_copilot_node_logs':
        result = await handleGetNodeLogs(args || {}, this.context);
        break;
        
      case 'cancel_copilot_dag':
        result = await handleCancelDag(args || {}, this.context);
        break;
        
      case 'delete_copilot_dag':
        result = await handleDeleteDag(args || {}, this.context);
        break;
        
      default:
        result = { success: false, error: `Unknown tool: ${name}` };
    }
    
    return this.successResponse(request.id, {
      content: [{ type: 'text', text: JSON.stringify(result) }]
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
