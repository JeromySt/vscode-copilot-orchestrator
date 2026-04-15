/**
 * @fileoverview MCP handler for running the full integration test plan.
 *
 * Creates a plan with scripted process output that exercises every major
 * behavior path in the orchestrator. The plan starts paused — resume it
 * to watch all node transitions, handler activations, and state machine
 * progressions with fully deterministic output.
 *
 * @module mcp/handlers/plan/runIntegrationTestHandler
 */

import {
  PlanHandlerContext,
  errorResult,
  resolveBaseBranch,
  resolveTargetBranch,
} from '../utils';
import { buildIntegrationTestPlan } from '../../../plan/testing/integrationTestPlanBuilder';
import { ScriptedProcessSpawner } from '../../../plan/testing/scriptedProcessSpawner';
import { Logger } from '../../../core/logger';

const log = Logger.for('mcp');

/**
 * Handle the `run_copilot_integration_test` MCP tool call.
 *
 * Builds a comprehensive integration test plan that exercises all major
 * orchestrator behaviors using scripted (fake) process output. The plan
 * is created in a paused state — call `resume_copilot_plan` to start
 * execution and observe all behaviors.
 *
 * **What gets tested:**
 * - Shell execution (success path)
 * - Agent execution with full handler coverage (SessionId, Stats, TaskComplete)
 * - Process execution via ProcessSpec
 * - Context pressure detection (rising token usage)
 * - Auto-heal: fail on attempt 1, succeed on retry
 * - Permanent failure with blocked downstream propagation
 * - Postcheck failure with recovery
 * - No-changes path (expectsNoChanges=true)
 * - Fan-in dependency merge
 * - All state transitions: pending → ready → scheduled → running → succeeded/failed/blocked
 *
 * @param args - Optional overrides: `name`, `baseBranch`, `targetBranch`, `maxParallel`, `startPaused`.
 * @param ctx  - Handler context providing PlanRunner and workspace path.
 * @returns On success: `{ success, planId, jobs, descriptions }`.
 */
export async function handleRunIntegrationTest(args: any, ctx: PlanHandlerContext): Promise<any> {
  try {
    const repoPath = ctx.workspacePath;
    if (!repoPath) {
      return errorResult('No workspace path available. Open a workspace first.');
    }

    // Resolve branches
    const baseBranch = await resolveBaseBranch(repoPath, ctx.git, args.baseBranch);
    const targetBranch = await resolveTargetBranch(
      baseBranch, repoPath, ctx.git, args.targetBranch,
      args.name || 'integration-test', ctx.configProvider,
    );

    // Build the integration test plan
    const testPlan = buildIntegrationTestPlan({
      name: args.name || 'Full Integration Test Plan',
      baseBranch,
      targetBranch,
      maxParallel: args.maxParallel ?? 4,
      repoPath,
    });

    // Create the scripted process spawner — this is the ONLY fake component.
    // Everything else uses real production code: the real CopilotCliRunner,
    // real ManagedProcessFactory, real ProcessOutputBus, real handlers
    // (SessionId, Stats, TaskComplete, ContextPressure), and real LogFileTailer.
    //
    // The spawner intercepts IProcessSpawner.spawn() and returns FakeChildProcess
    // instances that replay scripted stdout/stderr/exit codes. The real runner
    // wires these through the real managed process pipeline.
    const scriptedSpawner = new ScriptedProcessSpawner();
    scriptedSpawner.addScripts(testPlan.scripts);

    // Set startPaused based on args (default: true so user can inspect before running)
    testPlan.spec.startPaused = args.startPaused !== false;

    // Create the plan
    const plan = ctx.PlanRunner.enqueue(testPlan.spec);

    // Attach ONLY the scripted spawner to the plan instance.
    // The execution engine threads it into ExecutionContext.spawnerOverride,
    // which the executor passes to phase deps and the CopilotCliRunner.
    // No copilotRunnerOverride — the real CopilotCliRunner handles everything.
    (plan as any).__scripted_spawner__ = scriptedSpawner;

    log.info('Integration test plan created', {
      planId: plan.id,
      jobCount: plan.jobs.size,
      scriptCount: testPlan.scripts.length,
    });

    // Build job mapping for the response
    const jobMapping: Record<string, string> = {};
    for (const [nodeId, node] of plan.jobs) {
      jobMapping[node.producerId] = nodeId;
    }

    return {
      success: true,
      planId: plan.id,
      name: testPlan.spec.name,
      status: 'paused',
      jobCount: plan.jobs.size,
      scriptCount: testPlan.scripts.length,
      jobs: jobMapping,
      descriptions: testPlan.jobDescriptions,
      instructions: [
        'Plan created in paused state. To start execution:',
        `  1. Call resume_copilot_plan with planId: "${plan.id}"`,
        '  2. Watch the plan panel for node state transitions',
        '  3. Monitor handler activations (session IDs, stats, context pressure)',
        '',
        'Expected behaviors:',
        '  - root-setup: Shell success → unlocks all parallel jobs',
        '  - parallel-agent: Full handler coverage (Session ID + Stats + Task Complete)',
        '  - parallel-shell: Shell + passing postchecks',
        '  - pressure-agent: Context pressure rises to critical level',
        '  - auto-heal-job: Fails attempt 1, succeeds on retry',
        '  - always-fails: Permanent failure → blocks blocked-downstream',
        '  - blocked-downstream: Never runs (blocked by always-fails)',
        '  - postchecks-fail: Work succeeds, postchecks fail → auto-heal → both succeed',
        '  - no-changes: Analysis only, no git changes (expectsNoChanges=true)',
        '  - process-job: Direct process execution via ProcessSpec',
        '  - final-merge: Fan-in verification after all parallel jobs complete',
      ],
      note: 'This plan uses scripted (fake) process output for deterministic testing. ' +
            'No real agent/CLI processes will be spawned. All stdout/stderr output is pre-recorded.',
    };
  } catch (err: any) {
    log.error('Failed to create integration test plan', { error: err.message });
    return errorResult(`Failed to create integration test plan: ${err.message}`);
  }
}
