/**
 * @fileoverview Work Phase Executor
 *
 * Handles the main work execution phase and exports shared runner helpers
 * used by precheck and postcheck phases.
 *
 * @module plan/phases/workPhase
 */

import * as path from 'path';
import type { IPhaseExecutor, PhaseContext, PhaseResult } from '../../interfaces/IPhaseExecutor';
import type { IProcessSpawner } from '../../interfaces/IProcessSpawner';
import type { ICopilotRunner } from '../../interfaces/ICopilotRunner';
import { normalizeWorkSpec } from '../types';
import type { ProcessSpec, ShellSpec, AgentSpec, CopilotUsageMetrics } from '../types';
import { killProcessTree } from '../../process/processHelpers';

/** Adapt a shell command for Windows PowerShell 5.x compatibility. */
export function adaptCommandForPowerShell(command: string, errorAction: string = 'Continue'): string {
  // Adapt && chaining to PowerShell's error-checking equivalent
  const adapted = command.replace(/\s*&&\s*/g, '; if (!$?) { exit 1 }; ').replace(/\bls\s+-la\b/g, 'Get-ChildItem');
  // Set $ErrorActionPreference to control how PowerShell handles non-terminating
  // errors (e.g. stderr from native commands). Default 'Continue' prevents
  // NativeCommandError from causing unexpected failures. Callers can override
  // to 'Stop' when stderr truly indicates failure.
  //
  // Use -1 guard: in PowerShell 5.x, when a pipeline is terminated early by
  // Select-Object -First N, the upstream native command is killed and $LASTEXITCODE
  // becomes -1. This is not a real failure — treat it as success (0). Real
  // failures use codes like 1. PowerShell 7 (pwsh) handles this correctly by
  // letting the process exit via EPIPE with its actual code.
  return `$ErrorActionPreference = '${errorAction}'; ${adapted}; if ($LASTEXITCODE -eq -1) { exit 0 } else { exit $LASTEXITCODE }`;
}

// Shared helper: spawn a process/shell and track it in the PhaseContext
function spawnAndTrack(
  spawner: IProcessSpawner,
  executable: string, args: string[], cwd: string,
  env: NodeJS.ProcessEnv, timeout: number, ctx: PhaseContext, label: string,
): Promise<PhaseResult> {
  return new Promise((resolve) => {
    ctx.logInfo(`${label}: ${executable}`);
    ctx.logInfo(`Working directory: ${cwd}`);
    const proc = spawner.spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    ctx.setProcess(proc as any); // Cast to ChildProcess since ChildProcessLike is compatible
    const startTime = Date.now();
    ctx.setStartTime(startTime);
    ctx.logInfo(`${label} started: PID ${proc.pid}`);
    let stdout = '', stderr = '';
    let timeoutHandle: NodeJS.Timeout | undefined;
    const effectiveTimeout = timeout > 0 ? Math.min(timeout, 2147483647) : 0;
    if (effectiveTimeout > 0) {
      timeoutHandle = setTimeout(async () => {
        ctx.logError(`${label} timed out after ${effectiveTimeout}ms (PID: ${proc.pid})`);
        try { 
          if (proc.pid) {
            await killProcessTree(spawner, proc.pid, true);
          }
        } catch { /* ignore */ }
      }, effectiveTimeout);
    }
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', (d: string) => { stdout += d; ctx.logOutput('stdout', d); });
    proc.stderr?.on('data', (d: string) => { stderr += d; ctx.logOutput('stderr', d); });
    
    // Track stream completion separately from process exit.
    // The 'close' event fires when the process exits AND all stdio streams
    // are closed. However, on Windows with shell:true, the streams may
    // deliver their final buffered data in the same tick as 'close'.
    // Using setImmediate ensures all pending I/O callbacks (including any
    // final data events) are processed before we log the exit summary.
    proc.on('close', (code) => {
      setImmediate(() => {
        if (timeoutHandle) {clearTimeout(timeoutHandle);}
        ctx.setProcess(undefined);
        ctx.logInfo(`${label} exited: PID ${proc.pid}, code ${code}, duration ${Date.now() - startTime}ms`);
        if (stdout.trim()) {ctx.logInfo(`${label} stdout (${stdout.split('\n').length} lines)`);}
        if (stderr.trim()) {ctx.logInfo(`${label} stderr (${stderr.split('\n').length} lines, informational)`);}
        if (ctx.isAborted()) {resolve({ success: false, error: 'Execution canceled' });}
        else if (code === 0) {resolve({ success: true });}
        else {resolve({ success: false, error: `Exit code ${code}`, exitCode: code ?? undefined });}
      });
    });
    proc.on('error', (err) => {
      if (timeoutHandle) {clearTimeout(timeoutHandle);}
      ctx.setProcess(undefined);
      ctx.logError(`${label} error: PID ${proc.pid}, error: ${err.message}, duration ${Date.now() - startTime}ms`);
      resolve({ success: false, error: err.message });
    });
  });
}

