/**
 * @fileoverview Integration test plan builder.
 *
 * Constructs a Plan DAG and matching scripted process output that exercises
 * every major behavior of the orchestrator: success paths, failure + auto-heal,
 * blocked propagation, context pressure, postcheck failures, expectsNoChanges,
 * and the full handler pipeline (SessionId, Stats, TaskComplete, ContextPressure).
 *
 * The returned {@link IntegrationTestPlan} contains both the {@link PlanSpec}
 * (for plan creation) and the {@link ProcessScript} array (for the
 * {@link ScriptedProcessSpawner}). Together they produce fully deterministic
 * plan execution.
 *
 * @module plan/testing/integrationTestPlanBuilder
 */

import type { PlanSpec } from '../types/plan';
import type { JobNodeSpec } from '../types/nodes';
import type { ProcessScript } from './processScripts';
import {
  successfulAgentScript,
  successfulShellScript,
  failThenSucceedScripts,
  alwaysFailsScript,
  noChangesScript,
  failingPostcheckScript,
  passingPostcheckScript,
  contextPressureLogLines,
  sessionIdLines,
  statsLines,
  taskCompleteLines,
} from './processScripts';

/**
 * The complete integration test plan: spec + matching scripts.
 */
export interface IntegrationTestPlan {
  /** The plan specification to pass to PlanRunner.enqueue() or create_copilot_plan. */
  spec: PlanSpec;
  /** Process scripts to register on the ScriptedProcessSpawner. */
  scripts: ProcessScript[];
  /** Description of what each job exercises. */
  jobDescriptions: Record<string, string>;
}

/**
 * Job catalog — each entry represents a distinct behavior path.
 */
interface JobEntry {
  spec: JobNodeSpec;
  scripts: ProcessScript[];
  description: string;
}

// ─── Job Definitions ───────────────────────────────────────────────────────

function rootSetupJob(): JobEntry {
  return {
    spec: {
      producerId: 'root-setup',
      name: 'Project Setup',
      task: 'Install dependencies and verify build environment',
      work: { type: 'shell', command: 'npm ci && npm run build' },
      expectsNoChanges: true,
      dependencies: [],
      group: 'setup',
    },
    scripts: [
      successfulShellScript('root-setup:work', { argsContain: 'npm ci' }, [
        'npm warn deprecated some-package@1.2.3',
        'added 1247 packages in 32s',
        'Build succeeded.',
      ]),
    ],
    description: 'Shell execution, success path, clean stdout',
  };
}

function parallelAgentJob(): JobEntry {
  return {
    spec: {
      producerId: 'parallel-agent',
      name: 'Agent Work (Full Handler Coverage)',
      task: 'Refactor the auth module to use dependency injection',
      work: {
        type: 'agent',
        instructions: '# Refactor Auth Module\n\nRefactor `src/auth/` to use constructor injection.\n\n## Requirements\n- Extract interface `IAuthService`\n- Update all consumers to use the interface\n- Add unit tests',
      },
      expectsNoChanges: true,
      dependencies: ['root-setup'],
      group: 'parallel-work',
    },
    scripts: [
      successfulAgentScript('parallel-agent:work', { argsContain: 'Refactor Auth Module' }),
    ],
    description: 'Agent execution with full handler coverage (SessionId, Stats, TaskComplete)',
  };
}

function parallelShellJob(): JobEntry {
  return {
    spec: {
      producerId: 'parallel-shell',
      name: 'Shell Command (Process Execution)',
      task: 'Run linting and formatting checks',
      work: { type: 'shell', command: 'npm run lint && npm run format:check' },
      postchecks: { type: 'shell', command: 'npm run lint' },
      expectsNoChanges: true,
      dependencies: ['root-setup'],
      group: 'parallel-work',
    },
    scripts: [
      successfulShellScript('parallel-shell:work', { argsContain: 'format:check' }, [
        '✓ ESLint: 0 errors, 0 warnings',
        '✓ Prettier: all files formatted',
      ]),
      passingPostcheckScript('parallel-shell:postchecks', { argsContain: 'npm run lint' }),
    ],
    description: 'Shell execution with passing postchecks',
  };
}

