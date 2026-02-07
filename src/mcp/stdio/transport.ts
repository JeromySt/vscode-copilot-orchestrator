/**
 * @fileoverview Stdio transport for MCP JSON-RPC communication.
 *
 * Reads newline-delimited JSON-RPC 2.0 messages from an input stream,
 * dispatches them to a registered handler, and writes responses to an
 * output stream.
 *
 * @module mcp/stdio/transport
 */

import { Readable, Writable } from 'stream';
import { JsonRpcRequest, JsonRpcResponse } from '../types';

/**
 * Reads and writes newline-delimited JSON-RPC 2.0 messages
 * over a pair of byte streams (typically process.stdin/stdout).
 */
export interface IStdioTransport {
  /** Start listening for incoming messages. Resolves when input stream ends. */
  start(): Promise<void>;

  /** Send a JSON-RPC response back to the client. */
  send(message: JsonRpcResponse): void;

  /** Register a handler for incoming requests. */
  onRequest(handler: (request: JsonRpcRequest) => Promise<JsonRpcResponse>): void;

  /** Gracefully shut down the transport. */
  close(): void;
}

/**
 * Factory for creating stdio transports; allows tests to inject mock streams.
 */
export interface IStdioTransportFactory {
  create(input: Readable, output: Writable): IStdioTransport;
}

/**
 * Newline-delimited JSON-RPC 2.0 transport over stdio streams.
 *
 * Buffers incoming data and splits on newlines. Each complete line is
 * parsed as a JSON-RPC request, dispatched to the registered handler,
 * and the response is written back as a single line of JSON.
 *
 * @example
 * ```ts
 * const transport = new StdioTransport(process.stdin, process.stdout);
 * transport.onRequest(async (req) => handler.handleRequest(req));
 * await transport.start();
 * ```
 */
export class StdioTransport implements IStdioTransport {
  private handler?: (req: JsonRpcRequest) => Promise<JsonRpcResponse>;
  private buffer = '';

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {}

  onRequest(handler: (req: JsonRpcRequest) => Promise<JsonRpcResponse>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.input.setEncoding('utf-8');
      this.input.on('data', (chunk: string) => this.onData(chunk));
      this.input.on('end', () => resolve());
      this.input.on('error', () => resolve());
    });
  }

  send(message: JsonRpcResponse): void {
    const json = JSON.stringify(message);
    this.output.write(json + '\n');
  }

  close(): void {
    this.input.destroy();
  }

  private async onData(chunk: string): Promise<void> {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // Last element is the incomplete tail (or empty string)
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }

      let request: JsonRpcRequest;
      try {
        request = JSON.parse(trimmed);
      } catch {
        this.send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
        continue;
      }

      try {
        const response = await this.handler?.(request);
        if (response) { this.send(response); }
      } catch (err: any) {
        this.send({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32603, message: err?.message || 'Internal error' },
        });
      }
    }
  }
}
