/**
 * @fileoverview Comprehensive MCP schema completeness tests.
 *
 * These tests validate that the JSON schemas in src/mcp/validation/schemas.ts
 * accept every property supported by the TypeScript types in src/plan/types/.
 *
 * ⚠️ MAINTENANCE: When adding new properties to any WorkSpec type (ProcessSpec,
 * ShellSpec, AgentSpec, OnFailureConfig) or to PlanSpec / JobSpec, you MUST
 * update the "kitchen sink" fixtures in this file so the new property is covered.
 * If you forget, the schema will reject the property (additionalProperties: false)
 * and these tests will catch it.
 *
 * How it works:
 *   1. KITCHEN_SINK_PLAN exercises every field on create_copilot_plan, every
 *      job-level field, and every work-spec property (including on_failure).
 *   2. Individual "accepts <property>" tests ensure each property passes
 *      validation in isolation so failures are easy to diagnose.
 *   3. Negative tests confirm unknown properties are still rejected.
 */
import * as assert from 'assert';
import { suite, test } from 'mocha';

// ---------------------------------------------------------------------------
// Kitchen-sink fixture: uses EVERY supported property
// ---------------------------------------------------------------------------

/**
 * A plan that exercises every property the schema should accept.
 * If a new property is added to the types but not the schema, validation
 * of this object will fail and the test suite will catch the regression.
 */
const KITCHEN_SINK_PLAN = {
  // -- Plan-level fields --
  name: 'Kitchen Sink Plan',
  baseBranch: 'main',
  targetBranch: 'release/v1',
  maxParallel: 4,
  cleanUpSuccessfulWork: true,
  startPaused: false,
  additionalSymlinkDirs: ['.venv', 'vendor'],
  verifyRi: {
    type: 'shell',
    command: 'npm run build && npm test',
    onFailure: {
      noAutoHeal: true,
      message: 'Build failed after merge',
      resumeFromPhase: 'prechecks',
    },
  },

  // -- Jobs: one per work-spec type, plus all job-level fields --
  jobs: [
    {
      // Agent spec with ALL agent-specific properties
      producerId: 'agent-job',
      name: 'Agent Work',
      task: 'Implement feature X',
      instructions: '# Detailed instructions\n\nDo the thing.',
      group: 'build',
      expectsNoChanges: false,
      dependencies: [],
      work: {
        type: 'agent',
        instructions: '# Build feature',
        model: 'claude-sonnet-4',
        modelTier: 'standard',
        maxTurns: 15,
        resumeSession: true,
        allowedFolders: ['/shared/libs'],
        allowedUrls: ['https://api.example.com'],
        onFailure: {
          noAutoHeal: false,
          message: 'Agent failed',
          resumeFromPhase: 'work',
        },
      },
      prechecks: {
        type: 'shell',
        command: 'npm run lint',
        shell: 'bash',
        onFailure: {
          noAutoHeal: true,
          message: 'Lint must pass',
          resumeFromPhase: 'prechecks',
        },
      },
      postchecks: 'npm test',
    },
    {
      // Shell spec
      producerId: 'shell-job',
      task: 'Run shell command',
      dependencies: ['agent-job'],
      work: {
        type: 'shell',
        command: 'dotnet build',
        shell: 'pwsh',
      },
    },
    {
      // Process spec
      producerId: 'process-job',
      task: 'Run process',
      dependencies: [],
      work: {
        type: 'process',
        executable: 'node',
        args: ['build.js', '--release'],
      },
    },
    {
      // String spec (legacy)
      producerId: 'string-job',
      task: 'Run string command',
      dependencies: ['shell-job', 'process-job'],
      work: 'npm run build',
      prechecks: 'echo pre',
      postchecks: 'echo post',
    },
  ],

};

/**
 * Kitchen-sink retry_copilot_plan_job input.
 */
const KITCHEN_SINK_RETRY_NODE = {
  planId: 'plan-123',
  jobId: 'node-456',
  newWork: {
    type: 'agent',
    instructions: '# Fix the issue',
    model: 'claude-sonnet-4',
    modelTier: 'fast',
    maxTurns: 10,
    resumeSession: false,
    allowedFolders: ['/tmp/shared'],
    allowedUrls: ['https://registry.npmjs.org'],
    onFailure: {
      noAutoHeal: true,
      message: 'Cannot auto-heal this',
      resumeFromPhase: 'work',
    },
  },
  newPrechecks: {
    type: 'shell',
    command: 'npm run lint',
    onFailure: { resumeFromPhase: 'prechecks' },
  },
  newPostchecks: null,
  clearWorktree: true,
};

