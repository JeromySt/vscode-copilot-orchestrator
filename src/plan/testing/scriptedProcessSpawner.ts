/**
 * @fileoverview Scripted process spawner for deterministic integration testing.
 *
 * Replaces {@link DefaultProcessSpawner} via DI and plays back pre-recorded
 * scripts for each process invocation. Stdout/stderr lines are drip-fed on
 * timers to exercise the full process output bus, handler registry, and
 * managed process lifecycle with controlled, predictable output.
 *
 * @module plan/testing/scriptedProcessSpawner
 */

import { EventEmitter } from 'events';
import type { SpawnOptions } from 'child_process';
import type { IProcessSpawner, ChildProcessLike } from '../../interfaces/IProcessSpawner';
import type { ProcessScript, ScriptMatchCriteria } from './processScripts';
import { Logger } from '../../core/logger';

const log = Logger.for('plan');

/**
 * A fake child process that emits scripted stdout/stderr lines over time.
 *
 * Conforms to the {@link ChildProcessLike} interface so it can be returned
 * from {@link IProcessSpawner.spawn} and wired into managed processes.
 */
export class FakeChildProcess extends EventEmitter implements ChildProcessLike {
  /** Use the current process PID so the liveness watchdog doesn't kill us. */
  readonly pid = process.pid;
  exitCode: number | null = null;
  killed = false;
  readonly stdout: EventEmitter & NodeJS.ReadableStream;
  readonly stderr: EventEmitter & NodeJS.ReadableStream;

  /** Checkpoint manifest to write after process exits (set by spawner from script). */
  checkpointManifest?: Record<string, unknown>;

  /** Log-file entries to write to disk (set by spawner from script). */
  logFiles?: import('./processScripts').LogFileScript[];

  private _timers: ReturnType<typeof setTimeout>[] = [];

  constructor() {
    super();
    // Create stdout/stderr as EventEmitters with setEncoding stub
    // (workPhase.ts calls proc.stdout.setEncoding('utf8'))
    const makeStream = (): EventEmitter & NodeJS.ReadableStream => {
      const emitter = new EventEmitter() as any;
      emitter.setEncoding = () => emitter;
      emitter.read = () => null;
      emitter.readable = true;
      emitter.destroy = () => emitter;
      emitter.pipe = () => emitter;
      emitter.unpipe = () => emitter;
      emitter.resume = () => emitter;
      emitter.pause = () => emitter;
      emitter.wrap = () => emitter;
      emitter[Symbol.asyncIterator] = () => ({ next: () => Promise.resolve({ done: true, value: undefined }) });
      return emitter;
    };
    this.stdout = makeStream();
    this.stderr = makeStream();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    // Clean up pending timers
    for (const t of this._timers) { clearTimeout(t); }
    this._timers = [];
    this.exitCode = signal ? 1 : 0;
    this.emit('exit', this.exitCode, signal ? String(signal) : null);
    this.emit('close', this.exitCode, signal ? String(signal) : null);
    return true;
  }

  /** Schedule a timer and track it for cleanup on kill(). */
  _schedule(fn: () => void, delayMs: number): void {
    const t = setTimeout(fn, delayMs);
    this._timers.push(t);
  }
}

/**
 * Determines if a spawn() call matches a script's criteria.
 */
function matchesCriteria(
  criteria: ScriptMatchCriteria,
  command: string,
  args: string[],
  options: SpawnOptions,
): boolean {
  if (criteria.command) {
    if (criteria.command instanceof RegExp) {
      if (!criteria.command.test(command)) { return false; }
    } else {
      if (!command.includes(criteria.command)) { return false; }
    }
  }

  if (criteria.argsContain) {
    // Search command string, args, AND any referenced instructions files.
    const searchSpace = command + ' ' + args.join(' ');
    if (!searchSpace.includes(criteria.argsContain)) {
      // Check if any arg references an instructions file — read its content
      let foundInFile = false;
      const fs = require('fs');
      for (const arg of args) {
        if (arg.includes('.instructions.md') || arg.includes('.md')) {
          // Extract file path from the arg (may be wrapped in a sentence)
          const pathMatch = arg.match(/([a-zA-Z]:\\[^\s"]+\.md|\/[^\s"]+\.md)/);
          if (pathMatch) {
            try {
              const fileContent = fs.readFileSync(pathMatch[1], 'utf-8');
              if (fileContent.includes(criteria.argsContain)) {
                foundInFile = true;
                break;
              }
            } catch (err: any) {
              // Log file read failures for diagnosis
              log.warn('Script match: failed to read instructions file', { path: pathMatch[1], error: err.message });
            }
          }
        }
      }
      if (!foundInFile) { return false; }
    }
  }

  if (criteria.cwdContain && options.cwd) {
    const cwd = typeof options.cwd === 'string' ? options.cwd : options.cwd.toString();
    if (!cwd.includes(criteria.cwdContain)) { return false; }
  }

  return true;
}

