/**
 * @fileoverview MCP type definitions.
 * 
 * Shared types for the MCP module.
 * 
 * @module mcp/types
 */

/**
 * MCP tool definition returned by the `tools/list` JSON-RPC method.
 *
 * Conforms to the MCP specification's `Tool` schema:
 * each tool exposes a unique {@link name}, a human-/LLM-readable
 * {@link description}, and a JSON Schema ({@link inputSchema}) that
 * describes the accepted arguments.
 *
 * @see {@link https://modelcontextprotocol.io/specification | MCP Specification}
 *
 * @example
 * ```ts
 * const tool: McpTool = {
 *   name: 'get_copilot_plan_status',
 *   description: 'Get status of a Plan including progress and node states.',
 *   inputSchema: {
 *     type: 'object',
 *     properties: { id: { type: 'string', description: 'Plan ID' } },
 *     required: ['id'],
 *   },
 * };
 * ```
 */
export interface McpTool {
  /** Unique tool name used in `tools/call` requests (e.g. `"create_copilot_plan"`). */
  name: string;
  /** Human-readable description surfaced to LLM clients as tool documentation. */
  description: string;
  /**
   * JSON Schema describing the tool's input arguments.
   *
   * Must be an `object` type with a `properties` map. The optional `required`
   * array lists property names that must be supplied by the caller.
   */
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

/**
 * JSON-RPC 2.0 request envelope used by the MCP HTTP transport.
 *
 * The MCP protocol encodes every client→server message as a JSON-RPC 2.0
 * request.  The {@link method} field determines which MCP method is invoked
 * (`initialize`, `tools/list`, `tools/call`, etc.).
 *
 * @see {@link https://www.jsonrpc.org/specification | JSON-RPC 2.0 Specification}
 */
export interface JsonRpcRequest {
  /** Must be `"2.0"` per JSON-RPC 2.0. */
  jsonrpc: '2.0';
  /** Caller-assigned request identifier, echoed back in the response. */
  id: string | number;
  /** MCP method name (e.g. `"initialize"`, `"tools/call"`). */
  method: string;
  /** Method-specific parameters. For `tools/call` this contains `{ name, arguments }`. */
  params?: any;
}

/**
 * JSON-RPC 2.0 response envelope returned by the MCP server.
 *
 * Exactly one of {@link result} or {@link error} will be present.
 * Standard JSON-RPC error codes:
 * - `-32600` Invalid Request
 * - `-32601` Method not found
 * - `-32602` Invalid params
 * - `-32603` Internal error
 *
 * @see {@link https://www.jsonrpc.org/specification | JSON-RPC 2.0 Specification}
 */
export interface JsonRpcResponse {
  /** Must be `"2.0"` per JSON-RPC 2.0. */
  jsonrpc: '2.0';
  /** Echoed request identifier, or `null` for notifications. */
  id: string | number | null;
  /** Successful result payload (mutually exclusive with {@link error}). */
  result?: any;
  /** Error payload (mutually exclusive with {@link result}). */
  error?: { code: number; message: string; data?: any };
}

/**
 * Base dependency-injection context passed to every MCP tool handler.
 *
 * Provides access to the workspace path and legacy fields kept for backward
 * compatibility.  Concrete handlers use the extended {@link PlanHandlerContext}
 * (defined in `handlers/utils.ts`) which adds the {@link PlanRunner} instance.
 *
 * @remarks
 * `runner` and `plans` are retained for type compatibility but are always `null`.
 */
export interface ToolHandlerContext {
  /** @deprecated Legacy field – always `null`. Use `PlanRunner` via {@link PlanHandlerContext}. */
  runner: any;
  /** @deprecated Legacy field – always `null`. Use `PlanRunner` via {@link PlanHandlerContext}. */
  plans: any;
  /** Absolute filesystem path to the workspace root (git repository). */
  workspacePath: string;
}

/**
 * Signature for an MCP tool handler function.
 *
 * Every handler receives the caller-supplied arguments (already
 * JSON-parsed) and a {@link ToolHandlerContext} providing shared
 * dependencies.  Handlers return a result object that is serialised
 * as the `content` of the `tools/call` JSON-RPC response.
 *
 * @param args - Tool arguments matching the tool's `inputSchema`.
 * @param context - Shared dependency-injection context.
 * @returns Arbitrary result payload (serialised to JSON in the response).
 */
export type ToolHandler = (args: any, context: ToolHandlerContext) => Promise<any>;