/** Run a direct process (no shell). */
export function runProcess(spec: ProcessSpec, ctx: PhaseContext, spawner: IProcessSpawner): Promise<PhaseResult> {
  const cwd = spec.cwd ? path.resolve(ctx.worktreePath, spec.cwd) : ctx.worktreePath;
  const args = spec.args || [];
  ctx.logInfo(`Arguments: ${JSON.stringify(args)}`);
  if (ctx.env) {ctx.logInfo(`Plan/spec environment override keys: ${Object.keys(ctx.env).join(', ')}`);}
  if (spec.env) {ctx.logInfo(`Spec environment override keys: ${Object.keys(spec.env).join(', ')}`);}
  return spawnAndTrack(spawner, spec.executable, args, cwd, { ...process.env, ...ctx.env, ...spec.env }, spec.timeout || 0, ctx, 'Process');
}

/** Run a shell command. */
export function runShell(spec: ShellSpec, ctx: PhaseContext, spawner: IProcessSpawner): Promise<PhaseResult> {
  const cwd = spec.cwd ? path.resolve(ctx.worktreePath, spec.cwd) : ctx.worktreePath;
  const isWindows = process.platform === 'win32';
  const ea = spec.errorAction || 'Continue';
  let shell: string, shellArgs: string[];
  switch (spec.shell) {
    case 'cmd': shell = 'cmd.exe'; shellArgs = ['/c', spec.command]; break;
    case 'powershell': shell = 'powershell.exe'; shellArgs = ['-NoProfile', '-NonInteractive', '-Command', adaptCommandForPowerShell(spec.command, ea)]; break;
    case 'pwsh': shell = 'pwsh'; shellArgs = ['-NoProfile', '-NonInteractive', '-Command', adaptCommandForPowerShell(spec.command, ea)]; break;
    case 'bash': shell = 'bash'; shellArgs = ['-c', spec.command]; break;
    case 'sh': shell = '/bin/sh'; shellArgs = ['-c', spec.command]; break;
    default:
      if (isWindows) { shell = 'powershell.exe'; shellArgs = ['-NoProfile', '-NonInteractive', '-Command', adaptCommandForPowerShell(spec.command, ea)]; }
      else { shell = '/bin/sh'; shellArgs = ['-c', spec.command]; }
  }
  ctx.logInfo(`Command: ${spec.command}`);
  if (spec.shell) {ctx.logInfo(`Shell: ${shell}`);}
  if (spec.errorAction) {ctx.logInfo(`ErrorActionPreference: ${spec.errorAction}`);}
  if (ctx.env) {ctx.logInfo(`Plan/spec environment override keys: ${Object.keys(ctx.env).join(', ')}`);}  
  if (spec.env) {ctx.logInfo(`Spec environment override keys: ${Object.keys(spec.env).join(', ')}`);}  
  return spawnAndTrack(spawner, shell, shellArgs, cwd, { ...process.env, ...ctx.env, ...spec.env }, spec.timeout || 0, ctx, 'Shell');
}

