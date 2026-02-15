/**
 * @fileoverview Unified Copilot CLI Runner — handles all Copilot CLI interactions.
 * @module agent/copilotCliRunner
 */

import * as fs from 'fs';
import * as path from 'path';
import { isCopilotCliAvailable } from './cliCheckCore';
import { CopilotStatsParser } from './copilotStatsParser';
import type { CopilotUsageMetrics } from '../plan/types';
import type { IProcessSpawner, ChildProcessLike } from '../interfaces/IProcessSpawner';
import type { IEnvironment } from '../interfaces/IEnvironment';

// ── Types ──────────────────────────────────────────────────────────────

/**
 * Options for running Copilot CLI.
 */
export interface CopilotRunOptions {
  /** The working directory (typically a worktree path) */
  cwd: string;
  /** The task/prompt to execute */
  task: string;
  /** Additional instructions or context */
  instructions?: string;
  /** Label for logging purposes */
  label?: string;
  /** Resume an existing session */
  sessionId?: string;
  /** LLM model to use (e.g., 'claude-sonnet-4.5', 'gpt-5') */
  model?: string;
  /** Directory for Copilot logs */
  logDir?: string;
  /** Path to write session share file */
  sharePath?: string;
  /** Callback for output lines */
  onOutput?: (line: string) => void;
  /** Callback when process is spawned */
  onProcess?: (proc: ChildProcessLike) => void;
  /** Timeout in milliseconds (default: 5 minutes) */
  timeout?: number;
  /** Skip writing instructions file (for simple one-off prompts) */
  skipInstructionsFile?: boolean;
  /** Unique job/node ID to disambiguate instructions files across concurrent jobs */
  jobId?: string;
  /** Custom config directory for Copilot CLI session isolation. */
  configDir?: string;
  /** Additional folders the agent is allowed to access (beyond cwd/worktree). Must be absolute paths. */
  allowedFolders?: string[];
  /** URLs or URL patterns the agent is allowed to access. Secure by default (none allowed). */
  allowedUrls?: string[];
  /** Maximum agent turns/iterations (e.g., 1 for single-turn augmentation calls). */
  maxTurns?: number;
}

/**
 * Result from running Copilot CLI.
 */
export interface CopilotRunResult {
  success: boolean;
  sessionId?: string;
  error?: string;
  exitCode?: number;
  /** Usage metrics parsed from Copilot CLI stdout (premium requests, tokens, model breakdown, etc.) */
  metrics?: CopilotUsageMetrics;
}

/** Logger interface for dependency injection. */
export interface CopilotCliLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

// ── Default Logger ─────────────────────────────────────────────────────

const noopLogger: CopilotCliLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** @internal Lazy-loaded process spawner for backward compatibility. Production code must inject via DI. */
function getFallbackSpawner(): IProcessSpawner {
  const mod = require('../interfaces/IProcessSpawner');
  return new mod.DefaultProcessSpawner();
}

/** @internal Inline environment fallback. Production code must inject via DI. */
const fallbackEnvironment: IEnvironment = {
  get env() { return process.env; },
  get platform() { return process.platform; },
  cwd() { return process.cwd(); },
};

// ── CopilotCliRunner ───────────────────────────────────────────────────

/** Unified runner for Copilot CLI operations. */
export class CopilotCliRunner {
  private logger: CopilotCliLogger;
  private spawner: IProcessSpawner;
  private environment: IEnvironment;
  
  constructor(logger?: CopilotCliLogger, spawner?: IProcessSpawner, environment?: IEnvironment) {
    this.logger = logger ?? noopLogger;
    this.spawner = spawner ?? getFallbackSpawner();
    this.environment = environment ?? fallbackEnvironment;
  }
  
  /**
   * Check if Copilot CLI is available.
   */
  isAvailable(): boolean {
    return isCopilotCliAvailable();
  }
  