/**
 * Kitchen-sink update_copilot_plan_job input.
 */
const KITCHEN_SINK_UPDATE_NODE = {
  planId: 'plan-123',
  jobId: 'node-456',
  work: {
    type: 'shell',
    command: 'npm test',
    onFailure: {
      noAutoHeal: true,
      message: 'Tests must pass',
      resumeFromPhase: 'work',
    },
  },
  prechecks: {
    type: 'shell',
    command: 'npm run lint',
    onFailure: { message: 'Lint failed' },
  },
  postchecks: 'npm run e2e',
  resetToStage: 'prechecks',
};

/**
 * Kitchen-sink reshape_copilot_plan input.
 */
const KITCHEN_SINK_RESHAPE = {
  planId: 'plan-123',
  operations: [
    {
      type: 'add_node',
      spec: {
        producerId: 'new-node',
        task: 'New task',
        dependencies: [],
        work: {
          type: 'agent',
          instructions: '# New work',
          onFailure: { noAutoHeal: true },
        },
        prechecks: {
          type: 'shell',
          command: 'npm run lint',
          onFailure: { resumeFromPhase: 'prechecks' },
        },
        postchecks: 'npm test',
        instructions: '# Extra instructions',
        expectsNoChanges: false,
      },
    },
    {
      type: 'remove_node',
      producerId: 'old-node',
    },
    {
      type: 'update_deps',
      producerId: 'shell-job',
      dependencies: ['new-node'],
    },
  ],
};

/**
 * Kitchen-sink retry_copilot_job (job-centric, no planId) input.
 */
