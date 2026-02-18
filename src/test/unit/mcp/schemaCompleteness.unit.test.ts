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
  verify_ri: {
    type: 'shell',
    command: 'npm run build && npm test',
    on_failure: {
      no_auto_heal: true,
      message: 'Build failed after merge',
      resume_from_phase: 'prechecks',
    },
  },

  // -- Jobs: one per work-spec type, plus all job-level fields --
  jobs: [
    {
      // Agent spec with ALL agent-specific properties
      producer_id: 'agent-job',
      name: 'Agent Work',
      task: 'Implement feature X',
      instructions: '# Detailed instructions\n\nDo the thing.',
      group: 'build',
      expects_no_changes: false,
      dependencies: [],
      work: {
        type: 'agent',
        instructions: '# Build feature',
        agent: 'k8s-assistant',
        model: 'claude-sonnet-4',
        model_tier: 'standard',
        maxTurns: 15,
        resumeSession: true,
        allowedFolders: ['/shared/libs'],
        allowedUrls: ['https://api.example.com'],
        on_failure: {
          no_auto_heal: false,
          message: 'Agent failed',
          resume_from_phase: 'work',
        },
      },
      prechecks: {
        type: 'shell',
        command: 'npm run lint',
        shell: 'bash',
        on_failure: {
          no_auto_heal: true,
          message: 'Lint must pass',
          resume_from_phase: 'prechecks',
        },
      },
      postchecks: 'npm test',
    },
    {
      // Shell spec
      producer_id: 'shell-job',
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
      producer_id: 'process-job',
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
      producer_id: 'string-job',
      task: 'Run string command',
      dependencies: ['shell-job', 'process-job'],
      work: 'npm run build',
      prechecks: 'echo pre',
      postchecks: 'echo post',
    },
  ],

  // -- Groups (recursive) --
  groups: [
    {
      name: 'build',
      jobs: [
        {
          producer_id: 'grouped-job',
          task: 'Grouped task',
          dependencies: [],
          work: {
            type: 'agent',
            instructions: '# Grouped agent work',
            on_failure: { message: 'Grouped agent failed' },
          },
        },
      ],
      groups: [
        {
          name: 'sub-build',
          jobs: [
            {
              producer_id: 'sub-grouped-job',
              task: 'Sub-grouped task',
              dependencies: [],
            },
          ],
        },
      ],
    },
  ],
};

/**
 * Kitchen-sink retry_copilot_plan_node input.
 */
const KITCHEN_SINK_RETRY_NODE = {
  planId: 'plan-123',
  nodeId: 'node-456',
  newWork: {
    type: 'agent',
    instructions: '# Fix the issue',
    model: 'claude-sonnet-4',
    model_tier: 'fast',
    maxTurns: 10,
    resumeSession: false,
    allowedFolders: ['/tmp/shared'],
    allowedUrls: ['https://registry.npmjs.org'],
    on_failure: {
      no_auto_heal: true,
      message: 'Cannot auto-heal this',
      resume_from_phase: 'work',
    },
  },
  newPrechecks: {
    type: 'shell',
    command: 'npm run lint',
    on_failure: { resume_from_phase: 'prechecks' },
  },
  newPostchecks: null,
  clearWorktree: true,
};

/**
 * Kitchen-sink update_copilot_plan_node input.
 */
const KITCHEN_SINK_UPDATE_NODE = {
  planId: 'plan-123',
  nodeId: 'node-456',
  work: {
    type: 'shell',
    command: 'npm test',
    on_failure: {
      no_auto_heal: true,
      message: 'Tests must pass',
      resume_from_phase: 'work',
    },
  },
  prechecks: {
    type: 'shell',
    command: 'npm run lint',
    on_failure: { message: 'Lint failed' },
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
        producer_id: 'new-node',
        task: 'New task',
        dependencies: [],
        work: {
          type: 'agent',
          instructions: '# New work',
          on_failure: { no_auto_heal: true },
        },
        prechecks: {
          type: 'shell',
          command: 'npm run lint',
          on_failure: { resume_from_phase: 'prechecks' },
        },
        postchecks: 'npm test',
        instructions: '# Extra instructions',
        expects_no_changes: false,
      },
    },
    {
      type: 'remove_node',
      producer_id: 'old-node',
    },
    {
      type: 'update_deps',
      producer_id: 'shell-job',
      dependencies: ['new-node'],
    },
  ],
};

/**
 * Kitchen-sink retry_copilot_node (node-centric, no planId) input.
 */