function contextPressureJob(): JobEntry {
  return {
    spec: {
      producerId: 'pressure-agent',
      name: 'Agent Work (Context Pressure)',
      task: 'Implement the full payment processing module with tests',
      work: {
        type: 'agent',
        instructions: '# Payment Processing\n\nBuild the complete payment processing module.\nThis is a large task that may trigger context pressure.',
      },
      expectsNoChanges: true,
      dependencies: ['root-setup'],
      group: 'parallel-work',
    },
    scripts: [
      {
        label: 'pressure-agent:work',
        match: { argsContain: 'Payment Processing' },
        stdout: [
          ...sessionIdLines('880e8400-e29b-41d4-a716-446655440003'),
          // Phase 1: Normal work (~30s) — pressure normal
          { text: 'Starting payment processing module implementation...', delayMs: 2000 },
          { text: 'Analyzing existing codebase structure...', delayMs: 5000 },
          { text: 'Creating src/payments/types.ts — payment type definitions', delayMs: 8000 },
          { text: 'Creating src/payments/PaymentService.ts — core service', delayMs: 10000 },
          // Phase 2: Token usage growing (~30s) — pressure elevated
          { text: 'Creating src/payments/StripeAdapter.ts — gateway adapter', delayMs: 10000 },
          { text: 'Writing Stripe API integration with error handling...', delayMs: 8000 },
          { text: 'Adding retry logic and idempotency keys...', delayMs: 8000 },
          // Phase 3: Approaching limit (~30s) — pressure critical
          { text: 'Starting src/payments/webhooks.ts — event handlers...', delayMs: 10000 },
          { text: 'Context window utilization high — considering checkpoint...', delayMs: 8000 },
          { text: '⚠ Context pressure CRITICAL — initiating checkpoint protocol', delayMs: 5000 },
          // Phase 4: Checkpoint (~30s)
          { text: 'Committing completed work: PaymentService, StripeAdapter, types', delayMs: 5000 },
          { text: 'Writing checkpoint manifest with remaining work items...', delayMs: 3000 },
          { text: '[checkpoint] Partial work committed — 3 files completed, 4 remaining', delayMs: 2000 },
          ...statsLines({
            premiumRequests: 3.2,
            apiTime: '4m 15s',
            sessionTime: '8m 30s',
            linesAdded: 856,
            linesRemoved: 23,
            models: [
              { model: 'claude-opus-4', input: '890.5k', output: '45.2k', cached: '12.1k', premium: 2.8 },
              { model: 'claude-sonnet-4', input: '210.3k', output: '15.8k', premium: 0.4 },
            ],
          }),
          ...taskCompleteLines(),
        ],
        // Debug-log entries for LogFileTailer → ContextPressureHandler pipeline.
        // These are written to disk by the ScriptedCopilotRunner so the real
        // handler detects rising token usage and updates the pressure UI.
        logFiles: [
          {
            relativePath: 'debug.log',
            lines: contextPressureLogLines('critical', true),
          },
        ],
        exitCode: 0,
        exitDelayMs: 1000,
        // Checkpoint manifest — triggers the fan-out/fan-in DAG reshape.
        // The execution engine detects this file after the work phase and
        // creates sub-jobs for the remaining work items.
        checkpointManifest: {
          status: 'checkpointed',
          summary: 'Completed PaymentService and StripeAdapter. Remaining: webhooks, refund logic, and integration tests.',
          pressure: 0.82,
          completed: [
            { file: 'src/payments/PaymentService.ts', summary: 'Core payment service with create/capture/void methods' },
            { file: 'src/payments/StripeAdapter.ts', summary: 'Stripe payment gateway adapter' },
            { file: 'src/payments/types.ts', summary: 'Payment type definitions and interfaces' },
          ],
          inProgress: {
            file: 'src/payments/webhooks.ts',
            completedParts: 'Webhook event types and signature verification',
            remainingParts: 'Event handlers for payment_intent.succeeded and charge.refunded',
          },
          remaining: [
            { file: 'src/payments/refundService.ts', description: 'Refund processing logic with partial refund support' },
            { file: 'src/payments/__tests__/PaymentService.test.ts', description: 'Unit tests for PaymentService' },
            { file: 'src/payments/__tests__/webhooks.test.ts', description: 'Unit tests for webhook handlers' },
          ],
          suggestedSplits: [
            {
              name: 'Complete Webhooks',
              files: ['src/payments/webhooks.ts'],
              prompt: 'Complete the webhook event handlers for payment_intent.succeeded and charge.refunded events.',
              priority: 1,
            },
            {
              name: 'Refund Service',
              files: ['src/payments/refundService.ts'],
              prompt: 'Implement the refund processing service with partial refund support.',
              priority: 2,
            },
            {
              name: 'Unit Tests',
              files: ['src/payments/__tests__/PaymentService.test.ts', 'src/payments/__tests__/webhooks.test.ts'],
              prompt: 'Write comprehensive unit tests for PaymentService and webhook handlers.',
              priority: 3,
            },
          ],
          codebaseContext: {
            buildCommand: 'npm run build',
            testCommand: 'npm test',
            conventions: ['Use dependency injection', 'Strict TypeScript'],
          },
        },
      },
    ],
    description: 'Agent execution with context pressure → checkpoint → fan-out/fan-in DAG reshape',
  };
}