  /**
   * Run Copilot CLI with the given options.
   */
  async run(options: CopilotRunOptions): Promise<CopilotRunResult> {
    const {
      cwd,
      task,
      instructions,
      label = 'copilot',
      sessionId,
      model,
      logDir,
      sharePath,
      onOutput,
      onProcess,
      timeout = 300000, // 5 minutes default
      skipInstructionsFile = false,
    } = options;
    
    // Check if Copilot CLI is available
    if (!this.isAvailable()) {
      this.logger.warn(`[${label}] Copilot CLI not available`);
      return { success: true }; // Silent success - work can be done manually
    }
    
    // Setup instructions file if not skipped
    let instructionsFile: string | undefined;
    let instructionsDir: string | undefined;
    
    if (!skipInstructionsFile) {
      const instructionsSetup = this.writeInstructionsFile(cwd, task, instructions, label, options.jobId);
      instructionsFile = instructionsSetup.filePath;
      instructionsDir = instructionsSetup.dirPath;
    }
    
    // Build the command
    const copilotCmd = this.buildCommand({
      task: skipInstructionsFile ? task : `Complete the task described in the instructions file at ${instructionsFile}.`,
      sessionId,
      model,
      logDir,
      sharePath,
      configDir: options.configDir,
      cwd,
      allowedFolders: options.allowedFolders,
      allowedUrls: options.allowedUrls,
      maxTurns: options.maxTurns,
    });
    
    this.logger.info(`[${label}] Running: ${copilotCmd.substring(0, 100)}...`);
    
    // Execute and return result
    try {
      const result = await this.execute({
        command: copilotCmd,
        cwd,
        label,
        sessionId,
        timeout,
        onOutput,
        onProcess,
      });
      
      return result;
    } finally {
      // Cleanup instructions file
      if (instructionsFile) {
        this.cleanupInstructionsFile(instructionsFile, instructionsDir, label);
      }
    }
  }
  
