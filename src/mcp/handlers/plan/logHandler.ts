/**
 * @fileoverview MCP handler for orchestrator log retrieval.
 *
 * @module mcp/handlers/plan/logHandler
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Retrieves orchestrator logs (daemon or repo-specific).
 */
export async function handleGetOrchestratorLogs(
  args: { kind: 'daemon' | 'repo'; repo_root?: string; tail_lines?: number },
  _ctx: import('../utils').PlanHandlerContext,
): Promise<any> {
  const tailLines = args.tail_lines ?? 200;

  let logPath: string;
  if (args.kind === 'daemon') {
    logPath = getDaemonLogPath();
  } else {
    if (!args.repo_root) {
      return { success: false, error: 'repo_root is required when kind="repo"' };
    }
    const resolved = path.resolve(args.repo_root);
    logPath = getRepoLogPath(resolved);
  }

  try {
    if (!fs.existsSync(logPath)) {
      return { success: false, error: `Log file not found: ${logPath}`, path: logPath };
    }

    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n');
    const result = tailLines > 0 ? lines.slice(-tailLines).join('\n') : content;

    return {
      success: true,
      path: logPath,
      kind: args.kind,
      lines: tailLines > 0 ? Math.min(lines.length, tailLines) : lines.length,
      total_lines: lines.length,
      content: result,
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to read log: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function getDaemonLogDir(): string {
  if (process.platform === 'win32') {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'ai-orchestrator', 'logs',
    );
  }
  return path.join(os.homedir(), '.local', 'share', 'ai-orchestrator', 'logs');
}

/**
 * Find the most recent aio-daemon-{pid}.log in the daemon log directory.
 * Each daemon instance writes to its own PID-scoped file.
 */
function getDaemonLogPath(): string {
  const logDir = getDaemonLogDir();
  if (!fs.existsSync(logDir)) {
    return path.join(logDir, 'aio-daemon.log'); // fallback for error message
  }

  const files = fs.readdirSync(logDir)
    .filter(f => f.startsWith('aio-daemon-') && f.endsWith('.log'))
    .sort()
    .reverse();

  return files.length > 0 ? path.join(logDir, files[0]) : path.join(logDir, 'aio-daemon.log');
}

function getRepoLogPath(repoRoot: string): string {
  const logDir = path.join(repoRoot, '.aio', 'aio_logs');
  if (!fs.existsSync(logDir)) {
    return path.join(logDir, 'aio-daemon.log');
  }

  const files = fs.readdirSync(logDir)
    .filter(f => f.startsWith('aio-daemon-') && f.endsWith('.log'))
    .sort()
    .reverse();

  return files.length > 0 ? path.join(logDir, files[0]) : path.join(logDir, 'aio-daemon.log');
}
