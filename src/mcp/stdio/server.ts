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

async function main(): Promise<void> {

  const workspacePath = process.env.ORCHESTRATOR_WORKSPACE || process.cwd();
  const storagePath = process.env.ORCHESTRATOR_STORAGE
    || path.join(workspacePath, '.orchestrator', 'plans');

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
