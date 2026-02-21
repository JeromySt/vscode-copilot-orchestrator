/**
 * @fileoverview Unit tests for snapshot validation node builder (src/plan/svNodeBuilder.ts)
 */

import * as assert from 'assert';
import { suite, test } from 'mocha';
import { buildSvJobSpec } from '../../../plan/svNodeBuilder';

suite('svNodeBuilder', () => {
  suite('buildSvJobSpec', () => {
    test('builds basic SV job spec with required fields', () => {
      const result = buildSvJobSpec('main');
      
      assert.strictEqual(result.producerId, '__snapshot-validation__');
      assert.strictEqual(result.name, 'Snapshot Validation');
      assert.strictEqual(result.task, `Validate snapshot and merge to 'main'`);
      assert.ok(Array.isArray(result.dependencies));
      assert.strictEqual(result.dependencies.length, 0);
    });

    test('includes target branch in task description', () => {
      const result = buildSvJobSpec('feature/test');
      assert.strictEqual(result.task, `Validate snapshot and merge to 'feature/test'`);
    });

    test('includes prechecks with agent spec', () => {
      const result = buildSvJobSpec('main');
      
      assert.ok(result.prechecks);
      const prechecks = result.prechecks!;
      assert.strictEqual(prechecks.type, 'agent');
      assert.ok(prechecks.instructions);
      assert.ok(prechecks.instructions.includes('main'));
      assert.ok(prechecks.instructions.includes('snapshot'));
    });

    test('prechecks agent has fast model tier', () => {
      const result = buildSvJobSpec('main');
      
      assert.ok(result.prechecks);
      assert.strictEqual(result.prechecks!.modelTier, 'fast');
    });

    test('prechecks agent has onFailure config with noAutoHeal', () => {
      const result = buildSvJobSpec('main');
      
      assert.ok(result.prechecks);
      const prechecks = result.prechecks!;
      assert.ok(prechecks.onFailure);
      assert.strictEqual(prechecks.onFailure.noAutoHeal, true);
      assert.ok(prechecks.onFailure.message);
      assert.strictEqual(prechecks.onFailure.resumeFromPhase, 'prechecks');
    });

    test('prechecks includes instructions for rebase logic', () => {
      const result = buildSvJobSpec('develop');
      
      assert.ok(result.prechecks);
      const prechecks = result.prechecks!;
      assert.ok(prechecks.instructions.includes('SNAPSHOT_BASE'));
      assert.ok(prechecks.instructions.includes('TARGET_HEAD'));
      assert.ok(prechecks.instructions.includes('git rebase'));
      assert.ok(prechecks.instructions.includes('develop'));
    });

    test('includes postchecks with process spec', () => {
      const result = buildSvJobSpec('main');
      
      assert.ok(result.postchecks);
      const postchecks = result.postchecks!;
      assert.strictEqual(postchecks.type, 'process');
      assert.strictEqual(postchecks.executable, process.execPath);
      assert.ok(Array.isArray(postchecks.args));
    });

    test('postchecks process spec has Node.js script', () => {
      const result = buildSvJobSpec('main');
      
      assert.ok(result.postchecks);
      const postchecks = result.postchecks!;
      assert.ok(postchecks.args);
      assert.strictEqual(postchecks.args[0], '-e');
      assert.ok(postchecks.args[1]);
      assert.ok(postchecks.args[1].includes('snapshot-base'));
      assert.ok(postchecks.args[1].includes('git rev-parse'));
    });

    test('postchecks has ELECTRON_RUN_AS_NODE env var', () => {
      const result = buildSvJobSpec('main');
      
      assert.ok(result.postchecks);
      const postchecks = result.postchecks!;
      assert.ok(postchecks.env);
      assert.strictEqual(postchecks.env.ELECTRON_RUN_AS_NODE, '1');
    });

    test('postchecks has onFailure config with noAutoHeal', () => {
      const result = buildSvJobSpec('main');
      
      assert.ok(result.postchecks);
      const postchecks = result.postchecks!;
      assert.ok(postchecks.onFailure);
      assert.strictEqual(postchecks.onFailure.noAutoHeal, true);
      assert.ok(postchecks.onFailure.message);
      assert.strictEqual(postchecks.onFailure.resumeFromPhase, 'prechecks');
    });

    test('postchecks references correct target branch in script', () => {
      const result = buildSvJobSpec('feature/xyz');
      
      assert.ok(result.postchecks);
      const postchecks = result.postchecks!;
      assert.ok(postchecks.args);
      assert.ok(postchecks.args[1].includes('feature/xyz'));
    });

    test('sets assignedWorktreePath when provided', () => {
      const worktreePath = '/path/to/worktree';
      const result = buildSvJobSpec('main', worktreePath);
      
      assert.strictEqual(result.assignedWorktreePath, worktreePath);
    });

    test('assigns work when verifyRiSpec provided', () => {
      const verifyRiSpec = { type: 'shell', command: 'npm test' };
      const result = buildSvJobSpec('main', undefined, verifyRiSpec);
      
      assert.deepStrictEqual(result.work, verifyRiSpec);
    });

    test('work is undefined when no verifyRiSpec provided', () => {
      const result = buildSvJobSpec('main');
      
      assert.strictEqual(result.work, undefined);
    });

    test('full spec with all parameters', () => {
      const worktreePath = '/tmp/snapshot';
      const verifyRiSpec = { type: 'agent', instructions: 'Verify all tests pass' };
      const result = buildSvJobSpec('develop', worktreePath, verifyRiSpec);
      
      assert.strictEqual(result.producerId, '__snapshot-validation__');
      assert.strictEqual(result.name, 'Snapshot Validation');
      assert.strictEqual(result.task, `Validate snapshot and merge to 'develop'`);
      assert.deepStrictEqual(result.dependencies, []);
      assert.strictEqual(result.assignedWorktreePath, worktreePath);
      assert.deepStrictEqual(result.work, verifyRiSpec);
      assert.ok(result.prechecks);
      assert.ok(result.postchecks);
    });

    test('prechecks instructions include all three cases', () => {
      const result = buildSvJobSpec('main');
      
      assert.ok(result.prechecks);
      const prechecks = result.prechecks!;
      // Case A - unchanged
      assert.ok(prechecks.instructions.includes('Case A'));
      assert.ok(prechecks.instructions.includes('unchanged'));
      
      // Case B - rebase
      assert.ok(prechecks.instructions.includes('Case B'));
      assert.ok(prechecks.instructions.includes('rebase'));
      
      // Conflict resolution
      assert.ok(prechecks.instructions.includes('conflicts'));
      assert.ok(prechecks.instructions.includes('git add'));
      assert.ok(prechecks.instructions.includes('rebase --continue'));
    });

    test('postchecks script includes proper error handling', () => {
      const result = buildSvJobSpec('main');
      
      assert.ok(result.postchecks);
      const postchecks = result.postchecks!;
      assert.ok(postchecks.args);
      const script = postchecks.args[1];
      assert.ok(script.includes('try'));
      assert.ok(script.includes('catch'));
      assert.ok(script.includes('process.exit(0)'));
      assert.ok(script.includes('process.exit(1)'));
    });

    test('postchecks script checks commit SHA equality', () => {
      const result = buildSvJobSpec('main');
      
      assert.ok(result.postchecks);
      const postchecks = result.postchecks!;
      assert.ok(postchecks.args);
      const script = postchecks.args[1];
      assert.ok(script.includes('if (head === base)'));
      assert.ok(script.includes('fs.readFileSync'));
      assert.ok(script.includes('execSync'));
    });

    test('dependencies array is empty but defined', () => {
      const result = buildSvJobSpec('main');
      
      assert.ok(Array.isArray(result.dependencies));
      assert.strictEqual(result.dependencies.length, 0);
    });
  });
});
