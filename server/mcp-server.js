// MCP Server for Copilot Orchestrator (HTTP SSE Transport)
// Provides Model Context Protocol interface over HTTP with SSE
const http = require('http');
const ORCH_HOST = process.env.ORCH_HOST || '127.0.0.1';
const ORCH_PORT = +(process.env.ORCH_PORT || '39217');
const MCP_PORT = +(process.env.MCP_PORT || '39218');

const clients = new Map();
let messageId = 0;

// Helper to call the orchestrator HTTP API
function callOrchestrator(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      method,
      host: ORCH_HOST,
      port: ORCH_PORT,
      path,
      headers: { 'Content-Type': 'application/json' }
    };

    const req = http.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = Buffer.concat(chunks).toString('utf8');
          resolve(data ? JSON.parse(data) : {});
        } catch {
          resolve({});
        }
      });
    });

    req.on('error', reject);
    if (body) {
      const data = JSON.stringify(body);
      req.setHeader('Content-Length', Buffer.byteLength(data));
      req.write(data);
    }
    req.end();
  });
}

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// MCP HTTP Server with SSE
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${MCP_PORT}`);
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.end();
    return;
  }

  try {
    // Root path - SSE endpoint for MCP protocol
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/sse')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      const clientId = ++messageId;
      clients.set(clientId, res);

      console.error(`SSE client ${clientId} connected`);

      // Keep connection alive
      const keepAlive = setInterval(() => {
        res.write(': keep-alive\n\n');
      }, 30000);

      req.on('close', () => {
        clearInterval(keepAlive);
        clients.delete(clientId);
        console.error(`SSE client ${clientId} disconnected`);
      });

      return;
    }

    // POST endpoint for MCP messages
    if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '/message')) {
      res.setHeader('Content-Type', 'application/json');
      
      let body = '';
      req.on('data', chunk => body += chunk);
      await new Promise(resolve => req.on('end', resolve));
      
      const message = JSON.parse(body);
      let response;

      // Handle initialize
      if (message.method === 'initialize') {
        response = {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: {
              name: 'copilot-orchestrator',
              version: '0.4.0'
            }
          }
        };
      }
      
      // Handle tools/list
      else if (message.method === 'tools/list') {
        response = {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [
              {
                name: 'create_copilot_job',
                description: 'Create a new orchestrator job in an isolated git worktree. Optionally configure webhook callbacks for stage/job completion events (localhost URLs only for security).',
                inputSchema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Job ID (optional, will generate GUID if not provided)' },
                    name: { type: 'string', description: 'Human-readable job name for display' },
                    task: { type: 'string', description: 'Task description' },
                    repoPath: { type: 'string', description: 'Repository path' },
                    baseBranch: { type: 'string', description: 'Branch to start from (will merge back into this branch unless it\'s the default branch)' },
                    prechecks: { type: 'string', description: 'Pre-check command (optional, e.g., "npm test")' },
                    work: { type: 'string', description: 'Work to perform - use natural language (will auto-prefix with @agent) or shell command' },
                    postchecks: { type: 'string', description: 'Post-check command (optional, e.g., "npm run lint")' },
                    instructions: { type: 'string', description: 'Additional instructions for the AI agent (optional)' },
                    webhook: { 
                      type: 'object', 
                      description: 'Webhook configuration for callbacks on job events. SECURITY: Only localhost URLs allowed (127.0.0.1, ::1, localhost)',
                      properties: {
                        url: { type: 'string', description: 'Localhost URL to POST webhook notifications to (e.g., http://localhost:8080/callback)' },
                        events: { 
                          type: 'array', 
                          items: { type: 'string', enum: ['stage_complete', 'job_complete', 'job_failed'] },
                          description: 'Events to subscribe to (default: all events)'
                        },
                        headers: { 
                          type: 'object', 
                          description: 'Additional HTTP headers to send with webhook (e.g., Authorization)' 
                        }
                      },
                      required: ['url']
                    }
                  },
                  required: ['task', 'repoPath', 'baseBranch']
                }
              },
              {
                name: 'get_copilot_job_status',
                description: 'Get simplified status of a job. Returns: id, isComplete (boolean for easy polling termination), progress (0-100%), status, currentStep, stepStatuses, metrics (tests/coverage/errors), workSummary, recommendedPollIntervalMs. Use get_copilot_job_details for full job information.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Job ID' }
                  },
                  required: ['id']
                }
              },
              {
                name: 'get_copilot_jobs_batch_status',
                description: 'Get status of multiple jobs in a single call. Efficient for monitoring parallel jobs. Returns statuses array and allComplete boolean.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    ids: { 
                      type: 'array', 
                      items: { type: 'string' },
                      description: 'Array of Job IDs to check status for' 
                    }
                  },
                  required: ['ids']
                }
              },
              {
                name: 'get_copilot_job_details',
                description: 'Get full details of a job including task, policy, all attempts, work history, and complete configuration. Use get_copilot_job_status for a quick status check.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Job ID' }
                  },
                  required: ['id']
                }
              },
              {
                name: 'get_copilot_job_log_section',
                description: 'Get logs for a specific section of a job. Returns the log content for the requested section. If the section has not started yet, returns a message indicating the section was not found.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Job ID' },
                    section: { 
                      type: 'string', 
                      description: 'Log section to retrieve', 
                      enum: ['prechecks', 'work', 'postchecks', 'mergeback', 'cleanup', 'full']
                    }
                  },
                  required: ['id', 'section']
                }
              },
              {
                name: 'continue_copilot_job_work',
                description: 'Continue work on an existing job with new instructions (e.g., to fix failing postchecks). Reuses the same worktree and job GUID.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Job ID (GUID) to continue' },
                    work: { type: 'string', description: 'New work instructions to execute in the existing worktree' }
                  },
                  required: ['id', 'work']
                }
              },
              {
                name: 'retry_copilot_job',
                description: 'Retry a failed job with AI-guided analysis. By default, points the agent to the previous execution logs to analyze and fix failures. Optionally provide updated workContext to override the default analysis prompt.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Job ID (GUID) to retry' },
                    workContext: { type: 'string', description: 'Optional: Updated work context/instructions. If provided, overrides the default AI analysis prompt. If omitted, agent will automatically analyze previous logs and attempt to fix failures.' }
                  },
                  required: ['id']
                }
              },
              {
                name: 'list_copilot_jobs',
                description: 'List all orchestrator jobs',
                inputSchema: { type: 'object' }
              }
            ]
          }
        };
      }
      
      // Handle tools/call
      else if (message.method === 'tools/call') {
        const toolName = message.params.name;
        const args = message.params.arguments || {};
        let result;

        try {
          switch (toolName) {
            case 'create_copilot_job': {
              const { randomUUID } = require('crypto');
              
              // Always generate a GUID for the job ID
              const jobId = randomUUID();
              
              // Determine the friendly name:
              // 1. Use explicit 'name' if provided
              // 2. If 'id' was provided but isn't a GUID, use it as the name
              // 3. Fall back to task description or 'Unnamed Job'
              const isValidGuid = args.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.id);
              const jobName = args.name || (!isValidGuid && args.id) || args.task || 'Unnamed Job';
              
              // Auto-derive targetBranch: only differs from baseBranch if baseBranch is the default branch
              // Detect default branch from git remote
              let defaultBranch = 'main'; // fallback
              
              try {
                const { execSync } = require('child_process');
                // Get the default branch from git remote
                const remoteHead = execSync('git symbolic-ref refs/remotes/origin/HEAD', { 
                  cwd: args.repoPath, 
                  encoding: 'utf-8' 
                }).toString().trim();
                defaultBranch = remoteHead.replace('refs/remotes/origin/', '');
              } catch {
                // If remote HEAD not set, try to detect from common branches
                try {
                  const { execSync } = require('child_process');
                  const branches = execSync('git branch -r', { 
                    cwd: args.repoPath, 
                    encoding: 'utf-8' 
                  }).toString().trim();
                  if (branches.includes('origin/main')) defaultBranch = 'main';
                  else if (branches.includes('origin/master')) defaultBranch = 'master';
                  else if (branches.includes('origin/develop')) defaultBranch = 'develop';
                } catch {}
              }
              
              const isDefaultBranch = args.baseBranch === defaultBranch;
              const targetBranch = isDefaultBranch 
                ? (args.targetBranch || `feature/${args.name.replace(/\W+/g, '-').toLowerCase()}`)
                : args.baseBranch;
              
              const jobSpec = {
                id: jobId,
                name: jobName,
                task: args.task,
                inputs: {
                  repoPath: args.repoPath,
                  baseBranch: args.baseBranch,
                  targetBranch: targetBranch,
                  worktreeRoot: args.worktreeRoot || '.worktrees',
                  instructions: args.instructions || ''
                },
                policy: {
                  useJust: true,
                  steps: {
                    prechecks: args.prechecks || 'echo "No prechecks"',
                    // Auto-prefix work with @agent if it doesn't already have it and looks like natural language
                    work: args.work 
                      ? (args.work.startsWith('@') ? args.work : `@agent ${args.work}`)
                      : '@agent Implement the requested changes',
                    postchecks: args.postchecks || 'echo "No postchecks"'
                  }
                }
              };
              
              // Add webhook config if provided
              const requestBody = args.webhook 
                ? { ...jobSpec, webhook: args.webhook }
                : jobSpec;
              
              result = await callOrchestrator('POST', '/copilot_job', requestBody);
              break;
            }

            case 'get_copilot_job_status':
              result = await callOrchestrator('GET', `/copilot_job/${args.id}/status`);
              break;

            case 'get_copilot_jobs_batch_status':
              result = await callOrchestrator('POST', '/copilot_jobs/status', { ids: args.ids });
              break;

            case 'get_copilot_job_details':
              result = await callOrchestrator('GET', `/copilot_job/${args.id}`);
              break;

            case 'get_copilot_job_log_section':
              result = await callOrchestrator('GET', `/copilot_job/${args.id}/log/${args.section}`);
              break;

            case 'continue_copilot_job_work':
              result = await callOrchestrator('POST', `/copilot_job/${args.id}/continue`, { work: args.work });
              break;

            case 'retry_copilot_job':
              result = await callOrchestrator('POST', `/copilot_job/${args.id}/retry`, { workContext: args.workContext });
              break;

            case 'list_copilot_jobs':
              result = await callOrchestrator('GET', '/copilot_jobs');
              break;

            default:
              throw new Error('Unknown tool: ' + toolName);
          }

          response = {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify(result, null, 2)
              }]
            }
          };
        } catch (error) {
          response = {
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32000,
              message: error.message
            }
          };
        }
      }
      
      else {
        response = {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32601,
            message: 'Method not found: ' + message.method
          }
        };
      }

      res.end(JSON.stringify(response));
      return;
    }

    // Health check
    if (req.method === 'GET' && url.pathname === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ 
        status: 'ok', 
        mcp: 'running',
        orchestratorApi: `http://${ORCH_HOST}:${ORCH_PORT}`,
        endpoints: {
          sse: '/sse',
          message: '/message'
        }
      }));
      return;
    }

    // If we get here, method not supported for this path
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      error: 'Method not allowed',
      path: url.pathname,
      method: req.method,
      hint: 'Use GET / for SSE, POST / for messages, or GET /health for status'
    }));

  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      error: error.message
    }));
  }
});

server.listen(MCP_PORT, '127.0.0.1', () => {
  console.error(`MCP HTTP Server listening on http://127.0.0.1:${MCP_PORT}`);
  console.error(`Using SSE transport at /sse`);
  console.error(`Connecting to Orchestrator API at http://${ORCH_HOST}:${ORCH_PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
