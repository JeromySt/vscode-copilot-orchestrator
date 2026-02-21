/**
 * @fileoverview FileSystem Plan Store Implementation
 * 
 * Implements IPlanRepositoryStore for filesystem-based plan storage.
 * All file I/O goes through the injected IFileSystem interface for testability.
 * 
 * @module plan/store/FileSystemPlanStore
 */

import * as path from 'path';
import type { 
  IPlanRepositoryStore, 
  StoredPlanMetadata, 
  StoredJobMetadata 
} from '../../interfaces/IPlanRepositoryStore';
import type { WorkSpec } from '../types/specs';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import { Logger } from '../../core/logger';

const log = Logger.for('plan-persistence');

export class FileSystemPlanStore implements IPlanRepositoryStore {
  constructor(
    private readonly storagePath: string,
    private readonly workspacePath: string,
    private readonly fs: IFileSystem,
  ) {}

  async readPlanMetadata(planId: string): Promise<StoredPlanMetadata | undefined> {
    const planFile = path.join(this.storagePath, planId, 'plan.json');
    try {
      const content = await this.fs.readFileAsync(planFile);
      return JSON.parse(content) as StoredPlanMetadata;
    } catch (error) {
      if ((error as any)?.code === 'ENOENT') { return undefined; }
      log.error(`Failed to read plan metadata for ${planId}`, { error: (error as Error).message });
      throw error;
    }
  }

  readPlanMetadataSync(planId: string): StoredPlanMetadata | undefined {
    const planFile = path.join(this.storagePath, planId, 'plan.json');
    try {
      const content = this.fs.readFileSync(planFile);
      return JSON.parse(content) as StoredPlanMetadata;
    } catch (error) {
      if ((error as any)?.code === 'ENOENT') { return undefined; }
      return undefined;
    }
  }

  async writePlanMetadata(metadata: StoredPlanMetadata): Promise<void> {
    const planDir = path.join(this.storagePath, metadata.id);
    const planFile = path.join(planDir, 'plan.json');
    const tempFile = path.join(planDir, '.plan.json.tmp');
    try {
      await this.fs.mkdirAsync(planDir, { recursive: true });
      await this.fs.writeFileAsync(tempFile, JSON.stringify(metadata, null, 2));
      await this.fs.renameAsync(tempFile, planFile);
    } catch (error) {
      log.error(`Failed to write plan metadata for ${metadata.id}`, { error: (error as Error).message });
      try { await this.fs.unlinkAsync(tempFile); } catch { /* ignore */ }
      throw error;
    }
  }

  writePlanMetadataSync(metadata: StoredPlanMetadata): void {
    const planDir = path.join(this.storagePath, metadata.id);
    const planFile = path.join(planDir, 'plan.json');
    const tempFile = path.join(planDir, '.plan.json.tmp');
    try {
      this.fs.mkdirSync(planDir, { recursive: true });
      this.fs.writeFileSync(tempFile, JSON.stringify(metadata, null, 2));
      this.fs.renameSync(tempFile, planFile);
    } catch (error) {
      log.error(`Failed to write plan metadata sync for ${metadata.id}`, { error: (error as Error).message });
      try { this.fs.unlinkSync(tempFile); } catch { /* ignore */ }
      throw error;
    }
  }

  async readNodeSpec(planId: string, nodeId: string, phase: 'work' | 'prechecks' | 'postchecks'): Promise<WorkSpec | undefined> {
    const specFile = this.getSpecFilePath(planId, nodeId, phase);
    try {
      const content = await this.fs.readFileAsync(specFile);
      const spec = JSON.parse(content) as any;
      // For agent specs, hydrate instructions from companion .md file
      if (spec?.type === 'agent' && spec?.instructionsFile) {
        try {
          const mdPath = path.join(path.dirname(specFile), spec.instructionsFile);
          spec.instructions = await this.fs.readFileAsync(mdPath);
          delete spec.instructionsFile;
        } catch { /* md file missing — fall through with inline instructions if any */ }
      }
      return spec as WorkSpec;
    } catch (error) {
      // Backwards compat: try legacy work.md path for old plans
      if ((error as any)?.code === 'ENOENT' && phase === 'work') {
        const legacyPath = path.join(path.dirname(specFile), 'work.md');
        try {
          const content = await this.fs.readFileAsync(legacyPath);
          // Legacy work.md could be raw JSON or raw text
          try { return JSON.parse(content) as WorkSpec; } catch { return content as any; }
        } catch { /* no legacy file either */ }
      }
      if ((error as any)?.code === 'ENOENT') { return undefined; }
      log.error(`Failed to read node spec for ${planId}/${nodeId}/${phase}`, { error: (error as Error).message });
      throw error;
    }
  }

