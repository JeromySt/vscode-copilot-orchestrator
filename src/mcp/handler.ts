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

import { PlanRunner } from '../plan/runner';
import { Logger, ComponentLogger } from '../core/logger';
import { JsonRpcRequest, JsonRpcResponse } from './types';
import { IMcpRequestRouter } from '../interfaces/IMcpManager';
import { getPlanToolDefinitions } from './tools/planTools';
import { getNodeToolDefinitions } from './tools/nodeTools';
import { validateInput, hasSchema } from './validation';
import {
  PlanHandlerContext,
  handleCreatePlan,
  handleGetPlanStatus,
  handleListPlans,
  handleGetNodeDetails,
  handleGetNodeLogs,
  handleGetNodeAttempts,
  handleCancelPlan,
  handlePausePlan,
  handleResumePlan,
  handleDeletePlan,
  handleRetryPlan,
  handleGetNodeFailureContext,
  handleRetryPlanNode,
  handleUpdatePlanNode,
  handleGetNode,
  handleListNodes,
  handleRetryNode,
  handleForceFailNode,
  handleNodeFailureContext,
} from './handlers';

/** MCP component logger */
const log: ComponentLogger = Logger.for('mcp');

/**
 * MCP protocol version advertised during the `initialize` handshake.
 *
 * @see {@link https://modelcontextprotocol.io/specification | MCP Specification}
 */
const PROTOCOL_VERSION = '2024-11-05';

/**
 * Server identity included in the `initialize` response.
 *
 * The `version` field is bumped for major internal rewrites (e.g. the Plan
 * rewrite) so that clients can detect capability changes.
 */
const SERVER_INFO = {
  name: 'copilot-orchestrator',
  version: '0.6.0'  // Bumped for Plan rewrite
};

/**
 * MCP protocol handler for the HTTP transport layer.
 *
 * Receives JSON-RPC 2.0 requests (typically from `POST /mcp`), performs
 * protocol-level routing, and delegates tool execution to specialised
 * handlers in `handlers/planHandlers.ts`.
 *
 * Supported JSON-RPC methods:
 * | Method                      | Description                              |
 * |-----------------------------|------------------------------------------|
 * | `initialize`                | MCP handshake; returns capabilities      |
 * | `notifications/initialized` | Client acknowledgement (no-op response)  |
 * | `tools/list`                | Returns all registered tool definitions  |
 * | `tools/call`                | Executes a tool and returns its result   |
 *
 * @example
 * ```ts
 * const handler = new McpHandler(planRunner, '/workspace', git, configProvider);
 * const response = await handler.handleRequest({
 *   jsonrpc: '2.0',
 *   id: 1,
 *   method: 'tools/list',
 * });
 * // response.result.tools => McpTool[]
 * ```
 */
export class McpHandler implements IMcpRequestRouter {
  private readonly context: PlanHandlerContext;

  /**
   * Create a new MCP handler.
   *
   * @param PlanRunner      - Singleton {@link PlanRunner} that manages plan lifecycle.
   * @param workspacePath   - Absolute path to the workspace root (git repository).
   * @param git             - Git operations interface.
   * @param configProvider  - Optional configuration provider for reading VS Code settings.
   */
  constructor(
    PlanRunner: PlanRunner,
    workspacePath: string,
    git: import('../interfaces/IGitOperations').IGitOperations,
    configProvider?: import('../interfaces/IConfigProvider').IConfigProvider,
  ) {
    this.context = { 
      PlanRunner, 
      workspacePath,
      git,
      configProvider,
      // Legacy fields - kept for type compatibility
      runner: null as any,
      plans: null as any,
    };
    log.info('MCP Handler initialized', { workspacePath });
  }

  /**
   * Process an incoming MCP JSON-RPC request and return a response.
   *
   * Routes the request to the appropriate protocol handler based on
   * {@link JsonRpcRequest.method}.  Unknown methods receive a `-32601`
   * (Method not found) error.  Unhandled exceptions are caught and
   * returned as `-32603` (Internal error) responses.
   *
   * @param request - Parsed JSON-RPC 2.0 request.
   * @returns JSON-RPC 2.0 response (never throws).
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
          return await this.handleToolsList(request);

        case 'tools/call':
          return await this.handleToolsCall(request);

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
   * Handle the `initialize` JSON-RPC method.
   *
   * Returns the server's protocol version, capabilities (currently just
   * `tools`), and server identity.
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
   * Handle the `notifications/initialized` JSON-RPC method.
   *
   * Acknowledgement from the client that initialisation is complete.
   * No server-side action is required.
   */
  private handleInitializedNotification(request: JsonRpcRequest): JsonRpcResponse {
    log.info('Client initialized notification received');
    return this.successResponse(request.id, {});
  }

