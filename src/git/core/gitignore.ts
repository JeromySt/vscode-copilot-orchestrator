/**
 * @fileoverview Helper functions for managing .gitignore entries
 * 
 * @module git/core/gitignore
 */

import * as path from 'path';
import * as fs from 'fs';

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
 * @returns true if gitignore was modified, false if already up-to-date
 */
export async function ensureGitignoreEntries(
  repoPath: string,
  entries: string[] = ['.worktrees', '.orchestrator']
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
  
  await fs.promises.writeFile(gitignorePath, newContent, 'utf8');
  return true;
}
