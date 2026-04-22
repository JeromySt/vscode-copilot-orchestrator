// Smoke test for `DotnetTransport` (§4.6 / job 040 / VS-TRANS post-check J40-PC-4).
//
// These tests drive a fake `AioOrchestrator` binding so that we can exercise
// the TypeScript wrapper without requiring the compiled N-API addon. They
// verify the observable contract documented in src/transport/dotnetTransport.ts:
//   * constructor argument validation,
//   * lazy session creation (one session per wrapper instance),
//   * tool invocation forwarding,
//   * event forwarding via async iterator,
//   * idempotent disposal.

import * as assert from 'node:assert/strict';
import { DotnetTransport, TransportEvent } from '../../src/transport/dotnetTransport';

interface FakeSession {
    invokeTool: (toolName: string, params: object) => Promise<unknown>;
    watchEvents: () => AsyncIterable<TransportEvent>;
    [Symbol.asyncDispose]: () => Promise<void>;
}

function makeFakeSession(overrides: Partial<FakeSession> = {}) {
    const calls: Array<{ tool: string; params: object }> = [];
    const state = { disposed: false };
    const base: FakeSession = {
        invokeTool: async (toolName, params) => {
            calls.push({ tool: toolName, params });
            return { ok: true, toolName };
        },
        watchEvents: async function* () {
            yield { kind: 'plan.progress', payload: { pct: 10 }, at: new Date().toISOString() };
            yield { kind: 'plan.completed', payload: { pct: 100 }, at: new Date().toISOString() };
        },
        [Symbol.asyncDispose]: async () => {
            state.disposed = true;
        },
    };
    const merged: FakeSession = { ...base, ...overrides };
    return {
        invokeTool: merged.invokeTool,
        watchEvents: merged.watchEvents,
        [Symbol.asyncDispose]: merged[Symbol.asyncDispose],
        get disposed() {
            return state.disposed;
        },
        calls,
    };
}

function makeFakeOrchestrator(session: FakeSession) {
    return {
        createPlan: async () => {
            throw new Error('not used');
        },
        resolvePlan: async () => {
            throw new Error('not used');
        },
        listPlans: async function* () {
            // empty
        },
        createVsCodeSession: async (_windowId: string) => session,
    } as unknown as import('../../bindings/node/src/index').AioOrchestrator;
}

describe('dotnetTransport', () => {
    it('rejects a missing orchestrator', () => {
        assert.throws(() => new DotnetTransport(undefined as any, 'w1'), /orchestrator is required/);
    });

    it('rejects a missing windowId', () => {
        const session = makeFakeSession();
        assert.throws(() => new DotnetTransport(makeFakeOrchestrator(session), ''), /windowId is required/);
    });

    it('forwards tool invocations through the session', async () => {
        const session = makeFakeSession();
        const transport = new DotnetTransport(makeFakeOrchestrator(session), 'win-1');
        const result = (await transport.invokeTool('plan.create', { name: 'p1' })) as { ok: boolean; toolName: string };
        assert.equal(result.ok, true);
        assert.equal(result.toolName, 'plan.create');
        assert.equal(session.calls.length, 1);
        assert.equal(session.calls[0].tool, 'plan.create');
        await transport.dispose();
    });

    it('reuses a single session across invocations', async () => {
        const session = makeFakeSession();
        const transport = new DotnetTransport(makeFakeOrchestrator(session), 'win-2');
        await transport.invokeTool('a', {});
        await transport.invokeTool('b', {});
        assert.equal(session.calls.length, 2);
        await transport.dispose();
    });

    it('yields events through watchEvents', async () => {
        const session = makeFakeSession();
        const transport = new DotnetTransport(makeFakeOrchestrator(session), 'win-3');
        const kinds: string[] = [];
        for await (const evt of transport.watchEvents()) {
            kinds.push(evt.kind);
        }
        assert.deepEqual(kinds, ['plan.progress', 'plan.completed']);
        await transport.dispose();
    });

    it('disposes the underlying session once, even across multiple dispose calls', async () => {
        const session = makeFakeSession();
        const transport = new DotnetTransport(makeFakeOrchestrator(session), 'win-4');
        await transport.invokeTool('noop', {});
        await transport.dispose();
        await transport.dispose();
        assert.equal(session.disposed, true);
    });

    it('throws after dispose', async () => {
        const session = makeFakeSession();
        const transport = new DotnetTransport(makeFakeOrchestrator(session), 'win-5');
        await transport.dispose();
        await assert.rejects(() => transport.invokeTool('x', {}), /disposed/);
    });
});