/**
 * Play back a script's stdout/stderr/logFile lines on a FakeChildProcess.
 * Lines are emitted as 'data' events on the respective streams with
 * controlled timing. Log files are written to disk so the LogFileTailer
 * can feed them to handlers (e.g., ContextPressureHandler).
 *
 * @param proc - The fake process to play the script on
 * @param script - The script to play
 * @param cwd - Working directory from spawn() options
 * @param command - Full command string (used to parse --log-dir)
 * @param args - Command arguments (used to parse --log-dir)
 */
function playScript(proc: FakeChildProcess, script: ProcessScript, cwd?: string, command?: string, args?: string[]): void {
  let elapsed = 0;

  // Schedule stdout lines
  for (const line of script.stdout) {
    const delay = line.delayMs ?? 0;
    elapsed += delay;
    const capturedElapsed = elapsed;
    proc._schedule(() => {
      if (!proc.killed) {
        proc.stdout.emit('data', Buffer.from(line.text + '\n'));
      }
    }, capturedElapsed);
  }

  // Schedule stderr lines
  if (script.stderr) {
    let serrElapsed = 0;
    for (const line of script.stderr) {
      const delay = line.delayMs ?? 0;
      serrElapsed += delay;
      const capturedElapsed = serrElapsed;
      proc._schedule(() => {
        if (!proc.killed) {
          proc.stderr.emit('data', Buffer.from(line.text + '\n'));
        }
      }, capturedElapsed);
    }
    elapsed = Math.max(elapsed, serrElapsed);
  }

  // Schedule log-file writes to disk (for LogFileTailer → ContextPressureHandler).
  // Parse --log-dir from the command to write to the SAME directory the
  // ManagedProcessFactory's LogFileTailer is watching.
  if (script.logFiles && cwd) {
    const fs = require('fs');
    const path = require('path');
    
    // Extract --log-dir from command/args (the real CLI writes logs there)
    let logDir: string | undefined;
    const fullCmd = [command || '', ...(args || [])].join(' ');
    const logDirMatch = fullCmd.match(/--log-dir\s+"?([^"\s]+)"?/);
    if (logDirMatch) {
      logDir = logDirMatch[1];
    }
    // Fallback: same default as CopilotCliRunner
    if (!logDir) {
      logDir = path.join(cwd, '.orchestrator', '.copilot-cli', 'logs');
    }
    
    try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* best-effort */ }
    for (const logFile of script.logFiles) {
      const filePath = path.join(logDir, logFile.relativePath);
      let logElapsed = 0;
      for (const line of logFile.lines) {
        const delay = line.delayMs ?? 0;
        logElapsed += delay;
        const capturedElapsed = logElapsed;
        const capturedText = line.text;
        proc._schedule(() => {
          if (!proc.killed) {
            try { fs.appendFileSync(filePath, capturedText + '\n'); } catch { /* best-effort */ }
          }
        }, capturedElapsed);
      }
    }
  }

  // Write checkpoint manifest before exit if specified
  if (script.checkpointManifest && cwd) {
    const fs = require('fs');
    const path = require('path');
    const manifestDelay = elapsed + (script.exitDelayMs ? script.exitDelayMs / 2 : 50);
    proc._schedule(() => {
      if (!proc.killed) {
        try {
          const orchDir = path.join(cwd, '.orchestrator');
          fs.mkdirSync(orchDir, { recursive: true });
          fs.writeFileSync(path.join(orchDir, 'checkpoint-manifest.json'),
            JSON.stringify(script.checkpointManifest, null, 2));
        } catch { /* best-effort */ }
      }
    }, manifestDelay);
  }

  // Schedule process exit
  const exitDelay = elapsed + (script.exitDelayMs ?? 100);
  proc._schedule(() => {
    if (!proc.killed) {
      proc.exitCode = script.exitCode;
      if (script.signal) {
        proc.emit('exit', null, script.signal);
        proc.emit('close', null, script.signal);
      } else {
        proc.emit('exit', script.exitCode, null);
        proc.emit('close', script.exitCode, null);
      }
    }
  }, exitDelay);
}

