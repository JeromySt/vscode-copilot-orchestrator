/**
 * @fileoverview Power management system to prevent system sleep during plan execution.
 * 
 * Provides cross-platform functionality to prevent system sleep, hibernate, or display
 * sleep while plans are running. Uses platform-specific APIs:
 * - Windows: SetThreadExecutionState via PowerShell
 * - macOS: caffeinate command
 * - Linux: systemd-inhibit or fallback methods
 * 
 * @example
 * ```typescript
 * import { powerManager } from './core/powerManager';
 * 
 * // Acquire wake lock
 * const release = await powerManager.acquireWakeLock('Plan execution');
 * try {
 *   await executePlan();
 * } finally {
 *   release();
 * }
 * ```
 * 
 * @module core/powerManager
 */

import * as os from 'os';
import { Logger } from './logger';
import type { IProcessSpawner, ChildProcessLike } from '../interfaces/IProcessSpawner';

const log = Logger.for('extension');

/**
 * Power management interface for preventing system sleep
 * 
 * Provides a cross-platform API for acquiring and releasing wake locks
 * that prevent the system from entering sleep or hibernation states.
 */
export interface PowerManager {
  /**
   * Acquire a wake lock to prevent system sleep.
   * 
   * Platform-specific behavior:
   * - **Windows**: Uses `SetThreadExecutionState` API via PowerShell
   * - **macOS**: Uses `caffeinate` command with -dims flags
   * - **Linux**: Uses `systemd-inhibit` or falls back to `xdg-screensaver`
   * 
   * Multiple locks can be held simultaneously; the system will only sleep
   * when all locks have been released.
   * 
   * @param reason Human-readable reason for acquiring the wake lock (e.g., "Plan execution")
   * @returns Promise that resolves to a cleanup function. Call the function to release the lock.
   *          If acquisition fails, returns a no-op function to allow graceful degradation.
   * 
   * @example
   * ```typescript
   * const release = await powerManager.acquireWakeLock('Long-running plan');
   * try {
   *   await executeLongRunningPlan();
   * } finally {
   *   release();
   * }
   * ```
   */
  acquireWakeLock(reason: string): Promise<() => void>;
  
  /**
   * Check if any wake locks are currently active.
   * 
   * @returns true if one or more locks are held, false if all have been released
   */
  isWakeLockActive(): boolean;
  
  /**
   * Release all active wake locks immediately.
   * 
   * This terminates all platform-specific processes and clears the lock registry.
   * Called automatically on process exit and termination signals.
   */
  releaseAll(): void;
}

/**
 * Implementation of power management for different platforms.
 * 
 * Manages reference-counted wake locks using platform-specific mechanisms
 * to prevent system sleep. Each acquired lock returns an individual cleanup
 * function; the system only sleeps when all locks are released.
 * 
 * On unsupported platforms, acquireWakeLock returns a no-op function to
 * ensure graceful degradation.
 */
export class PowerManagerImpl implements PowerManager {
  private activeLocks: Map<string, ChildProcessLike | (() => void)> = new Map();
  private lockIdCounter = 0;
  private spawner: IProcessSpawner;

  constructor(spawner: IProcessSpawner) {
    this.spawner = spawner;
  }

  /**
   * Acquire a wake lock to prevent system sleep
   * @param reason Human-readable reason for the wake lock
   * @returns Promise that resolves to a cleanup function
   */
  async acquireWakeLock(reason: string): Promise<() => void> {
    const lockId = `lock-${++this.lockIdCounter}`;
    
    try {
      const platform = os.platform();
      let cleanup: ChildProcessLike | (() => void);

      switch (platform) {
        case 'win32':
          cleanup = await this.preventSleepWindows(reason);
          break;
        case 'darwin':
          cleanup = await this.preventSleepMac(reason);
          break;
        case 'linux':
          cleanup = await this.preventSleepLinux(reason);
          break;
        default:
          log.warn(`Power management not supported on platform: ${platform}`);
          return () => {}; // No-op cleanup
      }

      this.activeLocks.set(lockId, cleanup);
      log.info(`Wake lock acquired: ${lockId} (${reason})`);

      return () => {
        this.releaseLock(lockId);
      };
    } catch (error) {
      log.warn(`Failed to acquire wake lock: ${error instanceof Error ? error.message : String(error)}`);
      return () => {}; // No-op cleanup
    }
  }