  async writeNodeSpec(planId: string, nodeId: string, phase: 'work' | 'prechecks' | 'postchecks', spec: WorkSpec): Promise<void> {
    await this.ensureNodeSpecDir(planId, nodeId);
    const specFile = this.getSpecFilePath(planId, nodeId, phase);
    try {
      const specObj = typeof spec === 'string' ? { type: 'shell', command: spec } : { ...spec as any };
      // For agent specs (any phase), extract instructions into a companion .md file
      if (specObj.type === 'agent' && specObj.instructions) {
        const mdFileName = `${phase}_instructions.md`;
        const mdFile = path.join(path.dirname(specFile), mdFileName);
        await this.fs.writeFileAsync(mdFile, specObj.instructions);
        specObj.instructionsFile = mdFileName;
        delete specObj.instructions;
      }
      await this.fs.writeFileAsync(specFile, JSON.stringify(specObj, null, 2));
    } catch (error) {
      log.error(`Failed to write node spec for ${planId}/${nodeId}/${phase}`, { error: (error as Error).message });
      throw error;
    }
  }

  async moveFileToSpec(planId: string, nodeId: string, phase: 'work' | 'prechecks' | 'postchecks', sourcePath: string): Promise<void> {
    const resolvedSource = path.resolve(sourcePath);
    const resolvedWorkspace = path.resolve(this.workspacePath);
    if (!resolvedSource.startsWith(resolvedWorkspace + path.sep)) {
      throw new Error(`Source path ${sourcePath} is outside workspace boundary`);
    }
    const basename = path.basename(resolvedSource);
    if (!basename || basename === '.' || basename === '..' || basename === '.git') {
      throw new Error(`Invalid source path: ${sourcePath}`);
    }
    await this.ensureNodeSpecDir(planId, nodeId);
    const destPath = this.getSpecFilePath(planId, nodeId, phase);
    try {
      await this.fs.renameAsync(resolvedSource, destPath);
    } catch (error) {
      log.error(`Failed to move file to spec ${planId}/${nodeId}/${phase}`, { source: sourcePath, dest: destPath, error: (error as Error).message });
      throw error;
    }
  }

  async hasNodeSpec(planId: string, nodeId: string, phase: 'work' | 'prechecks' | 'postchecks'): Promise<boolean> {
    try { await this.fs.accessAsync(this.getSpecFilePath(planId, nodeId, phase)); return true; } catch { return false; }
  }

  async listPlanIds(): Promise<string[]> {
    const planIds: string[] = [];
    if (!(await this.fs.existsAsync(this.storagePath))) { return planIds; }
    try {
      const entries = await this.fs.readdirAsync(this.storagePath);
      for (const entry of entries) {
        const entryPath = path.join(this.storagePath, entry);
        try {
          const stats = await this.fs.lstatAsync(entryPath);
          if (stats.isDirectory()) {
            if (await this.fs.existsAsync(path.join(entryPath, 'plan.json'))) { planIds.push(entry); }
          } else if (stats.isFile() && entry.startsWith('plan-') && entry.endsWith('.json')) {
            planIds.push(entry.slice(5, -5));
          }
        } catch { /* skip */ }
      }
    } catch (error) {
      log.error('Failed to list plan IDs', { error: (error as Error).message });
      throw error;
    }
    return planIds;
  }

  async deletePlan(planId: string): Promise<void> {
    try {
      await this.fs.rmAsync(path.join(this.storagePath, planId), { recursive: true, force: true });
      const indexPath = path.join(this.storagePath, 'plans-index.json');
      try {
        if (this.fs.existsSync(indexPath)) {
          const index = this.fs.readJSON<{ plans: Record<string, any> }>(indexPath, { plans: {} });
          if (index.plans?.[planId]) { delete index.plans[planId]; this.fs.writeJSON(indexPath, index); }
        }
      } catch { /* ignore */ }
    } catch (error) {
      log.error(`Failed to delete plan ${planId}`, { error: (error as Error).message });
      throw error;
    }
  }

