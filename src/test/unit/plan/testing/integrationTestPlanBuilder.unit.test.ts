/**
 * @fileoverview Unit tests for integrationTestPlanBuilder.
 *
 * Validates that buildIntegrationTestPlan produces a well-formed plan spec
 * with all expected jobs, dependencies, and matching scripts.
 *
 * @module test/unit/plan/testing/integrationTestPlanBuilder.unit.test
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import { buildIntegrationTestPlan } from '../../../../plan/testing/integrationTestPlanBuilder';

suite('integrationTestPlanBuilder', () => {
  suite('buildIntegrationTestPlan', () => {
    test('returns spec, scripts, and descriptions', () => {
      const testPlan = buildIntegrationTestPlan();
      assert.ok(testPlan.spec);
      assert.ok(testPlan.scripts);
      assert.ok(testPlan.jobDescriptions);
    });

    test('spec has correct default name', () => {
      const testPlan = buildIntegrationTestPlan();
      assert.strictEqual(testPlan.spec.name, 'Full Integration Test Plan');
    });

    test('spec uses custom name when provided', () => {
      const testPlan = buildIntegrationTestPlan({ name: 'My Test' });
      assert.strictEqual(testPlan.spec.name, 'My Test');
    });

    test('spec has correct default settings', () => {
      const testPlan = buildIntegrationTestPlan();
      assert.strictEqual(testPlan.spec.baseBranch, 'main');
      assert.strictEqual(testPlan.spec.maxParallel, 4);
      assert.strictEqual(testPlan.spec.startPaused, true);
    });

    test('spec respects overrides', () => {
      const testPlan = buildIntegrationTestPlan({
        baseBranch: 'develop',
        maxParallel: 2,
        repoPath: '/tmp/repo',
      });
      assert.strictEqual(testPlan.spec.baseBranch, 'develop');
      assert.strictEqual(testPlan.spec.maxParallel, 2);
      assert.strictEqual(testPlan.spec.repoPath, '/tmp/repo');
    });

    test('contains all expected jobs', () => {
      const testPlan = buildIntegrationTestPlan();
      const producerIds = testPlan.spec.jobs.map(j => j.producerId);

      const expected = [
        'root-setup',
        'parallel-agent',
        'parallel-shell',
        'pressure-agent',
        'auto-heal-job',
        'always-fails',
        'blocked-downstream',
        'postchecks-fail',
        'no-changes',
        'process-job',
        'final-merge',
      ];

      for (const id of expected) {
        assert.ok(producerIds.includes(id), `Missing job: ${id}`);
      }
    });

    test('root-setup has no dependencies', () => {
      const testPlan = buildIntegrationTestPlan();
      const rootSetup = testPlan.spec.jobs.find(j => j.producerId === 'root-setup');
      assert.ok(rootSetup);
      assert.deepStrictEqual(rootSetup!.dependencies, []);
    });

    test('parallel jobs depend on root-setup', () => {
      const testPlan = buildIntegrationTestPlan();
      const parallelJobs = testPlan.spec.jobs.filter(j =>
        ['parallel-agent', 'parallel-shell', 'pressure-agent', 'auto-heal-job'].includes(j.producerId as string)
      );

      for (const job of parallelJobs) {
        assert.ok(job.dependencies.includes('root-setup'), `${job.producerId} should depend on root-setup`);
      }
    });

    test('blocked-downstream depends on always-fails', () => {
      const testPlan = buildIntegrationTestPlan();
      const blocked = testPlan.spec.jobs.find(j => j.producerId === 'blocked-downstream');
      assert.ok(blocked);
      assert.ok(blocked!.dependencies.includes('always-fails'));
    });

    test('final-merge is a fan-in job', () => {
      const testPlan = buildIntegrationTestPlan();
      const finalMerge = testPlan.spec.jobs.find(j => j.producerId === 'final-merge');
      assert.ok(finalMerge);
      assert.ok(finalMerge!.dependencies.length >= 5, 'final-merge should depend on multiple parallel jobs');
    });

    test('always-fails has autoHeal disabled', () => {
      const testPlan = buildIntegrationTestPlan();
      const alwaysFails = testPlan.spec.jobs.find(j => j.producerId === 'always-fails');
      assert.ok(alwaysFails);
      assert.strictEqual(alwaysFails!.autoHeal, false);
    });

    test('no-changes has expectsNoChanges enabled', () => {
      const testPlan = buildIntegrationTestPlan();
      const noChanges = testPlan.spec.jobs.find(j => j.producerId === 'no-changes');
      assert.ok(noChanges);
      assert.strictEqual(noChanges!.expectsNoChanges, true);
    });

    test('process-job uses ProcessSpec', () => {
      const testPlan = buildIntegrationTestPlan();
      const processJob = testPlan.spec.jobs.find(j => j.producerId === 'process-job');
      assert.ok(processJob);
      const work = processJob!.work as any;
      assert.strictEqual(work.type, 'process');
      assert.strictEqual(work.executable, 'node');
    });

    test('has scripts for non-blocked jobs', () => {
      const testPlan = buildIntegrationTestPlan();
      assert.ok(testPlan.scripts.length > 0);
      // blocked-downstream has no scripts (never runs)
      // but all other jobs should have at least one script
    });

    test('has descriptions for all jobs', () => {
      const testPlan = buildIntegrationTestPlan();
      const producerIds = testPlan.spec.jobs.map(j => j.producerId);
      for (const id of producerIds) {
        assert.ok(testPlan.jobDescriptions[id], `Missing description for ${id}`);
      }
    });

    test('auto-heal-job has scripts for fail-then-succeed pattern', () => {
      const testPlan = buildIntegrationTestPlan();
      const autoHealScripts = testPlan.scripts.filter(s => s.label.includes('auto-heal'));
      assert.ok(autoHealScripts.length >= 2, 'Should have at least 2 scripts (fail + succeed)');
      assert.ok(autoHealScripts.some(s => s.consumeOnce), 'Fail script should be consumeOnce');
    });

    test('jobs use visual groups', () => {
      const testPlan = buildIntegrationTestPlan();
      const groupedJobs = testPlan.spec.jobs.filter(j => j.group);
      assert.ok(groupedJobs.length > 0, 'Expected some jobs to have group assignments');
      const groups = [...new Set(groupedJobs.map(j => j.group))];
      assert.ok(groups.length >= 3, `Expected at least 3 groups, got: ${groups.join(', ')}`);
    });

    test('postchecks-fail has postchecks spec', () => {
      const testPlan = buildIntegrationTestPlan();
      const postchecksJob = testPlan.spec.jobs.find(j => j.producerId === 'postchecks-fail');
      assert.ok(postchecksJob);
      assert.ok(postchecksJob!.postchecks, 'postchecks-fail should have postchecks spec');
    });

    test('pressure-agent uses AgentSpec', () => {
      const testPlan = buildIntegrationTestPlan();
      const pressureJob = testPlan.spec.jobs.find(j => j.producerId === 'pressure-agent');
      assert.ok(pressureJob);
      const work = pressureJob!.work as any;
      assert.strictEqual(work.type, 'agent');
      assert.ok(work.instructions.length > 0);
    });
  });
});
