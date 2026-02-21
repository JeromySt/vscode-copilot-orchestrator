/**
 * @fileoverview Unit tests for MCP schema validation.
 *
 * Tests cover:
 * - scaffold_copilot_plan schema validation (required fields, optional fields)
 * - add_copilot_plan_job schema validation
 * - finalize_copilot_plan schema validation
 * - Input validation for required fields
 * - Schema boundary conditions (min/max values)
 * - Error messages for invalid input
 *
 * Target: 95%+ line coverage for schemas.ts and validation flows
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { validateInput, hasSchema } from '../../../mcp/validation';
import {
  scaffoldPlanSchema,
  addPlanNodeSchema,
  finalizePlanSchema,
  PRODUCER_ID_PATTERN,
} from '../../../mcp/validation/schemas';

suite('MCP Schema Validation', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    // Silence console output during tests
    sandbox.stub(console, 'log');
    sandbox.stub(console, 'debug');
    sandbox.stub(console, 'warn');
    sandbox.stub(console, 'error');
  });

  teardown(() => {
    sandbox.restore();
  });

  // ==========================================================================
  // hasSchema
  // ==========================================================================
  suite('hasSchema', () => {
    test('returns true for scaffold_copilot_plan', () => {
      assert.strictEqual(hasSchema('scaffold_copilot_plan'), true);
    });

    test('returns true for add_copilot_plan_job', () => {
      assert.strictEqual(hasSchema('add_copilot_plan_job'), true);
    });

    test('returns true for finalize_copilot_plan', () => {
      assert.strictEqual(hasSchema('finalize_copilot_plan'), true);
    });

    test('returns false for unknown tool', () => {
      assert.strictEqual(hasSchema('unknown_tool'), false);
    });
  });

  // ==========================================================================
  // scaffold_copilot_plan schema
  // ==========================================================================
  suite('scaffold_copilot_plan schema', () => {
    test('schema has correct $id', () => {
      assert.strictEqual(scaffoldPlanSchema.$id, 'scaffold_copilot_plan');
    });

    test('requires name field', () => {
      assert.ok(scaffoldPlanSchema.required.includes('name'));
    });

    test('validates minimal valid input', () => {
      const result = validateInput('scaffold_copilot_plan', {
        name: 'Test Plan',
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('rejects missing name', () => {
      const result = validateInput('scaffold_copilot_plan', {});
      assert.strictEqual(result.valid, false);
      assert.ok(result.error!.includes('name'));
    });

    test('accepts all optional fields', () => {
      const result = validateInput('scaffold_copilot_plan', {
        name: 'Full Plan',
        baseBranch: 'develop',
        targetBranch: 'feature/my-feature',
        maxParallel: 4,
        startPaused: true,
        cleanUpSuccessfulWork: false,
        additionalSymlinkDirs: ['.venv', 'vendor'],
        verifyRi: 'npm test',
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('accepts verify_ri as object', () => {
      const result = validateInput('scaffold_copilot_plan', {
        name: 'Plan with verify_ri object',
        verifyRi: {
          type: 'shell',
          command: 'npm run build && npm test',
        },
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('rejects maxParallel below minimum', () => {
      const result = validateInput('scaffold_copilot_plan', {
        name: 'Test',
        maxParallel: 0,
      });
      assert.strictEqual(result.valid, false);
    });

    test('rejects maxParallel above maximum', () => {
      const result = validateInput('scaffold_copilot_plan', {
        name: 'Test',
        maxParallel: 100,
      });
      assert.strictEqual(result.valid, false);
    });

    test('accepts maxParallel at boundaries', () => {
      const min = validateInput('scaffold_copilot_plan', {
        name: 'Test',
        maxParallel: 1,
      });
      assert.strictEqual(min.valid, true, min.error);

      const max = validateInput('scaffold_copilot_plan', {
        name: 'Test',
        maxParallel: 64,
      });
      assert.strictEqual(max.valid, true, max.error);
    });

    test('rejects unknown properties', () => {
      const result = validateInput('scaffold_copilot_plan', {
        name: 'Test',
        unknownField: 'value',
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error!.includes('unknownField'));
    });

    test('validates additionalSymlinkDirs as array of strings', () => {
      const valid = validateInput('scaffold_copilot_plan', {
        name: 'Test',
        additionalSymlinkDirs: ['dir1', 'dir2'],
      });
      assert.strictEqual(valid.valid, true, valid.error);
    });

    test('rejects non-string items in additionalSymlinkDirs', () => {
      const result = validateInput('scaffold_copilot_plan', {
        name: 'Test',
        additionalSymlinkDirs: [123, 'valid'],
      });
      assert.strictEqual(result.valid, false);
    });
  });

  // ==========================================================================
  // add_copilot_plan_job schema
  // ==========================================================================
  suite('add_copilot_plan_job schema', () => {
    test('schema has correct $id', () => {
      assert.strictEqual(addPlanNodeSchema.$id, 'add_copilot_plan_job');
    });

    test('requires planId, producerId, task, and work', () => {
      assert.ok(addPlanNodeSchema.required.includes('planId'));
      assert.ok(addPlanNodeSchema.required.includes('producerId'));
      assert.ok(addPlanNodeSchema.required.includes('task'));
      assert.ok(addPlanNodeSchema.required.includes('work'));
    });

    test('validates minimal valid input', () => {
      const result = validateInput('add_copilot_plan_job', {
        planId: 'plan-123',
        producerId: 'build-job',
        task: 'Build the application',
        work: 'npm run build',
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('rejects missing planId', () => {
      const result = validateInput('add_copilot_plan_job', {
        producerId: 'build-job',
        task: 'Build the application',
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error!.includes('planId'));
    });

    test('rejects missing producer_id', () => {
      const result = validateInput('add_copilot_plan_job', {
        planId: 'plan-123',
        task: 'Build the application',
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error!.includes('producer_id'));
    });

    test('rejects missing task', () => {
      const result = validateInput('add_copilot_plan_job', {
        planId: 'plan-123',
        producerId: 'build-job',
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error!.includes('task'));
    });

    test('validates producer_id pattern - lowercase alphanumeric and hyphens', () => {
      const valid = validateInput('add_copilot_plan_job', {
        planId: 'plan-123',
        producerId: 'build-step-1',
        task: 'Build',
        work: 'npm run build',
      });
      assert.strictEqual(valid.valid, true, valid.error);
    });

    test('rejects producer_id with uppercase', () => {
      const result = validateInput('add_copilot_plan_job', {
        planId: 'plan-123',
        producerId: 'Build-Step',
        task: 'Build',
      });
      assert.strictEqual(result.valid, false);
    });

    test('rejects producer_id too short', () => {
      const result = validateInput('add_copilot_plan_job', {
        planId: 'plan-123',
        producerId: 'ab',
        task: 'Build',
      });
      assert.strictEqual(result.valid, false);
    });

    test('accepts producer_id at minimum length (3)', () => {
      const result = validateInput('add_copilot_plan_job', {
        planId: 'plan-123',
        producerId: 'abc',
        task: 'Build',
        work: 'npm run build',
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('accepts all optional node fields', () => {
      const result = validateInput('add_copilot_plan_job', {
        planId: 'plan-123',
        producerId: 'build-job',
        task: 'Build the application',
        name: 'Build Step',
        dependencies: ['setup-job', 'lint-job'],
        group: 'build-phase',
        autoHeal: true,
        expectsNoChanges: false,
        work: 'npm run build',
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('accepts work as string', () => {
      const result = validateInput('add_copilot_plan_job', {
        planId: 'plan-123',
        producerId: 'build-job',
        task: 'Build',
        work: 'npm run build',
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('accepts work as shell spec object', () => {
      const result = validateInput('add_copilot_plan_job', {
        planId: 'plan-123',
        producerId: 'build-job',
        task: 'Build',
        work: {
          type: 'shell',
          command: 'npm run build',
          shell: 'bash',
        },
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('accepts work as process spec object', () => {
      const result = validateInput('add_copilot_plan_job', {
        planId: 'plan-123',
        producerId: 'build-job',
        task: 'Build',
        work: {
          type: 'process',
          executable: 'node',
          args: ['build.js', '--release'],
        },
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('accepts work as agent spec object', () => {
      const result = validateInput('add_copilot_plan_job', {
        planId: 'plan-123',
        producerId: 'build-job',
        task: 'Build',
        work: {
          type: 'agent',
          instructions: '# Build the project',
          model: 'claude-sonnet-4',
        },
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('accepts prechecks and postchecks', () => {
      const result = validateInput('add_copilot_plan_job', {
        planId: 'plan-123',
        producerId: 'build-job',
        task: 'Build',
        work: 'npm run build',
        prechecks: 'npm run lint',
        postchecks: {
          type: 'shell',
          command: 'npm test',
        },
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('validates dependency pattern', () => {
      const result = validateInput('add_copilot_plan_job', {
        planId: 'plan-123',
        producerId: 'build-job',
        task: 'Build',
        work: 'npm run build',
        dependencies: ['setup-job', 'lint/check'],
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('rejects unknown properties', () => {
      const result = validateInput('add_copilot_plan_job', {
        planId: 'plan-123',
        producerId: 'build-job',
        task: 'Build',
        work: 'npm run build',
        unknownField: 'value',
      });
      assert.strictEqual(result.valid, false);
    });
  });

  // ==========================================================================
  // finalize_copilot_plan schema
  // ==========================================================================
  suite('finalize_copilot_plan schema', () => {
    test('schema has correct $id', () => {
      assert.strictEqual(finalizePlanSchema.$id, 'finalize_copilot_plan');
    });

    test('requires planId field', () => {
      assert.ok(finalizePlanSchema.required.includes('planId'));
    });

    test('validates minimal valid input', () => {
      const result = validateInput('finalize_copilot_plan', {
        planId: 'plan-123',
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('rejects missing planId', () => {
      const result = validateInput('finalize_copilot_plan', {});
      assert.strictEqual(result.valid, false);
      assert.ok(result.error!.includes('planId'));
    });

    test('accepts startPaused option', () => {
      const result = validateInput('finalize_copilot_plan', {
        planId: 'plan-123',
        startPaused: true,
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('accepts startPaused false', () => {
      const result = validateInput('finalize_copilot_plan', {
        planId: 'plan-123',
        startPaused: false,
      });
      assert.strictEqual(result.valid, true, result.error);
    });

    test('rejects unknown properties', () => {
      const result = validateInput('finalize_copilot_plan', {
        planId: 'plan-123',
        unknownField: 'value',
      });
      assert.strictEqual(result.valid, false);
    });

    test('rejects non-boolean startPaused', () => {
      const result = validateInput('finalize_copilot_plan', {
        planId: 'plan-123',
        startPaused: 'yes',
      });
      assert.strictEqual(result.valid, false);
    });
  });

  // ==========================================================================
  // PRODUCER_ID_PATTERN constant
  // ==========================================================================
  suite('PRODUCER_ID_PATTERN', () => {
    test('matches valid lowercase alphanumeric', () => {
      const pattern = new RegExp(PRODUCER_ID_PATTERN);
      assert.ok(pattern.test('build'));
      assert.ok(pattern.test('build-step'));
      assert.ok(pattern.test('my-job-123'));
      assert.ok(pattern.test('abc'));
      assert.ok(pattern.test('123'));
    });

    test('rejects uppercase', () => {
      const pattern = new RegExp(PRODUCER_ID_PATTERN);
      assert.strictEqual(pattern.test('Build'), false);
      assert.strictEqual(pattern.test('BUILD'), false);
      assert.strictEqual(pattern.test('buildStep'), false);
    });

    test('rejects special characters', () => {
      const pattern = new RegExp(PRODUCER_ID_PATTERN);
      assert.strictEqual(pattern.test('build_step'), false);
      assert.strictEqual(pattern.test('build.step'), false);
      assert.strictEqual(pattern.test('build step'), false);
      assert.strictEqual(pattern.test('build@step'), false);
    });

    test('rejects too short (< 3)', () => {
      const pattern = new RegExp(PRODUCER_ID_PATTERN);
      assert.strictEqual(pattern.test('ab'), false);
      assert.strictEqual(pattern.test('a'), false);
      assert.strictEqual(pattern.test(''), false);
    });

    test('accepts exactly 3 characters', () => {
      const pattern = new RegExp(PRODUCER_ID_PATTERN);
      assert.ok(pattern.test('abc'));
      assert.ok(pattern.test('a-1'));
    });

    test('rejects too long (> 64)', () => {
      const pattern = new RegExp(PRODUCER_ID_PATTERN);
      const longId = 'a'.repeat(65);
      assert.strictEqual(pattern.test(longId), false);
    });

    test('accepts exactly 64 characters', () => {
      const pattern = new RegExp(PRODUCER_ID_PATTERN);
      const maxId = 'a'.repeat(64);
      assert.ok(pattern.test(maxId));
    });
  });

  // ==========================================================================
  // Cross-schema consistency
  // ==========================================================================
  suite('Cross-schema consistency', () => {
    test('all scaffolding tools use consistent patterns', () => {
      // Verify all three tools have schemas registered
      assert.strictEqual(hasSchema('scaffold_copilot_plan'), true);
      assert.strictEqual(hasSchema('add_copilot_plan_job'), true);
      assert.strictEqual(hasSchema('finalize_copilot_plan'), true);
    });

    test('planId field has consistent constraints', () => {
      // Both add_copilot_plan_job and finalize_copilot_plan use planId
      assert.ok(addPlanNodeSchema.properties.planId);
      assert.ok(finalizePlanSchema.properties.planId);
      
      // Both should have similar constraints
      assert.strictEqual(
        (addPlanNodeSchema.properties.planId as any).minLength,
        (finalizePlanSchema.properties.planId as any).minLength
      );
    });
  });
});
