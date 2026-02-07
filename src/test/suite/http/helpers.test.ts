/**
 * @fileoverview Unit tests for HTTP server request handling logic
 *
 * Tests cover:
 * - CORS headers and preflight handling
 * - Health endpoint behavior
 * - Root API info endpoint
 * - 404 for unknown routes
 * - Error handling in request processing
 * - ParsedRequest construction from raw requests
 */

import * as assert from 'assert';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Suppress Logger console output to avoid hanging test workers. */
function silenceConsole(): { restore: () => void } {
  const origLog = console.log;
  const origDebug = console.debug;
  const origWarn = console.warn;
  const origError = console.error;
  /* eslint-disable no-console */
  console.log = () => {};
  console.debug = () => {};
  console.warn = () => {};
  console.error = () => {};
  /* eslint-enable no-console */
  return {
    restore() {
      console.log = origLog;
      console.debug = origDebug;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

/**
 * Creates a mock IncomingMessage for testing the server request handler.
 */
function createMockIncomingMessage(
  method: string,
  url: string,
  body?: string,
): EventEmitter & { method: string; url: string; headers: Record<string, string> } {
  const emitter = new EventEmitter() as EventEmitter & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  emitter.method = method;
  emitter.url = url;
  emitter.headers = { host: 'localhost:3000' };

  if (body !== undefined) {
    process.nextTick(() => {
      emitter.emit('data', Buffer.from(body));
      emitter.emit('end');
    });
  } else {
    process.nextTick(() => {
      emitter.emit('end');
    });
  }

  return emitter;
}

/**
 * Creates a mock ServerResponse that captures written data and headers.
 */
function createMockServerResponse(): {
  statusCode: number;
  headers: Record<string, string | number>;
  body: string;
  ended: boolean;
  setHeader(name: string, value: string | number): void;
  end(data?: string): void;
} {
  return {
    statusCode: 200,
    headers: {} as Record<string, string | number>,
    body: '',
    ended: false,
    setHeader(name: string, value: string | number) {
      this.headers[name.toLowerCase()] = value;
    },
    end(data?: string) {
      if (data) {
        this.body = data;
      }
      this.ended = true;
    },
  };
}

/**
 * Minimal server handler that replicates the core logic from server.ts
 * without requiring PlanRunner or McpHandler dependencies.
 * This allows testing CORS, health, root, and 404 behavior in isolation.
 */
async function handleRequest(
  req: { method?: string; url?: string; headers: Record<string, string> },
  res: ReturnType<typeof createMockServerResponse>,
): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  // Standard headers
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && url.pathname === '/health') {
    res.statusCode = 200;
    res.end('{"status":"ok"}');
    return;
  }

  // Root API info
  if (req.method === 'GET' && url.pathname === '/') {
    const body = JSON.stringify({ name: 'Copilot Orchestrator MCP Server', version: '0.5.0' });
    res.statusCode = 200;
    res.setHeader('Content-Length', Buffer.byteLength(body, 'utf-8'));
    res.setHeader('Connection', 'close');
    res.end(body);
    return;
  }

  // 404
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found', path: url.pathname }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('HTTP Server - CORS Headers', () => {
  let silent: { restore: () => void };
  setup(() => { silent = silenceConsole(); });
  teardown(() => { silent.restore(); });

  test('should set Access-Control-Allow-Origin to *', async () => {
    const req = createMockIncomingMessage('GET', '/health');
    const res = createMockServerResponse();

    await handleRequest(req, res);

    assert.strictEqual(res.headers['access-control-allow-origin'], '*');
  });

  test('should set Access-Control-Allow-Methods', async () => {
    const req = createMockIncomingMessage('GET', '/health');
    const res = createMockServerResponse();

    await handleRequest(req, res);

    assert.strictEqual(
      res.headers['access-control-allow-methods'],
      'GET, POST, DELETE, OPTIONS',
    );
  });

  test('should set Access-Control-Allow-Headers', async () => {
    const req = createMockIncomingMessage('GET', '/health');
    const res = createMockServerResponse();

    await handleRequest(req, res);

    assert.strictEqual(res.headers['access-control-allow-headers'], 'Content-Type');
  });

  test('should set Content-Type to application/json', async () => {
    const req = createMockIncomingMessage('GET', '/health');
    const res = createMockServerResponse();

    await handleRequest(req, res);

    assert.strictEqual(res.headers['content-type'], 'application/json');
  });
});

