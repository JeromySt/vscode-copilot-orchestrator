/**
 * @fileoverview Release Preparation Logic
 *
 * Provides default preparation tasks and execution logic for pre-PR
 * validation and quality checks. Tasks can be automated via Copilot or
 * executed manually by developers.
 *
 * @module plan/releasePreparation
 */

import * as path from 'path';
import * as fs from 'fs';
import type {
  PreparationTask,
  PrepTaskType,
  ReleaseInstructions,
} from './types/releasePrep';
import type { ReleaseDefinition } from './types/release';
import type { ICopilotRunner } from '../interfaces/ICopilotRunner';
import { Logger } from '../core/logger';

const log = Logger.for('plan');

// ============================================================================
// DEFAULT TASK GENERATION
// ============================================================================

/**
 * Generate default preparation tasks based on release type and content.
 * 
 * For releases created from plans, we can auto-generate changelog from plan
 * summaries. For releases from branches, changelog requires manual input.
 * 
 * @param release - The release definition
 * @returns Array of default preparation tasks
 */
export function getDefaultPrepTasks(release: ReleaseDefinition): PreparationTask[] {
  const tasks: PreparationTask[] = [];
  const hasPlans = release.planIds.length > 0;

  // Task 1: Update changelog
  tasks.push({
    id: 'update-changelog',
    type: 'update-changelog',
    title: 'Update CHANGELOG.md',
    description: hasPlans
      ? 'Generate changelog entries from plan summaries and commit messages'
      : 'Add release notes to CHANGELOG.md for this release',
    status: 'pending',
    required: true,
    automatable: hasPlans, // Can auto-generate from plans
  });

  // Task 2: Update version
  tasks.push({
    id: 'update-version',
    type: 'update-version',
    title: 'Update Version Numbers',
    description: 'Bump version in package.json and other version files',
    status: 'pending',
    required: true,
    automatable: false, // Requires user decision on version number
  });

  // Task 3: Update documentation
  tasks.push({
    id: 'update-docs',
    type: 'update-docs',
    title: 'Update Documentation',
    description: 'Review and update README.md and docs/ for new features',
    status: 'pending',
    required: false,
    automatable: true, // AI can scan for doc gaps
  });

  // Task 4: Create release notes
  if (hasPlans) {
    tasks.push({
      id: 'create-release-notes',
      type: 'create-release-notes',
      title: 'Generate Release Notes',
      description: 'Create comprehensive release notes from plan results',
      status: 'pending',
      required: false,
      automatable: true,
    });
  }

  // Task 5: Run checks (compile + tests)
  tasks.push({
    id: 'run-checks',
    type: 'run-checks',
    title: 'Run Build & Tests',
    description: 'Execute npm run compile && npm run test:unit to validate changes',
    status: 'pending',
    required: true,
    automatable: true,
  });

  // Task 6: AI review
  tasks.push({
    id: 'ai-review',
    type: 'ai-review',
    title: 'AI Quality Review',
    description: 'Run AI review to check for quality issues, security concerns, and missing tests',
    status: 'pending',
    required: false,
    automatable: true,
  });

  return tasks;
}

// ============================================================================
// TASK EXECUTION
// ============================================================================

/**
 * Execute a specific preparation task.
 * 
 * Delegates to task-specific handlers based on task type. Automatable tasks
 * use Copilot CLI to perform the work.
 * 
 * @param task - The task to execute
 * @param release - The release definition
 * @param copilotRunner - Copilot CLI runner for automated tasks
 * @param repoPath - Path to the repository (isolated clone for releases)
 * @returns Updated task with results
 */
export async function executeTask(
  task: PreparationTask,
  release: ReleaseDefinition,
  copilotRunner: ICopilotRunner,
  repoPath: string,
): Promise<PreparationTask> {
  if (!task.automatable) {
    throw new Error(`Task ${task.id} is not automatable and must be completed manually`);
  }

  log.info('Executing preparation task', { releaseId: release.id, taskId: task.id, type: task.type });

  const updatedTask: PreparationTask = {
    ...task,
    status: 'in-progress',
    startedAt: Date.now(),
  };

  try {
    switch (task.type) {
      case 'update-changelog':
        return await executeUpdateChangelog(updatedTask, release, copilotRunner, repoPath);
      
      case 'update-docs':
        return await executeUpdateDocs(updatedTask, release, copilotRunner, repoPath);
      
      case 'create-release-notes':
        return await executeCreateReleaseNotes(updatedTask, release, copilotRunner, repoPath);
      
      case 'run-checks':
        return await executeRunChecks(updatedTask, release, copilotRunner, repoPath);
      
      case 'ai-review':
        return await executeAIReview(updatedTask, release, copilotRunner, repoPath);
      
      default:
        throw new Error(`Unknown task type: ${task.type}`);
    }
  } catch (error) {
    log.error('Task execution failed', { 
      releaseId: release.id, 
      taskId: task.id, 
      error: (error as Error).message 
    });
    
    return {
      ...updatedTask,
      status: 'pending', // Reset to pending so it can be retried
      error: (error as Error).message,
      completedAt: Date.now(),
    };
  }
}

