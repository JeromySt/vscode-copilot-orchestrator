/**
 * @fileoverview Snapshot Validation Node Builder
 *
 * Constructs the auto-managed snapshot-validation node spec. This node is
 * injected into every plan during scaffolding and automatically wired to
 * depend on all user-defined leaf nodes.
 *
 * @module plan/svNodeBuilder
 */

import type { AgentSpec, ProcessSpec, WorkSpec } from './types/specs';

/**
 * Job spec structure for SV node (minimal interface).
 */
export interface SvJobSpec {
  producerId: string;
  name: string;
  task: string;
  dependencies: string[];
  prechecks?: AgentSpec;
  postchecks?: ProcessSpec;
  assignedWorktreePath?: string;
  work?: WorkSpec;
}

/**
 * Build a default verification agent spec for snapshot validation.
 *
 * When `verifyRiSpec` is not provided, this generates a premium-tier agent
 * spec that performs a comprehensive review of the accumulated plan work:
 * - Reads all job specs and attempt outcomes from the plan definition folder
 * - Compares intended work against actual git changes in the snapshot
 * - Verifies completeness: all jobs' deliverables are present and functional
 * - Flags any obvious issues, missing files, or incomplete implementations
 *
 * The agent is given access to the plan's specs directory so it can review
 * the full intent of each job and validate the implementation against it.
 *
 * @param targetBranch - The target branch name (for context in instructions).
 * @param planId - The plan UUID (for constructing the plan specs path).
 * @param repoPath - The repository root path (for `allowedFolders`).
 * @param jobSummaries - Short descriptions of each job for the agent's context.
 * @returns An `AgentSpec` with premium model tier and instructions.
 */
export function buildDefaultVerificationSpec(
  targetBranch: string,
  planId: string,
  repoPath: string,
  jobSummaries: Array<{ name: string; task: string }>,
): AgentSpec {
  const planSpecsDir = `${repoPath}/.orchestrator/plans/${planId}/specs`;
  const jobList = jobSummaries.map((j, i) => `${i + 1}. **${j.name}**: ${j.task}`).join('\n');

  return {
    type: 'agent',
    modelTier: 'premium',
    instructions: [
      `# Snapshot Verification — Final Review Before Merge`,
      ``,
      `You are reviewing the accumulated work from a Copilot Orchestrator plan before it merges to \`${targetBranch}\`.`,
      `Your goal is to ensure all planned work is present, correct, and complete in this snapshot.`,
      ``,
      `## Plan Jobs`,
      ``,
      `The plan contained these jobs:`,
      ``,
      jobList,
      ``,
      `## Verification Steps`,
      ``,
      `### 1. Review the plan specs`,
      `Read the job specification files in the plan directory to understand what each job was supposed to deliver.`,
      `The plan specs are located at: \`${planSpecsDir}\``,
      `Each subfolder contains the work/prechecks/postchecks specs and attempt logs for that job.`,
      ``,
      `### 2. Review the actual changes`,
      `Run \`git log --oneline --all\` and \`git diff --stat HEAD~10..HEAD\` (adjust range as needed) to see what files were changed.`,
      `Cross-reference the changes against each job's stated deliverables.`,
      ``,
      `### 3. Verify completeness`,
      `For each job, confirm:`,
      `- The files/changes described in its spec are present in the snapshot`,
      `- No placeholder or stub implementations remain (e.g., \`// TODO\`, \`throw new NotImplementedException()\`)`,
      `- Tests exist for new functionality (if the job spec mentioned tests)`,
      ``,
      `### 4. Check for obvious issues`,
      `- Look for compilation errors: run the project's build command if one is apparent`,
      `- Check for obvious runtime issues (null references, missing imports, broken references)`,
      `- Verify no files were accidentally deleted or overwritten by concurrent jobs`,
      ``,
      `### 5. Report`,
      `If everything looks correct, print:`,
      `\`✅ Snapshot verification passed: all ${jobSummaries.length} job deliverables confirmed present and complete.\``,
      ``,
      `If issues are found, fix them if possible. If they cannot be fixed, print a clear summary of what's missing or broken.`,
    ].join('\n'),
    allowedFolders: [planSpecsDir],
  };
}

/**
 * Build the snapshot-validation job spec.
 *
 * The SV node handles:
 * - Prechecks: target branch health + snapshot rebase if target advanced
 * - Work: verify-ri spec (optional user-provided validation)
 * - Postchecks: commit SHA comparison to detect target branch changes
 * - Dependencies: auto-wired to all user leaf nodes
 *
 * @param targetBranch - The target branch to merge to.
 * @param snapshotWorktreePath - Optional pre-assigned snapshot worktree path.
 * @param verifyRiSpec - Optional user-provided verify-ri validation spec.
 * @param defaultVerifySpec - Optional default verification spec (used when verifyRiSpec is not provided).
 * @returns A job spec object for the snapshot-validation node.
 */