/** Run agent work. */
export async function runAgent(
  spec: AgentSpec, ctx: PhaseContext,
  copilotRunner: ICopilotRunner | undefined,
  spawner?: IProcessSpawner,
): Promise<PhaseResult> {
  if (!copilotRunner) {return { success: false, error: 'Agent work requires a Copilot runner to be configured' };}
  ctx.setIsAgentWork(true);
  const startTime = Date.now();
  ctx.setStartTime(startTime);
  ctx.logInfo(`Agent instructions: ${spec.instructions}`);

  // Auto-promote complex jobs to a premium tier + high effort when neither model
  // nor modelTier is explicitly set. Sonnet 4.6 has been observed to give up
  // (empty assistant message → end_turn) on large multi-file scaffold tasks
  // (Files-to-create ≥ 6 OR instructions > 4 KB). Bumping to a premium model
  // with deeper reasoning is the cheapest reliable mitigation.
  const COMPLEXITY_INSTR_BYTES = 4_000;
  const COMPLEXITY_FILE_COUNT = 6;
  const isExplicitlyTuned = !!spec.model || !!spec.modelTier;
  if (!isExplicitlyTuned && spec.instructions) {
    const instrBytes = Buffer.byteLength(spec.instructions, 'utf8');
    // Count "Files to create / modify" entries — heuristic: lines that look like
    // path-ish entries (contain '/' and end with file extension) inside the
    // instructions. Cheap and false-positive tolerant.
    const fileLikeLines = (spec.instructions.match(/^[\s\-*`]*[\w./_-]+\/[\w./_-]+\.[a-z0-9]+\s*$/gim) ?? []).length;
    if (instrBytes >= COMPLEXITY_INSTR_BYTES || fileLikeLines >= COMPLEXITY_FILE_COUNT) {
      // Mutate a copy so we never alter the persisted spec.
      spec = { ...spec, modelTier: 'premium', effort: spec.effort ?? 'high' };
      ctx.logInfo(
        `Auto-promoted complex agent job: instrBytes=${instrBytes}, fileLikeLines=${fileLikeLines} ` +
        `→ modelTier='premium', effort='${spec.effort}'. Set model/modelTier explicitly to opt out.`
      );
    }
  }

  // Resolve model from modelTier if model isn't explicitly set
  let resolvedModel = spec.model;
  if (!resolvedModel && spec.modelTier) {
    try {
      const { suggestModel } = await import('../../agent/modelDiscovery');
      const suggested = await suggestModel(spec.modelTier);
      if (suggested) {
        resolvedModel = suggested.id;
        ctx.logInfo(`Resolved modelTier '${spec.modelTier}' → '${resolvedModel}'`);
      }
    } catch { /* fallback to default */ }
  }

  if (resolvedModel) {ctx.logInfo(`Using model: ${resolvedModel}`);}
  if (spec.contextFiles?.length) {ctx.logInfo(`Agent context files: ${spec.contextFiles.join(', ')}`);}
  if (spec.maxTurns) {ctx.logInfo(`Agent max turns: ${spec.maxTurns}`);}
  if (spec.effort) {ctx.logInfo(`Agent effort: ${spec.effort}`);}
  if (spec.context) {ctx.logInfo(`Agent context: ${spec.context}`);}
  if (ctx.sessionId) {ctx.logInfo(`Resuming Copilot session: ${ctx.sessionId}`);}
  if (spec.allowedFolders?.length) {ctx.logInfo(`Agent allowed folders: ${spec.allowedFolders.join(', ')}`);}
  if (spec.allowedUrls?.length) {ctx.logInfo(`Agent allowed URLs: ${spec.allowedUrls.join(', ')}`);}
  if (ctx.env) {ctx.logInfo(`Plan/spec environment override keys: ${Object.keys(ctx.env).join(', ')}`);}

  // Resolve effort: only pass through if CLI supports --effort
  let resolvedEffort = spec.effort;
  if (resolvedEffort) {
    try {
      const { hasEffortSupport } = await import('../../agent/modelDiscovery');
      const supported = await hasEffortSupport();
      if (!supported) {
        ctx.logInfo(`Effort '${resolvedEffort}' specified but CLI does not support --effort — ignoring`);
        resolvedEffort = undefined;
      }
    } catch { /* fallback: skip effort if discovery fails */ resolvedEffort = undefined; }
  }

  try {
    const result = await copilotRunner.run({
      cwd: ctx.worktreePath,
      task: spec.instructions,
      instructions: ctx.node.instructions || spec.context,
      label: 'agent',
      model: resolvedModel,
      sessionId: ctx.sessionId,
      jobId: ctx.node.id,
      planId: ctx.planId,
      allowedFolders: spec.allowedFolders,
      allowedUrls: spec.allowedUrls,
      configDir: ctx.configDir,
      env: ctx.env,
      effort: resolvedEffort,
      timeout: 0,
      spawnerOverride: spawner,
      onOutput: (line: string) => ctx.logInfo(`[copilot] ${line}`),
      onProcess: (proc: any) => { ctx.setProcess(proc); ctx.setIsAgentWork(true); },
    });
    const durationMs = Date.now() - startTime;
    let metrics: CopilotUsageMetrics;
    if (result.metrics) { metrics = { ...result.metrics, durationMs }; }
    else { metrics = { durationMs }; }
    if (result.success) {
      // No-op exit detector: the CLI reports success but produced no work.
      // Without this, the commit phase eventually fails with "No work evidence
      // produced" — wasting the diagnostic signal and a full retry cycle.
      // Tripping conditions (all must hold):
      //   - The node does NOT declare expectsNoChanges (legitimate verify-only)
      //   - Stats reported zero adds AND zero removes (so we have a metric to trust)
      //   - Run lasted long enough that the model had a real chance to do work
      //     (avoids tripping on fast verification turns or transient rejections)
      const NOOP_MIN_DURATION_MS = 60_000;
      const expectsNoChanges = !!ctx.node.expectsNoChanges;
      const codeChanges = result.metrics?.codeChanges;
      const isZeroChange = codeChanges && codeChanges.linesAdded === 0 && codeChanges.linesRemoved === 0;
      if (!expectsNoChanges && isZeroChange && durationMs >= NOOP_MIN_DURATION_MS) {
        const error = `Agent exited with no-op turn — zero code changes after ${Math.round(durationMs / 1000)}s. ` +
          `The model gave up without producing output (likely research paralysis). ` +
          `Retry with a higher tier or narrower instructions.`;
        ctx.logError(`No-op detected: ${error}`);
        return { success: false, error, copilotSessionId: result.sessionId, exitCode: result.exitCode, metrics };
      }
      ctx.logInfo('Agent completed successfully');
      if (result.sessionId) {ctx.logInfo(`Captured session ID: ${result.sessionId}`);}
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
  private copilotRunner?: ICopilotRunner;
  private spawner: IProcessSpawner;
  
  constructor(deps: { 
    copilotRunner?: ICopilotRunner; 
    spawner: IProcessSpawner;
  }) {
    this.copilotRunner = deps.copilotRunner;
    this.spawner = deps.spawner;
  }
  
  async execute(context: PhaseContext): Promise<PhaseResult> {
    const normalized = normalizeWorkSpec(context.workSpec);
    if (!normalized) {return { success: true };}
    context.logInfo(`Work type: ${normalized.type}`);
    switch (normalized.type) {
      case 'process': return runProcess(normalized as ProcessSpec, context, this.spawner);
      case 'shell': return runShell(normalized as ShellSpec, context, this.spawner);
      case 'agent': return runAgent(normalized as AgentSpec, context, this.copilotRunner, this.spawner);
      default: return { success: false, error: `Unknown work type: ${(normalized as any).type}` };
    }
  }
}
