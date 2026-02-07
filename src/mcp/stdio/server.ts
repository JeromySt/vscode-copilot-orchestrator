/**
 * @fileoverview Entry-point for the stdio MCP child process.
 *
 * VS Code spawns this as:
 *   node mcp-stdio-server.js --ipc <pipe-path>
 *
 * This process acts as a bridge between:
 * - stdin/stdout (JSON-RPC to VS Code's Copilot)
 * - IPC connection (to extension host's McpHandler)
 *
 * All actual plan/job logic lives in the extension host via IPC.
 * This process is a thin transport layer only.
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

import { StdioTransport } from './transport';
import { McpIpcClient } from '../ipc/client';

/**
 * Parse command-line arguments.
 * Supports: --ipc <pipe-path>
 */
function parseArgs(): { ipc?: string } {
  const args = process.argv.slice(2);
  const result: { ipc?: string } = {};
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ipc' && args[i + 1]) {
      result.ipc = args[++i];
    }
  }
  
  return result;
}

async function main(): Promise<void> {
  const cliArgs = parseArgs();
  
  if (!cliArgs.ipc) {
    console.error('[mcp-stdio] ERROR: --ipc argument required');
    process.exit(1);
  }

  console.error('[mcp-stdio] Starting stdio server');
  console.error('[mcp-stdio]   IPC path:', cliArgs.ipc);

  // Connect to the extension's IPC server
  const ipcClient = new McpIpcClient(cliArgs.ipc);
  
  try {
    await ipcClient.connect();
    console.error('[mcp-stdio] Connected to extension IPC server');
  } catch (err) {
    console.error('[mcp-stdio] Failed to connect to IPC server:', err);
    process.exit(1);
  }

  // Create stdio transport for communication with VS Code
  const transport = new StdioTransport(process.stdin, process.stdout);

  // Forward all requests from stdio to IPC and return responses
  transport.onRequest(async (req) => {
    try {
      const response = await ipcClient.request(req);
      return response;
    } catch (err) {
      console.error('[mcp-stdio] IPC request failed:', err);
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32603, message: 'IPC communication error' }
      };
    }
  });

  // Block until stdin closes (VS Code killed us)
  await transport.start();

  // Clean up
  ipcClient.disconnect();
  console.error('[mcp-stdio] Shutting down');
}

main().catch((err) => {
  console.error('Fatal error in MCP stdio server:', err);
  process.exit(1);
});