export function buildSvJobSpec(
  targetBranch: string,
  snapshotWorktreePath?: string,
  verifyRiSpec?: any,
  defaultVerifySpec?: AgentSpec,
): SvJobSpec {
  // Prechecks: three-case logic for targetBranch health + snapshot rebase.
  // Runs in the snapshot worktree (HEAD = snapshot branch, shares refs with main repo).
  // The original base commit (targetBranch HEAD when snapshot was created) is written
  // to .orchestrator/snapshot-base by the runner at snapshot creation time.
  //
  // Case 1: targetBranch HEAD == snapshot base commit → success (no changes)
  // Case 2: targetBranch HEAD != snapshot base && target is clean → rebase snapshot
  //         onto new target HEAD, resolve any conflicts, complete success
  // Case 3: targetBranch HEAD != snapshot base && target is dirty → fail with
  //         user message explaining what to fix before retry
  const svPrechecks: AgentSpec = {
    type: 'agent',
    modelTier: 'fast',
    instructions: [
      `You are running in the snapshot worktree. Your job is to verify the target branch '${targetBranch}' is healthy and rebase the snapshot if the target has advanced.`,
      ``,
      `Step 1: Read the original snapshot base commit and the current target HEAD.`,
      `  SNAPSHOT_BASE = read the file .orchestrator/snapshot-base in the current directory`,
      `  TARGET_HEAD = run: git rev-parse "refs/heads/${targetBranch}"`,
      ``,
      `Step 2: Compare them.`,
      ``,
      `  Case A — TARGET_HEAD equals SNAPSHOT_BASE:`,
      `    The target branch has not changed since the snapshot was created.`,
      `    Print "✅ Target branch '${targetBranch}' unchanged since snapshot creation. No rebase needed."`,
      `    Exit successfully with no further action.`,
      ``,
      `  Case B — TARGET_HEAD does NOT equal SNAPSHOT_BASE:`,
      `    The target branch has advanced. Rebase the snapshot onto the new target HEAD:`,
      `    Run: git rebase --onto $TARGET_HEAD $SNAPSHOT_BASE HEAD`,
      ``,
      `      If the rebase succeeds cleanly:`,
      `        Update .orchestrator/snapshot-base to contain $TARGET_HEAD (the new base).`,
      `        Print "✅ Snapshot rebased onto updated '${targetBranch}' ($TARGET_HEAD)."`,
      `        Exit successfully.`,
      ``,
      `      If the rebase has conflicts:`,
      `        Resolve each conflict by examining both sides and producing a correct merge.`,
      `        For each conflicted file, choose the resolution that preserves both sets of changes.`,
      `        After resolving, run: git add <file> && git rebase --continue`,
      `        Repeat until rebase completes.`,
      `        Update .orchestrator/snapshot-base to contain $TARGET_HEAD (the new base).`,
      `        Print "✅ Snapshot rebased with conflict resolution onto '${targetBranch}'."`,
      `        Exit successfully.`,
      ``,
      `IMPORTANT: Do not modify any files except to resolve rebase conflicts and update .orchestrator/snapshot-base. Do not create commits beyond what git rebase produces.`,
    ].join('\n'),
    onFailure: {
      noAutoHeal: true,
      message: `Target branch '${targetBranch}' has uncommitted changes or is in a dirty state. Please clean up the target branch before retrying.`,
      resumeFromPhase: 'prechecks',
    },
  };

  // Postchecks: re-verify targetBranch hasn't moved since prechecks before merge-ri.
  // Reads .orchestrator/snapshot-base (updated by prechecks) and compares to current
  // targetBranch HEAD. If target advanced during work, fail and resume from prechecks
  // so the snapshot gets rebased again. Uses node.js for cross-platform compatibility
  // (bash not guaranteed on Windows, PowerShell can't handle bash syntax).
  //
  // NOTE: This runs in the SNAPSHOT worktree, so `git diff --quiet <target-ref>`
  // would compare the snapshot's files against the target branch — which will
  // ALWAYS differ because the snapshot has the merged plan work. We only need
  // to compare commit SHAs, not working tree content.
  const postcheckScript = [
    `const fs = require('fs');`,
    `const { execSync } = require('child_process');`,
    `try {`,
    `  const base = fs.readFileSync('.orchestrator/snapshot-base', 'utf8').trim();`,
    `  const head = execSync('git rev-parse "refs/heads/${targetBranch}"', { encoding: 'utf8' }).trim();`,
    `  if (head === base) {`,
    `    console.log('✅ Target branch ${targetBranch} unchanged since prechecks. Safe to merge.');`,
    `    process.exit(0);`,
    `  }`,
    `  console.error('❌ Target branch ${targetBranch} advanced during validation (' + base.slice(0,8) + ' -> ' + head.slice(0,8) + '). Needs rebase.');`,
    `  process.exit(1);`,
    `} catch (e) {`,
    `  console.error('❌ Post-check failed: ' + e.message);`,
    `  process.exit(1);`,
    `}`,
  ].join('\n');

  const svPostchecks: ProcessSpec = {
    type: 'process',
    executable: process.execPath,
    args: ['-e', postcheckScript],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    onFailure: {
      noAutoHeal: true,
      message: `Target branch '${targetBranch}' changed during validation. The plan will automatically retry from prechecks to rebase the snapshot.`,
      resumeFromPhase: 'prechecks',
    },
  };

  // Use user-provided verifyRiSpec, or fall back to the default verification spec.
  // The default spec performs a premium-tier AI review of all accumulated plan work
  // to catch completeness issues before merging to the target branch.
  const resolvedWork = verifyRiSpec || defaultVerifySpec;

  return {
    producerId: '__snapshot-validation__',
    name: 'Snapshot Validation',
    task: `Validate snapshot and merge to '${targetBranch}'`,
    dependencies: [], // Will be auto-wired by rewireSvDependencies()
    prechecks: svPrechecks,
    work: resolvedWork,
    postchecks: svPostchecks,
    assignedWorktreePath: snapshotWorktreePath,
  };
}
