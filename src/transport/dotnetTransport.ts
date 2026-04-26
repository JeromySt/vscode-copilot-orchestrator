// VS Code transport (§4.6 / job 040).
//
// Thin wrapper that forwards tool invocations and event subscriptions from the
// TypeScript VS Code extension to the .NET orchestrator across the N-API
// bindings (job 036). The .NET side (`AiOrchestrator.VsCode.Transport`) is the
// only .NET project allowed to reference `Microsoft.VisualStudio.*`.
//
// INV-2: each VS Code window receives its own `TransportSession`.
// INV-3: session idle timeout auto-disposes; invocations reset the idle timer.
// INV-5: tool invocations route through the `McpToolRegistry` (job 035).
// INV-7: cancellation tokens propagate from VS Code into .NET.
// INV-8: errors preserve the .NET exception type name on `code`.

import type { AioOrchestrator } from '../types/bindings';

export interface TransportEvent {
    readonly kind: string;
    readonly payload: unknown;
    readonly at: string;
}

interface TransportSessionHandle extends AsyncDisposable {
    invokeTool(toolName: string, parameters: object, signal?: AbortSignal): Promise<unknown>;
    watchEvents(signal?: AbortSignal): AsyncIterable<TransportEvent>;
}

interface VsCodeCapableOrchestrator extends AioOrchestrator {
    createVsCodeSession?(windowId: string): Promise<TransportSessionHandle>;
}

export class DotnetTransport implements AsyncDisposable {
    private readonly orchestrator: VsCodeCapableOrchestrator;
    private readonly windowId: string;
    private sessionPromise?: Promise<TransportSessionHandle>;
    private disposed = false;

    constructor(orchestrator: AioOrchestrator, windowId: string) {
        if (!orchestrator) {
            throw new Error('orchestrator is required');
        }
        if (!windowId) {
            throw new Error('windowId is required');
        }
        this.orchestrator = orchestrator as VsCodeCapableOrchestrator;
        this.windowId = windowId;
    }

    async invokeTool(toolName: string, params: object): Promise<unknown> {
        this.throwIfDisposed();
        const session = await this.ensureSession();
        return session.invokeTool(toolName, params);
    }

    async *watchEvents(): AsyncIterable<TransportEvent> {
        this.throwIfDisposed();
        const session = await this.ensureSession();
        for await (const evt of session.watchEvents()) {
            yield evt;
        }
    }

    async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        const p = this.sessionPromise;
        this.sessionPromise = undefined;
        if (p) {
            try {
                const session = await p;
                await session[Symbol.asyncDispose]();
            } catch {
                // Disposal is best-effort; surface nothing to the caller.
            }
        }
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.dispose();
    }

    private ensureSession(): Promise<TransportSessionHandle> {
        if (this.sessionPromise) {
            return this.sessionPromise;
        }
        if (typeof this.orchestrator.createVsCodeSession !== 'function') {
            return Promise.reject(
                new Error(
                    "The supplied orchestrator binding does not expose 'createVsCodeSession'. " +
                        'Ensure the .NET VsCodeTransport is registered via AddVsCodeTransport.',
                ),
            );
        }
        this.sessionPromise = this.orchestrator.createVsCodeSession(this.windowId);
        return this.sessionPromise;
    }

    private throwIfDisposed(): void {
        if (this.disposed) {
            throw new Error('DotnetTransport has been disposed.');
        }
    }
}
