/**
 * @fileoverview Process monitoring for job execution tracking.
 * 
 * This module provides OS-level process monitoring to track processes
 * spawned by jobs and display resource usage in the UI.
 * 
 * @module process/processMonitor
 */

import * as os from 'os';
import { ProcessInfo, ProcessNode } from '../types';
import { IProcessMonitor } from '../interfaces/IProcessMonitor';
import type { IProcessSpawner } from '../interfaces/IProcessSpawner';
import { execCommand } from './processHelpers';

/**
 * Process monitor implementation supporting Windows and Unix systems.
 * 
 * Uses platform-specific commands:
 * - Windows: PowerShell with Get-CimInstance
 * - Unix: ps command
 * 
 * @example
 * ```typescript
 * const monitor = new ProcessMonitor(spawner);
 * const snapshot = await monitor.getSnapshot();
 * const tree = monitor.buildTree([1234, 5678], snapshot);
 * ```
 */
export class ProcessMonitor implements IProcessMonitor {
  /** Cache for process snapshots */
  private snapshotCache: ProcessInfo[] = [];
  /** Timestamp of last snapshot */
  private lastSnapshotTime = 0;
  /** Cache TTL in milliseconds */
  private readonly cacheTtlMs: number;
  /** Track consecutive errors to avoid spam */
  private consecutiveErrors = 0;
  /** Timestamp of last error */
  private lastErrorTime = 0;
  /** Error throttle cooldown in ms */
  private readonly errorCooldownMs = 30000;
  /** Process spawner for executing commands */
  private readonly spawner: IProcessSpawner;
  
  /**
   * Create a new ProcessMonitor.
   * @param spawner - Process spawner for command execution
   * @param cacheTtlMs - How long to cache snapshots (default: 2000ms)
   */
  constructor(spawner: IProcessSpawner, cacheTtlMs = 2000) {
    this.spawner = spawner;
    this.cacheTtlMs = cacheTtlMs;
  }
  
  /**
   * Get a snapshot of all running processes.
   * Results are cached to reduce overhead.
   */
  async getSnapshot(): Promise<ProcessInfo[]> {
    const now = Date.now();
    
    // Return cached snapshot if still valid
    if (now - this.lastSnapshotTime < this.cacheTtlMs && this.snapshotCache.length > 0) {
      return this.snapshotCache;
    }
    
    // If we've had consecutive errors, back off to avoid spam
    if (this.consecutiveErrors > 0 && now - this.lastErrorTime < this.errorCooldownMs) {
      return this.snapshotCache; // Return stale cache
    }
    
    try {
      // Collect fresh snapshot
      const snapshot = process.platform === 'win32' 
        ? await this.getWindowsProcesses()
        : await this.getUnixProcesses();
      
      this.snapshotCache = snapshot;
      this.lastSnapshotTime = now;
      this.consecutiveErrors = 0; // Reset on success
      
      return snapshot;
    } catch (e) {
      this.consecutiveErrors++;
      this.lastErrorTime = now;
      
      // Only log first few errors to avoid spam
      if (this.consecutiveErrors <= 3) {
        console.error('Failed to get process snapshot:', e);
      } else if (this.consecutiveErrors === 4) {
        console.error('Process monitor: suppressing further errors for 30s');
      }
      
      return this.snapshotCache; // Return stale cache
    }
  }
  
  /**
   * Build a hierarchical process tree from root PIDs.
   * 
   * @param rootPids - PIDs to use as tree roots
   * @param snapshot - Process snapshot to build from
   * @returns Array of process trees
   */
  buildTree(rootPids: number[], snapshot: ProcessInfo[]): ProcessNode[] {
    if (!rootPids || rootPids.length === 0 || !snapshot || snapshot.length === 0) {
      return [];
    }
    
    // Build process map for O(1) lookup
    const processMap = new Map<number, ProcessInfo>();
    for (const proc of snapshot) {
      processMap.set(proc.pid, proc);
    }
    
    // Find all legitimate descendants using BFS
    // This prevents PID reuse issues where old processes coincidentally
    // have a parent PID matching our current processes
    const descendants = new Set<number>(rootPids);
    let foundNew = true;
    let iterations = 0;
    const maxIterations = 20;
    
    while (foundNew && iterations < maxIterations) {
      foundNew = false;
      iterations++;
      
      for (const [childPid, childProc] of processMap.entries()) {
        if (!descendants.has(childPid) && 
            descendants.has(childProc.parentPid) && 
            childPid !== childProc.parentPid) {
          descendants.add(childPid);
          foundNew = true;
        }
      }
    }
    
    // Build tree recursively
    const buildNode = (pid: number, depth = 0): ProcessNode | null => {
      const proc = processMap.get(pid);
      if (!proc || depth > 10) {return null;}
      
      const children: ProcessNode[] = [];
      for (const [childPid, childProc] of processMap.entries()) {
        if (descendants.has(childPid) && 
            childProc.parentPid === pid && 
            childPid !== pid) {
          const childNode = buildNode(childPid, depth + 1);
          if (childNode) {
            children.push(childNode);
          }
        }
      }
      
      return {
        ...proc,
        children: children.length > 0 ? children : undefined
      };
    };
    
    // Build tree for each root
    const results: ProcessNode[] = [];
    for (const rootPid of rootPids) {
      const tree = buildNode(rootPid);
      if (tree) {
        results.push(tree);
      }
    }
    
    return results;
  }
  
