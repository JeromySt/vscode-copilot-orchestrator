/**
 * @fileoverview Entry-point for the stdio MCP child process.
 *
 * VS Code spawns this as:
 *   node mcp-stdio-server.js
 *
 * Environment variables (injected via McpStdioServerDefinition.env):
 *   ORCHESTRATOR_WORKSPACE  — absolute workspace path
 *   ORCHESTRATOR_STORAGE    — absolute path to .orchestrator/plans
 *
 * @module mcp/stdio/server
 */

// CRITICAL: Redirect console.log to stderr BEFORE any imports
// that might log during module initialization.
// stdout is reserved for JSON-RPC messages only.
const origLog = console.log;
console.log = (...args: any[]) => console.error('[mcp-stdio]', ...args);
console.debug = (...args: any[]) => console.error('[mcp-stdio:debug]', ...args);
console.info = (...args: any[]) => console.error('[mcp-stdio:info]', ...args);
console.warn = (...args: any[]) => console.error('[mcp-stdio:warn]', ...args);

import * as path from 'path';
import { StdioTransport } from './transport';
import { McpHandler } from '../handler';
import { PlanRunner, PlanRunnerConfig, DefaultJobExecutor } from '../../plan';

/**
 * Parse command-line arguments.
 * Supports: --workspace <path> --storage <path>
 */
function parseArgs(): { workspace?: string; storage?: string } {
  const args = process.argv.slice(2);
  const result: { workspace?: string; storage?: string } = {};
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) {
      result.workspace = args[++i];
    } else if (args[i] === '--storage' && args[i + 1]) {
      result.storage = args[++i];
    }
  }
  
  return result;
}

async function main(): Promise<void> {

  const cliArgs = parseArgs();
  
  // Priority: CLI args > env vars > defaults
  const workspacePath = cliArgs.workspace 
    || process.env.ORCHESTRATOR_WORKSPACE 
    || process.cwd();
  const storagePath = cliArgs.storage
    || process.env.ORCHESTRATOR_STORAGE
    || path.join(workspacePath, '.orchestrator', 'plans');

  // Log the paths for debugging
  console.error('[mcp-stdio] Storage configuration:');
  console.error('[mcp-stdio]   CLI args:', JSON.stringify(cliArgs));
  console.error('[mcp-stdio]   Resolved workspacePath:', workspacePath);
  console.error('[mcp-stdio]   Resolved storagePath:', storagePath);

  // Bootstrap PlanRunner
  const config: PlanRunnerConfig = {
    storagePath,
    defaultRepoPath: workspacePath,
    maxParallel: 4,
    pumpInterval: 1000,
  };
  const runner = new PlanRunner(config);
  const executor = new DefaultJobExecutor();
  runner.setExecutor(executor);
  await runner.initialize();

  // Create handler + transport
  const handler = new McpHandler(runner, workspacePath);
  const transport = new StdioTransport(process.stdin, process.stdout);

  transport.onRequest((req) => handler.handleRequest(req));

  // Block until stdin closes (VS Code killed us)
  await transport.start();

  // Persist before exit
  runner.persistSync();
}

main().catch((err) => {
  console.error('Fatal error in MCP stdio server:', err);
  process.exit(1);
});
