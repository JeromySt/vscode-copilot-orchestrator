/**
 * @fileoverview Comprehensive tests for MCP IPC Server.
 * Covers McpIpcServer: constructor, start, stop, handleConnection, auth, processMessage.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as net from 'net';
import { McpIpcServer } from '../../../mcp/ipc/server';

suite('McpIpcServer', () => {
  let server: McpIpcServer;

  setup(() => {
    server = new McpIpcServer('test-session');
  });

  teardown(() => {
    try { server.stop(); } catch { /* ok */ }
  });

  suite('Constructor', () => {
    test('should create server with provided session ID', () => {
      assert.strictEqual(server.getSessionId(), 'test-session');
    });

    test('should generate session ID when not provided', () => {
      const auto = new McpIpcServer();
      assert.ok(auto.getSessionId().length > 0);
      auto.stop();
    });

    test('should generate auth nonce', () => {
      assert.ok(server.getAuthNonce().length > 0);
    });

    test('should generate pipe path', () => {
      const pipePath = server.getPipePath();
      assert.ok(pipePath.includes('orchestrator-mcp-test-session'));
    });
  });

  suite('State Management', () => {
    test('should not be running initially', () => {
      assert.strictEqual(server.isRunning(), false);
    });

    test('should not have client initially', () => {
      assert.strictEqual(server.hasClient(), false);
    });

    test('should be running after start', async () => {
      await server.start();
      assert.strictEqual(server.isRunning(), true);
    });

    test('should not be running after stop', async () => {
      await server.start();
      server.stop();
      assert.strictEqual(server.isRunning(), false);
    });

    test('should be idempotent on double start', async () => {
      await server.start();
      await server.start(); // Should not throw
      assert.strictEqual(server.isRunning(), true);
    });
  });

  suite('setHandler', () => {
    test('should accept handler', () => {
      server.setHandler({} as any);
      // No error thrown
      assert.ok(true);
    });
  });

  suite('Connection Handling', () => {
    test('should accept authenticated connection', async () => {
      await server.start();
      const nonce = server.getAuthNonce();
      const pipePath = server.getPipePath();

      // Create mock handler
      const mockHandler = {
        handleRequest: async (req: any) => ({
          jsonrpc: '2.0', id: req.id, result: { ok: true },
        }),
      };
      server.setHandler(mockHandler as any);

      // Connect client
      const client = net.createConnection(pipePath);
      await new Promise<void>((resolve, reject) => {
        client.on('connect', resolve);
        client.on('error', reject);
      });

      // Send auth
      client.write(JSON.stringify({ type: 'auth', nonce }) + '\n');

      // Wait for auth_success response
      const authResponse = await new Promise<string>((resolve) => {
        client.once('data', (data) => resolve(data.toString()));
      });
      assert.ok(authResponse.includes('auth_success'));
      assert.strictEqual(server.hasClient(), true);

      // Send MCP request
      client.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test' }) + '\n');

      // Wait for response
      const response = await new Promise<string>((resolve) => {
        client.once('data', (data) => resolve(data.toString()));
      });
      const parsed = JSON.parse(response.trim());
      assert.strictEqual(parsed.result.ok, true);

      client.destroy();
      // Wait for disconnect
      await new Promise(r => setTimeout(r, 50));
    });

    test('should reject invalid auth nonce', async () => {
      await server.start();
      const pipePath = server.getPipePath();

      const client = net.createConnection(pipePath);
      await new Promise<void>((resolve, reject) => {
        client.on('connect', resolve);
        client.on('error', reject);
      });

      // Send wrong nonce
      client.write(JSON.stringify({ type: 'auth', nonce: 'wrong' }) + '\n');

      await new Promise<void>((resolve) => {
        client.on('close', () => resolve());
      });
      assert.strictEqual(server.hasClient(), false);
    });

    test('should reject invalid auth message', async () => {
      await server.start();
      const pipePath = server.getPipePath();

      const client = net.createConnection(pipePath);
      await new Promise<void>((resolve, reject) => {
        client.on('connect', resolve);
        client.on('error', reject);
      });

      // Send invalid JSON
      client.write('not json\n');

      await new Promise<void>((resolve) => {
        client.on('close', () => resolve());
      });
    });

    test('should reject second connection', async () => {
      await server.start();
      const nonce = server.getAuthNonce();
      const pipePath = server.getPipePath();

      // First client authenticates
      const client1 = net.createConnection(pipePath);
      await new Promise<void>((resolve, reject) => {
        client1.on('connect', resolve);
        client1.on('error', reject);
      });
      client1.write(JSON.stringify({ type: 'auth', nonce }) + '\n');
      await new Promise<void>((resolve) => {
        client1.once('data', () => resolve());
      });

      // Second client tries to connect
      const client2 = net.createConnection(pipePath);
      await new Promise<void>((resolve, reject) => {
        client2.on('connect', resolve);
        client2.on('error', reject);
      });

      // Second client should be destroyed
      await new Promise<void>((resolve) => {
        client2.on('close', () => resolve());
      });

      client1.destroy();
      await new Promise(r => setTimeout(r, 50));
    });

    test('should allow reconnection after client disconnect', async () => {
      await server.start();
      const nonce = server.getAuthNonce();
      const pipePath = server.getPipePath();

      // First client connects and disconnects
      const client1 = net.createConnection(pipePath);
      await new Promise<void>((resolve, reject) => {
        client1.on('connect', resolve);
        client1.on('error', reject);
      });
      client1.write(JSON.stringify({ type: 'auth', nonce }) + '\n');
      await new Promise<void>((resolve) => {
        client1.once('data', () => resolve());
      });
      client1.destroy();
      await new Promise(r => setTimeout(r, 100));

      // Second client should be able to connect
      const client2 = net.createConnection(pipePath);
      await new Promise<void>((resolve, reject) => {
        client2.on('connect', resolve);
        client2.on('error', reject);
      });
      client2.write(JSON.stringify({ type: 'auth', nonce }) + '\n');
      const resp = await new Promise<string>((resolve) => {
        client2.once('data', (data) => resolve(data.toString()));
      });
      assert.ok(resp.includes('auth_success'));

      client2.destroy();
      await new Promise(r => setTimeout(r, 50));
    });

    test('should send error when handler not set', async () => {
      await server.start();
      const nonce = server.getAuthNonce();
      const pipePath = server.getPipePath();

      // Don't set handler

      const client = net.createConnection(pipePath);
      await new Promise<void>((resolve, reject) => {
        client.on('connect', resolve);
        client.on('error', reject);
      });

      client.write(JSON.stringify({ type: 'auth', nonce }) + '\n');
      await new Promise<void>((resolve) => {
        client.once('data', () => resolve());
      });

      // Send request without handler
      client.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test' }) + '\n');
      const response = await new Promise<string>((resolve) => {
        client.once('data', (data) => resolve(data.toString()));
      });
      const parsed = JSON.parse(response.trim());
      assert.ok(parsed.error);
      assert.strictEqual(parsed.error.code, -32603);

      client.destroy();
      await new Promise(r => setTimeout(r, 50));
    });

    test('should handle invalid JSON in message', async () => {
      await server.start();
      const nonce = server.getAuthNonce();
      const pipePath = server.getPipePath();
      server.setHandler({ handleRequest: async () => ({}) } as any);

      const client = net.createConnection(pipePath);
      await new Promise<void>((resolve, reject) => {
        client.on('connect', resolve);
        client.on('error', reject);
      });

      client.write(JSON.stringify({ type: 'auth', nonce }) + '\n');
      await new Promise<void>((resolve) => {
        client.once('data', () => resolve());
      });

      // Send invalid JSON
      client.write('not valid json\n');
      const response = await new Promise<string>((resolve) => {
        client.once('data', (data) => resolve(data.toString()));
      });
      const parsed = JSON.parse(response.trim());
      assert.ok(parsed.error);
      assert.strictEqual(parsed.error.code, -32700);

      client.destroy();
      await new Promise(r => setTimeout(r, 50));
    });
  });

  suite('Stop', () => {
    test('should clean up on stop', async () => {
      await server.start();
      server.stop();
      assert.strictEqual(server.isRunning(), false);
      assert.strictEqual(server.hasClient(), false);
    });

    test('should handle stop when not started', () => {
      server.stop(); // Should not throw
      assert.ok(true);
    });

    test('should destroy active authenticated client on stop', async () => {
      await server.start();
      const nonce = server.getAuthNonce();
      const pipePath = server.getPipePath();
      server.setHandler({ handleRequest: async () => ({}) } as any);

      const client = net.createConnection(pipePath);
      await new Promise<void>((resolve, reject) => {
        client.on('connect', resolve);
        client.on('error', reject);
      });

      // Authenticate
      client.write(JSON.stringify({ type: 'auth', nonce }) + '\n');
      await new Promise<void>((resolve) => {
        client.once('data', () => resolve());
      });

      assert.strictEqual(server.hasClient(), true);

      // Stop should destroy authenticated client
      server.stop();
      assert.strictEqual(server.isRunning(), false);
      assert.strictEqual(server.hasClient(), false);
      client.destroy();
      await new Promise(r => setTimeout(r, 50));
    });

    test('should handle authenticated client socket error', async () => {
      await server.start();
      const nonce = server.getAuthNonce();
      const pipePath = server.getPipePath();
      server.setHandler({ handleRequest: async () => ({}) } as any);

      const client = net.createConnection(pipePath);
      await new Promise<void>((resolve, reject) => {
        client.on('connect', resolve);
        client.on('error', reject);
      });

      // Authenticate
      client.write(JSON.stringify({ type: 'auth', nonce }) + '\n');
      await new Promise<void>((resolve) => {
        client.once('data', () => resolve());
      });

      assert.strictEqual(server.hasClient(), true);

      // Simulate error on the client socket by destroying it abruptly
      client.destroy(new Error('Simulated connection error'));
      await new Promise(r => setTimeout(r, 100));

      // After error, server should reset connection state
      assert.strictEqual(server.hasClient(), false);
    });

    test('should handle processMessage when handler not set', async () => {
      await server.start();
      const nonce = server.getAuthNonce();
      const pipePath = server.getPipePath();
      // Don't set handler

      const client = net.createConnection(pipePath);
      await new Promise<void>((resolve, reject) => {
        client.on('connect', resolve);
        client.on('error', reject);
      });

      // Authenticate
      client.write(JSON.stringify({ type: 'auth', nonce }) + '\n');
      await new Promise<void>((resolve) => {
        client.once('data', () => resolve());
      });

      // Send a message without handler
      client.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test' }) + '\n');
      const response = await new Promise<string>((resolve) => {
        client.once('data', (data) => resolve(data.toString()));
      });
      const parsed = JSON.parse(response.trim());
      assert.ok(parsed.error);
      assert.strictEqual(parsed.error.code, -32603);

      client.destroy();
      await new Promise(r => setTimeout(r, 50));
    });
  });
});
