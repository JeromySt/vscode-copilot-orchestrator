/**
 * @fileoverview Add Job MCP Tool Handler
 * 
 * Implements handler for adding jobs to scaffolding plans.
 * Delegates to the repository's addNode() which calls buildPlan() internally,
 * giving us SV node injection, dependency resolution, and group assignment for free.
 * 
 * @module mcp/handlers/plan/addJobHandler
 */

import { validateInput } from '../../validation';
import { validateAllowedFolders, validateAllowedUrls } from '../../validation';
import { validateAgentModels } from '../../validation';
import {
  PlanHandlerContext,
  errorResult,
} from '../utils';
import { Logger } from '../../../core/logger';

const log = Logger.for('mcp');

/**
 * Handle add_copilot_plan_job MCP tool call.
 * 
 * Adds a job to a scaffolding plan. Validates agent models, folders, and URLs if applicable.
 * Handles both inline instructions and instructionsFile references.
 * 
 * @param args - Tool arguments containing planId, producerId, task, and work specification
 * @param ctx - Handler context with PlanRepository access
 * @returns On success: { success: true, jobId, message }
 */
export async function handleAddPlanJob(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('add_copilot_plan_job', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  const { planId, producerId, name, task, dependencies, group, work, prechecks, postchecks, autoHeal, expectsNoChanges } = args;

  try {
    // Validate that the plan exists and is in scaffolding state
    const planDef = await ctx.PlanRepository.getDefinition(planId);
    if (!planDef) {
      return errorResult(`Plan with ID '${planId}' not found`);
    }

    // Validate agent models if work contains agent specifications
    const modelValidation = await validateAgentModels(args, 'add_copilot_plan_job');
    if (!modelValidation.valid) {
      return errorResult(modelValidation.error || 'Invalid agent models');
    }

    // Validate allowed folders
    const folderValidation = await validateAllowedFolders(args, 'add_copilot_plan_job');
    if (!folderValidation.valid) {
      return errorResult(folderValidation.error || 'Invalid allowed folders');
    }

    // Validate allowed URLs
    const urlValidation = await validateAllowedUrls(args, 'add_copilot_plan_job');
    if (!urlValidation.valid) {
      return errorResult(urlValidation.error || 'Invalid allowed URLs');
    }

    // Repository handles everything: append to spec.jobs, call buildPlan(), persist
    const rebuiltPlan = await ctx.PlanRepository.addNode(planId, {
      producerId: producerId,
      name: name || task,
      task,
      dependencies: dependencies || [],
      group,
      work,
      prechecks,
      postchecks,
      autoHeal: autoHeal,
      expectsNoChanges: expectsNoChanges,
    });

    // Replace in-memory plan topology with the rebuilt plan
    const existingPlan = ctx.PlanRunner.get(planId);
    if (existingPlan) {
      existingPlan.jobs = rebuiltPlan.jobs;
      existingPlan.nodeStates = rebuiltPlan.nodeStates;
      existingPlan.producerIdToNodeId = rebuiltPlan.producerIdToNodeId;
      existingPlan.roots = rebuiltPlan.roots;
      existingPlan.leaves = rebuiltPlan.leaves;
      existingPlan.groups = rebuiltPlan.groups || new Map();
      existingPlan.groupStates = rebuiltPlan.groupStates || new Map();
      existingPlan.groupPathToId = rebuiltPlan.groupPathToId || new Map();
      existingPlan.stateVersion = (existingPlan.stateVersion || 0) + 1;
      // Keep definition in sync so hydration works if the plan is finalized later
      existingPlan.definition = rebuiltPlan.definition;
    }

    // Emit planUpdated — triggers sidebar/detail panel refresh
    (ctx.PlanRunner as any)._state?.events?.emitPlanUpdated?.(planId);
    log.info('Job added to scaffolding plan', { planId, producerId: producerId, task });

    return {
      success: true,
      jobId: producerId,
      message: `Job '${producerId}' added to scaffolding plan '${planId}'. Task: ${task}`
    };

  } catch (error: any) {
    log.error('Failed to add job to scaffolding plan', { 
      error: error.message, 
      planId, 
      producerId: producerId 
    });
    return errorResult(`Failed to add job: ${error.message}`);
  }
}