  /**
   * Check if a process is currently running.
   * Uses signal 0 which checks existence without killing.
   */
  isRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Terminate a process and its descendants.
   */
  async terminate(pid: number, force = false): Promise<void> {
    if (process.platform === 'win32') {
      await this.terminateWindows(pid, force);
    } else {
      await this.terminateUnix(pid, force);
    }
  }
  
  /**
   * Get processes on Windows using PowerShell.
   */
  private async getWindowsProcesses(): Promise<ProcessInfo[]> {
    try {
      // Combined CIM query for efficiency - run asynchronously to avoid blocking
      const psCommand = `$procs = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,CreationDate,ThreadCount,HandleCount,Priority,ExecutablePath; $perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Select-Object IDProcess,PercentProcessorTime; $cpuMap = @{}; foreach ($p in $perf) { if ($p.IDProcess) { $cpuMap[$p.IDProcess] = $p.PercentProcessorTime } }; $result = @(); foreach ($proc in $procs) { $result += @{ ProcessId = $proc.ProcessId; ParentProcessId = $proc.ParentProcessId; Name = $proc.Name; CommandLine = $proc.CommandLine; WorkingSetSize = $proc.WorkingSetSize; CPU = if ($cpuMap.ContainsKey($proc.ProcessId)) { $cpuMap[$proc.ProcessId] } else { 0 }; CreationDate = if ($proc.CreationDate) { $proc.CreationDate.ToString('o') } else { $null }; ThreadCount = $proc.ThreadCount; HandleCount = $proc.HandleCount; Priority = $proc.Priority; ExecutablePath = $proc.ExecutablePath } }; $result | ConvertTo-Json`;
      
      // Increased timeout to 15s for high-load scenarios (many parallel jobs)
      const output = await execCommand(this.spawner, 'powershell', ['-NoProfile', '-Command', psCommand], 15000);
      
      const data = JSON.parse(output);
      const procs = Array.isArray(data) ? data : [data];
      const coreCount = os.cpus().length || 1;
      
      return procs.map(p => ({
        pid: p.ProcessId || 0,
        parentPid: p.ParentProcessId || 0,
        name: p.Name || 'unknown',
        commandLine: p.CommandLine || undefined,
        cpu: Math.round((p.CPU || 0) / coreCount * 10) / 10,
        memory: p.WorkingSetSize || 0,
        threadCount: p.ThreadCount || undefined,
        handleCount: p.HandleCount || undefined,
        priority: p.Priority || undefined,
        creationDate: p.CreationDate || undefined,
        executablePath: p.ExecutablePath || undefined
      }));
    } catch (e) {
      console.error('Failed to get Windows processes:', e);
      return [];
    }
  }
  
  /**
   * Get processes on Unix using ps command.
   */
  private async getUnixProcesses(): Promise<ProcessInfo[]> {
    try {
      const output = await execCommand(this.spawner, 'ps', ['-eo', 'pid,ppid,%cpu,rss,comm,args'], 3000);
      
      const lines = output.trim().split('\n').slice(1); // Skip header
      const processes: ProcessInfo[] = [];
      
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) {continue;}
        
        const pid = parseInt(parts[0], 10);
        const parentPid = parseInt(parts[1], 10);
        const cpu = parseFloat(parts[2]) || 0;
        const memoryKb = parseInt(parts[3], 10) || 0;
        const name = parts[4];
        const commandLine = parts.slice(5).join(' ');
        
        processes.push({
          pid,
          parentPid,
          name,
          commandLine: commandLine || undefined,
          cpu,
          memory: memoryKb * 1024 // Convert KB to bytes
        });
      }
      
      return processes;
    } catch (e) {
      console.error('Failed to get Unix processes:', e);
      return [];
    }
  }
  
  /**
   * Terminate a process tree on Windows.
   */
  private async terminateWindows(pid: number, force: boolean): Promise<void> {
    try {
      const args = force ? ['/F', '/T', '/PID', String(pid)] : ['/T', '/PID', String(pid)];
      await execCommand(this.spawner, 'taskkill', args, 5000);
    } catch (e) {
      console.error(`Failed to terminate Windows process ${pid}:`, e);
    }
  }
  
  /**
   * Terminate a process tree on Unix.
   */
  private async terminateUnix(pid: number, force: boolean): Promise<void> {
    try {
      // Get all descendant PIDs asynchronously
      let childPids: number[] = [];
      try {
        const result = await execCommand(this.spawner, 'pgrep', ['-P', String(pid)], 2000);
        childPids = result.trim().split('\n').filter(p => p).map(p => parseInt(p, 10));
      } catch {
        // pgrep returns non-zero if no children found
      }
      
      // Terminate children first
      for (const childPid of childPids) {
        await this.terminateUnix(childPid, force);
      }
      
      // Terminate the process itself
      const signal = force ? 'SIGKILL' : 'SIGTERM';
      process.kill(pid, signal);
    } catch (e) {
      // Process may already be dead
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
        console.error(`Failed to terminate Unix process ${pid}:`, e);
      }
    }
  }
}

