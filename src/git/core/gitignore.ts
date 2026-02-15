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
  entries: string[] = ['.worktrees', '.orchestrator'],
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
  return ensureGitignoreEntries(workspaceRoot, ['.worktrees/', '.orchestrator/']);
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
    return ['.worktrees/', '.orchestrator/'].every(entry => 
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