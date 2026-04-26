/**
 * @fileoverview .NET Daemon Lifecycle Manager
 *
 * Manages the AiOrchestrator .NET daemon child process. The daemon provides
 * the execution engine when experimental.useDotNetEngine is enabled.
 *
 * @module core/dotnetDaemonManager
 */

import * as path from 'path';
import * as net from 'net';
import { ChildProcess, spawn } from 'child_process';
import type { IDotNetDaemonManager, DaemonStatus } from '../interfaces/IDotNetDaemonManager';
import { Logger } from './logger';

const log = Logger.for('dotnet-daemon');

/** Max restart attempts before giving up. */
const MAX_RESTARTS = 3;
/** Timeout waiting for daemon pipe to become connectable. */
const READY_TIMEOUT_MS = 15_000;
/** Cooldown between restart attempts. */
const RESTART_DELAY_MS = 2_000;

export class DotNetDaemonManager implements IDotNetDaemonManager {
  private process: ChildProcess | null = null;
  private _pipeName: string | undefined;
  private _isRunning = false;
  private _lastError: string | undefined;
  private _startedAt: number | undefined;
  private restartCount = 0;
  private disposed = false;

  constructor(
    private readonly extensionPath: string,
    private readonly workspaceId: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this._pipeName = this.buildPipeName();
  }

  get isRunning(): boolean { return this._isRunning; }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('DaemonManager is disposed');
    if (this._isRunning) return;

    const binaryPath = this.resolveBinaryPath();
    log.info('Starting .NET daemon', { binaryPath, pipeName: this._pipeName });

    try {
      this.process = spawn(binaryPath, [
        'daemon', 'start',
        '--pipe-name', this._pipeName!,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          AIO_PIPE_NAME: this._pipeName,
          AIO_WORKSPACE_ID: this.workspaceId,
        },
        detached: false,
      });

      this.process.stdout?.on('data', (data: Buffer) => {
        log.debug(`[daemon stdout] ${data.toString().trim()}`);
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        log.warn(`[daemon stderr] ${data.toString().trim()}`);
      });

      this.process.on('exit', (code, signal) => {
        this._isRunning = false;
        log.info('Daemon exited', { code, signal });
        if (!this.disposed && code !== 0 && this.restartCount < MAX_RESTARTS) {
          this.restartCount++;
          log.warn(`Daemon crashed, restarting (attempt ${this.restartCount}/${MAX_RESTARTS})`);
          setTimeout(() => this.start().catch(e => {
            this._lastError = e instanceof Error ? e.message : String(e);
            log.error('Daemon restart failed', { error: this._lastError });
          }), RESTART_DELAY_MS);
        }
      });

      // Wait for pipe to become connectable
      await this.waitForReady();
      this._isRunning = true;
      this._startedAt = Date.now();
      this.restartCount = 0;
      this._lastError = undefined;
      log.info('Daemon is ready', { pid: this.process.pid });
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      log.error('Failed to start daemon', { error: this._lastError });
      this.killProcess();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.process || !this._isRunning) return;
    log.info('Stopping daemon', { pid: this.process.pid });

    // Send SIGTERM and wait up to 5s for graceful shutdown
    this.process.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.killProcess();
        resolve();
      }, 5_000);
      this.process!.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this._isRunning = false;
    this.process = null;
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  getStatus(): DaemonStatus {
    return {
      running: this._isRunning,
      pid: this.process?.pid,
      pipeName: this._pipeName,
      uptimeSeconds: this._startedAt ? Math.floor((Date.now() - this._startedAt) / 1000) : undefined,
      lastError: this._lastError,
    };
  }

  getPipeName(): string | undefined {
    return this._pipeName;
  }

  dispose(): void {
    this.disposed = true;
    this.killProcess();
  }

  private killProcess(): void {
    if (this.process) {
      try { this.process.kill('SIGKILL'); } catch { /* already dead */ }
      this.process = null;
      this._isRunning = false;
    }
  }

  private resolveBinaryPath(): string {
    const platformDir = this.platform === 'win32' ? 'win-x64'
      : this.platform === 'darwin' ? 'osx-x64'
      : 'linux-x64';
    const exe = this.platform === 'win32' ? 'aio.exe' : 'aio';
    return path.join(this.extensionPath, 'dotnet-bin', platformDir, exe);
  }

  private buildPipeName(): string {
    // Short deterministic name from workspace ID
    const hash = this.workspaceId.slice(0, 12);
    return this.platform === 'win32'
      ? `\\\\.\\pipe\\aio-daemon-${hash}`
      : `/tmp/aio-daemon-${hash}.sock`;
  }

  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + READY_TIMEOUT_MS;

      const tryConnect = () => {
        if (Date.now() > deadline) {
          reject(new Error(`Daemon did not become ready within ${READY_TIMEOUT_MS}ms`));
          return;
        }

        const client = net.connect(this._pipeName!);

        client.on('connect', () => {
          client.destroy();
          resolve();
        });

        client.on('error', () => {
          client.destroy();
          setTimeout(tryConnect, 200);
        });
      };

      // Give the process a moment to start
      setTimeout(tryConnect, 500);
    });
  }
}
