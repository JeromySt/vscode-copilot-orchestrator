/**
 * @fileoverview Scripted Copilot runner for deterministic integration testing.
 *
 * Replaces the real {@link CopilotCliRunner} when a plan uses scripted process
 * output. Instead of invoking the Copilot CLI, it plays back pre-recorded
 * stdout/stderr from the {@link ScriptedProcessSpawner}, extracting session IDs
 * and metrics from the scripted output just like the real runner would.
 *
 * @module plan/testing/scriptedCopilotRunner
 */

import type { ICopilotRunner } from '../../interfaces/ICopilotRunner';
import type { CopilotRunOptions, CopilotRunResult } from '../../agent/copilotCliRunner';
import type { IProcessSpawner } from '../../interfaces/IProcessSpawner';
import type { IManagedProcessFactory } from '../../interfaces/IManagedProcessFactory';
import type { FakeChildProcess } from './scriptedProcessSpawner';
import type { LogFileScript } from './processScripts';
import { Logger } from '../../core/logger';
import * as fs from 'fs';
import * as path from 'path';

const log = Logger.for('plan');

/**
 * Write log-file entries to disk on timers so the LogFileTailer picks them up.
 * This enables the ContextPressureHandler to detect token usage from debug logs.
 */
function scheduleLogFileWrites(
  logFiles: LogFileScript[],
  baseDir: string,
  proc: FakeChildProcess,
): void {
  for (const logFile of logFiles) {
    const filePath = path.join(baseDir, logFile.relativePath);
    let elapsed = 0;
    for (const line of logFile.lines) {
      const delay = line.delayMs ?? 0;
      elapsed += delay;
      const capturedElapsed = elapsed;
      const capturedText = line.text;
      proc._schedule(() => {
        if (!proc.killed) {
          try {
            fs.appendFileSync(filePath, capturedText + '\n');
          } catch { /* best-effort */ }
        }
      }, capturedElapsed);
    }
  }
}

/**
 * A fake Copilot runner that delegates to a {@link ScriptedProcessSpawner}
 * and optionally wires through {@link IManagedProcessFactory} for full
 * handler pipeline integration (SessionId, Stats, TaskComplete, ContextPressure).
 *
 * When `managedFactory` is provided, the spawned process goes through the
 * real output bus with all registered handlers. Log-file entries from the
 * script are written to disk so the LogFileTailer feeds them to the
 * ContextPressureHandler.
 */
export class ScriptedCopilotRunner implements ICopilotRunner {
  constructor(
    private readonly spawner: IProcessSpawner,
    private readonly managedFactory?: IManagedProcessFactory,
  ) {}

