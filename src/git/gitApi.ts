
import { spawnSync } from 'child_process';
export function listConflicts(repoPath: string): string[]{ const r = spawnSync('git',['diff','--name-only','--diff-filter=U'],{cwd:repoPath,encoding:'utf-8'}); return (r.stdout||'').trim().split(/\r?\n/).filter(Boolean); }
export async function stageAll(repoPath: string){ spawnSync('git',['add','--all'],{cwd:repoPath}); }
export async function commit(repoPath: string, message: string): Promise<boolean>{ const r = spawnSync('git',['commit','-m',message],{cwd:repoPath,encoding:'utf-8'}); return (r.status===0); }
export async function checkoutSide(repoPath: string, side:'ours'|'theirs', file:string){ spawnSync('git',['checkout',side,'--',file],{cwd:repoPath}); }
