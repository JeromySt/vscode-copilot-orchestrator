/**
 * @fileoverview Tests for plan type specs (src/plan/types/specs.ts).
 */

import * as assert from 'assert';
import { normalizeWorkSpec } from '../../../plan/types/specs';

suite('Plan Type Specs', () => {
  suite('normalizeWorkSpec', () => {
    test('returns undefined for undefined input', () => {
      assert.strictEqual(normalizeWorkSpec(undefined), undefined);
    });

    test('converts string to shell spec', () => {
      const result = normalizeWorkSpec('npm test');
      assert.deepStrictEqual(result, { type: 'shell', command: 'npm test' });
    });

    test('converts @agent string to agent spec', () => {
      const result = normalizeWorkSpec('@agent fix the bug');
      assert.ok(result);
      assert.strictEqual(result!.type, 'agent');
      assert.strictEqual((result as any).instructions, 'fix the bug');
    });

    test('converts @agent with no instructions to default', () => {
      const result = normalizeWorkSpec('@agent');
      assert.ok(result);
      assert.strictEqual(result!.type, 'agent');
      assert.strictEqual((result as any).instructions, 'Complete the task as specified');
    });

    test('returns object spec as-is', () => {
      const spec = { type: 'shell' as const, command: 'echo hi' };
      const result = normalizeWorkSpec(spec);
      assert.strictEqual(result, spec);
    });
  });
});