const KITCHEN_SINK_RETRY_NODE_CENTRIC = {
  planId: 'plan-123',
  jobId: 'job-789',
  newWork: {
    type: 'shell',
    command: 'npm run build',
    onFailure: { noAutoHeal: false },
  },
  newPrechecks: null,
  newPostchecks: {
    type: 'agent',
    instructions: '# Verify output',
    onFailure: { message: 'Post-check failed', resumeFromPhase: 'postchecks' },
  },
  clearWorktree: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('MCP Schema Completeness', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { validateInput, validatePostchecksPresence } = require('../../../mcp/validation/validator');

  // -----------------------------------------------------------------------
  // Kitchen-sink acceptance tests
  // -----------------------------------------------------------------------

  suite('Kitchen-sink plans pass validation', () => {
    test('create_copilot_plan accepts full kitchen-sink plan', () => {
      const result = validateInput('create_copilot_plan', KITCHEN_SINK_PLAN);
      assert.strictEqual(result.valid, true, `Validation errors: ${result.error}`);
    });

    test('retry_copilot_plan_job accepts full kitchen-sink input', () => {
      const result = validateInput('retry_copilot_plan_job', KITCHEN_SINK_RETRY_NODE);
      assert.strictEqual(result.valid, true, `Validation errors: ${result.error}`);
    });

    test('update_copilot_plan_job accepts full kitchen-sink input', () => {
      const result = validateInput('update_copilot_plan_job', KITCHEN_SINK_UPDATE_NODE);
      assert.strictEqual(result.valid, true, `Validation errors: ${result.error}`);
    });

    test('reshape_copilot_plan accepts full kitchen-sink input', () => {
      const result = validateInput('reshape_copilot_plan', KITCHEN_SINK_RESHAPE);
      assert.strictEqual(result.valid, true, `Validation errors: ${result.error}`);
    });

    test('retry_copilot_job (node-centric) accepts full kitchen-sink input', () => {
      const result = validateInput('retry_copilot_job', KITCHEN_SINK_RETRY_NODE_CENTRIC);
      assert.strictEqual(result.valid, true, `Validation errors: ${result.error}`);
    });
  });

  // -----------------------------------------------------------------------
  // Plan-level property isolation tests
  // -----------------------------------------------------------------------

  suite('Plan-level fields accepted individually', () => {
    const minimalPlan = (overrides: Record<string, unknown>) => ({
      name: 'Test',
      jobs: [{ producerId: 'job-one', task: 'X', dependencies: [], work: 'echo ok' }],
      ...overrides,
    });

    test('baseBranch', () => {
      const r = validateInput('create_copilot_plan', minimalPlan({ baseBranch: 'develop' }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('targetBranch', () => {
      const r = validateInput('create_copilot_plan', minimalPlan({ targetBranch: 'release/v1' }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('maxParallel', () => {
      const r = validateInput('create_copilot_plan', minimalPlan({ maxParallel: 8 }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('cleanUpSuccessfulWork', () => {
      const r = validateInput('create_copilot_plan', minimalPlan({ cleanUpSuccessfulWork: false }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('startPaused', () => {
      const r = validateInput('create_copilot_plan', minimalPlan({ startPaused: true }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('additionalSymlinkDirs', () => {
      const r = validateInput('create_copilot_plan', minimalPlan({ additionalSymlinkDirs: ['.venv'] }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('verify_ri as string', () => {
      const r = validateInput('create_copilot_plan', minimalPlan({ verifyRi: 'npm test' }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('verify_ri as object', () => {
      const r = validateInput('create_copilot_plan', minimalPlan({
        verifyRi: { type: 'shell', command: 'npm test' },
      }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('verify_ri with on_failure', () => {
      const r = validateInput('create_copilot_plan', minimalPlan({
        verifyRi: {
          type: 'agent',
          instructions: '# Verify',
          onFailure: { noAutoHeal: true, message: 'Verify failed' },
        },
      }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('groups is rejected (no longer supported at plan level)', () => {
      const r = validateInput('create_copilot_plan', minimalPlan({
        groups: [{ name: 'g1', jobs: [{ producerId: 'g-job', task: 'T', dependencies: [], work: 'echo ok' }] }],
      }));
      assert.strictEqual(r.valid, false);
    });
  });

  // -----------------------------------------------------------------------
  // Job-level property isolation tests
  // -----------------------------------------------------------------------

  suite('Job-level fields accepted individually', () => {
    const planWith = (jobOverrides: Record<string, unknown>) => ({
      name: 'Test',
      jobs: [{
        producerId: 'job-one',
        task: 'X',
        dependencies: [],
        work: 'echo ok',
        ...jobOverrides,
      }],
    });

    test('name', () => {
      const r = validateInput('create_copilot_plan', planWith({ name: 'My Job' }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('instructions', () => {
      const r = validateInput('create_copilot_plan', planWith({ instructions: '# Do things' }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('group', () => {
      const r = validateInput('create_copilot_plan', planWith({ group: 'build' }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('expects_no_changes', () => {
      const r = validateInput('create_copilot_plan', planWith({ expectsNoChanges: true }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('baseBranch (job-level)', () => {
      const r = validateInput('create_copilot_plan', planWith({ baseBranch: 'feature/x' }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('work as string', () => {
      const r = validateInput('create_copilot_plan', planWith({ work: 'npm test' }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('prechecks as string', () => {
      const r = validateInput('create_copilot_plan', planWith({ prechecks: 'npm run lint' }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('postchecks as string', () => {
      const r = validateInput('create_copilot_plan', planWith({ postchecks: 'npm test' }));
      assert.strictEqual(r.valid, true, r.error);
    });
  });

  // -----------------------------------------------------------------------
  // WorkSpec property isolation tests (all spec types)
  // -----------------------------------------------------------------------

  suite('WorkSpec properties accepted in work objects', () => {
    const planWithWork = (workSpec: Record<string, unknown>) => ({
      name: 'Test',
      jobs: [{
        producerId: 'job-one',
        task: 'X',
        dependencies: [],
        work: workSpec,
      }],
    });

    test('type: process + executable + args', () => {
      const r = validateInput('create_copilot_plan', planWithWork({
        type: 'process', executable: 'node', args: ['index.js'],
      }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('type: shell + command + shell', () => {
      const r = validateInput('create_copilot_plan', planWithWork({
        type: 'shell', command: 'npm test', shell: 'bash',
      }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('type: agent + instructions + model + maxTurns + resumeSession', () => {
      const r = validateInput('create_copilot_plan', planWithWork({
        type: 'agent',
        instructions: '# Task',
        model: 'gpt-4',
        maxTurns: 25,
        resumeSession: false,
      }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('allowedFolders', () => {
      const r = validateInput('create_copilot_plan', planWithWork({
        type: 'agent', instructions: '#', allowedFolders: ['/shared'],
      }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('allowedUrls', () => {
      const r = validateInput('create_copilot_plan', planWithWork({
        type: 'agent', instructions: '#', allowedUrls: ['https://api.example.com'],
      }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('on_failure with all fields', () => {
      const r = validateInput('create_copilot_plan', planWithWork({
        type: 'shell',
        command: 'npm test',
        onFailure: {
          noAutoHeal: true,
          message: 'Tests must pass',
          resumeFromPhase: 'work',
        },
      }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('on_failure with only no_auto_heal', () => {
      const r = validateInput('create_copilot_plan', planWithWork({
        type: 'shell', command: 'npm test',
        onFailure: { noAutoHeal: true },
      }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('on_failure with only message', () => {
      const r = validateInput('create_copilot_plan', planWithWork({
        type: 'shell', command: 'npm test',
        onFailure: { message: 'Fix manually' },
      }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('on_failure with only resume_from_phase', () => {
      const r = validateInput('create_copilot_plan', planWithWork({
        type: 'shell', command: 'npm test',
        onFailure: { resumeFromPhase: 'prechecks' },
      }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('on_failure resume_from_phase accepts all valid values', () => {
      const phases = ['merge-fi', 'prechecks', 'work', 'postchecks', 'commit', 'merge-ri'];
      for (const phase of phases) {
        const r = validateInput('create_copilot_plan', planWithWork({
          type: 'shell', command: 'x',
          onFailure: { resumeFromPhase: phase },
        }));
        assert.strictEqual(r.valid, true, `Phase '${phase}' should be valid: ${r.error}`);
      }
    });

    test('on_failure on prechecks', () => {
      const r = validateInput('create_copilot_plan', {
        name: 'Test',
        jobs: [{
          producerId: 'job-one', task: 'X', dependencies: [], work: 'echo ok',
          prechecks: {
            type: 'shell', command: 'npm run lint',
            onFailure: { noAutoHeal: true, message: 'Lint failed' },
          },
        }],
      });
      assert.strictEqual(r.valid, true, r.error);
    });

    test('on_failure on postchecks', () => {
      const r = validateInput('create_copilot_plan', {
        name: 'Test',
        jobs: [{
          producerId: 'job-one', task: 'X', dependencies: [], work: 'echo ok',
          postchecks: {
            type: 'shell', command: 'npm test',
            onFailure: { noAutoHeal: false },
          },
        }],
      });
      assert.strictEqual(r.valid, true, r.error);
    });

    test('all shell enum values accepted', () => {
      const shells = ['cmd', 'powershell', 'pwsh', 'bash', 'sh'];
      for (const shell of shells) {
        const r = validateInput('create_copilot_plan', planWithWork({
          type: 'shell', command: 'echo hi', shell,
        }));
        assert.strictEqual(r.valid, true, `Shell '${shell}' should be valid: ${r.error}`);
      }
    });

    test('type: agent with modelTier is accepted', () => {
      const r = validateInput('create_copilot_plan', planWithWork({
        type: 'agent', instructions: '# Task', modelTier: 'fast',
      }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('modelTier rejects invalid value', () => {
      const r = validateInput('create_copilot_plan', planWithWork({
        type: 'agent', instructions: '# Task', modelTier: 'ultra',
      }));
      assert.strictEqual(r.valid, false);
    });
  });

  // -----------------------------------------------------------------------
  // Negative tests: unknown properties still rejected
  // -----------------------------------------------------------------------

  suite('Unknown properties are still rejected', () => {
    test('unknown plan-level property', () => {
      const r = validateInput('create_copilot_plan', {
        name: 'Test',
        jobs: [{ producerId: 'job-one', task: 'X', dependencies: [] }],
        unknownField: true,
      });
      assert.strictEqual(r.valid, false);
      assert.ok(r.error!.includes('unknownField'));
    });

    test('unknown job-level property', () => {
      const r = validateInput('create_copilot_plan', {
        name: 'Test',
        jobs: [{ producerId: 'job-one', task: 'X', dependencies: [], work: 'echo ok', foo: 'bar' }],
      });
      assert.strictEqual(r.valid, false);
      assert.ok(r.error!.includes('foo'));
    });

    test('unknown work spec property', () => {
      const r = validateInput('create_copilot_plan', {
        name: 'Test',
        jobs: [{
          producerId: 'job-one', task: 'X', dependencies: [],
          work: { type: 'shell', command: 'x', unknownProp: true },
        }],
      });
      assert.strictEqual(r.valid, false);
    });

    test('unknown on_failure property', () => {
      const r = validateInput('create_copilot_plan', {
        name: 'Test',
        jobs: [{
          producerId: 'job-one', task: 'X', dependencies: [],
          work: {
            type: 'shell', command: 'x',
            onFailure: { noAutoHeal: true, unknownConfig: 'bad' },
          },
        }],
      });
      assert.strictEqual(r.valid, false);
    });

    test('invalid resume_from_phase value', () => {
      const r = validateInput('create_copilot_plan', {
        name: 'Test',
        jobs: [{
          producerId: 'job-one', task: 'X', dependencies: [],
          work: {
            type: 'shell', command: 'x',
            onFailure: { resumeFromPhase: 'invalid-phase' },
          },
        }],
      });
      assert.strictEqual(r.valid, false);
    });
  });

  // -----------------------------------------------------------------------
  // Cross-tool consistency: on_failure works everywhere workSpec is used
  // -----------------------------------------------------------------------

  suite('on_failure accepted in all tools that use work specs', () => {
    const workWithOnFailure = {
      type: 'shell',
      command: 'npm test',
      onFailure: { noAutoHeal: true, message: 'fail' },
    };

    test('retry_copilot_plan — newWork', () => {
      const r = validateInput('retry_copilot_plan', {
        planId: 'plan-1',
        newWork: workWithOnFailure,
      });
      assert.strictEqual(r.valid, true, r.error);
    });

    test('retry_copilot_plan — newPrechecks', () => {
      const r = validateInput('retry_copilot_plan', {
        planId: 'plan-1',
        newPrechecks: workWithOnFailure,
      });
      assert.strictEqual(r.valid, true, r.error);
    });

    test('retry_copilot_plan — newPostchecks', () => {
      const r = validateInput('retry_copilot_plan', {
        planId: 'plan-1',
        newPostchecks: workWithOnFailure,
      });
      assert.strictEqual(r.valid, true, r.error);
    });

    test('retry_copilot_plan_job — newWork', () => {
      const r = validateInput('retry_copilot_plan_job', {
        planId: 'p', jobId: 'n',
        newWork: workWithOnFailure,
      });
      assert.strictEqual(r.valid, true, r.error);
    });

    test('retry_copilot_job (job-centric) — newWork', () => {
      const r = validateInput('retry_copilot_job', {
        planId: 'p', jobId: 'n',
        newWork: workWithOnFailure,
      });
      assert.strictEqual(r.valid, true, r.error);
    });

    test('update_copilot_plan_job — work', () => {
      const r = validateInput('update_copilot_plan_job', {
        planId: 'p', jobId: 'n',
        work: workWithOnFailure,
      });
      assert.strictEqual(r.valid, true, r.error);
    });

    test('reshape_copilot_plan — spec.work', () => {
      const r = validateInput('reshape_copilot_plan', {
        planId: 'p',
        operations: [{
          type: 'add_node',
          spec: {
            producerId: 'new-job', task: 'T', dependencies: [],
            work: workWithOnFailure,
          },
        }],
      });
      assert.strictEqual(r.valid, true, r.error);
    });

    test('add_copilot_job — work', () => {
      const r = validateInput('add_copilot_job', {
        planId: 'p',
        nodes: [{
          producerId: 'new-job', task: 'T', dependencies: [],
          work: workWithOnFailure,
        }],
      });
      assert.strictEqual(r.valid, true, r.error);
    });
  });

  suite('validatePostchecksPresence', () => {
    test('returns warning when job has work but no postchecks', () => {
      const warnings = validatePostchecksPresence({
        name: 'Test Plan',
        jobs: [{ producerId: 'j1', task: 'Do stuff', dependencies: [], work: { type: 'shell', command: 'echo hi' } }],
      });
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes('postchecks'));
    });

    test('returns no warning when job has both work and postchecks', () => {
      const warnings = validatePostchecksPresence({
        name: 'Test Plan',
        jobs: [{ producerId: 'j1', task: 'Do stuff', dependencies: [], work: { type: 'shell', command: 'echo hi' }, postchecks: { type: 'shell', command: 'echo check' } }],
      });
      assert.strictEqual(warnings.length, 0);
    });

    test('returns no warning when no work specified', () => {
      const warnings = validatePostchecksPresence({
        name: 'Test Plan',
        jobs: [{ producerId: 'j1', task: 'Do stuff', dependencies: [] }],
      });
      assert.strictEqual(warnings.length, 0);
    });

    test('checks nested groups', () => {
      const warnings = validatePostchecksPresence({
        name: 'Test Plan',
        groups: [{ name: 'g1', jobs: [{ producerId: 'j1', task: 'Do stuff', dependencies: [], work: 'echo hi' }] }],
      });
      assert.strictEqual(warnings.length, 1);
    });
  });
});