  async exists(planId: string): Promise<boolean> {
    return this.fs.existsAsync(path.join(this.storagePath, planId, 'plan.json'));
  }

  async snapshotSpecsForAttempt(planId: string, nodeId: string, attemptNumber: number): Promise<void> {
    const attemptDir = this.getAttemptDir(planId, nodeId, attemptNumber);
    await this.fs.mkdirAsync(attemptDir, { recursive: true });
    if (attemptNumber === 1) {
      const currentPath = this.getCurrentSymlinkPath(planId, nodeId);
      try {
        const stats = await this.fs.lstatAsync(currentPath);
        if (stats.isDirectory() && !stats.isSymbolicLink()) {
          const files = await this.fs.readdirAsync(currentPath);
          for (const file of files) { await this.fs.renameAsync(path.join(currentPath, file), path.join(attemptDir, file)); }
          await this.fs.rmdirAsync(currentPath);
        }
      } catch { /* expected */ }
    } else {
      // Copy spec files from previous attempt — but NOT execution.log (each attempt gets a fresh log)
      const prevDir = this.getAttemptDir(planId, nodeId, attemptNumber - 1);
      try {
        const files = await this.fs.readdirAsync(prevDir);
        for (const file of files) {
          if (file === 'execution.log') { continue; } // Each attempt starts with a fresh log
          await this.fs.copyFileAsync(path.join(prevDir, file), path.join(attemptDir, file));
        }
      } catch { /* prev may not exist */ }
    }
    await this.pointCurrentToAttempt(planId, nodeId, attemptNumber);
    log.debug(`Snapshotted specs for attempt ${attemptNumber}`, { planId, nodeId, attemptNumber });
  }

  async readNodeSpecForAttempt(planId: string, nodeId: string, phase: 'work' | 'prechecks' | 'postchecks', attemptNumber: number): Promise<WorkSpec | undefined> {
    const specFile = this.getAttemptSpecFilePath(planId, nodeId, phase, attemptNumber);
    try {
      const content = await this.fs.readFileAsync(specFile);
      return phase === 'work' ? content : JSON.parse(content) as WorkSpec;
    } catch (error) {
      if ((error as any)?.code === 'ENOENT') { return undefined; }
      log.error(`Failed to read spec for attempt ${attemptNumber}`, { planId, nodeId, phase, error: (error as Error).message });
      throw error;
    }
  }

