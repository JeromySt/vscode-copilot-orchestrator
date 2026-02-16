/**
 * @fileoverview IPC Server for MCP communication.
 * 
 * The extension host runs this IPC server to receive MCP requests
 * from the stdio child process and forward them to the McpHandler.
 * 
 * Uses named pipes (Windows) or Unix sockets (Linux/Mac) for IPC.
 * Each VS Code instance gets a unique pipe based on a generated session ID.
 * 
 * Security measures:
 * - Random auth nonce passed via environment variable (not command line)
 * - Only accepts one authenticated connection
 * - First message must contain the auth nonce
 * - Auth timeout of 5 seconds
 * 
 * @module mcp/ipc/server
 */

import * as net from 'net';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { McpHandler } from '../handler';

/** Auth message sent by client on connect */
interface AuthMessage {
  type: 'auth';
  nonce: string;
}

/** How long to wait for auth before closing connection */
const AUTH_TIMEOUT_MS = 5000;

/**
 * Generate a unique session ID for this VS Code instance.
 * Uses crypto for uniqueness across multiple windows.
 */
function generateSessionId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Generate a cryptographically random auth nonce.
 */
function generateNonce(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * IPC Server that bridges the stdio MCP server to the extension's McpHandler.
 * 
 * Each VS Code instance creates its own IPC server with a unique session ID.
 * The stdio child process connects to this server using the path passed via CLI.
 * 
 * Security:
 * - Only accepts ONE connection that provides the correct auth nonce
 * - Auth nonce is passed to the child via environment variable
 * - Connection is rejected if auth fails or times out
 */
export class McpIpcServer {
  private server: net.Server | null = null;
  private readonly pipePath: string;
  private readonly sessionId: string;
  private readonly authNonce: string;
  private authenticatedClient: net.Socket | null = null;
  private handler: McpHandler | null = null;
  private hasAcceptedConnection: boolean = false;

  /**
   * Create an IPC server for this extension instance.
   * @param sessionId - Optional session ID. If not provided, generates a unique one.
   */
  constructor(sessionId?: string) {
    this.sessionId = sessionId || generateSessionId();
    this.authNonce = generateNonce();
    
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
   * Get the auth nonce that clients must provide to authenticate.
   * This should be passed to the child process via environment variable.
   */
  getAuthNonce(): string {
    return this.authNonce;
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
   * 
   * Security:
   * - Only one connection is ever accepted
   * - First message must be auth with correct nonce
   * - Auth must occur within AUTH_TIMEOUT_MS
   */
  private handleConnection(socket: net.Socket): void {
    // Security: Only accept one connection ever
    if (this.hasAcceptedConnection) {
      console.warn('[MCP IPC Server] Rejecting additional connection attempt (already have authenticated client)');
      socket.destroy();
      return;
    }

    console.log('[MCP IPC Server] Client connecting, awaiting auth...');
    
    let buffer = '';
    let authenticated = false;

    // Set up auth timeout
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        console.error('[MCP IPC Server] Auth timeout - closing connection');
        socket.destroy();
      }
    }, AUTH_TIMEOUT_MS);

    const handleData = async (data: Buffer) => {
      buffer += data.toString();
      
      // Process complete lines (newline-delimited JSON)
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) {continue;}

        if (!authenticated) {
          // First message must be auth
          try {
            const authMsg = JSON.parse(line) as AuthMessage;
            if (authMsg.type === 'auth' && authMsg.nonce === this.authNonce) {
              authenticated = true;
              this.hasAcceptedConnection = true;
              this.authenticatedClient = socket;
              clearTimeout(authTimeout);
              console.log('[MCP IPC Server] Client authenticated successfully');
              
              // Send auth success response
              socket.write(JSON.stringify({ type: 'auth_success' }) + '\n');
            } else {
              console.error('[MCP IPC Server] Auth failed - invalid nonce');
              clearTimeout(authTimeout);
              socket.destroy();
              return;
            }
          } catch {
            console.error('[MCP IPC Server] Auth failed - invalid auth message');
            clearTimeout(authTimeout);
            socket.destroy();
            return;
          }
        } else {
          // Process MCP message
          await this.processMessage(socket, line);
        }
      }
    };

    socket.on('data', handleData);

    socket.on('close', () => {
      clearTimeout(authTimeout);
      if (this.authenticatedClient === socket) {
        this.authenticatedClient = null;
        // Allow reconnection: VS Code may restart the MCP server process
        // The new process will have the same auth nonce from its environment
        this.hasAcceptedConnection = false;
        console.log('[MCP IPC Server] Authenticated client disconnected - accepting new connections');
      } else {
        console.log('[MCP IPC Server] Unauthenticated client disconnected');
      }
    });

    socket.on('error', (err) => {
      console.error('[MCP IPC Server] Socket error:', err);
      clearTimeout(authTimeout);
      if (this.authenticatedClient === socket) {
        this.authenticatedClient = null;
        // Allow reconnection on error as well
        this.hasAcceptedConnection = false;
        console.log('[MCP IPC Server] Authenticated client error - accepting new connections');
      }
    });
  }

  /**
   * Process a JSON-RPC message from the authenticated client.
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
    // Close authenticated client connection
    if (this.authenticatedClient) {
      this.authenticatedClient.destroy();
      this.authenticatedClient = null;
    }
    this.hasAcceptedConnection = false;

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

  /**
   * Check if a client is currently connected and authenticated.
   */
  hasClient(): boolean {
    return this.authenticatedClient !== null;
  }
}
