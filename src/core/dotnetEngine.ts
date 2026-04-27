/**
 * @fileoverview .NET Orchestration Engine
 *
 * Implements IOrchestrationEngine by communicating with the .NET AiOrchestrator
 * daemon via MCP protocol over a named pipe. The engine connects to the daemon's
 * named pipe and uses Content-Length framed JSON-RPC for communication, supporting
 * concurrent requests via request ID multiplexing on a persistent connection.
 *
 * @module core/dotnetEngine
 */

import { EventEmitter } from 'events';
import * as net from 'net';
import type {
  IOrchestrationEngine,
  EngineKind,
} from '../interfaces/IOrchestrationEngine';
import type {
  PlanSpec,
  PlanInstance,
  PlanStatus,
  NodeStatus,
  ExecutionPhase,
  AttemptRecord,
} from '../plan/types';
import type { RetryNodeOptions } from '../interfaces/IPlanRunner';
import type { IDotNetDaemonManager } from '../interfaces/IDotNetDaemonManager';
import { computePlanStatus } from '../plan/helpers';
import { Logger } from './logger';

const log = Logger.for('dotnet-engine');

/** JSON-RPC request counter for unique IDs. */
let nextRequestId = 1;

/**
 * MCP-based orchestration engine backed by the .NET CLI daemon.
 *
 * All plan operations are sent as MCP tool calls over a persistent named pipe.
 * Plan state is queried via get_copilot_plan_status and similar tools.
 */
export class DotNetOrchestrationEngine extends EventEmitter implements IOrchestrationEngine {
  readonly kind: EngineKind = 'dotnet';

  /** Cached plan state from daemon queries. */
  private planCache = new Map<string, PlanInstance>();

  /** Persistent named pipe connection. */
  private connection: net.Socket | undefined;

  /** Pending JSON-RPC requests awaiting responses. */
  private pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>();

  /** Buffer for accumulating data for Content-Length framing. */
  private buffer = '';

  constructor(
    private readonly daemonManager: IDotNetDaemonManager,
    private readonly repoRoot: string,
  ) {
    super();
  }