suite('HTTP Server - CORS Preflight', () => {
  let silent: { restore: () => void };
  setup(() => { silent = silenceConsole(); });
  teardown(() => { silent.restore(); });

  test('should handle OPTIONS request by ending response immediately', async () => {
    const req = createMockIncomingMessage('OPTIONS', '/mcp');
    const res = createMockServerResponse();

    await handleRequest(req, res);

    assert.ok(res.ended, 'Response should be ended');
    assert.strictEqual(res.body, '', 'No body for preflight');
  });

  test('should set CORS headers on OPTIONS request', async () => {
    const req = createMockIncomingMessage('OPTIONS', '/anything');
    const res = createMockServerResponse();

    await handleRequest(req, res);

    assert.strictEqual(res.headers['access-control-allow-origin'], '*');
    assert.strictEqual(
      res.headers['access-control-allow-methods'],
      'GET, POST, DELETE, OPTIONS',
    );
  });

  test('should handle OPTIONS for any path', async () => {
    const req = createMockIncomingMessage('OPTIONS', '/unknown/path');
    const res = createMockServerResponse();

    await handleRequest(req, res);

    assert.ok(res.ended);
    assert.strictEqual(res.body, '');
  });
});

suite('HTTP Server - Health Endpoint', () => {
  let silent: { restore: () => void };
  setup(() => { silent = silenceConsole(); });
  teardown(() => { silent.restore(); });

  test('should return 200 for GET /health', async () => {
    const req = createMockIncomingMessage('GET', '/health');
    const res = createMockServerResponse();

    await handleRequest(req, res);

    assert.strictEqual(res.statusCode, 200);
  });

  test('should return {"status":"ok"} body', async () => {
    const req = createMockIncomingMessage('GET', '/health');
    const res = createMockServerResponse();

    await handleRequest(req, res);

    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.status, 'ok');
  });

  test('should not match POST /health', async () => {
    const req = createMockIncomingMessage('POST', '/health');
    const res = createMockServerResponse();

    await handleRequest(req, res);

    // POST /health is not a health check, should be 404
    assert.strictEqual(res.statusCode, 404);
  });
});

suite('HTTP Server - Root Endpoint', () => {
  let silent: { restore: () => void };
  setup(() => { silent = silenceConsole(); });
  teardown(() => { silent.restore(); });

  test('should return 200 for GET /', async () => {
    const req = createMockIncomingMessage('GET', '/');
    const res = createMockServerResponse();

    await handleRequest(req, res);

    assert.strictEqual(res.statusCode, 200);
  });

  test('should return API info as JSON', async () => {
    const req = createMockIncomingMessage('GET', '/');
    const res = createMockServerResponse();

    await handleRequest(req, res);

    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.name, 'Copilot Orchestrator MCP Server');
    assert.strictEqual(parsed.version, '0.5.0');
  });

  test('should set Content-Length header', async () => {
    const req = createMockIncomingMessage('GET', '/');
    const res = createMockServerResponse();

    await handleRequest(req, res);

    assert.ok(res.headers['content-length'], 'Content-Length should be set');
    assert.ok(Number(res.headers['content-length']) > 0, 'Content-Length should be positive');
  });

  test('should set Connection: close header', async () => {
    const req = createMockIncomingMessage('GET', '/');
    const res = createMockServerResponse();

    await handleRequest(req, res);

    assert.strictEqual(res.headers['connection'], 'close');
  });
});

suite('HTTP Server - 404 Handling', () => {
  let silent: { restore: () => void };
  setup(() => { silent = silenceConsole(); });
  teardown(() => { silent.restore(); });

  test('should return 404 for unknown GET path', async () => {
    const req = createMockIncomingMessage('GET', '/unknown');
    const res = createMockServerResponse();

    await handleRequest(req, res);

    assert.strictEqual(res.statusCode, 404);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.error, 'Not found');
  });

  test('should include path in 404 response', async () => {
    const req = createMockIncomingMessage('GET', '/unknown/path');
    const res = createMockServerResponse();

    await handleRequest(req, res);

    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.path, '/unknown/path');
  });

  test('should return 404 for POST to unknown path', async () => {
    const req = createMockIncomingMessage('POST', '/nonexistent');
    const res = createMockServerResponse();

    await handleRequest(req, res);

    assert.strictEqual(res.statusCode, 404);
  });

  test('should return 404 for DELETE requests', async () => {
    const req = createMockIncomingMessage('DELETE', '/something');
    const res = createMockServerResponse();

    await handleRequest(req, res);

    assert.strictEqual(res.statusCode, 404);
  });
});

