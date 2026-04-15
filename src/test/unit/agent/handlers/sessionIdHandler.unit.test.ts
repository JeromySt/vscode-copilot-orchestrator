import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { SessionIdHandler, SessionIdHandlerFactory } from '../../../../agent/handlers/sessionIdHandler';
import { OutputSources } from '../../../../interfaces/IOutputHandler';

suite('SessionIdHandler', () => {
  let sandbox: sinon.SinonSandbox;
  let handler: SessionIdHandler;

  setup(() => {
    sandbox = sinon.createSandbox();
    handler = new SessionIdHandler();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('metadata', () => {
    test('should have correct name', () => {
      assert.strictEqual(handler.name, 'session-id');
    });

    test('should listen to stdout only', () => {
      assert.deepStrictEqual(handler.sources, [OutputSources.stdout]);
    });

    test('should have windowSize of 1', () => {
      assert.strictEqual(handler.windowSize, 1);
    });
  });

  suite('onLine', () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

    test('should capture session ID from "Session ID: <uuid>" pattern', () => {
      handler.onLine([`Session ID: ${uuid}`], OutputSources.stdout);
      assert.strictEqual(handler.getSessionId(), uuid);
    });

    test('should capture session ID from "session: <uuid>" pattern', () => {
      handler.onLine([`session: ${uuid}`], OutputSources.stdout);
      assert.strictEqual(handler.getSessionId(), uuid);
    });

    test('should capture session ID from "Starting session: <uuid>" pattern', () => {
      handler.onLine([`Starting session: ${uuid}`], OutputSources.stdout);
      assert.strictEqual(handler.getSessionId(), uuid);
    });

    test('should capture session ID case-insensitively', () => {
      handler.onLine([`SESSION ID: ${uuid}`], OutputSources.stdout);
      assert.strictEqual(handler.getSessionId(), uuid);
    });

    test('should keep only the first captured session ID', () => {
      const first = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const second = '11111111-2222-3333-4444-555555555555';
      handler.onLine([`Session ID: ${first}`], OutputSources.stdout);
      handler.onLine([`Session ID: ${second}`], OutputSources.stdout);
      assert.strictEqual(handler.getSessionId(), first);
    });

    test('should return undefined when no session ID found', () => {
      handler.onLine(['some random output line'], OutputSources.stdout);
      assert.strictEqual(handler.getSessionId(), undefined);
    });

    test('should not match malformed UUIDs', () => {
      handler.onLine(['Session ID: not-a-uuid'], OutputSources.stdout);
      assert.strictEqual(handler.getSessionId(), undefined);
    });

    test('should extract from line with surrounding text', () => {
      handler.onLine([`[INFO] Session ID: ${uuid} (started)`], OutputSources.stdout);
      assert.strictEqual(handler.getSessionId(), uuid);
    });
  });

  suite('SessionIdHandlerFactory', () => {
    test('should have correct name', () => {
      assert.strictEqual(SessionIdHandlerFactory.name, 'session-id');
    });

    test('should filter for copilot processes', () => {
      assert.deepStrictEqual(SessionIdHandlerFactory.processFilter, ['copilot']);
    });

    test('should create a SessionIdHandler instance', () => {
      const created = SessionIdHandlerFactory.create({ processLabel: 'copilot' });
      assert.ok(created instanceof SessionIdHandler);
    });
  });
});