const KITCHEN_SINK_RETRY_NODE_CENTRIC = {
  node_id: 'node-789',
  newWork: {
    type: 'shell',
    command: 'npm run build',
    on_failure: { no_auto_heal: false },
  },
  newPrechecks: null,
  newPostchecks: {
    type: 'agent',
    instructions: '# Verify output',
    on_failure: { message: 'Post-check failed', resume_from_phase: 'postchecks' },
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

    test('retry_copilot_plan_node accepts full kitchen-sink input', () => {
      const result = validateInput('retry_copilot_plan_node', KITCHEN_SINK_RETRY_NODE);
      assert.strictEqual(result.valid, true, `Validation errors: ${result.error}`);
    });

    test('update_copilot_plan_node accepts full kitchen-sink input', () => {
      const result = validateInput('update_copilot_plan_node', KITCHEN_SINK_UPDATE_NODE);
      assert.strictEqual(result.valid, true, `Validation errors: ${result.error}`);
    });

    test('reshape_copilot_plan accepts full kitchen-sink input', () => {
      const result = validateInput('reshape_copilot_plan', KITCHEN_SINK_RESHAPE);
      assert.strictEqual(result.valid, true, `Validation errors: ${result.error}`);
    });

    test('retry_copilot_node (node-centric) accepts full kitchen-sink input', () => {
      const result = validateInput('retry_copilot_node', KITCHEN_SINK_RETRY_NODE_CENTRIC);
      assert.strictEqual(result.valid, true, `Validation errors: ${result.error}`);
    });
  });

  // -----------------------------------------------------------------------
  // Plan-level property isolation tests
  // -----------------------------------------------------------------------

  suite('Plan-level fields accepted individually', () => {
    const minimalPlan = (overrides: Record<string, unknown>) => ({
      name: 'Test',
      jobs: [{ producer_id: 'job-one', task: 'X', dependencies: [] }],
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
      const r = validateInput('create_copilot_plan', minimalPlan({ verify_ri: 'npm test' }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('verify_ri as object', () => {
      const r = validateInput('create_copilot_plan', minimalPlan({
        verify_ri: { type: 'shell', command: 'npm test' },
      }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('verify_ri with on_failure', () => {
      const r = validateInput('create_copilot_plan', minimalPlan({
        verify_ri: {
          type: 'agent',
          instructions: '# Verify',
          on_failure: { no_auto_heal: true, message: 'Verify failed' },
        },
      }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('groups', () => {
      const r = validateInput('create_copilot_plan', minimalPlan({
        groups: [{ name: 'g1', jobs: [{ producer_id: 'g-job', task: 'T', dependencies: [] }] }],
      }));
      assert.strictEqual(r.valid, true, r.error);
    });
  });

  // -----------------------------------------------------------------------
  // Job-level property isolation tests
  // -----------------------------------------------------------------------

  suite('Job-level fields accepted individually', () => {
    const planWith = (jobOverrides: Record<string, unknown>) => ({
      name: 'Test',
      jobs: [{
        producer_id: 'job-one',
        task: 'X',
        dependencies: [],
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
      const r = validateInput('create_copilot_plan', planWith({ expects_no_changes: true }));
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
        producer_id: 'job-one',
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
        on_failure: {
          no_auto_heal: true,
          message: 'Tests must pass',
          resume_from_phase: 'work',
        },
      }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('on_failure with only no_auto_heal', () => {
      const r = validateInput('create_copilot_plan', planWithWork({
        type: 'shell', command: 'npm test',
        on_failure: { no_auto_heal: true },
      }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('on_failure with only message', () => {
      const r = validateInput('create_copilot_plan', planWithWork({
        type: 'shell', command: 'npm test',
        on_failure: { message: 'Fix manually' },
      }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('on_failure with only resume_from_phase', () => {
      const r = validateInput('create_copilot_plan', planWithWork({
        type: 'shell', command: 'npm test',
        on_failure: { resume_from_phase: 'prechecks' },
      }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('on_failure resume_from_phase accepts all valid values', () => {
      const phases = ['merge-fi', 'prechecks', 'work', 'postchecks', 'commit', 'merge-ri'];
      for (const phase of phases) {
        const r = validateInput('create_copilot_plan', planWithWork({
          type: 'shell', command: 'x',
          on_failure: { resume_from_phase: phase },
        }));
        assert.strictEqual(r.valid, true, `Phase '${phase}' should be valid: ${r.error}`);
      }
    });

    test('on_failure on prechecks', () => {
      const r = validateInput('create_copilot_plan', {
        name: 'Test',
        jobs: [{
          producer_id: 'job-one', task: 'X', dependencies: [],
          prechecks: {
            type: 'shell', command: 'npm run lint',
            on_failure: { no_auto_heal: true, message: 'Lint failed' },
          },
        }],
      });
      assert.strictEqual(r.valid, true, r.error);
    });

    test('on_failure on postchecks', () => {
      const r = validateInput('create_copilot_plan', {
        name: 'Test',
        jobs: [{
          producer_id: 'job-one', task: 'X', dependencies: [],
          postchecks: {
            type: 'shell', command: 'npm test',
            on_failure: { no_auto_heal: false },
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

    test('type: agent with model_tier is accepted', () => {
      const r = validateInput('create_copilot_plan', planWithWork({
        type: 'agent', instructions: '# Task', model_tier: 'fast',
      }));
      assert.strictEqual(r.valid, true, r.error);
    });

    test('model_tier rejects invalid value', () => {
      const r = validateInput('create_copilot_plan', planWithWork({
        type: 'agent', instructions: '# Task', model_tier: 'ultra',
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
        jobs: [{ producer_id: 'job-one', task: 'X', dependencies: [] }],
        unknownField: true,
      });
      assert.strictEqual(r.valid, false);
      assert.ok(r.error!.includes('unknownField'));
    });

    test('unknown job-level property', () => {
      const r = validateInput('create_copilot_plan', {
        name: 'Test',
        jobs: [{ producer_id: 'job-one', task: 'X', dependencies: [], foo: 'bar' }],
      });
      assert.strictEqual(r.valid, false);
      assert.ok(r.error!.includes('foo'));
    });

    test('unknown work spec property', () => {
      const r = validateInput('create_copilot_plan', {
        name: 'Test',
        jobs: [{
          producer_id: 'job-one', task: 'X', dependencies: [],
          work: { type: 'shell', command: 'x', unknownProp: true },
        }],
      });
      assert.strictEqual(r.valid, false);
    });

    test('unknown on_failure property', () => {
      const r = validateInput('create_copilot_plan', {
        name: 'Test',
        jobs: [{
          producer_id: 'job-one', task: 'X', dependencies: [],
          work: {
            type: 'shell', command: 'x',
            on_failure: { no_auto_heal: true, unknownConfig: 'bad' },
          },
        }],
      });
      assert.strictEqual(r.valid, false);
    });

    test('invalid resume_from_phase value', () => {
      const r = validateInput('create_copilot_plan', {
        name: 'Test',
        jobs: [{
          producer_id: 'job-one', task: 'X', dependencies: [],
          work: {
            type: 'shell', command: 'x',
            on_failure: { resume_from_phase: 'invalid-phase' },
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
      on_failure: { no_auto_heal: true, message: 'fail' },
    };

    test('retry_copilot_plan — newWork', () => {
      const r = validateInput('retry_copilot_plan', {
        id: 'plan-1',
        newWork: workWithOnFailure,
      });
      assert.strictEqual(r.valid, true, r.error);
    });

    test('retry_copilot_plan — newPrechecks', () => {
      const r = validateInput('retry_copilot_plan', {
        id: 'plan-1',
        newPrechecks: workWithOnFailure,
      });
      assert.strictEqual(r.valid, true, r.error);
    });

    test('retry_copilot_plan — newPostchecks', () => {
      const r = validateInput('retry_copilot_plan', {
        id: 'plan-1',
        newPostchecks: workWithOnFailure,
      });
      assert.strictEqual(r.valid, true, r.error);
    });

    test('retry_copilot_plan_node — newWork', () => {
      const r = validateInput('retry_copilot_plan_node', {
        planId: 'p', nodeId: 'n',
        newWork: workWithOnFailure,
      });
      assert.strictEqual(r.valid, true, r.error);
    });

    test('retry_copilot_node (node-centric) — newWork', () => {
      const r = validateInput('retry_copilot_node', {
        node_id: 'n',
        newWork: workWithOnFailure,
      });
      assert.strictEqual(r.valid, true, r.error);
    });

    test('update_copilot_plan_node — work', () => {
      const r = validateInput('update_copilot_plan_node', {
        planId: 'p', nodeId: 'n',
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
            producer_id: 'new-job', task: 'T', dependencies: [],
            work: workWithOnFailure,
          },
        }],
      });
      assert.strictEqual(r.valid, true, r.error);
    });

    test('add_copilot_node — work', () => {
      const r = validateInput('add_copilot_node', {
        plan_id: 'p',
        nodes: [{
          producer_id: 'new-job', task: 'T', dependencies: [],
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
        jobs: [{ producer_id: 'j1', task: 'Do stuff', dependencies: [], work: { type: 'shell', command: 'echo hi' } }],
      });
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes('postchecks'));
    });

    test('returns no warning when job has both work and postchecks', () => {
      const warnings = validatePostchecksPresence({
        name: 'Test Plan',
        jobs: [{ producer_id: 'j1', task: 'Do stuff', dependencies: [], work: { type: 'shell', command: 'echo hi' }, postchecks: { type: 'shell', command: 'echo check' } }],
      });
      assert.strictEqual(warnings.length, 0);
    });

    test('returns no warning when no work specified', () => {
      const warnings = validatePostchecksPresence({
        name: 'Test Plan',
        jobs: [{ producer_id: 'j1', task: 'Do stuff', dependencies: [] }],
      });
      assert.strictEqual(warnings.length, 0);
    });

    test('checks nested groups', () => {
      const warnings = validatePostchecksPresence({
        name: 'Test Plan',
        groups: [{ name: 'g1', jobs: [{ producer_id: 'j1', task: 'Do stuff', dependencies: [], work: 'echo hi' }] }],
      });
      assert.strictEqual(warnings.length, 1);
    });
  });
});