  async migrateLegacy(planId: string): Promise<void> {
    const legacyFile = path.join(this.storagePath, `plan-${planId}.json`);
    try {
      const content = await this.fs.readFileAsync(legacyFile);
      const lp = JSON.parse(content);
      const metadata: StoredPlanMetadata = {
        id: lp.id, spec: lp.spec, jobs: [], producerIdToNodeId: lp.producerIdToNodeId || {},
        roots: lp.roots || [], leaves: lp.leaves || [], nodeStates: lp.nodeStates || {},
        groups: lp.groups, groupStates: lp.groupStates, groupPathToId: lp.groupPathToId,
        parentPlanId: lp.parentPlanId, parentNodeId: lp.parentNodeId, repoPath: lp.repoPath,
        baseBranch: lp.baseBranch, baseCommitAtStart: lp.baseCommitAtStart, targetBranch: lp.targetBranch,
        worktreeRoot: lp.worktreeRoot, createdAt: lp.createdAt, startedAt: lp.startedAt, endedAt: lp.endedAt,
        stateVersion: lp.stateVersion, cleanUpSuccessfulWork: lp.cleanUpSuccessfulWork !== false,
        maxParallel: lp.maxParallel || 0, workSummary: lp.workSummary, isPaused: lp.isPaused,
        branchReady: lp.branchReady, snapshot: lp.snapshot,
      };
      const jobsByPid = new Map<string, any>();
      for (const j of lp.spec?.jobs || []) { if (j.producerId) { jobsByPid.set(j.producerId, j); } }
      for (const n of lp.nodes || []) {
        const nm: StoredJobMetadata = { id: n.id, producerId: n.producerId, name: n.name, task: n.task, dependencies: n.dependencies || [], group: n.group, hasWork: false, hasPrechecks: false, hasPostchecks: false };
        const w = n.work || jobsByPid.get(n.producerId)?.work || n.inlineWork;
        if (w) { await this.writeNodeSpec(planId, n.id, 'work', w); nm.hasWork = true; }
        const pc = n.prechecks || jobsByPid.get(n.producerId)?.prechecks || n.inlinePrechecks;
        if (pc) { await this.writeNodeSpec(planId, n.id, 'prechecks', pc); nm.hasPrechecks = true; }
        const poc = n.postchecks || jobsByPid.get(n.producerId)?.postchecks || n.inlinePostchecks;
        if (poc) { await this.writeNodeSpec(planId, n.id, 'postchecks', poc); nm.hasPostchecks = true; }
        const ns = lp.nodeStates?.[n.id];
        const ah: any[] = ns?.attemptHistory || [];
        if (ah.length > 0) {
          for (const a of ah) {
            if (!a.attemptNumber) { continue; }
            const ad = this.getAttemptDir(planId, n.id, a.attemptNumber);
            await this.fs.mkdirAsync(ad, { recursive: true });
            if (a.workUsed) { await this.fs.writeFileAsync(path.join(ad, 'work.json'), typeof a.workUsed === 'string' ? a.workUsed : JSON.stringify(a.workUsed, null, 2)); }
            if (pc) { await this.fs.writeFileAsync(path.join(ad, 'prechecks.json'), typeof pc === 'string' ? pc : JSON.stringify(pc, null, 2)); }
            if (poc) { await this.fs.writeFileAsync(path.join(ad, 'postchecks.json'), typeof poc === 'string' ? poc : JSON.stringify(poc, null, 2)); }
          }
          const latest = Math.max(...ah.map((a: any) => a.attemptNumber || 0));
          if (latest > 0) {
            const cl = this.getCurrentSymlinkPath(planId, n.id);
            try { const s = await this.fs.lstatAsync(cl); if (s.isDirectory() && !s.isSymbolicLink()) { const f = await this.fs.readdirAsync(cl); const ld = this.getAttemptDir(planId, n.id, latest); for (const fi of f) { try { await this.fs.accessAsync(path.join(ld, fi)); } catch { await this.fs.copyFileAsync(path.join(cl, fi), path.join(ld, fi)); } } await this.fs.rmAsync(cl, { recursive: true, force: true }); } } catch { /* ok */ }
            await this.pointCurrentToAttempt(planId, n.id, latest);
          }
        }
        metadata.jobs.push(nm);
      }
      const logsDir = path.join(path.dirname(this.storagePath), 'logs');
      for (const nd of metadata.jobs) {
        const ns = lp.nodeStates?.[nd.id]; const ah: any[] = ns?.attemptHistory || [];
        for (const a of ah) { if (!a.attemptNumber) continue; const k = `${planId}_${nd.id}_${a.attemptNumber}`; const old = path.join(logsDir, `${k}.log`); if (this.fs.existsSync(old)) { const ad = this.getAttemptDir(planId, nd.id, a.attemptNumber); await this.fs.mkdirAsync(ad, { recursive: true }); try { await this.fs.renameAsync(old, path.join(ad, 'execution.log')); } catch { try { await this.fs.copyFileAsync(old, path.join(ad, 'execution.log')); await this.fs.unlinkAsync(old); } catch { /* */ } } } }
        if (ah.length === 0 && ns?.attempts) { for (let i = 1; i <= ns.attempts; i++) { const old = path.join(logsDir, `${planId}_${nd.id}_${i}.log`); if (this.fs.existsSync(old)) { const ad = this.getAttemptDir(planId, nd.id, i); await this.fs.mkdirAsync(ad, { recursive: true }); try { await this.fs.renameAsync(old, path.join(ad, 'execution.log')); } catch { try { await this.fs.copyFileAsync(old, path.join(ad, 'execution.log')); await this.fs.unlinkAsync(old); } catch { /* */ } } } } }
      }
      if (metadata.spec?.jobs) { for (const j of metadata.spec.jobs) { const nid = metadata.producerIdToNodeId?.[j.producerId]; if (!nid) continue; if (j.work?.type === 'agent' && j.work?.instructions) { j.work.instructionsRef = `specs/${nid}/current/work.json`; delete j.work.instructions; } if (j.prechecks?.type === 'agent' && j.prechecks?.instructions) { j.prechecks.instructionsRef = `specs/${nid}/current/prechecks.json`; delete j.prechecks.instructions; } if (j.postchecks?.type === 'agent' && j.postchecks?.instructions) { j.postchecks.instructionsRef = `specs/${nid}/current/postchecks.json`; delete j.postchecks.instructions; } if (j.work && j.work.type !== 'agent') { const nd = metadata.jobs.find(x => x.id === nid); if (nd?.hasWork) { j.work = { ref: `specs/${nid}/current/work.json` } as any; } } if (j.postchecks && typeof j.postchecks !== 'string' && j.postchecks?.type !== 'agent') { const nd = metadata.jobs.find(x => x.id === nid); if (nd?.hasPostchecks) { j.postchecks = { ref: `specs/${nid}/current/postchecks.json` } as any; } } if (typeof j.postchecks === 'string') { const nd = metadata.jobs.find(x => x.id === nid); if (nd?.hasPostchecks) { j.postchecks = { ref: `specs/${nid}/current/postchecks.json` } as any; } } } }
      for (const [, ns] of Object.entries(metadata.nodeStates || {})) { const s = ns as any; if (s.attemptHistory) { for (const a of s.attemptHistory) { if (a.workUsed) { const nid = Object.entries(metadata.producerIdToNodeId || {}).find(([, id]) => id === s.id)?.[1] || s.id; a.workUsedRef = `specs/${nid || 'unknown'}/attempts/${a.attemptNumber}/work.json`; delete a.workUsed; } if (a.logs && typeof a.logs === 'string' && a.logs.length > 100) { a.logsRef = `specs/${a.nodeId || 'unknown'}/attempts/${a.attemptNumber}/execution.log`; delete a.logs; } } } }
      await this.writePlanMetadata(metadata);
      await this.fs.unlinkAsync(legacyFile);
      log.info(`Migrated legacy plan ${planId} to new format`);
    } catch (error) { log.error(`Failed to migrate legacy plan ${planId}`, { error: (error as Error).message }); throw error; }
  }

