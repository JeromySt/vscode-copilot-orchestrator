/**
 * @fileoverview Job Splitter Implementation
 *
 * Converts a checkpoint manifest into sub-job work chunks and specs for the
 * fan-out/fan-in DAG reshaping pattern. See docs/CONTEXT_PRESSURE_DESIGN.md §7.
 *
 * @module plan/analysis/jobSplitter
 */

import type {
  IJobSplitter,
  CheckpointManifest,
  WorkChunk,
  ManifestCodebaseContext,
} from '../../interfaces/IJobSplitter';
import type { AgentSpec } from '../types/specs';
import type { JobNodeSpec } from '../types/nodes';
import type { IConfigProvider } from '../../interfaces/IConfigProvider';

const DEFAULT_MAX_SUB_JOBS = 8;
const CONFIG_SECTION = 'copilotOrchestrator';
const CONFIG_KEY_MAX_SUB_JOBS = 'contextPressure.maxSubJobs';

/**
 * Default implementation of {@link IJobSplitter}.
 *
 * Chunk strategy:
 * - Primary: agent's `suggestedSplits` sorted by priority
 * - Fallback: naive batch-by-2 with inProgress getting its own chunk
 *
 * Sub-job specs use premium model tier with fresh sessions (no parent session resume).
 */
export class DefaultJobSplitter implements IJobSplitter {
  constructor(
    private readonly configProvider: IConfigProvider,
  ) {}

  buildChunks(manifest: CheckpointManifest, _originalInstructions: string): WorkChunk[] {
    const maxSubJobs = this.configProvider.getConfig<number>(
      CONFIG_SECTION,
      CONFIG_KEY_MAX_SUB_JOBS,
      DEFAULT_MAX_SUB_JOBS,
    );

    let chunks: WorkChunk[];

    // Primary: use agent's suggested splits (agent knows the work best)
    if (manifest.suggestedSplits && manifest.suggestedSplits.length > 0) {
      chunks = manifest.suggestedSplits
        .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
        .map(split => ({
          name: split.name,
          files: split.files,
          description: split.name,
          prompt: split.prompt,
          priority: split.priority ?? 99,
        }));
    } else {
      // Fallback: naive batching
      chunks = this.buildNaiveChunks(manifest);
    }

    // Cap at maxSubJobs — batch excess items into the last chunk
    if (chunks.length > maxSubJobs) {
      const kept = chunks.slice(0, maxSubJobs);
      const excess = chunks.slice(maxSubJobs);
      const lastChunk = kept[kept.length - 1];
      for (const extra of excess) {
        lastChunk.files.push(...extra.files);
        if (extra.description) {
          lastChunk.description += '\n' + extra.description;
        }
      }
      chunks = kept;
    }

    return chunks;
  }

  buildSubJobSpec(chunk: WorkChunk, manifest: CheckpointManifest, parentNodeId: string): AgentSpec {
    const completedList = manifest.completed
      .map(f => `- ✅ \`${f.file}\`: ${f.summary}`)
      .join('\n');

    const instructions = chunk.prompt
      ? this.buildAgentPromptInstructions(chunk, completedList)
      : this.buildFallbackInstructions(chunk, manifest, parentNodeId, completedList);

    return {
      type: 'agent',
      modelTier: 'premium',
      resumeSession: false,
      instructions,
    };
  }

  buildFanInSpec(parentNode: JobNodeSpec, subJobProducerIds: string[]): JobNodeSpec {
    return {
      producerId: `${parentNode.producerId}-fan-in`,
      name: `${parentNode.name ?? parentNode.producerId} (validate)`,
      task: 'Validate combined sub-job output',
      work: { type: 'shell', command: 'true' },
      postchecks: parentNode.postchecks,
      dependencies: subJobProducerIds,
      autoHeal: true,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private buildNaiveChunks(manifest: CheckpointManifest): WorkChunk[] {
    const chunks: WorkChunk[] = [];

    // If there's an in-progress file, it gets its own chunk (highest priority)
    if (manifest.inProgress) {
      chunks.push({
        files: [manifest.inProgress.file],
        description: `Complete ${manifest.inProgress.file}: ${manifest.inProgress.remainingParts}`,
        priority: 1,
      });
    }

    // Group remaining items: max 2 files per chunk
    const remaining = [...manifest.remaining];
    let priorityCounter = chunks.length > 0 ? 2 : 1;
    while (remaining.length > 0) {
      const batch = remaining.splice(0, 2);
      chunks.push({
        files: batch.map(r => r.file),
        description: batch.map(r => `${r.file}: ${r.description}`).join('\n'),
        priority: priorityCounter++,
      });
    }

    return chunks;
  }

  private buildAgentPromptInstructions(chunk: WorkChunk, completedList: string): string {
    return `# Continuation Task — ${chunk.name}

You are continuing work that a prior agent checkpointed due to context pressure.
The prior agent's completed work is already in this worktree via forward integration.

## Already Completed (DO NOT modify)
${completedList}

## Your Assignment (from the prior agent)
${chunk.prompt}

## Rules
- ONLY work on the files listed in your assignment
- DO NOT modify completed files
- Implement REAL, functional code — not stubs or placeholders
- Write tests alongside implementations where required
- Commit when done
`;
  }

  private buildFallbackInstructions(
    chunk: WorkChunk,
    manifest: CheckpointManifest,
    parentNodeId: string,
    completedList: string,
  ): string {
    const fileList = chunk.files.map(f => `- \`${f}\``).join('\n');
    const codebaseCtx = manifest.codebaseContext
      ? formatCodebaseContext(manifest.codebaseContext)
      : '(not provided)';

    return `# Continuation Task — ${chunk.description}

You are continuing work that a prior agent checkpointed due to context pressure.
The prior agent's completed work is already in this worktree via forward integration.

## Already Completed (DO NOT modify)
${completedList}

## Your Assignment
${fileList}

## Original Specification
The parent job's full specification is available at:
\`.github/instructions/orchestrator-job-${parentNodeId}.md\`
Read this file for the complete task description, constraints, and acceptance criteria.
Focus only on the files listed in "Your Assignment" above.

## Codebase Context
${codebaseCtx}

## Rules
- ONLY work on the files listed in "Your Assignment"
- DO NOT modify completed files
- Implement REAL, functional code — not stubs or placeholders
- Write tests alongside implementations where required
- Commit when done
`;
  }
}

/**
 * Format codebase context from the manifest into a readable Markdown block.
 */
function formatCodebaseContext(ctx: ManifestCodebaseContext): string {
  const lines: string[] = [];

  if (ctx.buildCommand) {
    lines.push(`- **Build**: \`${ctx.buildCommand}\``);
  }
  if (ctx.testCommand) {
    lines.push(`- **Test**: \`${ctx.testCommand}\``);
  }
  if (ctx.projectStructure) {
    lines.push(`- **Project structure**: ${ctx.projectStructure}`);
  }
  if (ctx.conventions) {
    lines.push(`- **Conventions**: ${ctx.conventions}`);
  }
  if (ctx.warnings) {
    lines.push(`- **⚠️ Warnings**: ${ctx.warnings}`);
  }

  return lines.length > 0 ? lines.join('\n') : '(not provided)';
}
