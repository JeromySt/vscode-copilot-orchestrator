/**
 * @fileoverview IPC Server for MCP communication.
 * 
 * The extension host runs this IPC server to receive MCP requests
 * from the stdio child process and forward them to the McpHandler.
 * 
 * Uses named pipes (Windows) or Unix sockets (Linux/Mac) for IPC.
 * Each VS Code instance gets a unique pipe based on a generated session ID.
 * 
 * @module mcp/ipc/server
 */

import * as net from 'net';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { McpHandler } from '../handler';

/**
 * Generate a unique session ID for this VS Code instance.
 * Uses crypto for uniqueness across multiple windows.
 */
function generateSessionId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * IPC Server that bridges the stdio MCP server to the extension's McpHandler.
 * 
 * Each VS Code instance creates its own IPC server with a unique session ID.
 * The stdio child process connects to this server using the path passed via CLI.
 */
export class McpIpcServer {
  private server: net.Server | null = null;
  private readonly pipePath: string;
  private readonly sessionId: string;
  private clients: Set<net.Socket> = new Set();
  private handler: McpHandler | null = null;

  /**
   * Create an IPC server for this extension instance.
   * @param sessionId - Optional session ID. If not provided, generates a unique one.
   */
  constructor(sessionId?: string) {
    this.sessionId = sessionId || generateSessionId();
    
    // Create a unique pipe path for this VS Code instance
    // Format: orchestrator-mcp-{sessionId}
    const pipeName = `orchestrator-mcp-${this.sessionId}`;
    
    if (os.platform() === 'win32') {
      // Windows named pipe
      this.pipePath = `\\\\.\\pipe\\${pipeName}`;
    } else {
      // Unix socket in temp directory
      const tmpDir = os.tmpdir();
      this.pipePath = path.join(tmpDir, `${pipeName}.sock`);
    }
  }

  /**
   * Get the unique session ID for this server instance.
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get the pipe path for clients to connect to.
   */
  getPipePath(): string {
    return this.pipePath;
  }

  /**
   * Set the McpHandler that will process requests.
   */
  setHandler(handler: McpHandler): void {
    this.handler = handler;
  }

  /**
   * Start the IPC server.
   */
  async start(): Promise<void> {
    if (this.server) {
      return; // Already running
    }

    // Clean up stale socket file on Unix
    if (os.platform() !== 'win32') {
      try {
        fs.unlinkSync(this.pipePath);
      } catch {
        // File doesn't exist, that's fine
      }
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err) => {
        console.error('[MCP IPC Server] Server error:', err);
        reject(err);
      });

      this.server.listen(this.pipePath, () => {
        console.log('[MCP IPC Server] Listening on:', this.pipePath);
        resolve();
      });
    });
  }

  /**
   * Handle a new client connection.
   */
  private handleConnection(socket: net.Socket): void {
    console.log('[MCP IPC Server] Client connected');
    this.clients.add(socket);

    let buffer = '';

    socket.on('data', async (data) => {
      buffer += data.toString();
      
      // Process complete lines (newline-delimited JSON)
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          await this.processMessage(socket, line);
        }
      }
    });

    socket.on('close', () => {
      console.log('[MCP IPC Server] Client disconnected');
      this.clients.delete(socket);
    });

    socket.on('error', (err) => {
      console.error('[MCP IPC Server] Socket error:', err);
      this.clients.delete(socket);
    });
  }

  /**
   * Process a JSON-RPC message from the client.
   */
  private async processMessage(socket: net.Socket, message: string): Promise<void> {
    if (!this.handler) {
      const errorResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: 'Handler not initialized' }
      };
      socket.write(JSON.stringify(errorResponse) + '\n');
      return;
    }

    try {
      const request = JSON.parse(message);
      const response = await this.handler.handleRequest(request);
      
      if (response !== null) {
        socket.write(JSON.stringify(response) + '\n');
      }
    } catch (err) {
      console.error('[MCP IPC Server] Error processing message:', err);
      const errorResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' }
      };
      socket.write(JSON.stringify(errorResponse) + '\n');
    }
  }

  /**
   * Stop the IPC server and close all connections.
   */
  stop(): void {
    // Close all client connections
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    // Close the server
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Clean up socket file on Unix
    if (os.platform() !== 'win32') {
      try {
        fs.unlinkSync(this.pipePath);
      } catch {
        // File doesn't exist or already cleaned up
      }
    }

    console.log('[MCP IPC Server] Stopped');
  }

  /**
   * Check if the server is running.
   */
  isRunning(): boolean {
    return this.server !== null;
  }
}