  /**
   * Handle the `tools/list` JSON-RPC method.
   *
   * Returns all registered MCP tool definitions from
   * {@link getPlanToolDefinitions}.
   */
  private async handleToolsList(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const tools = [
      ...(await getPlanToolDefinitions()),
      ...(await getNodeToolDefinitions()),
    ];
    log.info('Tools list requested', { toolCount: tools.length });
    log.debug('Tools list - tool names', { tools: tools.map(t => t.name) });
    
    return this.successResponse(request.id, { tools });
  }

  /**
   * Handle the `tools/call` JSON-RPC method.
   *
   * Routes the call to the matching plan handler based on the tool `name`.
   * The handler result is wrapped in an MCP `content` array with a single
   * `text` item containing the JSON-serialised result.
   * 
   * All input is validated against JSON schemas before processing.
   */
  private async handleToolsCall(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { name, arguments: args } = request.params || {};
    log.info('Tool call', { tool: name });
    log.debug('Tool call arguments', { tool: name, args });
    
    // Validate input against JSON schema before processing
    if (hasSchema(name)) {
      const validation = validateInput(name, args || {});
      if (!validation.valid) {
        log.warn('Schema validation failed', { tool: name, error: validation.error });
        return this.successResponse(request.id, {
          content: [{ type: 'text', text: JSON.stringify({ 
            success: false, 
            error: validation.error 
          }) }]
        });
      }
    }
    
    let result: any;
    
    // Route to appropriate handler
    switch (name) {
      case 'create_copilot_plan':
        result = await handleCreatePlan(args || {}, this.context);
        break;
        
      case 'get_copilot_plan_status':
        result = await handleGetPlanStatus(args || {}, this.context);
        break;
        
      case 'list_copilot_plans':
        result = await handleListPlans(args || {}, this.context);
        break;
        
      case 'get_copilot_node_details':
        result = await handleGetNodeDetails(args || {}, this.context);
        break;
        
      case 'get_copilot_node_logs':
        result = await handleGetNodeLogs(args || {}, this.context);
        break;
        
      case 'get_copilot_node_attempts':
        result = await handleGetNodeAttempts(args || {}, this.context);
        break;
        
      case 'cancel_copilot_plan':
        result = await handleCancelPlan(args || {}, this.context);
        break;
        
      case 'pause_copilot_plan':
        result = await handlePausePlan(args || {}, this.context);
        break;
        
      case 'resume_copilot_plan':
        result = await handleResumePlan(args || {}, this.context);
        break;
        
      case 'delete_copilot_plan':
        result = await handleDeletePlan(args || {}, this.context);
        break;
        
      case 'retry_copilot_plan':
        result = await handleRetryPlan(args || {}, this.context);
        break;
        
      case 'get_copilot_plan_node_failure_context':
        result = await handleGetNodeFailureContext(args || {}, this.context);
        break;
        
      case 'retry_copilot_plan_node':
        result = await handleRetryPlanNode(args || {}, this.context);
        break;
        
      case 'update_copilot_plan_node':
        result = await handleUpdatePlanNode(args || {}, this.context);
        break;
        
      // --- New node-centric tools ---
      case 'get_copilot_node':
        result = await handleGetNode(args || {}, this.context);
        break;
        
      case 'list_copilot_nodes':
        result = await handleListNodes(args || {}, this.context);
        break;
        
      case 'retry_copilot_node':
        result = await handleRetryNode(args || {}, this.context);
        break;
        
      case 'force_fail_copilot_node':
        result = await handleForceFailNode(args || {}, this.context);
        break;
        
      case 'get_copilot_node_failure_context':
        result = await handleNodeFailureContext(args || {}, this.context);
        break;
        
      default:
        result = { success: false, error: `Unknown tool: ${name}` };
    }
    
    return this.successResponse(request.id, {
      content: [{ type: 'text', text: JSON.stringify(result) }]
    });
  }

  /**
   * Build a JSON-RPC 2.0 success response.
   *
   * @param id     - Request identifier to echo.
   * @param result - Payload to include in the response.
   */
  private successResponse(id: string | number, result: any): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  /**
   * Build a JSON-RPC 2.0 error response.
   *
   * @param id      - Request identifier to echo (may be `null` for parse errors).
   * @param code    - JSON-RPC error code (e.g. `-32601` for Method not found).
   * @param message - Human-readable error description.
   */
  private errorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}