function autoHealJob(): JobEntry {
  return {
    spec: {
      producerId: 'auto-heal-job',
      name: 'Auto-Heal (Fail Then Succeed)',
      task: 'Fix TypeScript compilation errors in the worker module',
      work: { type: 'shell', command: 'npm run build:worker-module' },
      autoHeal: true,
      expectsNoChanges: true,
      dependencies: ['root-setup'],
      group: 'resilience',
    },
    scripts: [
      // First attempt: shell work fails (consumeOnce removes it after first match)
      {
        ...failThenSucceedScripts('auto-heal-job:work', { argsContain: 'build:worker-module' })[0],
      },
      // Auto-heal: the engine replaces shell work with heal agent.
      // The heal instructions file contains "Auto-Heal" and "build:worker-module".
      successfulAgentScript('auto-heal-job:heal-agent', { argsContain: 'Auto-Heal' }),
    ],
    description: 'Shell work fails on attempt 1, auto-heals and succeeds on attempt 2',
  };
}

function alwaysFailsJob(): JobEntry {
  return {
    spec: {
      producerId: 'always-fails',
      name: 'Permanent Failure',
      task: 'Attempt an impossible task that will always fail',
      work: { type: 'shell', command: 'exit 1' },
      autoHeal: false,
      dependencies: ['root-setup'],
      group: 'resilience',
    },
    scripts: [
      alwaysFailsScript('always-fails:work', { argsContain: "Continue'; exit 1" }),
    ],
    description: 'Always fails — tests permanent failure and blocked propagation',
  };
}

function blockedJob(): JobEntry {
  return {
    spec: {
      producerId: 'blocked-downstream',
      name: 'Blocked Downstream',
      task: 'This job depends on always-fails and will be blocked',
      work: { type: 'shell', command: 'echo "should never run"' },
      dependencies: ['always-fails'],
      group: 'resilience',
    },
    scripts: [],
    description: 'Never runs — validates blocked state propagation from failed dependency',
  };
}

function postcheckFailJob(): JobEntry {
  return {
    spec: {
      producerId: 'postchecks-fail',
      name: 'Postcheck Failure + Recovery',
      task: 'Implement feature with initially failing tests',
      work: {
        type: 'agent',
        instructions: '# Feature Implementation\n\nAdd the new notification system.',
      },
      postchecks: { type: 'shell', command: 'npm test' },
      autoHeal: true,
      expectsNoChanges: true,
      dependencies: ['root-setup'],
      group: 'resilience',
    },
    scripts: [
      // Work phase succeeds
      successfulAgentScript('postchecks-fail:work', { argsContain: 'Feature Implementation' }),
      // First postcheck fails (consumeOnce so the retry postcheck matches the passing script)
      {
        ...failingPostcheckScript('postchecks-fail:postchecks-fail', { argsContain: 'npm test' }),
        consumeOnce: true,
      },
      // After auto-heal, the heal agent runs as work phase
      successfulAgentScript('postchecks-fail:heal-agent', { argsContain: 'Auto-Heal' }),
      // Retry postchecks succeed
      passingPostcheckScript('postchecks-fail:postchecks-pass', { argsContain: 'npm test' }),
    ],
    description: 'Work succeeds but postchecks fail → auto-heal → both succeed on retry',
  };
}

function noChangesJob(): JobEntry {
  return {
    spec: {
      producerId: 'no-changes',
      name: 'Analysis Only (No Changes)',
      task: 'Review code and verify no changes are needed',
      work: {
        type: 'agent',
        instructions: '# Code Review\n\nAnalyze the codebase and report findings.',
      },
      expectsNoChanges: true,
      dependencies: ['root-setup'],
      group: 'validation',
    },
    scripts: [
      noChangesScript('no-changes:work', { argsContain: 'Code Review' }),
    ],
    description: 'expectsNoChanges=true — commit phase skips, validates no-diff path',
  };
}

function processSpecJob(): JobEntry {
  return {
    spec: {
      producerId: 'process-job',
      name: 'Direct Process Execution',
      task: 'Run a Node.js script directly via ProcessSpec',
      work: {
        type: 'process',
        executable: 'node',
        args: ['scripts/validate.js', '--strict'],
        timeout: 30000,
      },
      expectsNoChanges: true,
      dependencies: ['root-setup'],
      group: 'validation',
    },
    scripts: [
      successfulShellScript('process-job:work', { command: 'node' }, [
        'Validation script starting...',
        'Checking configuration: OK',
        'Checking database schema: OK',
        'All validations passed.',
      ]),
    ],
    description: 'ProcessSpec execution path (not shell, not agent)',
  };
}

