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

    test('parses valid JSON string to agent spec', () => {
      const jsonStr = '{"type":"agent","instructions":"do it"}';
      const result = normalizeWorkSpec(jsonStr);
      assert.ok(result);
      assert.strictEqual(result!.type, 'agent');
      assert.strictEqual((result as any).instructions, 'do it');
    });

    test('parses valid JSON string to shell spec', () => {
      const jsonStr = '{"type":"shell","command":"npm run build"}';
      const result = normalizeWorkSpec(jsonStr);
      assert.ok(result);
      assert.strictEqual(result!.type, 'shell');
      assert.strictEqual((result as any).command, 'npm run build');
    });

    test('treats invalid JSON starting with { as shell command', () => {
      const result = normalizeWorkSpec('{not json}');
      assert.deepStrictEqual(result, { type: 'shell', command: '{not json}' });
    });

    test('treats JSON string without type property as shell command', () => {
      const jsonStr = '{"command":"test"}';
      const result = normalizeWorkSpec(jsonStr);
      assert.deepStrictEqual(result, { type: 'shell', command: '{"command":"test"}' });
    });

    test('parses JSON with whitespace prefix', () => {
      const jsonStr = '  \t{"type":"agent","instructions":"task"}';
      const result = normalizeWorkSpec(jsonStr);
      assert.ok(result);
      assert.strictEqual(result!.type, 'agent');
      assert.strictEqual((result as any).instructions, 'task');
    });

    test('converts snake_case on_failure to camelCase onFailure', () => {
      const spec = {
        type: 'shell' as const,
        command: 'test',
        on_failure: {
          no_auto_heal: true,
          message: 'Failed',
          resume_from_phase: 'prechecks' as const
        }
      };
      const result = normalizeWorkSpec(spec as any);
      assert.ok(result);
      assert.strictEqual((result as any).onFailure.noAutoHeal, true);
      assert.strictEqual((result as any).onFailure.message, 'Failed');
      assert.strictEqual((result as any).onFailure.resumeFromPhase, 'prechecks');
      assert.strictEqual((result as any).on_failure, undefined);
    });

    test('converts snake_case model_tier to camelCase modelTier', () => {
      const spec = {
        type: 'agent' as const,
        instructions: 'test',
        model_tier: 'fast' as const
      };
      const result = normalizeWorkSpec(spec as any);
      assert.ok(result);
      assert.strictEqual((result as any).modelTier, 'fast');
      assert.strictEqual((result as any).model_tier, undefined);
    });

    test('converts snake_case error_action to camelCase errorAction', () => {
      const spec = {
        type: 'shell' as const,
        command: 'test',
        error_action: 'Stop' as const
      };
      const result = normalizeWorkSpec(spec as any);
      assert.ok(result);
      assert.strictEqual((result as any).errorAction, 'Stop');
      assert.strictEqual((result as any).error_action, undefined);
    });

    test('handles JSON string with nested on_failure config', () => {
      const jsonStr = '{"type":"agent","instructions":"fix","on_failure":{"no_auto_heal":true}}';
      const result = normalizeWorkSpec(jsonStr);
      assert.ok(result);
      assert.strictEqual(result!.type, 'agent');
      assert.strictEqual((result as any).onFailure.noAutoHeal, true);
    });

    test('passthrough when both camelCase and snake_case present (camelCase wins)', () => {
      const spec = {
        type: 'agent' as const,
        instructions: 'test',
        modelTier: 'premium' as const,
        model_tier: 'fast' as const
      };
      const result = normalizeWorkSpec(spec as any);
      assert.ok(result);
      assert.strictEqual((result as any).modelTier, 'premium');
    });
  });
});
