/**
 * @fileoverview Schema validation test coverage
 *
 * Tests all schemas for required fields, optional fields, and validation rules.
 * This test file covers the requirements from orchestrator-job-58b2eaf6 task:
 * - workSpecObjectSchema requires 'type' field
 * - jobSchema has 'env' field
 * - createPlanSchema has 'resumeAfterPlan' field
 * - scaffoldPlanSchema has 'resumeAfterPlan' field
 * - updatePlanSchema has 'resumeAfterPlan' field (empty string to clear)
 * - pausePlanSchema and resumePlanSchema exist and validate
 * - All job-centric schemas require 'planId'
 * - get_copilot_job_logs has 'phase' + 'tail' fields
 * - get_copilot_job_attempts has 'attemptNumber' + 'includeLogs' fields
 * - Removed schemas validation (no legacy schemas in registry)
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { validateInput, hasSchema } from '../../../mcp/validation';
import {
  createPlanSchema,
  scaffoldPlanSchema,
  updatePlanSchema,
  pausePlanSchema,
  resumePlanSchema,
  getNodeLogsSchema,
  getNodeAttemptsSchema,
  getNodeSchema,
  listNodesSchema,
  retryNodeCentricSchema,
  forceFailNodeSchema,
  getNodeFailureContextSchema,
} from '../../../mcp/validation/schemas';

suite('Schema Validation Coverage', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(console, 'log');
    sandbox.stub(console, 'debug');
    sandbox.stub(console, 'warn');
    sandbox.stub(console, 'error');
  });

  teardown(() => {
    sandbox.restore();
  });

  // ==========================================================================
  // workSpecObjectSchema - requires 'type' field
  // ==========================================================================
  suite('workSpecObjectSchema requires type field', () => {
    test('accepts work spec with type=agent', () => {
      const result = validateInput('create_copilot_plan', {
        name: 'Test Plan',
        jobs: [{
          producerId: 'job-1',
          task: 'Test task',
          dependencies: [],
          work: {
            type: 'agent',
            instructions: 'Do work',
          },
        }],
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('accepts work spec with type=shell', () => {
      const result = validateInput('create_copilot_plan', {
        name: 'Test Plan',
        jobs: [{
          producerId: 'job-1',
          task: 'Test task',
          dependencies: [],
          work: {
            type: 'shell',
            command: 'npm test',
          },
        }],
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('accepts work spec with type=process', () => {
      const result = validateInput('create_copilot_plan', {
        name: 'Test Plan',
        jobs: [{
          producerId: 'job-1',
          task: 'Test task',
          dependencies: [],
          work: {
            type: 'process',
            executable: 'node',
            args: ['build.js'],
          },
        }],
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('rejects work spec object without type field', () => {
      const result = validateInput('create_copilot_plan', {
        name: 'Test Plan',
        jobs: [{
          producerId: 'job-1',
          task: 'Test task',
          dependencies: [],
          work: {
            command: 'npm test',
          },
        }],
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('type') || result.error?.includes('required'));
    });
  });

  // ==========================================================================
  // jobSchema has 'env' field
  // ==========================================================================
  suite('jobSchema has env field', () => {
    test('accepts job-level env field', () => {
      const result = validateInput('create_copilot_plan', {
        name: 'Test Plan',
        jobs: [{
          producerId: 'job-1',
          task: 'Test task',
          dependencies: [],
          work: 'npm test',
          env: {
            NODE_ENV: 'production',
            API_KEY: 'test-key',
          },
        }],
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('accepts job with no env field', () => {
      const result = validateInput('create_copilot_plan', {
        name: 'Test Plan',
        jobs: [{
          producerId: 'job-1',
          task: 'Test task',
          dependencies: [],
          work: 'npm test',
        }],
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('rejects job-level env with non-string values', () => {
      const result = validateInput('create_copilot_plan', {
        name: 'Test Plan',
        jobs: [{
          producerId: 'job-1',
          task: 'Test task',
          dependencies: [],
          work: 'npm test',
          env: {
            NODE_ENV: 123,
          },
        }],
      });
      assert.strictEqual(result.valid, false);
    });
  });

  // ==========================================================================
  // createPlanSchema has 'resumeAfterPlan' field
  // ==========================================================================
  suite('createPlanSchema has resumeAfterPlan field', () => {
    test('accepts resumeAfterPlan field', () => {
      const result = validateInput('create_copilot_plan', {
        name: 'Test Plan',
        jobs: [{
          producerId: 'job-1',
          task: 'Test task',
          dependencies: [],
          work: 'npm test',
        }],
        resumeAfterPlan: 'plan-abc-123',
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('accepts plan without resumeAfterPlan field', () => {
      const result = validateInput('create_copilot_plan', {
        name: 'Test Plan',
        jobs: [{
          producerId: 'job-1',
          task: 'Test task',
          dependencies: [],
          work: 'npm test',
        }],
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('rejects empty resumeAfterPlan string', () => {
      const result = validateInput('create_copilot_plan', {
        name: 'Test Plan',
        jobs: [{
          producerId: 'job-1',
          task: 'Test task',
          dependencies: [],
          work: 'npm test',
        }],
        resumeAfterPlan: '',
      });
      assert.strictEqual(result.valid, false);
    });

    test('rejects resumeAfterPlan too long', () => {
      const result = validateInput('create_copilot_plan', {
        name: 'Test Plan',
        jobs: [{
          producerId: 'job-1',
          task: 'Test task',
          dependencies: [],
          work: 'npm test',
        }],
        resumeAfterPlan: 'a'.repeat(101),
      });
      assert.strictEqual(result.valid, false);
    });
  });

  // ==========================================================================
  // scaffoldPlanSchema has 'resumeAfterPlan' field
  // ==========================================================================
  suite('scaffoldPlanSchema has resumeAfterPlan field', () => {
    test('accepts resumeAfterPlan field', () => {
      const result = validateInput('scaffold_copilot_plan', {
        name: 'Test Plan',
        resumeAfterPlan: 'plan-abc-123',
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('accepts plan without resumeAfterPlan field', () => {
      const result = validateInput('scaffold_copilot_plan', {
        name: 'Test Plan',
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('rejects empty resumeAfterPlan string', () => {
      const result = validateInput('scaffold_copilot_plan', {
        name: 'Test Plan',
        resumeAfterPlan: '',
      });
      assert.strictEqual(result.valid, false);
    });
  });

  // ==========================================================================
  // updatePlanSchema has 'resumeAfterPlan' field (empty string to clear)
  // ==========================================================================
  suite('updatePlanSchema has resumeAfterPlan field', () => {
    test('schema has correct $id', () => {
      assert.strictEqual(updatePlanSchema.$id, 'update_copilot_plan');
    });

    test('accepts resumeAfterPlan with plan ID', () => {
      const result = validateInput('update_copilot_plan', {
        planId: 'plan-123',
        resumeAfterPlan: 'plan-abc-456',
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('accepts empty string to clear resumeAfterPlan', () => {
      const result = validateInput('update_copilot_plan', {
        planId: 'plan-123',
        resumeAfterPlan: '',
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('accepts update without resumeAfterPlan', () => {
      const result = validateInput('update_copilot_plan', {
        planId: 'plan-123',
        maxParallel: 8,
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('rejects resumeAfterPlan too long', () => {
      const result = validateInput('update_copilot_plan', {
        planId: 'plan-123',
        resumeAfterPlan: 'a'.repeat(101),
      });
      assert.strictEqual(result.valid, false);
    });
  });

  // ==========================================================================
  // pausePlanSchema and resumePlanSchema exist and validate
  // ==========================================================================
  suite('pausePlanSchema exists and validates', () => {
    test('schema has correct $id', () => {
      assert.strictEqual(pausePlanSchema.$id, 'pause_copilot_plan');
    });

    test('schema is registered', () => {
      assert.strictEqual(hasSchema('pause_copilot_plan'), true);
    });

    test('requires planId field', () => {
      assert.ok(pausePlanSchema.required.includes('planId'));
    });

    test('validates minimal valid input', () => {
      const result = validateInput('pause_copilot_plan', {
        planId: 'plan-123',
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('rejects missing planId', () => {
      const result = validateInput('pause_copilot_plan', {});
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('planId'));
    });

    test('rejects unknown properties', () => {
      const result = validateInput('pause_copilot_plan', {
        planId: 'plan-123',
        unknownField: 'value',
      });
      assert.strictEqual(result.valid, false);
    });
  });

  suite('resumePlanSchema exists and validates', () => {
    test('schema has correct $id', () => {
      assert.strictEqual(resumePlanSchema.$id, 'resume_copilot_plan');
    });

    test('schema is registered', () => {
      assert.strictEqual(hasSchema('resume_copilot_plan'), true);
    });

    test('requires planId field', () => {
      assert.ok(resumePlanSchema.required.includes('planId'));
    });

    test('validates minimal valid input', () => {
      const result = validateInput('resume_copilot_plan', {
        planId: 'plan-123',
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('rejects missing planId', () => {
      const result = validateInput('resume_copilot_plan', {});
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('planId'));
    });

    test('rejects unknown properties', () => {
      const result = validateInput('resume_copilot_plan', {
        planId: 'plan-123',
        unknownField: 'value',
      });
      assert.strictEqual(result.valid, false);
    });
  });

  // ==========================================================================
  // All job-centric schemas require 'planId'
  // ==========================================================================
  suite('Job-centric schemas require planId', () => {
    test('get_copilot_job requires planId', () => {
      assert.ok(getNodeSchema.required.includes('planId'));
      const result = validateInput('get_copilot_job', { jobId: 'job-1' });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('planId'));
    });

    test('list_copilot_jobs requires planId', () => {
      assert.ok(listNodesSchema.required.includes('planId'));
      const result = validateInput('list_copilot_jobs', { status: 'running' });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('planId'));
    });

    test('retry_copilot_job requires planId', () => {
      assert.ok(retryNodeCentricSchema.required.includes('planId'));
      const result = validateInput('retry_copilot_job', { jobId: 'job-1' });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('planId'));
    });

    test('force_fail_copilot_job requires planId', () => {
      assert.ok(forceFailNodeSchema.required.includes('planId'));
      const result = validateInput('force_fail_copilot_job', { jobId: 'job-1' });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('planId'));
    });

    test('get_copilot_job_failure_context requires planId', () => {
      assert.ok(getNodeFailureContextSchema.required.includes('planId'));
      const result = validateInput('get_copilot_job_failure_context', { jobId: 'job-1' });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('planId'));
    });
  });

  // ==========================================================================
  // get_copilot_job_logs has 'phase' + 'tail' fields
  // ==========================================================================
  suite('get_copilot_job_logs has phase and tail fields', () => {
    test('schema has correct $id', () => {
      assert.strictEqual(getNodeLogsSchema.$id, 'get_copilot_job_logs');
    });

    test('requires planId and jobId', () => {
      assert.ok(getNodeLogsSchema.required.includes('planId'));
      assert.ok(getNodeLogsSchema.required.includes('jobId'));
    });

    test('accepts request without phase or tail', () => {
      const result = validateInput('get_copilot_job_logs', {
        planId: 'plan-123',
        jobId: 'job-1',
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('accepts phase field with valid enum value', () => {
      const validPhases = ['merge-fi', 'setup', 'prechecks', 'work', 'commit', 'postchecks', 'merge-ri', 'all'];
      for (const phase of validPhases) {
        const result = validateInput('get_copilot_job_logs', {
          planId: 'plan-123',
          jobId: 'job-1',
          phase,
        });
        assert.strictEqual(result.valid, true, `${phase}: ${result.error}`);
      }
    });

    test('rejects invalid phase value', () => {
      const result = validateInput('get_copilot_job_logs', {
        planId: 'plan-123',
        jobId: 'job-1',
        phase: 'invalid-phase',
      });
      assert.strictEqual(result.valid, false);
    });

    test('accepts tail field with valid number', () => {
      const result = validateInput('get_copilot_job_logs', {
        planId: 'plan-123',
        jobId: 'job-1',
        tail: 100,
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('rejects tail below minimum', () => {
      const result = validateInput('get_copilot_job_logs', {
        planId: 'plan-123',
        jobId: 'job-1',
        tail: 0,
      });
      assert.strictEqual(result.valid, false);
    });

    test('rejects tail above maximum', () => {
      const result = validateInput('get_copilot_job_logs', {
        planId: 'plan-123',
        jobId: 'job-1',
        tail: 10001,
      });
      assert.strictEqual(result.valid, false);
    });

    test('accepts both phase and tail together', () => {
      const result = validateInput('get_copilot_job_logs', {
        planId: 'plan-123',
        jobId: 'job-1',
        phase: 'work',
        tail: 500,
      });
      assert.strictEqual(result.valid, true, result.error);
    });
  });

  // ==========================================================================
  // get_copilot_job_attempts has 'attemptNumber' + 'includeLogs' fields
  // ==========================================================================
  suite('get_copilot_job_attempts has attemptNumber and includeLogs fields', () => {
    test('schema has correct $id', () => {
      assert.strictEqual(getNodeAttemptsSchema.$id, 'get_copilot_job_attempts');
    });

    test('requires planId and jobId', () => {
      assert.ok(getNodeAttemptsSchema.required.includes('planId'));
      assert.ok(getNodeAttemptsSchema.required.includes('jobId'));
    });

    test('accepts request without attemptNumber or includeLogs', () => {
      const result = validateInput('get_copilot_job_attempts', {
        planId: 'plan-123',
        jobId: 'job-1',
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('accepts attemptNumber field', () => {
      const result = validateInput('get_copilot_job_attempts', {
        planId: 'plan-123',
        jobId: 'job-1',
        attemptNumber: 3,
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('rejects attemptNumber below minimum', () => {
      const result = validateInput('get_copilot_job_attempts', {
        planId: 'plan-123',
        jobId: 'job-1',
        attemptNumber: 0,
      });
      assert.strictEqual(result.valid, false);
    });

    test('rejects attemptNumber above maximum', () => {
      const result = validateInput('get_copilot_job_attempts', {
        planId: 'plan-123',
        jobId: 'job-1',
        attemptNumber: 1001,
      });
      assert.strictEqual(result.valid, false);
    });

    test('accepts includeLogs field', () => {
      const result = validateInput('get_copilot_job_attempts', {
        planId: 'plan-123',
        jobId: 'job-1',
        includeLogs: true,
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('accepts includeLogs as false', () => {
      const result = validateInput('get_copilot_job_attempts', {
        planId: 'plan-123',
        jobId: 'job-1',
        includeLogs: false,
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('rejects non-boolean includeLogs', () => {
      const result = validateInput('get_copilot_job_attempts', {
        planId: 'plan-123',
        jobId: 'job-1',
        includeLogs: 'yes',
      });
      assert.strictEqual(result.valid, false);
    });

    test('accepts both attemptNumber and includeLogs together', () => {
      const result = validateInput('get_copilot_job_attempts', {
        planId: 'plan-123',
        jobId: 'job-1',
        attemptNumber: 2,
        includeLogs: true,
      });
      assert.strictEqual(result.valid, true, result.error);
    });
  });

  // ==========================================================================
  // Removed schemas validation
  // ==========================================================================
  suite('Removed schemas are not in registry', () => {
    test('get_copilot_job_details is not registered', () => {
      assert.strictEqual(hasSchema('get_copilot_job_details'), false);
    });

    test('retry_copilot_plan_job is not registered', () => {
      assert.strictEqual(hasSchema('retry_copilot_plan_job'), false);
    });

    test('get_copilot_plan_job_failure_context is not registered', () => {
      assert.strictEqual(hasSchema('get_copilot_plan_job_failure_context'), false);
    });
  });
});
