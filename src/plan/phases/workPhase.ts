/**
 * @fileoverview Work Phase Executor
 *
 * Handles the main work execution phase and exports shared runner helpers
 * used by precheck and postcheck phases.
 *
 * @module plan/phases/workPhase
 */

import * as path from 'path';
import { spawn } from 'child_process';
import type { IPhaseExecutor, PhaseContext, PhaseResult } from '../../interfaces/IPhaseExecutor';
import { normalizeWorkSpec } from '../types';
import type { ProcessSpec, ShellSpec, AgentSpec, CopilotUsageMetrics } from '../types';

/** Adapt a shell command for Windows PowerShell 5.x compatibility. */
export function adaptCommandForPowerShell(command: string): string {
  // Adapt && chaining to PowerShell's error-checking equivalent
  const adapted = command.replace(/\s*&&\s*/g, '; if (!$?) { exit 1 }; ').replace(/\bls\s+-la\b/g, 'Get-ChildItem');
  // Wrap in $ErrorActionPreference = 'Continue' to prevent stderr from native
  // commands being treated as terminating errors. PowerShell by default wraps
  // stderr output as NativeCommandError which can cause unexpected failures.
  // We rely solely on exit code (not stderr content) to determine success.
  return `$ErrorActionPreference = 'Continue'; ${adapted}; exit $LASTEXITCODE`;
}

// Shared helper: spawn a process/shell and track it in the PhaseContext
function spawnAndTrack(
  executable: string, args: string[], cwd: string,
  env: NodeJS.ProcessEnv, timeout: number, ctx: PhaseContext, label: string,
): Promise<PhaseResult> {
  return new Promise((resolve) => {
    ctx.logInfo(`${label}: ${executable}`);
    ctx.logInfo(`Working directory: ${cwd}`);
    const proc = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    ctx.setProcess(proc);
    const startTime = Date.now();
    ctx.setStartTime(startTime);
    ctx.logInfo(`${label} started: PID ${proc.pid}`);
    let stdout = '', stderr = '';
    let timeoutHandle: NodeJS.Timeout | undefined;
    const effectiveTimeout = timeout > 0 ? Math.min(timeout, 2147483647) : 0;
    if (effectiveTimeout > 0) {
      timeoutHandle = setTimeout(() => {
        ctx.logError(`${label} timed out after ${effectiveTimeout}ms (PID: ${proc.pid})`);
        try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t']); else proc.kill('SIGTERM'); } catch { /* ignore */ }
      }, effectiveTimeout);
    }
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', (d: string) => { stdout += d; ctx.logOutput('stdout', d); });
    proc.stderr?.on('data', (d: string) => { stderr += d; ctx.logOutput('stderr', d); });
    proc.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      ctx.setProcess(undefined);
      ctx.logInfo(`${label} exited: PID ${proc.pid}, code ${code}, duration ${Date.now() - startTime}ms`);
      if (stderr.trim()) {
        // Log stderr content for diagnostics, but do NOT treat it as failure
        // PowerShell writes warnings, progress, and verbose output to stderr
        ctx.logInfo(`${label} stderr output (informational, not an error):`);
        ctx.logOutput('stderr', stderr);
      }
      if (ctx.isAborted()) resolve({ success: false, error: 'Execution canceled' });
      else if (code === 0) resolve({ success: true });
      else resolve({ success: false, error: `Exit code ${code}`, exitCode: code ?? undefined });
    });
    proc.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      ctx.setProcess(undefined);
      ctx.logError(`${label} error: PID ${proc.pid}, error: ${err.message}, duration ${Date.now() - startTime}ms`);
      resolve({ success: false, error: err.message });
    });
  });
}

/** Run a direct process (no shell). */
export function runProcess(spec: ProcessSpec, ctx: PhaseContext): Promise<PhaseResult> {
  const cwd = spec.cwd ? path.resolve(ctx.worktreePath, spec.cwd) : ctx.worktreePath;
  const args = spec.args || [];
  ctx.logInfo(`Arguments: ${JSON.stringify(args)}`);
  if (spec.env) ctx.logInfo(`Environment overrides: ${JSON.stringify(spec.env)}`);
  return spawnAndTrack(spec.executable, args, cwd, { ...process.env, ...spec.env }, spec.timeout || 0, ctx, 'Process');
}