/**
 * Process spawner that replays scripted output instead of running real processes.
 *
 * Register scripts before use. When {@link spawn} is called, the spawner
 * finds the first matching script and creates a {@link FakeChildProcess}
 * that replays its stdout/stderr output on timers.
 *
 * Use this to replace `IProcessSpawner` in the DI container for integration
 * testing of the full plan execution pipeline.
 *
 * @example
 * ```typescript
 * const spawner = new ScriptedProcessSpawner();
 * spawner.addScript(successfulAgentScript('my-job', { cwdContain: 'my-job' }));
 * // Register in DI container to replace DefaultProcessSpawner
 * ```
 */
export class ScriptedProcessSpawner implements IProcessSpawner {
  private _scripts: ProcessScript[] = [];
  private readonly _spawnLog: Array<{ command: string; args: string[]; cwd?: string; matched: string | null }> = [];
  private _defaultExitCode = 0;

  /**
   * Register a script to be played when a matching spawn() call occurs.
   * Scripts are matched in registration order; first match wins.
   */
  addScript(script: ProcessScript): void {
    this._scripts.push(script);
  }

  /**
   * Register multiple scripts at once.
   */
  addScripts(scripts: ProcessScript[]): void {
    for (const s of scripts) { this._scripts.push(s); }
  }

  /**
   * Set the default exit code for unmatched spawn() calls.
   * Default: 0. Set to 1 to make unmatched calls fail.
   */
  setDefaultExitCode(code: number): void {
    this._defaultExitCode = code;
  }

  /**
   * Spawn a fake process that replays a matching script.
   *
   * If no script matches, returns a process that immediately exits
   * with the default exit code and empty output.
   */
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcessLike {
    const proc = new FakeChildProcess();

    // Find matching script
    const scriptIndex = this._scripts.findIndex(s => matchesCriteria(s.match, command, args, options));

    if (scriptIndex >= 0) {
      const script = this._scripts[scriptIndex];
      log.info(`Matched script: ${script.label}`, { command, args: args.slice(0, 3) });
      this._spawnLog.push({
        command,
        args,
        cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
        matched: script.label,
      });

      // Remove consumeOnce scripts after matching
      if (script.consumeOnce) {
        this._scripts.splice(scriptIndex, 1);
      }

      // Attach checkpoint manifest metadata for ScriptedCopilotRunner to write
      if (script.checkpointManifest) {
        proc.checkpointManifest = script.checkpointManifest;
      }

      // Attach log-file entries for backward compat (ScriptedCopilotRunner)
      if (script.logFiles) {
        proc.logFiles = script.logFiles;
      }

      const spawnCwd = typeof options.cwd === 'string' ? options.cwd : undefined;
      playScript(proc, script, spawnCwd, command, args);
    } else {
      log.warn(`No matching script for spawn`, { command, args: args.slice(0, 3) });
      this._spawnLog.push({
        command,
        args,
        cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
        matched: null,
      });

      // Default: immediate exit with empty output
      proc._schedule(() => {
        proc.exitCode = this._defaultExitCode;
        proc.emit('exit', this._defaultExitCode, null);
        proc.emit('close', this._defaultExitCode, null);
      }, 50);
    }

    return proc;
  }

  /**
   * Get the log of all spawn() calls and which scripts they matched.
   * Useful for test assertions.
   */
  getSpawnLog(): ReadonlyArray<{ command: string; args: string[]; cwd?: string; matched: string | null }> {
    return this._spawnLog;
  }

  /**
   * Get the count of remaining (unconsumed) scripts.
   */
  getRemainingScriptCount(): number {
    return this._scripts.length;
  }

  /**
   * Clear all scripts and reset the spawn log.
   */
  reset(): void {
    this._scripts = [];
    this._spawnLog.length = 0;
  }
}