  private getSpecFilePath(planId: string, nodeId: string, phase: 'work' | 'prechecks' | 'postchecks'): string {
    return path.join(this.storagePath, planId, 'specs', nodeId, 'current', `${phase}.json`);
  }
  private getAttemptSpecFilePath(planId: string, nodeId: string, phase: 'work' | 'prechecks' | 'postchecks', attemptNumber: number): string {
    return path.join(this.storagePath, planId, 'specs', nodeId, 'attempts', String(attemptNumber), `${phase}.json`);
  }
  private getCurrentSymlinkPath(planId: string, nodeId: string): string {
    return path.join(this.storagePath, planId, 'specs', nodeId, 'current');
  }
  private getAttemptDir(planId: string, nodeId: string, attemptNumber: number): string {
    return path.join(this.storagePath, planId, 'specs', nodeId, 'attempts', String(attemptNumber));
  }

  private async ensureNodeSpecDir(planId: string, nodeId: string): Promise<void> {
    const currentLink = this.getCurrentSymlinkPath(planId, nodeId);
    try {
      const stats = await this.fs.lstatAsync(currentLink);
      if (stats.isSymbolicLink()) { return; }
      if (process.platform === 'win32') { try { await this.fs.readlinkAsync(currentLink); return; } catch { /* not junction */ } }
    } catch { /* create */ }
    const attemptDir = this.getAttemptDir(planId, nodeId, 1);
    await this.fs.mkdirAsync(attemptDir, { recursive: true });
    try {
      const stats = await this.fs.lstatAsync(currentLink);
      if (stats.isDirectory()) { const files = await this.fs.readdirAsync(currentLink); for (const f of files) { await this.fs.renameAsync(path.join(currentLink, f), path.join(attemptDir, f)); } await this.fs.rmdirAsync(currentLink); }
    } catch { /* expected */ }
    await this.pointCurrentToAttempt(planId, nodeId, 1);
  }

  private async pointCurrentToAttempt(planId: string, nodeId: string, attemptNumber: number): Promise<void> {
    const currentLink = this.getCurrentSymlinkPath(planId, nodeId);
    const attemptDir = this.getAttemptDir(planId, nodeId, attemptNumber);
    try {
      const stats = await this.fs.lstatAsync(currentLink);
      if (stats.isSymbolicLink() || stats.isDirectory()) {
        if (process.platform === 'win32') { await this.fs.rmAsync(currentLink, { recursive: false, force: true }); }
        else { await this.fs.unlinkAsync(currentLink); }
      }
    } catch { /* doesn't exist */ }
    await this.fs.symlinkAsync(attemptDir, currentLink, process.platform === 'win32' ? 'junction' : 'dir');
  }
}