  async initialize(): Promise<void> {
    log.info('Initializing .NET engine — starting daemon and connecting');

    await this.daemonManager.start();
    await this.connect();

    // Send initialize handshake
    await this.callMcp('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vscode-copilot-orchestrator', version: '1.0.0' },
    });
    log.info('.NET engine initialized');
  }

  async shutdown(): Promise<void> {
    log.info('Shutting down .NET engine');

    this.rejectAllPending(new Error('Engine shut down'));

    if (this.connection) {
      this.connection.destroy();
      this.connection = undefined;
    }

    await this.daemonManager.stop();
  }

  persistSync(): void {
    // .NET daemon persists its own state
  }

  // ── Connection ─────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    const pipeName = this.daemonManager.getPipeName();
    if (!pipeName) throw new Error('Daemon pipe name not available');

    // On Windows: \\.\pipe\<name> → net.connect({path})
    // On Unix: /tmp/<name>.sock → net.connect({path})
    const pipePath = process.platform === 'win32'
      ? `\\\\.\\pipe\\${pipeName}`
      : pipeName;

    return new Promise<void>((resolve, reject) => {
      const socket = net.connect({ path: pipePath }, () => {
        this.connection = socket;
        log.info('Connected to daemon pipe', { pipePath });
        resolve();
      });

      socket.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString();
        this.drainResponses();
      });

      socket.on('error', (err) => {
        log.error('Pipe connection error', { error: err.message });
        if (!this.connection) {
          reject(new Error(`Failed to connect to daemon pipe: ${err.message}`));
        } else {
          this.rejectAllPending(new Error(`Pipe connection lost: ${err.message}`));
          this.connection = undefined;
        }
      });

      socket.on('close', () => {
        log.info('Pipe connection closed');
        this.rejectAllPending(new Error('Pipe connection closed'));
        this.connection = undefined;
      });
    });
  }

  private drainResponses(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) break;
      const len = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + len) break;
      const body = this.buffer.slice(bodyStart, bodyStart + len);
      this.buffer = this.buffer.slice(bodyStart + len);

      try {
        const response = JSON.parse(body);
        const p = this.pending.get(response.id);
        if (p) {
          this.pending.delete(response.id);
          if (response.error) {
            p.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
          } else {
            p.resolve(response.result);
          }
        }
      } catch (e) {
        log.error('Failed to parse MCP response', { error: String(e) });
      }
    }
  }

  // ── Plan Creation ──────────────────────────────────────────────────

  async enqueue(spec: PlanSpec): Promise<PlanInstance> {
    const result = await this.callTool('scaffold_copilot_plan', {
      name: spec.name,
      jobs: spec.jobs?.map(n => ({
        name: n.name,
        task: n.task,
        deps: n.dependencies,
      })),
    });
    const plan = this.parsePlanResult(result);
    // Finalize to start execution
    await this.callTool('finalize_copilot_plan', { plan_id: plan.id });
    return plan;
  }

  async enqueueJob(jobSpec: Parameters<IOrchestrationEngine['enqueueJob']>[0]): Promise<PlanInstance> {
    const result = await this.callTool('scaffold_copilot_plan', {
      name: jobSpec.name,
      jobs: [{ name: jobSpec.name, task: jobSpec.task }],
    });
    const plan = this.parsePlanResult(result);
    await this.callTool('finalize_copilot_plan', { plan_id: plan.id });
    return plan;
  }

  // ── Queries ────────────────────────────────────────────────────────

  get(planId: string): PlanInstance | undefined {
    return this.planCache.get(planId);
  }

  getAll(): PlanInstance[] {
    return [...this.planCache.values()];
  }

  getByStatus(status: PlanStatus): PlanInstance[] {
    return this.getAll().filter(p => {
      const computed = computePlanStatus(p.nodeStates.values(), !!p.startedAt, !!p.isPaused, !!p.archivedAt);
      return computed === status;
    });
  }

  getStatus(planId: string) {
    const plan = this.planCache.get(planId);
    if (!plan) return undefined;
    const counts = {} as Record<NodeStatus, number>;
    for (const state of plan.nodeStates.values()) {
      counts[state.status] = (counts[state.status] ?? 0) + 1;
    }
    const total = plan.nodeStates.size;
    const completed = (counts['succeeded'] ?? 0) + (counts['failed'] ?? 0) + (counts['canceled'] ?? 0);
    const status = computePlanStatus(plan.nodeStates.values(), !!plan.startedAt, !!plan.isPaused, !!plan.archivedAt);
    return {
      plan,
      status,
      counts,
      progress: total > 0 ? completed / total : 0,
    };
  }

  getGlobalStats() {
    const plans = this.getAll();
    const statusOf = (p: PlanInstance) => computePlanStatus(p.nodeStates.values(), !!p.startedAt, !!p.isPaused, !!p.archivedAt);
    return {
      running: plans.filter(p => statusOf(p) === 'running').length,
      maxParallel: 16,
      queued: plans.filter(p => statusOf(p) === 'pending').length,
    };
  }

  getNodeLogs(_planId: string, _nodeId: string, _phase?: 'all' | ExecutionPhase, _attemptNumber?: number): string {
    return ''; // TODO: implement via get_copilot_job_logs tool
  }

  getNodeAttempts(_planId: string, _nodeId: string): AttemptRecord[] {
    return []; // TODO: implement via get_copilot_job_attempts tool
  }

  getNodeFailureContext(_planId: string, _nodeId: string) {
    return { error: 'Not yet implemented for .NET engine' };
  }

  // ── Control ────────────────────────────────────────────────────────

  async pause(planId: string): Promise<boolean> {
    const result = await this.callTool('pause_copilot_plan', { plan_id: planId });
    return result?.success ?? false;
  }

  async resume(planId: string): Promise<boolean> {
    const result = await this.callTool('resume_copilot_plan', { plan_id: planId });
    return result?.success ?? false;
  }

  async cancel(planId: string): Promise<boolean> {
    const result = await this.callTool('cancel_copilot_plan', { plan_id: planId });
    return result?.success ?? false;
  }

  async delete(planId: string): Promise<boolean> {
    const result = await this.callTool('delete_copilot_plan', { plan_id: planId });
    this.planCache.delete(planId);
    return result?.success ?? false;
  }

  async retryNode(planId: string, nodeId: string, _options?: RetryNodeOptions) {
    const result = await this.callTool('retry_copilot_job', {
      plan_id: planId,
      job_id: nodeId,
    });
    return { success: result?.success ?? false, error: result?.error };
  }

  async forceFailNode(planId: string, nodeId: string): Promise<void> {
    await this.callTool('force_fail_copilot_job', {
      plan_id: planId,
      job_id: nodeId,
    });
  }

  // ── Logs ───────────────────────────────────────────────────────────

  async getDaemonLogs(): Promise<string | null> {
    try {
      const result = await this.callTool('get_orchestrator_logs', { kind: 'daemon' });
      return result?.content ?? null;
    } catch { return null; }
  }

  async getRepoLogs(repoRoot: string): Promise<string | null> {
    try {
      const result = await this.callTool('get_orchestrator_logs', {
        kind: 'repo',
        repo_root: repoRoot,
      });
      return result?.content ?? null;
    } catch { return null; }
  }

  // ── MCP Communication ──────────────────────────────────────────────

  private async callTool(toolName: string, args: Record<string, unknown>): Promise<any> {
    const result = await this.callMcp('tools/call', { name: toolName, arguments: { ...args, repo_root: this.repoRoot } });
    // For tools/call, the result is in result.content[0].text
    if (result?.content?.[0]?.text) {
      try { return JSON.parse(result.content[0].text); } catch { return result; }
    }
    return result;
  }

  private callMcp(method: string, params: unknown): Promise<any> {
    if (!this.connection) throw new Error('Not connected to daemon');

    const id = nextRequestId++;
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });
    const frame = `Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.connection!.write(frame);

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('MCP call timed out'));
        }
      }, 30_000);
    });
  }

  private rejectAllPending(error: Error): void {
    for (const p of this.pending.values()) {
      p.reject(error);
    }
    this.pending.clear();
  }

  private parsePlanResult(result: any): PlanInstance {
    // Minimal PlanInstance from daemon response — many fields are Maps that
    // can't be meaningfully constructed until the daemon sends full state.
    // Use `as unknown as PlanInstance` because the daemon response shape is
    // not known at compile time and will be hydrated via event sync.
    const id = result?.plan_id ?? result?.id ?? `plan-${Date.now()}`;
    const plan = {
      id,
      spec: { name: result?.name ?? 'Unnamed', jobs: [] } as PlanSpec,
      jobs: new Map(),
      producerIdToNodeId: new Map(),
      roots: [],
      leaves: [],
      nodeStates: new Map(),
      groups: new Map(),
      groupStates: new Map(),
      groupPathToId: new Map(),
      repoPath: '',
      baseBranch: result?.baseBranch ?? 'main',
      targetBranch: result?.targetBranch,
      worktreeRoot: '',
      createdAt: Date.now(),
      stateVersion: 0,
      cleanUpSuccessfulWork: true,
      maxParallel: 4,
    } as unknown as PlanInstance;
    this.planCache.set(plan.id, plan);
    return plan;
  }
}
