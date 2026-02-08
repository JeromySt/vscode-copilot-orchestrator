/**
 * @fileoverview IPC Client for MCP communication.
 * 
 * The stdio MCP server uses this client to forward requests
 * to the extension host's McpHandler via IPC.
 * 
 * Security:
 * - Reads auth nonce from MCP_AUTH_NONCE environment variable
 * - Sends auth message as first message on connect
 * - Connection fails if auth is rejected by server
 * 
 * @module mcp/ipc/client
 */

import * as net from 'net';

/** Environment variable name for the auth nonce */
const AUTH_NONCE_ENV = 'MCP_AUTH_NONCE';

/**
 * Pending request waiting for response.
 */
interface PendingRequest {
  resolve: (response: any) => void;
  reject: (error: Error) => void;
}

/**
 * IPC Client that connects to the extension host's MCP server.
 * 
 * Forwards JSON-RPC requests from the stdio transport to the
 * extension's McpHandler and returns responses.
 * 
 * Security:
 * - Must authenticate with nonce from environment variable
 * - Server will reject connection without valid auth
 */
export class McpIpcClient {
  private socket: net.Socket | null = null;
  private readonly pipePath: string;
  private readonly authNonce: string | undefined;
  private buffer: string = '';
  private pendingRequests: Map<string | number, PendingRequest> = new Map();
  private connected: boolean = false;
  private authenticated: boolean = false;
  private connectPromise: Promise<void> | null = null;

  constructor(pipePath: string) {
    this.pipePath = pipePath;
    this.authNonce = process.env[AUTH_NONCE_ENV];
    
    if (!this.authNonce) {
      console.error(`[MCP IPC Client] Warning: ${AUTH_NONCE_ENV} environment variable not set`);
    }
  }

  /**
   * Connect to the IPC server and authenticate.
   */
  async connect(): Promise<void> {
    if (this.connected && this.authenticated) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.pipePath, () => {
        console.error('[MCP IPC Client] Connected to:', this.pipePath);
        this.connected = true;
        
        // Send auth message immediately
        if (this.authNonce) {
          const authMsg = JSON.stringify({ type: 'auth', nonce: this.authNonce }) + '\n';
          this.socket!.write(authMsg, (err) => {
            if (err) {
              console.error('[MCP IPC Client] Failed to send auth:', err);
              reject(err);
            }
          });
        } else {
          // No nonce - connection will likely be rejected
          console.error('[MCP IPC Client] No auth nonce available - connection may fail');
          reject(new Error(`${AUTH_NONCE_ENV} environment variable not set`));
        }
      });

      // Wait for auth response
      let authBuffer = '';
      const onAuthData = (data: Buffer) => {
        authBuffer += data.toString();
        const lines = authBuffer.split('\n');
        authBuffer = lines.pop() || '';
        
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const response = JSON.parse(line);
            if (response.type === 'auth_success') {
              this.authenticated = true;
              console.error('[MCP IPC Client] Authenticated successfully');
              
              // Switch to normal message handling
              this.socket!.removeListener('data', onAuthData);
              this.socket!.on('data', (d) => this.handleData(d));
              
              // Process any remaining buffered data
              if (authBuffer.trim()) {
                this.handleData(authBuffer);
              }
              
              resolve();
            } else {
              console.error('[MCP IPC Client] Unexpected auth response:', response);
              reject(new Error('Unexpected auth response'));
            }
          } catch (err) {
            console.error('[MCP IPC Client] Failed to parse auth response:', err);
            reject(err);
          }
        }
      };

      this.socket.on('data', onAuthData);

      this.socket.on('error', (err) => {
        console.error('[MCP IPC Client] Connection error:', err);
        this.connected = false;
        this.authenticated = false;
        this.connectPromise = null;  // Allow reconnection
        reject(err);
      });

      this.socket.on('close', () => {
        console.error('[MCP IPC Client] Connection closed');
        this.connected = false;
        this.authenticated = false;
        this.connectPromise = null;  // Allow reconnection
        // Reject all pending requests
        for (const [, pending] of this.pendingRequests) {
          pending.reject(new Error('Connection closed'));
        }
        this.pendingRequests.clear();
      });
      
      // Auth timeout
      setTimeout(() => {
        if (!this.authenticated) {
          console.error('[MCP IPC Client] Auth timeout');
          this.socket?.destroy();
          reject(new Error('Auth timeout'));
        }
      }, 5000);
    });

    return this.connectPromise;
  }

  /**
   * Handle incoming data from the server.
   */
  private handleData(data: Buffer | string): void {
    this.buffer += data.toString();
    
    // Process complete lines (newline-delimited JSON)
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const response = JSON.parse(line);
          const id = response.id;
          
          if (id !== undefined && this.pendingRequests.has(id)) {
            const pending = this.pendingRequests.get(id)!;
            this.pendingRequests.delete(id);
            pending.resolve(response);
          }
        } catch (err) {
          console.error('[MCP IPC Client] Failed to parse response:', err);
        }
      }
    }
  }

  /**
   * Send a request to the IPC server and wait for response.
   * Automatically reconnects if the connection was lost.
   */
  async request(req: any): Promise<any> {
    // Reconnect if needed
    if (!this.connected || !this.authenticated || !this.socket) {
      this.connectPromise = null;  // Clear any stale promise
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      const id = req.id;
      
      // For notifications (no id), we don't expect a response
      if (id === undefined) {
        this.socket!.write(JSON.stringify(req) + '\n');
        resolve(null);
        return;
      }

      // Store pending request
      this.pendingRequests.set(id, { resolve, reject });

      // Send request
      this.socket!.write(JSON.stringify(req) + '\n', (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${id} timed out`));
        }
      }, 30000);
    });
  }

  /**
   * Check if connected and authenticated to the server.
   */
  isConnected(): boolean {
    return this.connected && this.authenticated;
  }

  /**
   * Disconnect from the server.
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.authenticated = false;
    this.connectPromise = null;
    this.pendingRequests.clear();
  }
}
