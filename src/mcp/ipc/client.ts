/**
 * @fileoverview IPC Client for MCP communication.
 * 
 * The stdio MCP server uses this client to forward requests
 * to the extension host's McpHandler via IPC.
 * 
 * @module mcp/ipc/client
 */

import * as net from 'net';

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
 */
export class McpIpcClient {
  private socket: net.Socket | null = null;
  private readonly pipePath: string;
  private buffer: string = '';
  private pendingRequests: Map<string | number, PendingRequest> = new Map();
  private connected: boolean = false;
  private connectPromise: Promise<void> | null = null;

  constructor(pipePath: string) {
    this.pipePath = pipePath;
  }

  /**
   * Connect to the IPC server.
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.pipePath, () => {
        console.error('[MCP IPC Client] Connected to:', this.pipePath);
        this.connected = true;
        resolve();
      });

      this.socket.on('data', (data) => {
        this.handleData(data);
      });

      this.socket.on('error', (err) => {
        console.error('[MCP IPC Client] Connection error:', err);
        this.connected = false;
        reject(err);
      });

      this.socket.on('close', () => {
        console.error('[MCP IPC Client] Connection closed');
        this.connected = false;
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new Error('Connection closed'));
        }
        this.pendingRequests.clear();
      });
    });

    return this.connectPromise;
  }

  /**
   * Handle incoming data from the server.
   */
  private handleData(data: Buffer): void {
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
   */
  async request(req: any): Promise<any> {
    if (!this.connected || !this.socket) {
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
   * Check if connected to the server.
   */
  isConnected(): boolean {
    return this.connected;
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
    this.connectPromise = null;
    this.pendingRequests.clear();
  }
}