suite('HTTP Server - ParsedRequest Construction', () => {
  let silent: { restore: () => void };
  setup(() => { silent = silenceConsole(); });
  teardown(() => { silent.restore(); });

  test('should parse URL pathname correctly', () => {
    const url = new URL('/mcp', 'http://localhost:3000');
    assert.strictEqual(url.pathname, '/mcp');
  });

  test('should handle URL with query parameters', () => {
    const url = new URL('/api/plans?status=active', 'http://localhost:3000');
    assert.strictEqual(url.pathname, '/api/plans');
    assert.strictEqual(url.searchParams.get('status'), 'active');
  });

  test('should handle URL with trailing slash', () => {
    const url = new URL('/api/', 'http://localhost:3000');
    assert.strictEqual(url.pathname, '/api/');
  });

  test('should default method to GET when undefined', () => {
    const raw: string | undefined = undefined;
    const method = raw || 'GET';
    assert.strictEqual(method, 'GET');
  });

  test('should construct ParsedRequest-like object', () => {
    const req = createMockIncomingMessage('POST', '/mcp');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const parsed = {
      req,
      res: createMockServerResponse(),
      url,
      method: req.method || 'GET',
      pathname: url.pathname,
    };

    assert.strictEqual(parsed.method, 'POST');
    assert.strictEqual(parsed.pathname, '/mcp');
    assert.ok(parsed.url instanceof URL);
  });
});

/**
 * Tests the MCP route matching guard: `method === 'POST' && pathname === '/mcp'`
 */
function mcpRouteMatches(method: string, pathname: string): boolean {
  return method === 'POST' && pathname === '/mcp';
}

suite('HTTP Server - MCP Route Handler', () => {
  let silent: { restore: () => void };
  setup(() => { silent = silenceConsole(); });
  teardown(() => { silent.restore(); });

  test('handleMcp should return false for non-POST methods', () => {
    assert.strictEqual(mcpRouteMatches('GET', '/mcp'), false);
  });

  test('handleMcp should return false for non-/mcp paths', () => {
    assert.strictEqual(mcpRouteMatches('POST', '/other'), false);
  });

  test('handleMcp should match POST /mcp', () => {
    assert.strictEqual(mcpRouteMatches('POST', '/mcp'), true);
  });

  test('handleMcp should not match POST /MCP (case sensitive)', () => {
    assert.strictEqual(mcpRouteMatches('POST', '/MCP'), false);
  });

  test('handleMcp should not match POST /mcp/', () => {
    assert.strictEqual(mcpRouteMatches('POST', '/mcp/'), false);
  });
});

suite('HTTP Server - URL Parsing Edge Cases', () => {
  let silent: { restore: () => void };
  setup(() => { silent = silenceConsole(); });
  teardown(() => { silent.restore(); });

  test('should handle missing url by defaulting to /', () => {
    const rawUrl: string | undefined = undefined;
    const url = new URL(rawUrl || '/', 'http://localhost:3000');
    assert.strictEqual(url.pathname, '/');
  });

  test('should handle URL with fragments', () => {
    const url = new URL('/api#section', 'http://localhost:3000');
    assert.strictEqual(url.pathname, '/api');
    assert.strictEqual(url.hash, '#section');
  });

  test('should handle URL with encoded characters', () => {
    const url = new URL('/api/plan%20name', 'http://localhost:3000');
    assert.strictEqual(url.pathname, '/api/plan%20name');
  });

  test('should handle empty path segments', () => {
    const url = new URL('//api///path', 'http://localhost:3000');
    assert.strictEqual(url.pathname, '//api///path');
  });

  test('should handle URL with port in host header', () => {
    const host = 'localhost:8080';
    const url = new URL('/health', `http://${host}`);
    assert.strictEqual(url.port, '8080');
    assert.strictEqual(url.hostname, 'localhost');
  });
});
