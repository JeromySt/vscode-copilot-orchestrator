/**
 * @fileoverview Scaffold Release Tasks MCP Tool Handler
 * 
 * Implements handler for scaffold_release_tasks MCP tool.
 * Creates default task files in .orchestrator/release/tasks/ for customization.
 * 
 * @module mcp/handlers/plan/scaffoldReleaseTasksHandler
 */

import { validateInput } from '../../validation';
import {
  PlanHandlerContext,
  errorResult,
} from '../utils';
import { Logger } from '../../../core/logger';
import { scaffoldDefaultTaskFiles } from '../../../plan/releaseTaskLoader';

const log = Logger.for('mcp');

/**
 * Handle scaffold_release_tasks MCP tool call.
 * 
 * Creates default release task files in .orchestrator/release/tasks/ directory.
 * Each task file contains YAML frontmatter with task metadata and markdown body
 * with task description.
 * 
 * Files are named: 01-changelog.md, 02-version.md, 03-compile.md, 04-tests.md,
 * 05-docs.md, 06-ai-review.md
 * 
 * If files already exist, they are not overwritten.
 * 
 * @param args - Tool arguments containing optional repoPath
 * @param ctx - Handler context
 * @returns On success: { success: true, created: string[] }
 */
export async function handleScaffoldReleaseTasks(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('scaffold_release_tasks', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  // Get repoPath from args or use workspace root
  let repoPath = args.repoPath;
  
  if (!repoPath) {
    // Use workspace path from context
    if (ctx.workspacePath) {
      repoPath = ctx.workspacePath;
    } else {
      return errorResult('No repository path provided and no workspace root available');
    }
  }

  try {
    const created = await scaffoldDefaultTaskFiles(repoPath);
    
    log.info('Scaffolded release tasks', { repoPath, created: created.length });

    if (created.length === 0) {
      return {
        success: true,
        created: [],
        message: 'No new task files created. All default task files already exist.'
      };
    }

    return {
      success: true,
      created,
      message: `Created ${created.length} task file(s). You can now customize these files to match your release process.`
    };

  } catch (error: any) {
    log.error('Failed to scaffold release tasks', { error: error.message, repoPath });
    return errorResult(`Failed to scaffold release tasks: ${error.message}`);
  }
}