// ============================================================================
// TASK-SPECIFIC HANDLERS
// ============================================================================

/**
 * Execute changelog update task using Copilot to generate entries from plan data.
 */
async function executeUpdateChangelog(
  task: PreparationTask,
  release: ReleaseDefinition,
  copilotRunner: ICopilotRunner,
  repoPath: string,
): Promise<PreparationTask> {
  const changelogPath = path.join(repoPath, 'CHANGELOG.md');
  const hasChangelog = fs.existsSync(changelogPath);

  const taskDescription = hasChangelog
    ? `Update CHANGELOG.md with entries for release ${release.name}. Extract changes from the commits in the current branch.`
    : `Create CHANGELOG.md following Keep a Changelog format and add entries for release ${release.name}.`;

  const result = await copilotRunner.run({
    cwd: repoPath,
    task: taskDescription,
    model: 'claude-sonnet-4.5',
  });

  if (!result.success) {
    throw new Error(`Changelog update failed: ${result.error || 'Unknown error'}`);
  }

  return {
    ...task,
    status: 'completed',
    result: 'Changelog updated successfully',
    completedAt: Date.now(),
  };
}

/**
 * Execute documentation update task using Copilot to identify gaps.
 */
async function executeUpdateDocs(
  task: PreparationTask,
  release: ReleaseDefinition,
  copilotRunner: ICopilotRunner,
  repoPath: string,
): Promise<PreparationTask> {
  const taskDescription = `Review the changes in the current branch and update documentation (README.md, docs/) to reflect new features, API changes, or configuration updates. Ensure all new features are documented.`;

  const result = await copilotRunner.run({
    cwd: repoPath,
    task: taskDescription,
    model: 'claude-sonnet-4.5',
  });

  if (!result.success) {
    throw new Error(`Documentation update failed: ${result.error || 'Unknown error'}`);
  }

  return {
    ...task,
    status: 'completed',
    result: 'Documentation updated successfully',
    completedAt: Date.now(),
  };
}

/**
 * Execute release notes creation using Copilot to synthesize plan results.
 */
async function executeCreateReleaseNotes(
  task: PreparationTask,
  release: ReleaseDefinition,
  copilotRunner: ICopilotRunner,
  repoPath: string,
): Promise<PreparationTask> {
  const taskDescription = `Create comprehensive release notes in .github/RELEASE_NOTES.md for ${release.name}. Include: (1) Summary of changes, (2) New features, (3) Bug fixes, (4) Breaking changes if any, (5) Migration guide if needed. Extract information from commit messages and code changes.`;

  const result = await copilotRunner.run({
    cwd: repoPath,
    task: taskDescription,
    model: 'claude-sonnet-4.5',
  });

  if (!result.success) {
    throw new Error(`Release notes creation failed: ${result.error || 'Unknown error'}`);
  }

  return {
    ...task,
    status: 'completed',
    result: 'Release notes created at .github/RELEASE_NOTES.md',
    completedAt: Date.now(),
  };
}

/**
 * Execute build and test checks.
 */
async function executeRunChecks(
  task: PreparationTask,
  release: ReleaseDefinition,
  copilotRunner: ICopilotRunner,
  repoPath: string,
): Promise<PreparationTask> {
  // Check if package.json exists to determine the command
  const packageJsonPath = path.join(repoPath, 'package.json');
  const hasPackageJson = fs.existsSync(packageJsonPath);

  if (!hasPackageJson) {
    throw new Error('No package.json found - cannot determine check commands');
  }

  const taskDescription = `Run the build and test suite to validate the release: (1) Execute 'npm run compile' to ensure code compiles, (2) Execute 'npm run test:unit' to run the test suite. Report any failures.`;

  const result = await copilotRunner.run({
    cwd: repoPath,
    task: taskDescription,
    model: 'claude-sonnet-4.5',
  });

  if (!result.success) {
    throw new Error(`Checks failed: ${result.error || 'Build or tests failed'}`);
  }

  return {
    ...task,
    status: 'completed',
    result: 'All checks passed successfully',
    completedAt: Date.now(),
  };
}

