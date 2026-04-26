/**
 * @fileoverview .NET Orchestration Engine
 *
 * Implements IOrchestrationEngine by communicating with the .NET AiOrchestrator
 * daemon via MCP protocol over named pipes. Plan operations are forwarded as
 * MCP tool calls; events are received via a streaming connection.
 *
 * @module core/dotnetEngine
 */

import { EventEmitter } from 'events';
import * as net from 'net';
import type {
  IOrchestrationEngine,
  EngineKind,
} from '../interfaces/IOrchestrationEngine';
import type { IDotNetDaemonManager } from '../interfaces/IDotNetDaemonManager';
import type {
  PlanSpec,
  PlanInstance,
  PlanStatus,
  NodeStatus,
  ExecutionPhase,
  AttemptRecord,
  NodeExecutionState,
} from '../plan/types';
import type { RetryNodeOptions } from '../interfaces/IPlanRunner';
import { computePlanStatus } from '../plan/helpers';
import { Logger } from './logger';

const log = Logger.for('dotnet-engine');

/** JSON-RPC request counter for unique IDs. */
let nextRequestId = 1;

/**
 * MCP-based orchestration engine backed by the .NET daemon.
 *
 * All plan operations are sent as MCP tool calls over a named pipe.
 * Plan state is queried via get_copilot_plan_status and similar tools.
 */
export class DotNetOrchestrationEngine extends EventEmitter implements IOrchestrationEngine {
  readonly kind: EngineKind = 'dotnet';

  /** Cached plan state from daemon queries. */
  private planCache = new Map<string, PlanInstance>();

  constructor(private readonly daemonManager: IDotNetDaemonManager) {
    super();
  }

  async initialize(): Promise<void> {
    log.info('Initializing .NET engine — starting daemon');
    await this.daemonManager.start();

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
    await this.daemonManager.stop();
  }

  persistSync(): void {
    // .NET daemon persists its own state
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
    return this.callMcp('tools/call', { name: toolName, arguments: args });
  }

  private async callMcp(method: string, params: unknown): Promise<any> {
    const pipeName = this.daemonManager.getPipeName();
    if (!pipeName) throw new Error('Daemon not started');

    const id = nextRequestId++;
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      const client = net.connect(pipeName, () => {
        const frame = `Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`;
        client.write(frame);
      });

      let buffer = '';
      client.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        // Parse Content-Length framing
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const header = buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) return;
        const contentLength = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + contentLength) return;
        const body = buffer.slice(bodyStart, bodyStart + contentLength);
        client.destroy();

        try {
          const response = JSON.parse(body);
          if (response.error) {
            reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
          } else {
            // For tools/call, the result is in response.result.content[0].text
            if (method === 'tools/call' && response.result?.content?.[0]?.text) {
              try { resolve(JSON.parse(response.result.content[0].text)); } catch { resolve(response.result); }
            } else {
              resolve(response.result);
            }
          }
        } catch (e) {
          reject(new Error(`Failed to parse MCP response: ${e}`));
        }
      });

      client.on('error', (err) => {
        client.destroy();
        reject(new Error(`MCP pipe connection failed: ${err.message}`));
      });

      setTimeout(() => {
        client.destroy();
        reject(new Error('MCP call timed out'));
      }, 30_000);
    });
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
