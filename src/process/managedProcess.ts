/**
 * @fileoverview Managed process implementation.
 *
 * Wraps a {@link ChildProcessLike} with a {@link ProcessOutputBus},
 * auto-wires stdout/stderr, starts {@link LogFileTailer}s, and provides
 * high-resolution lifecycle timestamps, computed durations, and diagnostics.
 *
 * @see docs/PROCESS_OUTPUT_BUS_DESIGN.md §5.2
 * @module process/managedProcess
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import type { ChildProcessLike } from '../interfaces/IProcessSpawner';
import type { IProcessSpawner } from '../interfaces/IProcessSpawner';
import type { LogSourceConfig } from '../interfaces/IManagedProcessFactory';
import type {
  IManagedProcess,
  ProcessTimestamps,
  ProcessDurations,
  ProcessDiagnostics,
} from '../interfaces/IManagedProcess';
import type { OutputSource } from '../interfaces/IOutputHandler';
import { OutputSources } from '../interfaces/IOutputHandler';
import type { ProcessOutputBus } from './processOutputBus';
import { LogFileTailer } from './logFileTailer';
import { Logger } from '../core/logger';

const log = Logger.for('process-output-bus');

/**
 * Compute durations from timestamps.
 */
function computeDurations(ts: ProcessTimestamps): ProcessDurations {
  return {
    total: ts.exited != null && ts.requested != null ? ts.exited - ts.requested : undefined,
    spawnLatency: ts.created != null && ts.requested != null ? ts.created - ts.requested : undefined,
    startupLatency: ts.running != null && ts.created != null ? ts.running - ts.created : undefined,
    processLifetime: ts.exited != null && ts.created != null ? ts.exited - ts.created : undefined,
    killLatency: ts.exited != null && ts.killRequested != null ? ts.exited - ts.killRequested : undefined,
  };
}

export class ManagedProcess implements IManagedProcess {
  private _tailers: LogFileTailer[] = [];
  private _lineEmitter = new EventEmitter();
  private _timestamps: ProcessTimestamps;
  readonly bus: ProcessOutputBus;

  constructor(
    private readonly _proc: ChildProcessLike,
    bus: ProcessOutputBus,
    logSources: LogSourceConfig[],
    timestamps: ProcessTimestamps,
    private readonly _spawner?: IProcessSpawner,
    private readonly _platform?: string,
  ) {
    this.bus = bus;
    this._timestamps = timestamps;

    // Wire the bus line callback → internal emitter
    bus.setLineCallback((line: string, source: OutputSource) => {
      this._lineEmitter.emit('line', line, source);
    });

    // Track first output as "running" timestamp
    const markRunning = () => {
      if (this._timestamps.running == null) {
        this._timestamps.running = performance.now();
      }
    };

    // Auto-wire stdout/stderr → bus with typed sources
    _proc.stdout?.on('data', (data: Buffer) => {
      markRunning();
      bus.feed(data.toString(), OutputSources.stdout);
    });
    _proc.stderr?.on('data', (data: Buffer) => {
      markRunning();
      bus.feed(data.toString(), OutputSources.stderr);
    });

    // Start log tailers (ensure directories exist first)
    const pid = _proc.pid;
    for (const src of logSources) {
      if (src.type === 'directory') {
        try { fs.mkdirSync(src.path, { recursive: true }); } catch { /* best-effort */ }
      }
      // Thread PID to directory-mode tailers so they pick only the current process's log
      const srcWithPid = (src.type === 'directory' && pid) ? { ...src, pid } : src;
      const tailer = new LogFileTailer(srcWithPid, bus);
      tailer.start();
      this._tailers.push(tailer);
    }

    // Auto-cleanup on exit AND error
    const cleanup = () => {
      for (const t of this._tailers) { t.stop(); }
    };

    _proc.on('exit', (code: number | null, _signal: string | null) => {
      this._timestamps.exited = performance.now();
      if (this._timestamps.killRequested != null) {
        this._timestamps.killed = this._timestamps.exited;
      }
      log.debug('Process exited', { pid: this.pid, code });
      cleanup();
    });

    _proc.on('error', (err: Error) => {
      if (this._timestamps.exited == null) {
        this._timestamps.exited = performance.now();
      }
      log.debug('Process error', { pid: this.pid, error: err.message });
      cleanup();
    });
  }

  get pid(): number | undefined { return this._proc.pid; }
  get exitCode(): number | null { return this._proc.exitCode; }
  get killed(): boolean { return this._proc.killed; }

  get timestamps(): Readonly<ProcessTimestamps> { return this._timestamps; }

  get durations(): ProcessDurations {
    return computeDurations(this._timestamps);
  }

  diagnostics(): ProcessDiagnostics {
    return {
      pid: this.pid,
      exitCode: this.exitCode,
      killed: this.killed,
      timestamps: { ...this._timestamps },
      durations: this.durations,
      handlerNames: this.bus.getHandlerNames(),
      busMetrics: this.bus.getMetrics(),
      tailerMetrics: this._tailers.map(t => t.getMetrics()),
    };
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this._timestamps.killRequested = performance.now();

    // Platform-aware kill: Windows ignores SIGTERM — use taskkill for process tree kill
    if (this._platform === 'win32' && this._spawner && this._proc.pid) {
      try {
        this._spawner.spawn('taskkill', ['/pid', String(this._proc.pid), '/f', '/t'], { shell: true });
        return true;
      } catch { return false; }
    }

    const result = this._proc.kill(signal);

    // Unix: escalate to SIGKILL after 5s if SIGTERM doesn't work
    if (this._platform !== 'win32' && signal !== 'SIGKILL') {
      setTimeout(() => { try { this._proc.kill('SIGKILL'); } catch { /* ignore */ } }, 5000);
    }
    return result;
  }

  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'line', listener: (line: string, source: OutputSource) => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    if (event === 'line') {
      this._lineEmitter.on('line', listener);
    } else {
      this._proc.on(event, listener);
    }
    return this;
  }
}