  /**
   * Write instructions to .github/instructions/ in the working directory.
   * Public so callers with custom execution needs can still use standardized instructions.
   */
  writeInstructionsFile(
    cwd: string,
    task: string,
    instructions: string | undefined,
    label: string,
    jobId?: string
  ): { filePath: string; dirPath: string } {
    const instructionsDir = path.join(cwd, '.github', 'instructions');
    const suffix = jobId ? `-${jobId.slice(0, 8)}` : '';
    const instructionsFile = path.join(instructionsDir, `orchestrator-job${suffix}.instructions.md`);
    
    // Get the worktree folder name for scoping
    const worktreeName = path.basename(cwd);
    const worktreeParent = path.basename(path.dirname(cwd));
    const applyToScope = `${worktreeParent}/${worktreeName}/**`;
    
    // Build instructions content with frontmatter
    const content = `---
applyTo: '${applyToScope}'
---

# Current Task

${task}

${instructions ? `## Additional Context\n\n${instructions}` : ''}

## Guidelines

- Focus only on the task described above
- Make minimal, targeted changes
- Follow existing code patterns and conventions in this repository
- Commit your changes when complete
`;
    
    try {
      fs.mkdirSync(instructionsDir, { recursive: true });
      fs.writeFileSync(instructionsFile, content, 'utf8');
      this.logger.info(`[${label}] Wrote instructions to: ${instructionsFile}`);
    } catch (e) {
      this.logger.warn(`[${label}] Failed to write instructions file: ${e}`);
    }
    
    return { filePath: instructionsFile, dirPath: instructionsDir };
  }
  
  /** Delegates to the standalone {@link sanitizeUrl} pure function. */
  sanitizeUrl(raw: string): string | null {
    return sanitizeUrl(raw, this.logger);
  }

  /** Delegates to the standalone {@link buildCommand} pure function. */
  buildCommand(options: BuildCommandOptions): string {
    return buildCommand(options, {
      logger: this.logger,
      fallbackCwd: this.environment.cwd(),
    });
  }
  
  /**
   * Execute the Copilot CLI command.
   */
  private execute(options: {
    command: string; cwd: string; label: string; sessionId?: string;
    timeout: number; onOutput?: (line: string) => void;
    onProcess?: (proc: ChildProcessLike) => void;
  }): Promise<CopilotRunResult> {
    const { command, cwd, label, sessionId, timeout, onOutput, onProcess } = options;
    
    return new Promise((resolve) => {
      // Clean environment: remove NODE_OPTIONS to avoid passing VS Code flags to CLI
      const cleanEnv = { ...this.environment.env };
      delete cleanEnv.NODE_OPTIONS;
      
      // Log the full invocation for diagnostics (to both logger AND onOutput for node log visibility)
      this.logger.info(`[${label}] Spawning: ${command}`);
      this.logger.info(`[${label}] CWD: ${cwd}`);
      const defaultKeyPrefixes = ['PATH', 'SYSTEM', 'WIN', 'COM', 'TEMP', 'TMP', 'HOME', 'USER', 'APP', 'LOCAL', 'PROGRAM', 'OS', 'PROCESSOR', 'NUMBER_OF', 'COMPUTER', 'VSCODE', 'ELECTRON', 'CHROME', 'NO_COLOR', 'PROMPT', 'PUBLIC', 'DRIVER', 'SESSION', 'LOGON', 'FPS_', 'GIT_TR', 'WVD_', 'NUGET', 'CONDA', 'PSModule', 'WSLENV', 'WT_', 'YARN', 'npm_', 'MACE', 'UATDATA', 'APPLICATION_INS', 'POWERSHELL_D', 'OneDrive', 'ESPMRepo', 'Chocolatey', 'IsDevBox', 'CLIENTNAME', 'CommonProgram'];
      const envLines: string[] = [];
      for (const [key, value] of Object.entries(cleanEnv)) {
        if (value && !defaultKeyPrefixes.some(p => key.toUpperCase().startsWith(p.toUpperCase()))) {
          const redacted = /token|key|secret|password|auth/i.test(key) ? '***' : value;
          envLines.push(`  ${key}=${redacted}`);
        }
      }
      
      // Emit to onOutput so it appears in the node execution log
      if (onOutput) {
        onOutput(`Spawning: ${command}`);
        onOutput(`CWD: ${cwd}`);
        if (envLines.length > 0) {
          onOutput(`Environment (non-default):`);
          for (const line of envLines) { onOutput(line); }
        }
      }
      // Also emit to component logger for extension output channel
      if (envLines.length > 0) {
        this.logger.debug(`[${label}] Environment (non-default keys):`);
        for (const line of envLines) { this.logger.debug(`[${label}] ${line}`); }
      }
      
      const proc = this.spawner.spawn(command, [], { cwd, shell: true, env: cleanEnv });
      let capturedSessionId: string | undefined = sessionId;
      const statsParser = new CopilotStatsParser();
      let timeoutHandle: NodeJS.Timeout | undefined;
      let wasKilledByTimeout = false;
      
      // timeout === 0 means no timeout (agent work can run indefinitely)
      const effectiveTimeout = timeout > 0 ? Math.min(timeout, 2147483647) : 0;
      if (effectiveTimeout > 0) {
        timeoutHandle = setTimeout(() => {
          wasKilledByTimeout = true;
          this.logger.error(`[${label}] Process timed out after ${effectiveTimeout}ms, killing PID ${proc.pid}`);
          try {
            if (this.environment.platform === 'win32') {
              this.spawner.spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { shell: true });
            } else {
              proc.kill('SIGTERM');
            }
          } catch (e) { /* ignore */ }
        }, effectiveTimeout);
      }

      // Track "Task complete" marker for Windows exit-code workaround
      let sawTaskComplete = false;
      
      if (proc.pid) {
        this.logger.info(`[${label}] Copilot PID: ${proc.pid}`);
        onProcess?.(proc);
      }
      
      const extractSession = (text: string) => {
        if (capturedSessionId) { return; }
        const match = text.match(/Session ID[:\s]+([a-f0-9-]{36})/i) ||
                     text.match(/session[:\s]+([a-f0-9-]{36})/i) ||
                     text.match(/Starting session[:\s]+([a-f0-9-]{36})/i);
        if (match) {
          capturedSessionId = match[1];
          this.logger.info(`[${label}] Captured session ID: ${capturedSessionId}`);
        }
      };
      
      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        text.split('\n').forEach(line => {
          if (line.trim()) {
            this.logger.debug(`[${label}] ${line.trim()}`);
            statsParser.feedLine(line.trim());
            onOutput?.(line.trim());
            if (!sawTaskComplete && line.includes('Task complete')) { sawTaskComplete = true; }
          }
        });
        extractSession(text);
      });
      
      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        text.split('\n').forEach(line => {
          if (line.trim()) {
            this.logger.debug(`[${label}] ${line.trim()}`);
            statsParser.feedLine(line.trim());
            onOutput?.(line.trim());
          }
        });
        extractSession(text);
      });
      
      proc.on('exit', (code, signal) => {
        if (timeoutHandle) { clearTimeout(timeoutHandle); }
        // Windows: code=null & signal=null after normal completion → treat as 0 if marker seen
        const effectiveCode = (code === null && signal === null && sawTaskComplete) ? 0 : code;
        const metrics = statsParser.getMetrics();
        if (metrics && !metrics.tokenUsage && metrics.modelBreakdown?.length) {
          const totals = metrics.modelBreakdown.reduce(
            (acc, m) => ({ input: acc.input + m.inputTokens, output: acc.output + m.outputTokens }),
            { input: 0, output: 0 }
          );
          metrics.tokenUsage = {
            inputTokens: totals.input, outputTokens: totals.output,
            totalTokens: totals.input + totals.output, model: metrics.modelBreakdown[0].model,
          };
        }

        if (effectiveCode !== 0) {
          let reason: string;
          if (wasKilledByTimeout) {
            reason = `Copilot CLI killed by signal TIMEOUT after ${effectiveTimeout}ms (PID ${proc.pid})`;
          } else if (signal) {
            reason = `Copilot CLI was killed by signal ${signal} (PID ${proc.pid})`;
          } else {
            reason = `Copilot CLI exited with code ${effectiveCode}`;
          }
          this.logger.error(`[${label}] ${reason}, code=${code}, signal=${signal}, sawTaskComplete=${sawTaskComplete}`);
          resolve({ success: false, sessionId: capturedSessionId, error: reason, exitCode: effectiveCode ?? undefined, metrics });
        } else {
          if (code === null) {
            this.logger.info(`[${label}] Copilot CLI completed (exit code null coerced to 0 — task completion marker was present)`);
          } else {
            this.logger.info(`[${label}] Copilot CLI completed successfully`);
          }
          resolve({ success: true, sessionId: capturedSessionId, exitCode: 0, metrics });
        }
      });
      
      proc.on('error', (err) => {
        if (timeoutHandle) { clearTimeout(timeoutHandle); }
        this.logger.error(`[${label}] Copilot CLI error: ${err.message}`);
        resolve({ success: false, error: err.message });
      });
    });
  }
  
  /**
   * Clean up the instructions file after execution.
   * Public so callers with custom execution can clean up properly.
   */
  cleanupInstructionsFile(
    filePath: string,
    dirPath: string | undefined,
    label: string
  ): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.logger.debug(`[${label}] Cleaned up instructions file`);
        
        // Try to remove directory if empty
        if (dirPath) {
          try {
            const files = fs.readdirSync(dirPath);
            if (files.length === 0) {
              fs.rmdirSync(dirPath);
            }
          } catch { /* ignore */ }
        }
      }
    } catch (e) {
      this.logger.warn(`[${label}] Failed to cleanup instructions file: ${e}`);
    }
  }
}

// ============================================================================
// PURE FUNCTIONS (exported for direct testing)
// ============================================================================

/**
 * Sanitize and validate a URL string from untrusted user input.
 * Pure function — no side effects. Returns the sanitized URL or null.
 *
 * @param raw - The raw URL string to validate
 * @param logger - Optional logger for security audit messages
 */
export function sanitizeUrl(raw: string, logger?: CopilotCliLogger): string | null {
  const log = logger ?? noopLogger;
  if (!raw || typeof raw !== 'string') {
    log.warn(`[SECURITY] Rejected URL: empty or non-string input`);
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    log.warn(`[SECURITY] Rejected URL: empty after trim`);
    return null;
  }
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    log.warn(`[SECURITY] Rejected URL containing control characters`);
    return null;
  }
  if (/[`|;\n\r\\]/.test(trimmed) || /\$\(/.test(trimmed)) {
    log.warn(`[SECURITY] Rejected URL containing shell metacharacters: ${trimmed.substring(0, 50)}`);
    return null;
  }
  if (trimmed.includes('&&')) {
    log.warn(`[SECURITY] Rejected URL containing '&&' shell operator: ${trimmed.substring(0, 50)}`);
    return null;
  }
  if (trimmed.startsWith('-')) {
    log.warn(`[SECURITY] Rejected URL starting with dash (argument injection): ${trimmed.substring(0, 50)}`);
    return null;
  }
  const isWildcard = trimmed.startsWith('*.');
  const urlToTest = isWildcard ? `https://${trimmed.slice(2)}` : trimmed;
  let parsed: URL;
  try {
    parsed = new URL(urlToTest.includes('://') ? urlToTest : `https://${urlToTest}`);
  } catch {
    log.warn(`[SECURITY] Rejected URL: invalid URL format: ${trimmed.substring(0, 50)}`);
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    log.warn(`[SECURITY] Rejected URL with disallowed scheme: ${parsed.protocol}`);
    return null;
  }
  if (parsed.username || parsed.password) {
    log.warn(`[SECURITY] Rejected URL containing embedded credentials`);
    return null;
  }
  return trimmed;
}

