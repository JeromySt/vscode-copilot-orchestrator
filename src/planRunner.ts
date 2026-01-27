
import * as vscode from 'vscode';
import { JobRunner, JobSpec } from './jobRunner';
export type PlanJob = { id: string; task?: string; dependsOn?: string[]; inputs: { baseBranch: string; targetBranch: string; instructions?: string } };
export type PlanSpec = { id: string; maxParallel?: number; worktreeRoot?: string; repoPath?: string; jobs: PlanJob[] };
export type PlanState = { id: string; status: 'queued'|'running'|'succeeded'|'failed'|'canceled'|'partial'; queued: string[]; running: string[]; done: string[]; failed: string[]; canceled: string[]; submitted: string[]; startedAt?: number; endedAt?: number };
export class PlanRunner { private plans = new Map<string, PlanState>(); private interval?: NodeJS.Timer; constructor(private runner: JobRunner){}
  list(): PlanState[] { return Array.from(this.plans.values()); }
  enqueue(spec: PlanSpec){ const id = spec.id; const state: PlanState = { id, status:'queued', queued:[], running:[], done:[], failed:[], canceled:[], submitted:[] }; state.queued = spec.jobs.filter(j=> (j.dependsOn||[]).length===0).map(j=>j.id); this.plans.set(id,state); if (!this.interval) this.interval = setInterval(()=>this.pump(spec), 500); }
  cancel(id: string){ const p = this.plans.get(id); if (!p) return; p.status='canceled'; p.endedAt=Date.now(); }
  get(id: string){ return this.plans.get(id); }
  private pump(spec: PlanSpec){ 
    const p = this.plans.get(spec.id); 
    if (!p) return; 
    if (['canceled','succeeded','failed','partial'].includes(p.status)) return; 
    const ws = (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)!; 
    const worktreeRoot = spec.worktreeRoot||'.worktrees'; 
    const maxP = spec.maxParallel && spec.maxParallel>0? spec.maxParallel : (this.runner as any).maxWorkers || 1; 
    if (!p.startedAt) p.startedAt=Date.now(); 
    p.status='running';
    
    while (p.running.length < maxP && p.queued.length){ 
      const jobId = p.queued.shift()!; 
      const j = spec.jobs.find(x=>x.id===jobId)!; 
      const guid = require('crypto').randomUUID(); 
      const specJ: JobSpec = { 
        id: guid, 
        name: jobId, 
        task: j.task||'plan-job', 
        inputs:{ 
          repoPath: spec.repoPath||ws, 
          baseBranch: j.inputs.baseBranch, 
          targetBranch: j.inputs.targetBranch, 
          worktreeRoot, 
          instructions: j.inputs.instructions||'' 
        }, 
        policy:{ 
          useJust: true, 
          steps:{ 
            prechecks:'npm ci || true', 
            work:'npm run work || echo work', 
            postchecks:'npm test || true' 
          } 
        } 
      }; 
      this.runner.enqueue(specJ); 
      p.submitted.push(jobId); 
      p.running.push(jobId); 
    }
    
    const jobs = this.runner.list(); 
    for (const r of jobs){ 
      // Match by job name (which is the plan job ID) instead of GUID
      const pj = spec.jobs.find(j=> r.name === j.id || r.inputs.targetBranch===j.inputs.targetBranch); 
      if (!pj) continue; 
      const jid = pj.id; 
      if (r.status==='succeeded' && p.running.includes(jid)){ 
        p.running = p.running.filter(x=>x!==jid); 
        p.done.push(jid); 
        const deps = spec.jobs.filter(x=> (x.dependsOn||[]).includes(jid)); 
        for (const d of deps){ 
          const ready = (d.dependsOn||[]).every(x=> p.done.includes(x)); 
          const notQueued = !p.submitted.includes(d.id) && !p.queued.includes(d.id); 
          if (ready && notQueued) p.queued.push(d.id); 
        } 
      }
      else if (r.status==='failed' && p.running.includes(jid)){ 
        p.running = p.running.filter(x=>x!==jid); 
        p.failed.push(jid); 
      }
      else if (r.status==='canceled' && p.running.includes(jid)){ 
        p.running = p.running.filter(x=>x!==jid); 
        p.canceled.push(jid); 
      } 
    }
    
    const total = spec.jobs.length; 
    const finished = p.done.length + p.failed.length + p.canceled.length; 
    if (finished===total && p.running.length===0 && p.queued.length===0){ 
      p.endedAt=Date.now(); 
      if (p.failed.length>0) p.status = p.done.length>0? 'partial':'failed'; 
      else if (p.canceled.length>0) p.status = 'partial'; 
      else p.status='succeeded'; 
    }
  }
}
