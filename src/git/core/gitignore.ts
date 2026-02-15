/**
 * @fileoverview Helper functions for managing .gitignore entries
 * 
 * @module git/core/gitignore
 */

import * as path from 'path';
import * as fs from 'fs';
import type { GitLogger } from './executor';
import { execAsync } from './executor';

/**
 * Canonical list of .gitignore entries managed by the orchestrator.
 * This is the single source of truth — used by ensureGitignoreEntries,
 * diff pattern detection, and the .gitignore "only change" check.
 */
export const ORCHESTRATOR_GITIGNORE_ENTRIES = [
  '.worktrees/',
  '.orchestrator/',
  '.github/instructions/orchestrator-*.instructions.md',
] as const;

/**
 * Regex patterns that match orchestrator-managed .gitignore diff lines.
 * Derived from {@link ORCHESTRATOR_GITIGNORE_ENTRIES} plus comment/whitespace.
 * Used to detect whether a .gitignore diff contains ONLY orchestrator changes.
 */
const ORCHESTRATOR_DIFF_PATTERNS: RegExp[] = [
  // Entries with/without trailing slash, with/without leading slash
  /^[+-]\.orchestrator\/?$/,
  /^[+-]\/?\.orchestrator\/?$/,
  /^[+-]\.worktrees\/?$/,
  /^[+-]\/?\.worktrees\/?$/,
  // Instruction file glob
  /^[+-]\.github\/instructions\/orchestrator-.*\.instructions\.md$/,
  // Comment header
  /^[+-]#\s*[Cc]opilot [Oo]rchestrator/,
  // Empty lines (often added alongside entries)
  /^[+-]\s*$/,
];

/**
 * Ensure .gitignore contains required entries for orchestrator temporary files.
 * 
 * This function is called automatically when:
 * - A new plan is created (`planInitialization.ts`)
 * - A worktree is set up for a job (`worktrees.ts`)
 * 
 * Ensures the following entries are present:
 * - `.worktrees` - The root directory containing all job worktrees
 * - `.orchestrator` - Per-worktree orchestrator state (Copilot session cache, evidence files)
 * 
 * This prevents orchestrator-generated temporary files from being accidentally committed.
 * 
 * @param repoPath - Path to the repository (worktree or main repo)
 * @param entries - Entries to ensure are present (default: ['.worktrees', '.orchestrator'])
 * @param logger - Optional logger for status messages
 * @returns true if gitignore was modified, false if already up-to-date
 */
export async function ensureGitignoreEntries(
  repoPath: string,
  entries: string[] = [...ORCHESTRATOR_GITIGNORE_ENTRIES],
  logger?: GitLogger
): Promise<boolean> {
  const gitignorePath = path.join(repoPath, '.gitignore');
  
  let existingContent = '';
  try {
    existingContent = await fs.promises.readFile(gitignorePath, 'utf8');
  } catch {
    // File doesn't exist, will create
  }
  
  // Parse existing entries (handle both Unix and Windows line endings)
  const existingEntries = new Set(
    existingContent
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
  );
  
  // Find missing entries
  const missingEntries = entries.filter(entry => !existingEntries.has(entry));
  
  if (missingEntries.length === 0) {
    return false; // Already up-to-date
  }
  
  // Build new content
  let newContent = existingContent;
  
  // Ensure file ends with newline
  if (newContent && !newContent.endsWith('\n')) {
    newContent += '\n';
  }
  
  // Add header comment if adding orchestrator entries
  if (!existingContent.includes('# Copilot Orchestrator')) {
    newContent += '\n# Copilot Orchestrator temporary files\n';
  }
  
  // Add missing entries
  for (const entry of missingEntries) {
    newContent += `${entry}\n`;
  }
  
  try {
    await fs.promises.writeFile(gitignorePath, newContent, 'utf8');
    logger?.('[git] Updated .gitignore with orchestrator entries');
    return true;
  } catch (error) {
    logger?.(`[git] Warning: Could not update .gitignore: ${error}`);
    return false;
  }
}

/**
 * Ensure .gitignore contains required entries for orchestrator temporary files.
 * This is the ONLY function that should modify .gitignore for the orchestrator extension.
 * 
 * @param workspaceRoot - The workspace root path
 * @returns true if .gitignore was modified, false if already up to date
 */
export async function ensureOrchestratorGitIgnore(workspaceRoot: string): Promise<boolean> {
  return ensureGitignoreEntries(workspaceRoot, [...ORCHESTRATOR_GITIGNORE_ENTRIES]);
}

/**
 * Check if .gitignore has all required orchestrator entries.
 */
export async function isOrchestratorGitIgnoreConfigured(workspaceRoot: string): Promise<boolean> {
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  
  try {
    const content = await fs.promises.readFile(gitignorePath, 'utf-8');
    const lines = content.split('\n').map(l => l.trim());
    
    // Check if any of the required entry variations are present
    return [...ORCHESTRATOR_GITIGNORE_ENTRIES].every(entry => 
      lines.includes(entry) || lines.includes(entry.replace(/\/$/, ''))
    );
  } catch {
    return false;
  }
}

/**
 * Check if a path is ignored by git (via `git check-ignore`).
 *
 * @param repoPath - Repository root path
 * @param relativePath - Path relative to repo root to check
 * @returns true if the path is gitignored, false otherwise
 */
export async function isIgnored(repoPath: string, relativePath: string): Promise<boolean> {
  const result = await execAsync(['check-ignore', '-q', relativePath], { cwd: repoPath });
  return result.success; // exit code 0 = ignored, 1 = not ignored
}

/**
 * Check if a unified diff contains only orchestrator-managed .gitignore changes.
 *
 * Uses {@link ORCHESTRATOR_DIFF_PATTERNS} (derived from
 * {@link ORCHESTRATOR_GITIGNORE_ENTRIES}) as the single source of truth.
 *
 * @param diff - Unified diff output (from `git diff` or `git stash show -p`)
 * @returns true if every added/removed line matches an orchestrator pattern
 */
export function isDiffOnlyOrchestratorChanges(diff: string): boolean {
  const lines = diff.split(/\r?\n/);

  for (const line of lines) {
    // Skip diff metadata
    if (line.startsWith('diff ') || line.startsWith('index ') ||
        line.startsWith('--- ') || line.startsWith('+++ ') ||
        line.startsWith('@@') || line.startsWith('\\')) {
      continue;
    }
    // Skip context lines
    if (!line.startsWith('+') && !line.startsWith('-')) {
      continue;
    }
    if (!ORCHESTRATOR_DIFF_PATTERNS.some(p => p.test(line))) {
      return false;
    }
  }
  return true;
}