/** Run a shell command. */
export function runShell(spec: ShellSpec, ctx: PhaseContext): Promise<PhaseResult> {
  const cwd = spec.cwd ? path.resolve(ctx.worktreePath, spec.cwd) : ctx.worktreePath;
  const isWindows = process.platform === 'win32';
  let shell: string, shellArgs: string[];
  switch (spec.shell) {
    case 'cmd': shell = 'cmd.exe'; shellArgs = ['/c', spec.command]; break;
    case 'powershell': shell = 'powershell.exe'; shellArgs = ['-NoProfile', '-NonInteractive', '-Command', spec.command]; break;
    case 'pwsh': shell = 'pwsh'; shellArgs = ['-NoProfile', '-NonInteractive', '-Command', spec.command]; break;
    case 'bash': shell = 'bash'; shellArgs = ['-c', spec.command]; break;
    case 'sh': shell = '/bin/sh'; shellArgs = ['-c', spec.command]; break;
    default:
      if (isWindows) { shell = 'powershell.exe'; shellArgs = ['-NoProfile', '-NonInteractive', '-Command', adaptCommandForPowerShell(spec.command)]; }
      else { shell = '/bin/sh'; shellArgs = ['-c', spec.command]; }
  }
  ctx.logInfo(`Command: ${spec.command}`);
  if (spec.env) ctx.logInfo(`Environment overrides: ${JSON.stringify(spec.env)}`);
  return spawnAndTrack(shell, shellArgs, cwd, { ...process.env, ...spec.env }, spec.timeout || 0, ctx, 'Shell');
}

/** Run agent work. */
export async function runAgent(
  spec: AgentSpec, ctx: PhaseContext,
  agentDelegator: any | undefined, getCopilotConfigDir: () => string,
): Promise<PhaseResult> {
  if (!agentDelegator) return { success: false, error: 'Agent work requires an agent delegator to be configured' };
  ctx.setIsAgentWork(true);
  const startTime = Date.now();
  ctx.setStartTime(startTime);
  ctx.logInfo(`Agent instructions: ${spec.instructions}`);
  if (spec.model) ctx.logInfo(`Using model: ${spec.model}`);
  if (spec.contextFiles?.length) ctx.logInfo(`Agent context files: ${spec.contextFiles.join(', ')}`);
  if (spec.maxTurns) ctx.logInfo(`Agent max turns: ${spec.maxTurns}`);
  if (spec.context) ctx.logInfo(`Agent context: ${spec.context}`);
  if (ctx.sessionId) ctx.logInfo(`Resuming Copilot session: ${ctx.sessionId}`);
  if (spec.allowedFolders?.length) ctx.logInfo(`Agent allowed folders: ${spec.allowedFolders.join(', ')}`);
  if (spec.allowedUrls?.length) ctx.logInfo(`Agent allowed URLs: ${spec.allowedUrls.join(', ')}`);
  try {
    const configDir = getCopilotConfigDir();
    const result = await agentDelegator.delegate({
      task: spec.instructions,
      instructions: ctx.node.instructions || spec.context,
      worktreePath: ctx.worktreePath, model: spec.model,
      contextFiles: spec.contextFiles, maxTurns: spec.maxTurns,
      sessionId: ctx.sessionId, jobId: ctx.node.id, configDir,
      allowedFolders: spec.allowedFolders, allowedUrls: spec.allowedUrls,
      logOutput: (line: string) => ctx.logInfo(line),
      onProcess: (proc: any) => { ctx.setProcess(proc); ctx.setIsAgentWork(true); },
    });
    const durationMs = Date.now() - startTime;
    let metrics: CopilotUsageMetrics;
    if (result.metrics) { metrics = { ...result.metrics, durationMs }; }
    else { metrics = { durationMs }; if (result.tokenUsage) metrics.tokenUsage = result.tokenUsage; }
    if (result.success) {
      ctx.logInfo('Agent completed successfully');
      if (result.sessionId) ctx.logInfo(`Captured session ID: ${result.sessionId}`);
      return { success: true, copilotSessionId: result.sessionId, metrics };
    }
    ctx.logError(`Agent failed: ${result.error}`);
    return { success: false, error: result.error, copilotSessionId: result.sessionId, exitCode: result.exitCode, metrics };
  } catch (error: any) {
    ctx.logError(`Agent error: ${error.message}`);
    return { success: false, error: error.message, metrics: { durationMs: Date.now() - startTime } };
  }
}

/** Executes the main work phase of a job node. */
export class WorkPhaseExecutor implements IPhaseExecutor {
  private agentDelegator?: any;
  private getCopilotConfigDir: () => string;
  constructor(deps: { agentDelegator?: any; getCopilotConfigDir: () => string }) {
    this.agentDelegator = deps.agentDelegator;
    this.getCopilotConfigDir = deps.getCopilotConfigDir;
  }
  async execute(context: PhaseContext): Promise<PhaseResult> {
    const normalized = normalizeWorkSpec(context.workSpec);
    if (!normalized) return { success: true };
    context.logInfo(`Work type: ${normalized.type}`);
    switch (normalized.type) {
      case 'process': return runProcess(normalized as ProcessSpec, context);
      case 'shell': return runShell(normalized as ShellSpec, context);
      case 'agent': return runAgent(normalized as AgentSpec, context, this.agentDelegator, this.getCopilotConfigDir);
      default: return { success: false, error: `Unknown work type: ${(normalized as any).type}` };
    }
  }
}
