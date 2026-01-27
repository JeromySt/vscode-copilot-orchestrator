
import { spawnSync } from 'child_process';
import * as path from 'path';
import { ensureDir } from '../core/utils';
export type WorktreePlan = { jobId: string; repoPath: string; worktreeRoot: string; baseBranch: string; targetBranch: string };
function sh(cmd: string, cwd: string, log: (s:string)=>void) { const p = spawnSync(cmd, { cwd, shell:true, stdio:'pipe', encoding:'utf-8' }); if (p.stdout) log(p.stdout); if (p.stderr) log(p.stderr); if (p.status!==0) throw new Error(`Command failed (${p.status}): ${cmd}`); }
export function createWorktrees(plan: WorktreePlan, log:(s:string)=>void) {
  const { repoPath, worktreeRoot, baseBranch, targetBranch, jobId } = plan;
  const fs = require('fs');
  
  // Ensure orchestrator directories are in .gitignore to prevent tracking runtime data
  const gitignorePath = path.join(repoPath, '.gitignore');
  try {
    let gitignoreContent = '';
    if (fs.existsSync(gitignorePath)) {
      gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
    }
    
    let modified = false;
    
    // Add worktreeRoot to .gitignore if not already there
    const ignorePattern = worktreeRoot.startsWith('/') ? worktreeRoot : `/${worktreeRoot}`;
    if (!gitignoreContent.includes(worktreeRoot)) {
      gitignoreContent += (gitignoreContent.endsWith('\n') || gitignoreContent === '' ? '' : '\n') + 
                          `# Copilot Orchestrator\n${ignorePattern}\n`;
      modified = true;
    }
    
    // Add .orchestrator directory (contains logs, patches, job metadata)
    if (!gitignoreContent.includes('.orchestrator')) {
      gitignoreContent += (gitignoreContent.endsWith('\n') ? '' : '\n') + 
                          `/.orchestrator\n`;
      modified = true;
    }
    
    if (modified) {
      fs.writeFileSync(gitignorePath, gitignoreContent, 'utf-8');
      log(`[orchestrator] Updated .gitignore with orchestrator directories`);
    }
  } catch (e) {
    log(`[orchestrator] Warning: Could not update .gitignore: ${e}`);
  }
  
  sh(`git fetch --all --tags`, repoPath, log);
  
  // Switch to base branch - handle both local and remote-tracked branches
  sh(`git switch ${baseBranch}`, repoPath, log);
  
  // Try to pull if branch has upstream, otherwise skip
  const pullResult = spawnSync('git', ['pull', '--ff-only'], { 
    cwd: repoPath, 
    shell: true, 
    stdio: 'pipe', 
    encoding: 'utf-8' 
  });
  
  // Log output regardless of success (informational)
  if (pullResult.stdout) log(pullResult.stdout);
  if (pullResult.stderr && pullResult.status === 0) log(pullResult.stderr);
  
  // Only fail if pull failed for reasons other than "no tracking information"
  if (pullResult.status !== 0 && pullResult.stderr && !pullResult.stderr.includes('no tracking information')) {
    log(`[orchestrator] Warning: Pull failed - ${pullResult.stderr}`);
    // Don't throw, continue with current state
  }
  
  const wtRootAbs = path.join(repoPath, worktreeRoot); ensureDir(wtRootAbs);
  const jobRoot = path.join(wtRootAbs, jobId);
  
  // Check if worktree already exists (for retry/continue scenarios)
  const worktreeExists = fs.existsSync(jobRoot) && fs.existsSync(path.join(jobRoot, '.git'));
  
  if (worktreeExists) {
    log(`[orchestrator] Worktree already exists, reusing: ${jobRoot}`);
    // Just ensure we're on the right branch and up to date
    sh(`git -C "${jobRoot}" fetch --all`, repoPath, log);
    return jobRoot;
  }
  
  // Create new worktree
  ensureDir(jobRoot);
  
  // Use copilot_jobs/{guid} naming convention for safety and framework association
  const jobBranch = `copilot_jobs/${jobId}`;
  
  // Always create worktree from local branch (not origin) - let caller manage pushes
  // This ensures worktrees work with local-only branches
  sh(`git worktree add -B ${jobBranch} "${jobRoot}" "${baseBranch}"`, repoPath, log);
  
  sh(`git submodule update --init --recursive`, repoPath, log);
  sh(`git -C "${jobRoot}" config submodule.recurse true`, repoPath, log);
  const list = spawnSync('git', ['config','--file','.gitmodules','--get-regexp','^submodule\..*\.path$'], { cwd: repoPath, encoding:'utf-8' });
  const lines = list.stdout? list.stdout.trim().split(/\r?\n/) : [];
  for (const line of lines) {
    const m = line.match(/^submodule\.(.*?)\.path\s+(.*)$/); if (!m) continue; const name = m[1]; const smPath = m[2];
    const branchQ = spawnSync('git', ['config','--file','.gitmodules',`submodule.${name}.branch`], { cwd: repoPath, encoding:'utf-8' });
    const branch = (branchQ.stdout||'').trim() || 'main';
    const abs = path.join(repoPath, smPath); const dest = path.join(jobRoot, smPath); ensureDir(path.dirname(dest));
    const check = spawnSync('git', ['show-ref','--verify','--quiet',`refs/remotes/origin/${branch}`], { cwd: abs });
    if (check.status===0) sh(`git worktree add -B ${jobBranch} "${dest}" "origin/${branch}"`, abs, log);
    else { const head = spawnSync('git',['rev-parse','HEAD'],{cwd:abs,encoding:'utf-8'}).stdout.trim(); sh(`git worktree add "${dest}" ${head}`, abs, log); }
  }
  return jobRoot;
}
