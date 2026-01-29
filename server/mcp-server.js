#!/usr/bin/env node
/**
 * @fileoverview MCP Server for Copilot Orchestrator
 * 
 * This server handles MCP (Model Context Protocol) requests from GitHub Copilot
 * and directly manages job execution without an HTTP intermediary.
 * 
 * Transport: stdio (VS Code spawns this process)
 * 
 * Usage: Automatically spawned by VS Code when MCP is enabled
 */

const readline = require('readline');
const path = require('path');
const { JobStore } = require('./job-store');

// Import tool definitions from compiled TypeScript
// This ensures single source of truth for tool schemas
let toolDefinitionsModule;
try {
  toolDefinitionsModule = require('../out/mcp/tools');
} catch (e) {
  // Fallback: tools not yet compiled, will use inline definitions
  toolDefinitionsModule = null;
}

// Configuration from environment
const WORKSPACE_PATH = process.env.ORCH_WORKSPACE || process.cwd();

// Initialize job store
let jobStore = null;

function getJobStore() {
  if (!jobStore) {
    jobStore = new JobStore(WORKSPACE_PATH);
  }
  return jobStore;
}

// ============================================================================
// MCP TOOL DEFINITIONS
// ============================================================================

/**
 * Get tool definitions from compiled TypeScript sources.
 * This ensures single source of truth - schemas are defined in planTools.ts and jobTools.ts
 */
function getToolDefinitions() {
  // Use compiled TypeScript definitions if available
  if (toolDefinitionsModule && toolDefinitionsModule.getAllToolDefinitions) {
    return toolDefinitionsModule.getAllToolDefinitions();
  }
  
  // Fallback: minimal inline definitions (should not be used in production)
  console.error('[MCP Server] Warning: Could not load compiled tool definitions, using minimal fallback');
  return [
    {
      name: 'create_copilot_job',
      description: 'Create a new orchestrator job.',
      inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] }
    },
    {
      name: 'list_copilot_jobs',
      description: 'List all jobs.',
      inputSchema: { type: 'object', properties: {} }
    }
  ];
}

// ============================================================================
// MCP TOOL HANDLERS
// ============================================================================

