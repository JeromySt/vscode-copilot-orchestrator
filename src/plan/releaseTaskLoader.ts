/**
 * @fileoverview Release Task Loader
 *
 * Loads release preparation tasks from markdown files in .orchestrator/release/tasks/.
 * Each task file contains YAML frontmatter with task metadata and markdown body
 * with task description/instructions.
 *
 * @module plan/releaseTaskLoader
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../core/logger';
import type { PrepTask } from './types/release';

const log = Logger.for('plan');

// ============================================================================
// FRONTMATTER PARSER
// ============================================================================

interface TaskFrontmatter {
  id?: string;
  title?: string;
  required?: boolean;
  autoSupported?: boolean;
  order?: number;
}

/**
 * Parse YAML frontmatter from markdown file.
 * Uses a simple regex/split approach without external YAML dependencies.
 * Only handles basic key: value pairs (strings, booleans, numbers).
 */
function parseFrontmatter(content: string): { frontmatter: TaskFrontmatter; body: string } {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const [, yamlContent, body] = match;
  const frontmatter: TaskFrontmatter = {};

  // Parse each line as key: value
  const lines = yamlContent.split('\n');
  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      continue;
    }

    const key = line.substring(0, colonIndex).trim();
    const valueStr = line.substring(colonIndex + 1).trim();

    if (!key || !valueStr) {
      continue;
    }

    // Parse value based on type
    let value: string | boolean | number;
    if (valueStr === 'true') {
      value = true;
    } else if (valueStr === 'false') {
      value = false;
    } else if (/^-?\d+$/.test(valueStr)) {
      value = parseInt(valueStr, 10);
    } else if (/^-?\d+\.\d+$/.test(valueStr)) {
      value = parseFloat(valueStr);
    } else {
      value = valueStr;
    }

    (frontmatter as any)[key] = value;
  }

  return { frontmatter, body: body.trim() };
}

// ============================================================================
// TASK LOADER
// ============================================================================

/**
 * Load release preparation tasks from markdown files.
 * 
 * Reads all .md files from <repoPath>/.orchestrator/release/tasks/,
 * parses frontmatter, and returns sorted PrepTask array.
 * 
 * @param repoPath - Root path of the repository
 * @returns Array of PrepTask objects, sorted by order then filename
 */
export async function loadReleaseTasks(repoPath: string): Promise<PrepTask[]> {
  const tasksDir = path.join(repoPath, '.orchestrator', 'release', 'tasks');

  // If directory doesn't exist, return empty array (not an error)
  if (!fs.existsSync(tasksDir)) {
    log.debug('Release tasks directory not found', { tasksDir });
    return [];
  }

  let files: string[];
  try {
    files = fs.readdirSync(tasksDir);
  } catch (err) {
    log.warn('Failed to read release tasks directory', { tasksDir, error: (err as Error).message });
    return [];
  }

  // Filter for .md files
  const mdFiles = files.filter((f) => f.endsWith('.md'));
  if (mdFiles.length === 0) {
    log.debug('No release task files found', { tasksDir });
    return [];
  }

  const tasks: Array<PrepTask & { _order?: number; _filename?: string }> = [];

  for (const filename of mdFiles) {
    const filepath = path.join(tasksDir, filename);
    let content: string;

    try {
      content = fs.readFileSync(filepath, 'utf-8');
    } catch (err) {
      log.warn('Failed to read release task file', { filepath, error: (err as Error).message });
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);

    // Validate required fields
    if (!frontmatter.id || !frontmatter.title) {
      log.warn('Skipping task file with missing id or title', { filepath, frontmatter });
      continue;
    }

    // Build PrepTask
    const task: PrepTask & { _order?: number; _filename?: string } = {
      id: frontmatter.id,
      title: frontmatter.title,
      description: body || undefined,
      required: frontmatter.required ?? false,
      autoSupported: frontmatter.autoSupported ?? true,
      status: 'pending',
      _order: frontmatter.order,
      _filename: filename,
    };

    tasks.push(task);
  }

  // Sort by order (if specified), then filename
  tasks.sort((a, b) => {
    // Primary sort: order (if both have it)
    if (a._order !== undefined && b._order !== undefined) {
      if (a._order !== b._order) {
        return a._order - b._order;
      }
    }
    // If only one has order, prioritize it
    if (a._order !== undefined && b._order === undefined) {
      return -1;
    }
    if (a._order === undefined && b._order !== undefined) {
      return 1;
    }
    // Secondary sort: filename
    return (a._filename || '').localeCompare(b._filename || '');
  });

  // Remove temporary sorting fields
  tasks.forEach((task) => {
    delete task._order;
    delete task._filename;
  });

  log.info('Loaded release tasks from files', { tasksDir, count: tasks.length });
  return tasks;
}

// ============================================================================
// DEFAULT TASKS
// ============================================================================

/**
 * Get the default hardcoded release preparation tasks.
 * Used as fallback when no task files exist.
 * 
 * @returns Array of default PrepTask objects
 */
export function getDefaultReleaseTasks(): PrepTask[] {
  return [
    { id: 'changelog', title: 'Update CHANGELOG', description: 'Add release notes to CHANGELOG.md', required: true, autoSupported: true, status: 'pending' },
    { id: 'version', title: 'Bump Version', description: 'Update version in package.json', required: true, autoSupported: true, status: 'pending' },
    { id: 'compile', title: 'Run Compilation', description: 'Ensure TypeScript compiles without errors', required: true, autoSupported: true, status: 'pending' },
    { id: 'tests', title: 'Run Tests', description: 'Execute test suite', required: true, autoSupported: true, status: 'pending' },
    { id: 'docs', title: 'Update Documentation', description: 'Review and update README if needed', required: false, autoSupported: false, status: 'pending' },
    { id: 'ai-review', title: 'AI Code Review', description: 'Run Copilot code review on changes', required: false, autoSupported: true, status: 'pending' },
  ];
}