/** Options for {@link buildCommand}. */
export interface BuildCommandOptions {
  task: string;
  sessionId?: string;
  model?: string;
  logDir?: string;
  sharePath?: string;
  configDir?: string;
  cwd?: string;
  allowedFolders?: string[];
  allowedUrls?: string[];
  maxTurns?: number;
}

/**
 * Build a Copilot CLI command string.
 * Pure function — all I/O (fs.existsSync, process.cwd) must be provided via callbacks.
 *
 * @param options  - Command options
 * @param deps     - Optional dependency overrides for testing
 */
export function buildCommand(
  options: BuildCommandOptions,
  deps?: {
    logger?: CopilotCliLogger;
    existsSync?: (p: string) => boolean;
    fallbackCwd?: string;
    urlSanitizer?: (raw: string) => string | null;
  },
): string {
  const log = deps?.logger ?? noopLogger;
  const exists = deps?.existsSync ?? fs.existsSync;
  const { task, sessionId, model, logDir, sharePath, configDir, cwd, allowedFolders, allowedUrls, maxTurns } = options;

  const allowedPaths: string[] = [];
  if (cwd) {
    const normalizedCwd = path.resolve(cwd);
    if (exists(normalizedCwd)) {
      allowedPaths.push(normalizedCwd);
      log.debug(`[SECURITY] Added worktree to allowed paths: ${normalizedCwd}`);
    } else {
      log.error(`[SECURITY] Working directory does not exist: ${cwd} (normalized: ${normalizedCwd})`);
      allowedPaths.push(normalizedCwd);
    }
  }
  if (allowedFolders && allowedFolders.length > 0) {
    for (const folder of allowedFolders) {
      if (!path.isAbsolute(folder)) {
        log.warn(`[SECURITY] Skipping relative allowed folder (must be absolute): ${folder}`);
        continue;
      }
      const normalized = path.resolve(folder);
      if (exists(normalized)) {
        allowedPaths.push(normalized);
      } else {
        log.warn(`[SECURITY] Allowed folder does not exist: ${folder}`);
      }
    }
  }

  log.info(`[SECURITY] Copilot CLI allowed directories (${allowedPaths.length}):`);
  for (const p of allowedPaths) {
    log.info(`[SECURITY]   - ${p}`);
  }

  let pathsArg: string;
  if (allowedPaths.length === 0) {
    const fallbackPath = cwd || deps?.fallbackCwd || process.cwd();
    log.warn(`[SECURITY] No allowed paths specified, using explicit cwd: ${fallbackPath}`);
    pathsArg = `--add-dir ${JSON.stringify(fallbackPath)}`;
  } else {
    pathsArg = allowedPaths.map(p => `--add-dir ${JSON.stringify(p)}`).join(' ');
  }

  const doSanitize = deps?.urlSanitizer ?? ((raw: string) => sanitizeUrl(raw, log));
  let urlsArg = '';
  const sanitizedUrls: string[] = [];
  if (allowedUrls && allowedUrls.length > 0) {
    for (const rawUrl of allowedUrls) {
      const validated = doSanitize(rawUrl);
      if (validated) {
        sanitizedUrls.push(validated);
      }
    }

    if (sanitizedUrls.length > 0) {
      log.info(`[SECURITY] Copilot CLI allowed URLs (${sanitizedUrls.length} of ${allowedUrls.length} passed validation):`);
      for (const url of sanitizedUrls) {
        try {
          const parsed = new URL(url);
          log.info(`[SECURITY]   - ${parsed.origin}${parsed.pathname}`);
        } catch {
          log.info(`[SECURITY]   - ${url.split('?')[0].split('#')[0]}`);
        }
      }
      urlsArg = sanitizedUrls.map(u => `--allow-url ${JSON.stringify(u)}`).join(' ');
    } else {
      log.warn(`[SECURITY] All ${allowedUrls.length} provided URLs failed validation — network access disabled`);
    }
  } else {
    log.info(`[SECURITY] Copilot CLI allowed URLs: none (network access disabled)`);
  }

  let cmd = `copilot -p ${JSON.stringify(task)} --stream off ${pathsArg} --allow-all-tools`;
  if (urlsArg) { cmd += ` ${urlsArg}`; }
  if (configDir) { cmd += ` --config-dir ${JSON.stringify(configDir)}`; }
  if (model) { cmd += ` --model ${model}`; }
  if (logDir) { cmd += ` --log-dir ${JSON.stringify(logDir)} --log-level debug`; }
  if (sharePath) { cmd += ` --share ${JSON.stringify(sharePath)}`; }
  if (sessionId) { cmd += ` --resume ${sessionId}`; }
  if (maxTurns && maxTurns > 0) { cmd += ` --max-turns ${maxTurns}`; }
  log.info(`[SECURITY] Copilot CLI command: copilot ${cmd}`);
  return cmd;
}
