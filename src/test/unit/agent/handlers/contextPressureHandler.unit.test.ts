/**
 * @fileoverview Unit tests for ContextPressureHandler and ContextPressureHandlerFactory.
 *
 * Covers regex matching for all three debug-log concerns (token usage,
 * model limits, compaction), the monitor getter, dispose cleanup, and
 * factory creation/skip logic per PROCESS_OUTPUT_BUS_DESIGN.md §6.2.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import {
  ContextPressureHandler,
  ContextPressureHandlerFactory,
} from '../../../../agent/handlers/contextPressureHandler';
import { OutputSources } from '../../../../interfaces/IOutputHandler';
import type { IContextPressureMonitor, ContextPressureState } from '../../../../interfaces/IContextPressureMonitor';
import * as pressureMonitorRegistry from '../../../../plan/analysis/pressureMonitorRegistry';

function makeMockMonitor(overrides?: Partial<IContextPressureMonitor>): IContextPressureMonitor {
  return {
    recordTurnUsage: sinon.stub(),
    setModelLimits: sinon.stub(),
    recordCompaction: sinon.stub(),
    setAiUsage: sinon.stub(),
    getState: sinon.stub().returns({
      planId: 'plan-1',
      nodeId: 'node-1',
      attemptNumber: 1,
      agentPhase: 'work',
      maxPromptTokens: undefined,
      maxContextWindow: undefined,
      currentInputTokens: 0,
      tokenHistory: [],
      level: 'normal',
      compactionDetected: false,
      lastUpdated: Date.now(),
    } as ContextPressureState),
    onPressureChange: sinon.stub().returns({ dispose: sinon.stub() }),
    reset: sinon.stub(),
    ...overrides,
  };
}

suite('ContextPressureHandler', () => {
  let sandbox: sinon.SinonSandbox;
  let mockMonitor: IContextPressureMonitor;
  let handler: ContextPressureHandler;
  const source = OutputSources.logFile('debug-log');

  setup(() => {
    sandbox = sinon.createSandbox();
    mockMonitor = makeMockMonitor();
    handler = new ContextPressureHandler(mockMonitor);
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('metadata', () => {
    test('name is context-pressure', () => {
      assert.strictEqual(handler.name, 'context-pressure');
    });

    test('sources contains log-file:debug-log', () => {
      assert.strictEqual(handler.sources.length, 1);
      assert.deepStrictEqual(handler.sources[0], OutputSources.logFile('debug-log'));
    });

    test('windowSize is 15', () => {
      assert.strictEqual(handler.windowSize, 15);
    });
  });

  suite('token usage regex', () => {
    test('matches input_tokens and output_tokens on the same line', () => {
      handler.onLine(['"input_tokens": 39880, "output_tokens": 1024'], source);

      assert.ok((mockMonitor.recordTurnUsage as sinon.SinonStub).calledOnce);
      assert.deepStrictEqual(
        (mockMonitor.recordTurnUsage as sinon.SinonStub).firstCall.args,
        [39880, 1024],
      );
    });

    test('matches only input_tokens (output defaults to 0)', () => {
      handler.onLine(['{"input_tokens": 5000}'], source);

      assert.ok((mockMonitor.recordTurnUsage as sinon.SinonStub).calledOnce);
      assert.deepStrictEqual(
        (mockMonitor.recordTurnUsage as sinon.SinonStub).firstCall.args,
        [5000, 0],
      );
    });

    test('matches only output_tokens (input defaults to 0)', () => {
      handler.onLine(['{"output_tokens": 2500}'], source);

      assert.ok((mockMonitor.recordTurnUsage as sinon.SinonStub).calledOnce);
      assert.deepStrictEqual(
        (mockMonitor.recordTurnUsage as sinon.SinonStub).firstCall.args,
        [0, 2500],
      );
    });
  });

  suite('model limits regex', () => {
    test('matches both max_prompt_tokens and max_context_window_tokens', () => {
      handler.onLine(
        ['"max_prompt_tokens": 136000, "max_context_window_tokens": 200000'],
        source,
      );

      assert.ok((mockMonitor.setModelLimits as sinon.SinonStub).calledOnce);
      assert.deepStrictEqual(
        (mockMonitor.setModelLimits as sinon.SinonStub).firstCall.args,
        [136000, 200000],
      );
    });

    test('matches only max_prompt_tokens (context window defaults to 0)', () => {
      handler.onLine(['{"max_prompt_tokens": 800000}'], source);

      assert.ok((mockMonitor.setModelLimits as sinon.SinonStub).calledOnce);
      assert.deepStrictEqual(
        (mockMonitor.setModelLimits as sinon.SinonStub).firstCall.args,
        [800000, 0],
      );
    });

    test('matches only max_context_window_tokens (prompt defaults to 0)', () => {
      handler.onLine(['{"max_context_window_tokens": 200000}'], source);

      assert.ok((mockMonitor.setModelLimits as sinon.SinonStub).calledOnce);
      assert.deepStrictEqual(
        (mockMonitor.setModelLimits as sinon.SinonStub).firstCall.args,
        [0, 200000],
      );
    });
  });

  suite('compaction regex', () => {
    test('matches truncateBasedOn tokenCount', () => {
      handler.onLine(['"truncateBasedOn": "tokenCount"'], source);

      assert.ok((mockMonitor.recordCompaction as sinon.SinonStub).calledOnce);
    });

    test('matches with surrounding JSON context', () => {
      handler.onLine(
        ['{"strategy": {"truncateBasedOn": "tokenCount", "keep": 10}}'],
        source,
      );

      assert.ok((mockMonitor.recordCompaction as sinon.SinonStub).calledOnce);
    });
  });

  suite('no-match lines', () => {
    test('does not call monitor for unrelated lines', () => {
      handler.onLine(['[INFO] Agent started successfully'], source);

      assert.ok((mockMonitor.recordTurnUsage as sinon.SinonStub).notCalled);
      assert.ok((mockMonitor.setModelLimits as sinon.SinonStub).notCalled);
      assert.ok((mockMonitor.recordCompaction as sinon.SinonStub).notCalled);
    });

    test('does not call monitor for empty lines', () => {
      handler.onLine([''], source);

      assert.ok((mockMonitor.recordTurnUsage as sinon.SinonStub).notCalled);
      assert.ok((mockMonitor.setModelLimits as sinon.SinonStub).notCalled);
      assert.ok((mockMonitor.recordCompaction as sinon.SinonStub).notCalled);
    });
  });

  suite('monitor getter', () => {
    test('returns the injected monitor', () => {
      assert.strictEqual(handler.monitor, mockMonitor);
    });
  });

  suite('dispose', () => {
    test('calls unregisterMonitor with planId and nodeId from monitor state', () => {
      const unregisterStub = sandbox.stub(pressureMonitorRegistry, 'unregisterMonitor');

      handler.dispose();

      assert.ok(unregisterStub.calledOnce);
      assert.deepStrictEqual(unregisterStub.firstCall.args, ['plan-1', 'node-1']);
    });
  });
});

suite('ContextPressureHandlerFactory', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('metadata', () => {
    test('name is context-pressure', () => {
      assert.strictEqual(ContextPressureHandlerFactory.name, 'context-pressure');
    });

    test('processFilter is copilot', () => {
      assert.deepStrictEqual(ContextPressureHandlerFactory.processFilter, ['copilot']);
    });
  });

  suite('create', () => {
    test('returns undefined when planId is missing', () => {
      const result = ContextPressureHandlerFactory.create({
        processLabel: 'copilot',
        nodeId: 'node-1',
      });

      assert.strictEqual(result, undefined);
    });

    test('returns undefined when nodeId is missing', () => {
      const result = ContextPressureHandlerFactory.create({
        processLabel: 'copilot',
        planId: 'plan-1',
      });

      assert.strictEqual(result, undefined);
    });

    test('returns undefined when both planId and nodeId are missing', () => {
      const result = ContextPressureHandlerFactory.create({
        processLabel: 'copilot',
      });

      assert.strictEqual(result, undefined);
    });

    test('returns ContextPressureHandler when context is complete', () => {
      sandbox.stub(pressureMonitorRegistry, 'registerMonitor');

      const result = ContextPressureHandlerFactory.create({
        processLabel: 'copilot',
        planId: 'plan-1',
        nodeId: 'node-1',
      });

      assert.ok(result !== undefined);
      assert.strictEqual(result!.name, 'context-pressure');
      assert.ok(result instanceof ContextPressureHandler);
    });

    test('registers monitor in global registry', () => {
      const registerStub = sandbox.stub(pressureMonitorRegistry, 'registerMonitor');

      ContextPressureHandlerFactory.create({
        processLabel: 'copilot',
        planId: 'plan-1',
        nodeId: 'node-1',
      });

      assert.ok(registerStub.calledOnce);
      assert.strictEqual(registerStub.firstCall.args[0], 'plan-1');
      assert.strictEqual(registerStub.firstCall.args[1], 'node-1');
    });

    test('handler monitor is accessible via getter', () => {
      sandbox.stub(pressureMonitorRegistry, 'registerMonitor');

      const result = ContextPressureHandlerFactory.create({
        processLabel: 'copilot',
        planId: 'plan-1',
        nodeId: 'node-1',
      }) as ContextPressureHandler;

      assert.ok(result.monitor !== undefined);
      const state = result.monitor.getState();
      assert.strictEqual(state.planId, 'plan-1');
      assert.strictEqual(state.nodeId, 'node-1');
    });
  });
});
