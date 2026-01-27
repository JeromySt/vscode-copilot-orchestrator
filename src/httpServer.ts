
import * as http from 'http';
import { JobRunner, JobSpec } from './jobRunner';
import { PlanRunner, PlanSpec } from './planRunner';

// Helper to calculate progress percentage based on phase
function calculateProgress(job: any): number {
  const phaseWeights: Record<string, number> = {
    'prechecks': 10,
    'work': 70,
    'postchecks': 85,
    'mergeback': 95,
    'cleanup': 100
  };
  
  if (job.status === 'succeeded') return 100;
  if (job.status === 'failed' || job.status === 'canceled') return -1; // -1 indicates incomplete
  if (job.status === 'queued') return 0;
  
  const currentStep = job.currentStep;
  if (!currentStep) return 5; // Just started
  
  // If current step is running, we're partway through that phase
  const stepStatuses = job.stepStatuses || {};
  const phases = ['prechecks', 'work', 'postchecks', 'mergeback', 'cleanup'];
  
  let progress = 0;
  for (const phase of phases) {
    if (stepStatuses[phase] === 'success' || stepStatuses[phase] === 'skipped') {
      progress = phaseWeights[phase];
    } else if (phase === currentStep) {
      // Currently in this phase - estimate halfway through
      const prevPhase = phases[phases.indexOf(phase) - 1];
      const prevProgress = prevPhase ? phaseWeights[prevPhase] : 0;
      progress = prevProgress + (phaseWeights[phase] - prevProgress) / 2;
      break;
    }
  }
  
  return Math.round(progress);
}

// Helper to build job status response
function buildJobStatus(job: any) {
  const currentAttempt = job.attempts?.find((a: any) => a.attemptId === job.currentAttemptId);
  const isComplete = job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled';
  const isRunning = job.status === 'running' || job.status === 'queued';
  
  // Calculate exponential polling interval: 500ms -> 10000ms based on duration
  let recommendedPollIntervalMs = 0;
  if (isRunning && job.startedAt) {
    const durationSec = Math.floor((Date.now() - job.startedAt) / 1000);
    const doublings = Math.floor(durationSec / 30);
    recommendedPollIntervalMs = Math.min(500 * Math.pow(2, doublings), 10000);
  } else if (isRunning) {
    recommendedPollIntervalMs = 500;
  }
  
  return {
    id: job.id,
    isComplete,
    status: job.status,
    progress: calculateProgress(job),
    currentStep: job.currentStep || null,
    stepStatuses: job.stepStatuses || {},
    attemptNumber: job.attempts?.length || 0,
    currentAttempt: currentAttempt ? {
      attemptId: currentAttempt.attemptId,
      status: currentAttempt.status,
      stepStatuses: currentAttempt.stepStatuses || {},
      workSummary: currentAttempt.workSummary || null
    } : null,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    duration: job.endedAt && job.startedAt ? Math.round((job.endedAt - job.startedAt) / 1000) : (job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : null),
    recommendedPollIntervalMs,
    workSummary: job.workSummary || null,
    metrics: job.metrics || null
  };
}