/**
 * Execute AI quality review of the release changes.
 */
async function executeAIReview(
  task: PreparationTask,
  release: ReleaseDefinition,
  copilotRunner: ICopilotRunner,
  repoPath: string,
): Promise<PreparationTask> {
  const taskDescription = `Review the changes in the current branch for: (1) Code quality issues, (2) Security vulnerabilities, (3) Missing test coverage, (4) Potential bugs, (5) Documentation gaps. Create a review summary in .github/AI_REVIEW.md with findings and recommendations.`;

  const result = await copilotRunner.run({
    cwd: repoPath,
    task: taskDescription,
    model: 'claude-sonnet-4.5',
  });

  if (!result.success) {
    throw new Error(`AI review failed: ${result.error || 'Unknown error'}`);
  }

  return {
    ...task,
    status: 'completed',
    result: 'AI review completed - see .github/AI_REVIEW.md',
    completedAt: Date.now(),
  };
}

// ============================================================================
// TASK STATUS MANAGEMENT
// ============================================================================

/**
 * Mark a task as completed with optional result message.
 */
export function completeTask(task: PreparationTask, result?: string): PreparationTask {
  return {
    ...task,
    status: 'completed',
    result: result || task.result,
    completedAt: Date.now(),
  };
}

/**
 * Mark a task as skipped (optional tasks only).
 */
export function skipTask(task: PreparationTask): PreparationTask {
  if (task.required) {
    throw new Error(`Cannot skip required task: ${task.id}`);
  }

  return {
    ...task,
    status: 'skipped',
    completedAt: Date.now(),
  };
}

/**
 * Check if all required tasks are completed.
 */
export function areRequiredTasksComplete(tasks: PreparationTask[]): boolean {
  return tasks
    .filter((t) => t.required)
    .every((t) => t.status === 'completed');
}

// ============================================================================
// RELEASE INSTRUCTIONS
// ============================================================================

/**
 * Find or generate release instructions file.
 * 
 * Looks for .github/instructions/release.instructions.md in the repository.
 * If not found, generates a default template using Copilot.
 * 
 * @param repoPath - Path to the repository
 * @param copilotRunner - Copilot CLI runner for generating instructions
 * @returns Release instructions metadata
 */
export async function getOrCreateReleaseInstructions(
  repoPath: string,
  copilotRunner: ICopilotRunner,
): Promise<ReleaseInstructions> {
  const instructionsPath = path.join(repoPath, '.github', 'instructions', 'release.instructions.md');

  // Check if file already exists
  if (fs.existsSync(instructionsPath)) {
    const content = fs.readFileSync(instructionsPath, 'utf-8');
    log.info('Found existing release instructions', { path: instructionsPath });
    return {
      filePath: instructionsPath,
      content,
      source: 'existing',
    };
  }

  // Generate default instructions using Copilot
  log.info('Generating default release instructions', { path: instructionsPath });

  const taskDescription = `Create a comprehensive release instructions file at .github/instructions/release.instructions.md that includes:

1. Release Checklist - step-by-step preparation tasks
2. Documentation Standards - what documentation must be updated
3. Version Bump Conventions - how to choose version numbers (semver)
4. Pre-PR Validation Steps - required checks before creating PR
5. Review Guidelines - what reviewers should focus on
6. Security Checklist - security considerations for releases

Use markdown format with clear sections and actionable items.`;

  const result = await copilotRunner.run({
    cwd: repoPath,
    task: taskDescription,
    model: 'claude-sonnet-4.5',
  });

  if (!result.success) {
    throw new Error(`Failed to generate release instructions: ${result.error || 'Unknown error'}`);
  }

  // Read the generated content
  if (!fs.existsSync(instructionsPath)) {
    throw new Error('Release instructions file was not created');
  }

  const content = fs.readFileSync(instructionsPath, 'utf-8');

  return {
    filePath: instructionsPath,
    content,
    source: 'auto-generated',
  };
}