  /**
   * Check if any wake locks are currently active
   */
  isWakeLockActive(): boolean {
    return this.activeLocks.size > 0;
  }

  /**
   * Release all active wake locks
   */
  releaseAll(): void {
    const lockIds = Array.from(this.activeLocks.keys());
    for (const lockId of lockIds) {
      this.releaseLock(lockId);
    }
  }

  /**
   * Release a specific wake lock
   */
  private releaseLock(lockId: string): void {
    const cleanup = this.activeLocks.get(lockId);
    if (!cleanup) {
      return;
    }

    try {
      if (typeof cleanup === 'function') {
        cleanup();
      } else if (cleanup && typeof cleanup.kill === 'function') {
        cleanup.kill();
      }
      this.activeLocks.delete(lockId);
      log.info(`Wake lock released: ${lockId}`);
    } catch (error) {
      log.warn(`Error releasing wake lock ${lockId}: ${error instanceof Error ? error.message : String(error)}`);
      this.activeLocks.delete(lockId);
    }
  }

  /**
   * Windows implementation using SetThreadExecutionState via PowerShell.
   * 
   * Uses the Windows SetThreadExecutionState API to inform the system that
   * the application is actively working. The flags prevent:
   * - ES_CONTINUOUS (0x80000000) — Notification remains active until explicitly cleared
   * - ES_SYSTEM_REQUIRED (0x00000001) — System should not enter sleep
   * - ES_DISPLAY_REQUIRED (0x00000002) — Display should not turn off
   * 
   * The state is re-asserted every 30 seconds to ensure the system remains
   * in the wake state even if there are long idle periods in the plan execution.
   * 
   * @param reason Human-readable reason (for logging)
   * @returns Promise resolving to the spawned PowerShell process; call process.kill() to release
   * @throws If PowerShell cannot be spawned or exits immediately
   * 
   * @platform Windows only
   */
  private async preventSleepWindows(reason: string): Promise<ChildProcessLike> {
    return new Promise((resolve, reject) => {
      // PowerShell script that continuously sets execution state to prevent sleep
      // ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001) | ES_DISPLAY_REQUIRED (0x00000002) = 0x80000003
      // Note: This prevents idle-triggered sleep but NOT policy-driven hibernation
      // (e.g., DevBox VMs with Azure-level hibernate policies). There is no user-level
      // API to override forced hibernation — configure the DevBox idle timeout in Azure portal.
      const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PowerUtil {
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
"@

# Keep setting execution state every 30 seconds
while ($true) {
    [PowerUtil]::SetThreadExecutionState(0x80000003) | Out-Null
    Start-Sleep -Seconds 30
}
`.trim();

      const proc = this.spawner.spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle', 'Hidden',
        '-Command', script
      ], {
        detached: false,
        stdio: 'ignore'
      }) as ChildProcessLike;

      proc.on('error', (error) => {
        log.warn(`Windows power management process error: ${error.message}`);
        reject(error);
      });

      // Give it a moment to start
      setTimeout(() => {
        if (proc.exitCode === null) {
          resolve(proc);
        } else {
          reject(new Error('PowerShell process exited immediately'));
        }
      }, 500);
    });
  }

  /**
   * macOS implementation using caffeinate command.
   * 
   * Uses the caffeinate command with flags to prevent all sleep modes:
   * - -d: Prevent display sleep
   * - -i: Prevent idle sleep (also keeps system awake when not plugged in)
   * - -m: Prevent disk sleep
   * - -s: Prevent system sleep
   * 
   * The caffeinate process runs in the foreground and maintains the wake lock
   * until it is terminated.
   * 
   * @param reason Human-readable reason (for logging)
   * @returns Promise resolving to the spawned caffeinate process; call process.kill() to release
   * @throws If caffeinate is not available or exits immediately
   * 
   * @platform macOS only
   */
  private async preventSleepMac(reason: string): Promise<ChildProcessLike> {
    return new Promise((resolve, reject) => {
      // -d: prevent display sleep
      // -i: prevent idle sleep
      // -m: prevent disk sleep
      // -s: prevent system sleep
      const proc = this.spawner.spawn('caffeinate', ['-dims'], {
        detached: false,
        stdio: 'ignore'
      }) as ChildProcessLike;

      proc.on('error', (error) => {
        log.warn(`macOS caffeinate error: ${error.message}`);
        reject(error);
      });

      // Give it a moment to start
      setTimeout(() => {
        if (proc.exitCode === null) {
          log.debug(`caffeinate started for: ${reason}`);
          resolve(proc);
        } else {
          reject(new Error('caffeinate exited immediately'));
        }
      }, 100);
    });
  }

  /**
   * Linux implementation using systemd-inhibit.
   * 
   * Attempts to use systemd-inhibit to request a power management lock that
   * prevents idle sleep and system sleep:
   * - --what=idle:sleep: Inhibit both idle and sleep actions
   * - --who=Copilot Orchestrator: Identifies the lock holder
   * - --why: Provides the reason (visible in systemd logs)
   * 
   * If systemd-inhibit is not available or fails, falls back to
   * preventSleepLinuxFallback() which uses xdg-screensaver.
   * 
   * @param reason Human-readable reason (for logging and systemd)
   * @returns Promise resolving to the spawned systemd-inhibit process or fallback;
   *          call process.kill() to release
   * @throws Only if both systemd-inhibit and fallback methods fail
   * 
   * @platform Linux only (systemd systems)
   */
  private async preventSleepLinux(reason: string): Promise<ChildProcessLike> {
    return new Promise((resolve, reject) => {
      // Try systemd-inhibit first
      const proc = this.spawner.spawn('systemd-inhibit', [
        '--what=idle:sleep',
        '--who=Copilot Orchestrator',
        `--why=${reason}`,
        'sleep', 'infinity'
      ], {
        detached: false,
        stdio: 'ignore'
      }) as ChildProcessLike;

      proc.on('error', (error) => {
        log.warn(`Linux systemd-inhibit error: ${error.message}`);
        // Try fallback method
        this.preventSleepLinuxFallback(reason)
          .then(resolve)
          .catch(reject);
      });

      // Give it a moment to start
      setTimeout(() => {
        if (proc.exitCode === null) {
          log.debug(`systemd-inhibit started for: ${reason}`);
          resolve(proc);
        } else {
          // Try fallback
          this.preventSleepLinuxFallback(reason)
            .then(resolve)
            .catch(reject);
        }
      }, 100);
    });
  }

  /**
   * Linux fallback implementation using xdg-screensaver.
   * 
   * Used when systemd-inhibit is not available. Periodically resets the
   * X11 idle timer using xdg-screensaver, which prevents the screen from
   * turning off and (on most systems) prevents sleep.
   * 
   * The screensaver reset is called every 30 seconds in a loop. Errors are
   * silently ignored (e.g., if X11 is not available on a headless system).
   * 
   * @param reason Human-readable reason (for logging)
   * @returns Promise resolving to the spawned shell script process; call process.kill() to release
   * @throws Only if the shell process cannot be spawned
   * 
   * @platform Linux only (X11 systems); gracefully fails on headless/Wayland systems
   */
  private async preventSleepLinuxFallback(reason: string): Promise<ChildProcessLike> {
    return new Promise((resolve, reject) => {
      // Fallback: continuously reset idle timer using xdg-screensaver
      const script = `
while true; do
  xdg-screensaver reset 2>/dev/null || true
  sleep 30
done
`.trim();

      const proc = this.spawner.spawn('sh', ['-c', script], {
        detached: false,
        stdio: 'ignore'
      }) as ChildProcessLike;

      proc.on('error', (error) => {
        log.warn(`Linux fallback power management error: ${error.message}`);
        reject(error);
      });

      setTimeout(() => {
        if (proc.exitCode === null) {
          log.debug(`Linux fallback method started for: ${reason}`);
          resolve(proc);
        } else {
          reject(new Error('Linux fallback method failed to start'));
        }
      }, 100);
    });
  }
}