async function handleToolCall(message) {
  const { name, arguments: args } = message.params;
  const store = getJobStore();

  try {
    let result;

    switch (name) {
      case 'create_copilot_job': {
        const job = store.create({
          id: args.id,
          name: args.name,
          task: args.task,
          repoPath: args.repoPath || WORKSPACE_PATH,
          baseBranch: args.baseBranch || 'main',
          prechecks: args.prechecks,
          work: args.work || args.task,
          postchecks: args.postchecks,
          instructions: args.instructions,
          webhook: args.webhook,
          inputs: {
            repoPath: args.repoPath || WORKSPACE_PATH,
            baseBranch: args.baseBranch || 'main'
          },
          policy: {
            steps: {
              prechecks: args.prechecks || '',
              work: args.work || `@agent ${args.task}`,
              postchecks: args.postchecks || ''
            }
          }
        });
        result = {
          success: true,
          jobId: job.id,
          message: `Job ${job.id} created and queued`,
          status: store.getStatus(job.id)
        };
        break;
      }

      case 'get_copilot_job_status': {
        const status = store.getStatus(args.id);
        if (!status) {
          result = { error: `Job ${args.id} not found` };
        } else {
          result = status;
        }
        break;
      }

      case 'get_copilot_jobs_batch_status': {
        const statuses = args.ids.map(id => store.getStatus(id) || { id, error: 'Not found' });
        const allComplete = statuses.every(s => s.isComplete || s.error);
        result = { statuses, allComplete };
        break;
      }

      case 'get_copilot_job_details': {
        const job = store.get(args.id);
        if (!job) {
          result = { error: `Job ${args.id} not found` };
        } else {
          result = job;
        }
        break;
      }

      case 'get_copilot_job_log_section': {
        const section = args.section === 'full' ? null : args.section;
        const log = store.getLog(args.id, section);
        if (log === null) {
          result = { error: `Log section '${args.section}' not found for job ${args.id}` };
        } else {
          result = { section: args.section, content: log };
        }
        break;
      }

      case 'list_copilot_jobs': {
        let jobs = store.list();
        if (args.status && args.status !== 'all') {
          const statusMap = {
            running: ['running', 'queued'],
            completed: ['succeeded'],
            failed: ['failed', 'canceled']
          };
          const allowed = statusMap[args.status] || [];
          jobs = jobs.filter(j => allowed.includes(j.status));
        }
        result = { jobs, count: jobs.length };
        break;
      }

      case 'cancel_copilot_job': {
        const success = store.cancel(args.id);
        result = success 
          ? { success: true, message: `Job ${args.id} canceled` }
          : { error: `Job ${args.id} not found or already completed` };
        break;
      }

      case 'retry_copilot_job': {
        const job = store.retry(args.id, args.instructions);
        result = job
          ? { success: true, message: `Job ${args.id} queued for retry`, status: store.getStatus(args.id) }
          : { error: `Job ${args.id} not found or currently running` };
        break;
      }

      case 'continue_copilot_job_work': {
        const job = store.continueWork(args.id, args.work);
        result = job
          ? { success: true, message: `Additional work queued for job ${args.id}`, status: store.getStatus(args.id) }
          : { error: `Job ${args.id} not found` };
        break;
      }

      // ========== Plan Handlers ==========

      case 'create_copilot_plan': {
        // Helper function to recursively map subPlans
        const mapSubPlans = (subPlans) => {
          if (!subPlans) return undefined;
          return subPlans.map(sp => ({
            id: sp.id,
            name: sp.name,
            triggerAfter: sp.triggerAfter,
            mergeInto: sp.mergeInto,
            maxParallel: sp.maxParallel,
            jobs: sp.jobs.map(j => ({
              id: j.id,
              name: j.name || j.id,
              task: j.task,
              work: j.work || `@agent ${j.task}`,
              dependsOn: j.dependsOn,
              prechecks: j.prechecks,
              postchecks: j.postchecks,
              instructions: j.instructions
            })),
            subPlans: mapSubPlans(sp.subPlans)  // Recursive!
          }));
        };
        
        const plan = store.createPlan({
          id: args.id,
          name: args.name,
          maxParallel: args.maxParallel,
          jobs: args.jobs.map(j => ({
            planJobId: j.id,
            id: j.id,
            name: j.name || j.id,
            task: j.task,
            work: j.work || `@agent ${j.task}`,
            dependsOn: j.dependsOn,
            baseBranch: j.baseBranch || 'main',
            prechecks: j.prechecks,
            postchecks: j.postchecks,
            instructions: j.instructions,
            repoPath: WORKSPACE_PATH
          })),
          subPlans: mapSubPlans(args.subPlans)
        });
        
        // Count all subPlans recursively
        const countSubPlans = (sps) => {
          if (!sps) return 0;
          return sps.reduce((sum, sp) => sum + 1 + countSubPlans(sp.subPlans), 0);
        };
        const totalSubPlans = countSubPlans(args.subPlans);
        
        result = {
          success: true,
          planId: plan.id,
          message: `Plan ${plan.id} created with ${plan.jobs.total} jobs${totalSubPlans > 0 ? ` and ${totalSubPlans} sub-plan(s)` : ''}`,
          status: plan
        };
        break;
      }

      case 'get_copilot_plan_status': {
        const status = store.getPlanStatus(args.id);
        if (!status) {
          result = { error: `Plan ${args.id} not found` };
        } else {
          result = status;
        }
        break;
      }

      case 'list_copilot_plans': {
        const plans = store.listPlans();
        result = { plans, count: plans.length };
        break;
      }

      case 'cancel_copilot_plan': {
        const success = store.cancelPlan(args.id);
        result = success
          ? { success: true, message: `Plan ${args.id} canceled` }
          : { error: `Plan ${args.id} not found` };
        break;
      }

      case 'delete_copilot_job': {
        const success = store.delete(args.id);
        result = success
          ? { success: true, message: `Job ${args.id} deleted` }
          : { error: `Job ${args.id} not found` };
        break;
      }

      case 'delete_copilot_jobs': {
        const results = [];
        for (const id of args.ids) {
          const success = store.delete(id);
          results.push({ id, success, message: success ? 'deleted' : 'not found' });
        }
        const successCount = results.filter(r => r.success).length;
        result = {
          success: successCount > 0,
          message: `Deleted ${successCount} of ${args.ids.length} jobs`,
          results
        };
        break;
      }

      case 'delete_copilot_plan': {
        const deleteResult = store.deletePlan(args.id, args.deleteJobs !== false);
        result = deleteResult.success
          ? deleteResult
          : { error: deleteResult.message || `Plan ${args.id} not found` };
        break;
      }

      default:
        result = { error: `Unknown tool: ${name}` };
    }

    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      }
    };

  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }],
        isError: true
      }
    };
  }
}

// ============================================================================
// MCP MESSAGE HANDLER
// ============================================================================

async function handleMcpMessage(message) {
  // Initialize
  if (message.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'copilot-orchestrator',
          version: '0.5.0'
        }
      }
    };
  }

  // Notifications (no response)
  if (message.method === 'notifications/initialized') {
    return null;
  }

  // List tools
  if (message.method === 'tools/list') {
    const tools = getToolDefinitions();
    process.stderr.write(`[MCP Server] tools/list requested, returning ${tools.length} tools\n`);
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: { tools }
    };
  }

  // Call tool
  if (message.method === 'tools/call') {
    return await handleToolCall(message);
  }

  // Unknown method
  return {
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: `Method not found: ${message.method}` }
  };
}

// ============================================================================
// STDIO TRANSPORT
// ============================================================================

function startStdioServer() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  let buffer = '';

  rl.on('line', async (line) => {
    buffer += line;
    
    try {
      const message = JSON.parse(buffer);
      buffer = '';

      const response = await handleMcpMessage(message);
      if (response) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        // Incomplete JSON, wait for more data
        buffer += '\n';
      } else {
        // Real error
        const errorResponse = {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' }
        };
        process.stdout.write(JSON.stringify(errorResponse) + '\n');
        buffer = '';
      }
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });

  // Log startup (to stderr so it doesn't interfere with JSON-RPC)
  process.stderr.write('[MCP Server] Copilot Orchestrator ready (stdio mode)\n');
  process.stderr.write(`[MCP Server] Workspace: ${WORKSPACE_PATH}\n`);
}

// ============================================================================
// MAIN
// ============================================================================

startStdioServer();