export function startHttp(runner: JobRunner, plans: PlanRunner, host: string, port: number){
  const server = http.createServer(async (req,res)=> { 
    const url = new URL(req.url||'/', `http://${host}:${port}`); 
    res.setHeader('Content-Type','application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') { res.end(); return; }
    
    try {
      // GET /copilot_jobs - List all jobs
      if (req.method==='GET' && url.pathname==='/copilot_jobs'){ 
        const jobs = runner.list(); 
        res.end(JSON.stringify({jobs, count: jobs.length})); 
        return; 
      }
      
      // POST /copilot_jobs/status - Batch status check for multiple job IDs
      if (req.method==='POST' && url.pathname==='/copilot_jobs/status'){
        let body = '';
        req.on('data', c => body += c);
        await new Promise(r => req.on('end', r));
        const { ids } = JSON.parse(body) as { ids: string[] };
        
        if (!ids || !Array.isArray(ids)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing or invalid ids array' }));
          return;
        }
        
        const jobs = runner.list();
        const statuses = ids.map(id => {
          const job = jobs.find(j => j.id === id);
          if (!job) return { id, error: 'Job not found' };
          return buildJobStatus(job);
        });
        
        res.end(JSON.stringify({ 
          statuses,
          allComplete: statuses.every(s => 'isComplete' in s && s.isComplete),
          timestamp: Date.now()
        }));
        return;
      }
      
      // POST /copilot_job - Create new job
      if (req.method==='POST' && url.pathname==='/copilot_job'){ 
        let body=''; 
        req.on('data',c=> body+=c); 
        await new Promise(r=> req.on('end',r)); 
        const spec = JSON.parse(body) as JobSpec;
        
        // Auto-derive targetBranch from baseBranch if not specified
        // Only differs if baseBranch is the repository's default branch
        if (!spec.inputs.targetBranch) {
          const { execSync } = require('child_process');
          let defaultBranch = 'main'; // fallback
          
          try {
            // Get the default branch from git remote
            const remoteHead = execSync('git symbolic-ref refs/remotes/origin/HEAD', { 
              cwd: spec.inputs.repoPath, 
              encoding: 'utf-8' 
            }).trim();
            defaultBranch = remoteHead.replace('refs/remotes/origin/', '');
          } catch {
            // If remote HEAD not set, try to detect from common branches
            try {
              const branches = execSync('git branch -r', { 
                cwd: spec.inputs.repoPath, 
                encoding: 'utf-8' 
              }).trim();
              if (branches.includes('origin/main')) defaultBranch = 'main';
              else if (branches.includes('origin/master')) defaultBranch = 'master';
              else if (branches.includes('origin/develop')) defaultBranch = 'develop';
            } catch {}
          }
          
          const isDefaultBranch = spec.inputs.baseBranch === defaultBranch;
          spec.inputs.targetBranch = isDefaultBranch 
            ? `feature/${spec.name.replace(/\W+/g, '-').toLowerCase()}`
            : spec.inputs.baseBranch;
        }
        
        runner.enqueue(spec); 
        
        // Return full job status for immediate monitoring
        const job = runner.list().find(j => j.id === spec.id);
        res.end(JSON.stringify({
          ok: true, 
          id: spec.id, 
          message: 'Job created successfully',
          status: job?.status || 'queued',
          currentStep: job?.currentStep || null,
          stepStatuses: job?.stepStatuses || {},
          recommendedPollIntervalMs: 2000
        })); 
        return; 
      }
      
      // GET /copilot_job/:id/status - Get simplified job status
      if (req.method==='GET' && url.pathname.match(/^\/copilot_job\/[^\/]+\/status$/)){
        const id = url.pathname.split('/')[2];
        const job = runner.list().find(j=> j.id===id);
        if (!job){
          res.statusCode=404;
          res.end(JSON.stringify({error:'Job not found', id}));
          return;
        }
        
        res.end(JSON.stringify(buildJobStatus(job)));
        return;
      }
      
      // GET /copilot_job/:id - Get full job details
      if (req.method==='GET' && url.pathname.match(/^\/copilot_job\/[^\/]+$/)){ 
        const id = url.pathname.split('/')[2]; 
        const job = runner.list().find(j=> j.id===id); 
        if (!job){ 
          res.statusCode=404; 
          res.end(JSON.stringify({error:'Job not found', id})); 
          return;
        } 
        res.end(JSON.stringify(job)); 
        return; 
      }
      
      // POST /copilot_job/:id/cancel - Cancel job
      if (req.method==='POST' && url.pathname.endsWith('/cancel')){ 
        const id = url.pathname.split('/')[2]; 
        (runner as any).cancel(id); 
        res.end(JSON.stringify({ok:true, id, message: 'Job cancelled'})); 
        return; 
      }
      
      // POST /copilot_job/:id/continue - Continue work on existing job
      if (req.method==='POST' && url.pathname.endsWith('/continue')){
        const id = url.pathname.split('/')[2];
        let body='';
        req.on('data', c=> body+=c);
        await new Promise(r=> req.on('end',r));
        const data = JSON.parse(body);
        
        const result = (runner as any).continueWork(id, data.work);
        if (!result) {
          res.statusCode = 404;
          res.end(JSON.stringify({error: 'Job not found or cannot be continued', id}));
          return;
        }
        res.end(JSON.stringify({ok:true, id, message: 'Job work continuation queued'}));
        return;
      }
      
      // POST /copilot_job/:id/retry - Retry failed job with optional updated work context
      if (req.method==='POST' && url.pathname.endsWith('/retry')){
        const id = url.pathname.split('/')[2];
        let body='';
        req.on('data', c=> body+=c);
        await new Promise(r=> req.on('end',r));
        const data = body ? JSON.parse(body) : {};
        
        (runner as any).retry(id, data.workContext);
        
        // Get updated job to return full status
        const job = runner.list().find(j => j.id === id);
        const currentAttempt = job?.attempts?.find((a: any) => a.attemptId === job?.currentAttemptId);
        const contextMsg = data.workContext ? ' with updated context' : ' with AI analysis';
        
        res.end(JSON.stringify({
          ok: true, 
          id, 
          message: `Job retry queued${contextMsg}`,
          attemptId: currentAttempt?.attemptId || null,
          attemptNumber: job?.attempts?.length || 0,
          status: job?.status || 'queued',
          currentStep: job?.currentStep || null,
          stepStatuses: job?.stepStatuses || {},
          recommendedPollIntervalMs: 2000
        }));
        return;
      }
      
      // GET /copilot_job/:id/log/:section - Get job log section
      if (req.method==='GET' && url.pathname.match(/^\/copilot_job\/[^\/]+\/log\/[^\/]+$/)){
        const parts = url.pathname.split('/');
        const id = parts[2];
        const section = parts[4];
        
        const job = runner.list().find(j => j.id === id);
        if (!job) {
          res.statusCode = 404;
          res.end(JSON.stringify({error: 'Job not found', id}));
          return;
        }
        
        if (!job.logFile) {
          res.statusCode = 404;
          res.end(JSON.stringify({error: 'No log file for this job', id}));
          return;
        }
        
        const fs = require('fs');
        let logContent = '';
        try {
          logContent = fs.readFileSync(job.logFile, 'utf-8');
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({error: 'Failed to read log file', message: String(e)}));
          return;
        }
        
        let filteredLog = logContent;
        let sectionStatus = 'unknown';
        
        if (section && section !== 'full') {
          const sectionName = section.toUpperCase();
          const startMarker = `========== ${sectionName} SECTION START ==========`;
          const endMarker = `========== ${sectionName} SECTION END ==========`;
          
          const startIdx = logContent.indexOf(startMarker);
          const endIdx = logContent.indexOf(endMarker);
          
          // Check job's phase status
          const stepStatus = job.stepStatuses?.[section.toLowerCase() as keyof typeof job.stepStatuses];
          const isCurrentStep = job.currentStep === section.toLowerCase();
          
          if (startIdx >= 0 && endIdx >= 0 && endIdx > startIdx) {
            // Section is complete - return full section
            filteredLog = logContent.substring(startIdx, endIdx + endMarker.length);
            sectionStatus = stepStatus || 'completed';
          } else if (startIdx >= 0) {
            // Section started but not ended yet - return content from start to end of file
            filteredLog = logContent.substring(startIdx);
            sectionStatus = isCurrentStep ? 'running' : (stepStatus || 'in-progress');
          } else {
            // Section hasn't started
            if (stepStatus) {
              sectionStatus = stepStatus;
              filteredLog = `Section '${section}' status is '${stepStatus}' but no logs found.`;
            } else if (job.status === 'running' || job.status === 'queued') {
              sectionStatus = 'pending';
              filteredLog = `Section '${section}' has not started yet. Current phase: ${job.currentStep || 'unknown'}.`;
            } else {
              sectionStatus = 'not-run';
              filteredLog = `Section '${section}' was not executed. Job status: ${job.status}.`;
            }
          }
        } else {
          sectionStatus = job.status;
        }
        
        res.end(JSON.stringify({
          ok: true, 
          jobId: id, 
          section, 
          sectionStatus,
          jobStatus: job.status,
          currentStep: job.currentStep,
          log: filteredLog
        }));
        return;
      }
      
      // POST /plan - Create plan
      if (req.method==='POST' && url.pathname==='/plan'){ 
        let body=''; 
        req.on('data',c=> body+=c); 
        await new Promise(r=> req.on('end',r)); 
        const spec = JSON.parse(body) as PlanSpec; 
        plans.enqueue(spec); 
        res.end(JSON.stringify({ok:true, id: spec.id, message: 'Plan created successfully'})); 
        return; 
      }
      
      // GET /plan/:id - Get plan status
      if (req.method==='GET' && url.pathname.startsWith('/plan/')){ 
        const id = url.pathname.split('/')[2]; 
        const plan = plans.get(id); 
        if (!plan){ 
          res.statusCode=404; 
          res.end(JSON.stringify({error:'Plan not found', id})); 
          return;
        } 
        res.end(JSON.stringify(plan)); 
        return; 
      }
      
      // POST /plan/:id/cancelPlan - Cancel plan
      if (req.method==='POST' && url.pathname.endsWith('/cancelPlan')){ 
        const id = url.pathname.split('/')[2]; 
        plans.cancel(id); 
        res.end(JSON.stringify({ok:true, id, message: 'Plan cancelled'})); 
        return; 
      }
      
      // GET / - API info
      if (req.method==='GET' && url.pathname==='/'){
        res.end(JSON.stringify({
          name: 'Copilot Orchestrator MCP Server',
          version: '0.4.0',
          endpoints: {
            'GET /copilot_jobs': 'List all jobs',
            'POST /copilot_job': 'Create a new job',
            'GET /copilot_job/:id/status': 'Get simplified job status (id, status, currentStep, stepStatuses, duration)',
            'GET /copilot_job/:id': 'Get full job details',
            'GET /copilot_job/:id/log/:section': 'Get job log section (prechecks/work/postchecks/mergeback/cleanup/full)',
            'POST /copilot_job/:id/cancel': 'Cancel a job',
            'POST /copilot_job/:id/continue': 'Continue work on existing job with new instructions',
            'POST /copilot_job/:id/retry': 'Retry failed job with AI analysis (optional: {workContext: string})'
          }
        }));
        return;
      }
      
      res.statusCode = 404;
      res.end(JSON.stringify({error: 'Not found', path: url.pathname}));
    } catch (e: any) {
      res.statusCode = 500;
      res.end(JSON.stringify({error: String(e), message: e.message})); 
    } 
  }); 
  
  server.listen(port, host, () => {
    console.log(`Copilot Orchestrator HTTP API listening on http://${host}:${port}`);
  }); 
  
  return server; 
}
