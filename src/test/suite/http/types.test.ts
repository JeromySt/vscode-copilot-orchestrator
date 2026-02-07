/**
 * @fileoverview Unit tests for HTTP types and helper functions
 *
 * Tests cover:
 * - readBody: reading request body from IncomingMessage streams
 * - sendJson: sending JSON responses with correct headers
 * - sendError: sending error responses with status codes
 * - ParsedRequest construction
 */

import * as assert from 'assert';
import { EventEmitter } from 'events';
import { readBody, sendJson, sendError } from '../../../http/types';

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
 * Creates a mock IncomingMessage-like readable stream.
 * Emits 'data' and 'end' events to simulate request body reading.
 */
function createMockRequest(body?: string): EventEmitter & { method?: string; url?: string; headers: Record<string, string> } {
  const emitter = new EventEmitter() as EventEmitter & { method?: string; url?: string; headers: Record<string, string> };
  emitter.method = 'POST';
  emitter.url = '/test';
  emitter.headers = { host: 'localhost:3000' };

  if (body !== undefined) {
    // Schedule data emission on next tick so the listener can be attached first
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
 * Creates a mock ServerResponse that captures written data.
 */
function createMockResponse(): {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('HTTP Types - readBody', () => {
  let silent: { restore: () => void };
  setup(() => { silent = silenceConsole(); });
  teardown(() => { silent.restore(); });

  test('should read a simple string body', async () => {
    const req = createMockRequest('hello world');
    const body = await readBody(req as any);
    assert.strictEqual(body, 'hello world');
  });

  test('should return empty string for empty body', async () => {
    const req = createMockRequest();
    const body = await readBody(req as any);
    assert.strictEqual(body, '');
  });

  test('should read JSON body', async () => {
    const jsonData = JSON.stringify({ method: 'test', id: 1 });
    const req = createMockRequest(jsonData);
    const body = await readBody(req as any);
    assert.strictEqual(body, jsonData);
    const parsed = JSON.parse(body);
    assert.strictEqual(parsed.method, 'test');
    assert.strictEqual(parsed.id, 1);
  });

  test('should handle multi-chunk body', async () => {
    const emitter = new EventEmitter();
    process.nextTick(() => {
      emitter.emit('data', Buffer.from('chunk1'));
      emitter.emit('data', Buffer.from('chunk2'));
      emitter.emit('data', Buffer.from('chunk3'));
      emitter.emit('end');
    });
    const body = await readBody(emitter as any);
    assert.strictEqual(body, 'chunk1chunk2chunk3');
  });

  test('should handle large body', async () => {
    const largeBody = 'x'.repeat(10000);
    const req = createMockRequest(largeBody);
    const body = await readBody(req as any);
    assert.strictEqual(body.length, 10000);
    assert.strictEqual(body, largeBody);
  });

  test('should handle body with special characters', async () => {
    const specialBody = '{"emoji": "🚀", "unicode": "café"}';
    const req = createMockRequest(specialBody);
    const body = await readBody(req as any);
    assert.strictEqual(body, specialBody);
  });
});

suite('HTTP Types - sendJson', () => {
  let silent: { restore: () => void };
  setup(() => { silent = silenceConsole(); });
  teardown(() => { silent.restore(); });

  test('should send JSON with default 200 status code', () => {
    const res = createMockResponse();
    const data = { status: 'ok' };
    sendJson(res as any, data);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, JSON.stringify(data));
    assert.ok(res.ended, 'Response should be ended');
  });

  test('should set Content-Length header', () => {
    const res = createMockResponse();
    const data = { message: 'hello' };
    sendJson(res as any, data);

    const expectedLength = Buffer.byteLength(JSON.stringify(data), 'utf-8');
    assert.strictEqual(res.headers['content-length'], expectedLength);
  });

  test('should set Connection: close header', () => {
    const res = createMockResponse();
    sendJson(res as any, { test: true });
    assert.strictEqual(res.headers['connection'], 'close');
  });

  test('should send with custom status code', () => {
    const res = createMockResponse();
    sendJson(res as any, { created: true }, 201);
    assert.strictEqual(res.statusCode, 201);
  });

  test('should handle complex nested objects', () => {
    const res = createMockResponse();
    const data = {
      plans: [{ id: 'p1', nodes: [{ id: 'n1' }] }],
      meta: { count: 1 },
    };
    sendJson(res as any, data);

    const parsed = JSON.parse(res.body);
    assert.deepStrictEqual(parsed, data);
  });

  test('should handle null data', () => {
    const res = createMockResponse();
    sendJson(res as any, null);
    assert.strictEqual(res.body, 'null');
    assert.ok(res.ended);
  });

  test('should handle array data', () => {
    const res = createMockResponse();
    const data = [1, 2, 3];
    sendJson(res as any, data);
    assert.strictEqual(res.body, '[1,2,3]');
  });

  test('should correctly compute Content-Length for unicode', () => {
    const res = createMockResponse();
    const data = { text: 'café' };
    sendJson(res as any, data);

    const jsonStr = JSON.stringify(data);
    const expectedLength = Buffer.byteLength(jsonStr, 'utf-8');
    assert.strictEqual(res.headers['content-length'], expectedLength);
    // UTF-8 byte length may differ from string length
    assert.ok(expectedLength >= jsonStr.length);
  });
});

suite('HTTP Types - sendError', () => {
  let silent: { restore: () => void };
  setup(() => { silent = silenceConsole(); });
  teardown(() => { silent.restore(); });

  test('should send error with default 400 status code', () => {
    const res = createMockResponse();
    sendError(res as any, 'Bad request');

    assert.strictEqual(res.statusCode, 400);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.error, 'Bad request');
    assert.ok(res.ended);
  });

  test('should send error with custom status code', () => {
    const res = createMockResponse();
    sendError(res as any, 'Not found', 404);

    assert.strictEqual(res.statusCode, 404);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.error, 'Not found');
  });

  test('should send 500 internal server error', () => {
    const res = createMockResponse();
    sendError(res as any, 'Internal error', 500);

    assert.strictEqual(res.statusCode, 500);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.error, 'Internal error');
  });

  test('should include additional details when provided', () => {
    const res = createMockResponse();
    sendError(res as any, 'Validation failed', 422, {
      fields: ['name', 'email'],
      code: 'VALIDATION_ERROR',
    });

    assert.strictEqual(res.statusCode, 422);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.error, 'Validation failed');
    assert.deepStrictEqual(parsed.fields, ['name', 'email']);
    assert.strictEqual(parsed.code, 'VALIDATION_ERROR');
  });

  test('should merge details with error field', () => {
    const res = createMockResponse();
    sendError(res as any, 'Not found', 404, { path: '/unknown' });

    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.error, 'Not found');
    assert.strictEqual(parsed.path, '/unknown');
  });

  test('should handle error with no details', () => {
    const res = createMockResponse();
    sendError(res as any, 'Forbidden', 403);

    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.error, 'Forbidden');
    assert.strictEqual(Object.keys(parsed).length, 1);
  });
});