  async run(options: CopilotRunOptions): Promise<CopilotRunResult> {
    const cwd = options.cwd || process.cwd();
    log.info('ScriptedCopilotRunner executing', { cwd, task: options.task?.slice(0, 80) });

    return new Promise<CopilotRunResult>((resolve) => {
      // Spawn through the scripted spawner — it will match by cwd
      const proc = this.spawner.spawn('copilot-cli', ['--task', options.task || ''], {
        cwd,
        shell: true,
        env: options.env,
      });

      // Notify caller of the spawned process (for kill support)
      if (options.onProcess) { options.onProcess(proc); }

      // Write log-file entries to disk if the matched script has them.
      // This enables the LogFileTailer → ContextPressureHandler pipeline.
      const fakeProc = proc as unknown as FakeChildProcess;
      if (fakeProc.logFiles && fakeProc.logFiles.length > 0) {
        const logDir = path.join(cwd, '.orchestrator', '.copilot-cli', 'logs');
        try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* best-effort */ }
        scheduleLogFileWrites(fakeProc.logFiles, logDir, fakeProc);
      }

      // Wire through ManagedProcessFactory for full handler pipeline
      // (SessionId, Stats, TaskComplete, ContextPressure handlers all activate)
      let managed: any;
      if (this.managedFactory) {
        const logDir = path.join(cwd, '.orchestrator', '.copilot-cli', 'logs');
        try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* best-effort */ }
        managed = this.managedFactory.create(proc, {
          label: 'copilot',
          planId: options.planId,
          nodeId: options.jobId,
          worktreePath: cwd,
          logSources: [{
            name: 'debug-log',
            type: 'directory' as const,
            path: logDir,
          }],
        });
      }

      const stdoutLines: string[] = [];
      let sessionId: string | undefined;

      // Collect stdout
      if (proc.stdout) {
        proc.stdout.on('data', (data: Buffer) => {
          const text = data.toString();
          for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) { continue; }
            stdoutLines.push(trimmed);

            // Notify caller of output lines
            if (options.onOutput) { options.onOutput(trimmed); }

            // Extract session ID (same patterns as SessionIdHandler)
            if (!sessionId) {
              const match = trimmed.match(/(?:Session ID|session|Starting session)[:\s]+([a-f0-9-]{36})/i);
              if (match) { sessionId = match[1]; }
            }
          }
        });
      }

      // Wait for exit
      proc.on('close', (code: number | null) => {
        const exitCode = code ?? 0;
        const success = exitCode === 0 || stdoutLines.some(l => l.includes('Task complete'));

        // Write checkpoint manifest if the matched script specifies one.
        // This simulates an agent that checkpointed due to context pressure.
        const fakeProc = proc as unknown as FakeChildProcess;
        if (fakeProc.checkpointManifest && cwd) {
          try {
            const orchDir = path.join(cwd, '.orchestrator');
            fs.mkdirSync(orchDir, { recursive: true });
            const manifestPath = path.join(orchDir, 'checkpoint-manifest.json');
            fs.writeFileSync(manifestPath, JSON.stringify(fakeProc.checkpointManifest, null, 2));
            log.info('Wrote checkpoint manifest', { cwd, manifestPath });
          } catch (err: any) {
            log.error('Failed to write checkpoint manifest', { cwd, error: err.message });
          }
        }

        log.info('ScriptedCopilotRunner completed', { 
          cwd, exitCode, success, lineCount: stdoutLines.length, sessionId,
          hasManifest: !!fakeProc.checkpointManifest,
        });

        // Read metrics and session from managed process handlers (same as real CopilotCliRunner)
        let metrics: any;
        if (managed?.bus) {
          try {
            const statsHandler = managed.bus.getHandler('stats');
            const sessionHandler = managed.bus.getHandler('session-id');
            const taskCompleteHandler = managed.bus.getHandler('task-complete');
            if (statsHandler?.getMetrics) { metrics = statsHandler.getMetrics(); }
            if (sessionHandler?.getSessionId && !sessionId) { sessionId = sessionHandler.getSessionId(); }
            if (taskCompleteHandler?.sawTaskComplete?.()) {
              // Coerce null exit code to 0 (Windows workaround, same as real runner)
              if (code === null) { /* exitCode already 0 from ?? 0 */ }
            }
          } catch (err: any) {
            log.warn('Failed to read handlers from managed process', { error: err.message });
          }
        }

        resolve({
          success,
          exitCode,
          sessionId,
          metrics,
          error: success ? undefined : `Process exited with code ${exitCode}`,
        });
      });

      // Handle error events
      proc.on('error', (err: Error) => {
        resolve({
          success: false,
          exitCode: 1,
          error: err.message,
        });
      });
    });
  }

  isAvailable(): boolean {
    return true; // Always available in test mode
  }

  writeInstructionsFile(
    _cwd: string,
    _task: string,
    _instructions: string | undefined,
    _label: string,
    _jobId?: string,
  ): { filePath: string; dirPath: string } {
    // No-op in test mode — return dummy paths
    return { filePath: '/dev/null', dirPath: '/dev/null' };
  }

  buildCommand(options: {
    task: string;
    sessionId?: string;
    model?: string;
    cwd?: string;
  }): string {
    return `copilot-cli --task "${options.task}"`;
  }

  cleanupInstructionsFile(
    _filePath: string,
    _dirPath: string | undefined,
    _label: string,
  ): void {
    // No-op in test mode
  }
}