function finalMergeJob(): JobEntry {
  return {
    spec: {
      producerId: 'final-merge',
      name: 'Final Integration Verification',
      task: 'Verify all parallel changes integrate cleanly',
      work: { type: 'shell', command: 'npm run build && npm test' },
      expectsNoChanges: true,
      dependencies: [
        'parallel-agent',
        'parallel-shell',
        'pressure-agent',
        'auto-heal-job',
        'postchecks-fail',
        'no-changes',
        'process-job',
      ],
      group: 'finalize',
    },
    scripts: [
      successfulShellScript('final-merge:work', { argsContain: 'npm run build; if' }, [
        'Build: success',
        '143 passing (12s)',
        '0 failing',
        'All integration tests passed.',
      ]),
    ],
    description: 'Fan-in job — depends on all parallel successes, validates combined result',
  };
}

// ─── Plan Builder ──────────────────────────────────────────────────────────

/**
 * Build the full integration test plan with all behavior variations.
 *
 * The plan DAG exercises:
 * - **Shell execution** (root-setup, parallel-shell)
 * - **Agent execution** with full handler coverage (parallel-agent)
 * - **Process execution** via ProcessSpec (process-job)
 * - **Context pressure** with rising token counts (pressure-agent)
 * - **Auto-heal** — fail then succeed on retry (auto-heal-job)
 * - **Permanent failure** and blocked propagation (always-fails → blocked-downstream)
 * - **Postcheck failure** with recovery (postchecks-fail)
 * - **No changes** path (no-changes with expectsNoChanges=true)
 * - **Fan-in** dependency merge (final-merge depends on all parallel jobs)
 * - **State transitions**: pending → ready → scheduled → running → succeeded/failed/blocked
 *
 * DAG shape:
 * ```
 * root-setup ──┬── parallel-agent ──────────┬── final-merge ── [SV Node]
 *              ├── parallel-shell ──────────┤
 *              ├── pressure-agent ──────────┤
 *              ├── auto-heal-job ───────────┤
 *              ├── postchecks-fail ─────────┤
 *              ├── no-changes ──────────────┤
 *              ├── process-job ─────────────┘
 *              ├── always-fails ──→ blocked-downstream (never runs)
 *              └──────────────────────────────────────────────────
 * ```
 *
 * @param opts - Optional overrides for the plan spec.
 * @returns The complete {@link IntegrationTestPlan}.
 */
export function buildIntegrationTestPlan(opts?: {
  name?: string;
  baseBranch?: string;
  targetBranch?: string;
  maxParallel?: number;
  repoPath?: string;
}): IntegrationTestPlan {
  const entries: JobEntry[] = [
    rootSetupJob(),
    parallelAgentJob(),
    parallelShellJob(),
    contextPressureJob(),
    autoHealJob(),
    alwaysFailsJob(),
    blockedJob(),
    postcheckFailJob(),
    noChangesJob(),
    processSpecJob(),
    finalMergeJob(),
  ];

  const jobs = entries.map(e => e.spec);
  const scripts = entries.flatMap(e => e.scripts);

  // Add scripts for dynamically-created sub-jobs from context pressure split.
  // The reshape creates sub-jobs with instructions containing the chunk prompts.
  // Match by unique text from each suggestedSplit's prompt field.
  scripts.push(
    successfulAgentScript('pressure-sub-1:webhooks', { argsContain: 'webhook event handlers' }),
    successfulAgentScript('pressure-sub-2:refund', { argsContain: 'refund processing' }),
    successfulAgentScript('pressure-sub-3:tests', { argsContain: 'unit tests for PaymentService' }),
  );
  // Fan-in job uses { type: 'shell', command: 'true' } — the default unmatched exit 0 handles it.

  const jobDescriptions: Record<string, string> = {};
  for (const entry of entries) {
    jobDescriptions[entry.spec.producerId] = entry.description;
  }

  const spec: PlanSpec = {
    name: opts?.name ?? 'Full Integration Test Plan',
    baseBranch: opts?.baseBranch ?? 'main',
    targetBranch: opts?.targetBranch,
    maxParallel: opts?.maxParallel ?? 4,
    startPaused: true,
    repoPath: opts?.repoPath,
    jobs,
  };

  return { spec, scripts, jobDescriptions };
}
