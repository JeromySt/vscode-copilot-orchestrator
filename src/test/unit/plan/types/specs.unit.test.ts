import { suite, test } from 'mocha';
import * as assert from 'assert';
import { normalizeWorkSpec } from '../../../../plan/types/specs';

suite('normalizeWorkSpec', () => {
  test('converts error_action to errorAction', () => {
    const input: any = { type: 'shell', command: 'npm test', error_action: 'Continue' };
    const result = normalizeWorkSpec(input);
    assert.strictEqual((result as any).errorAction, 'Continue');
    assert.strictEqual((input as any).error_action, undefined);
  });

  test('preserves agent field on AgentSpec', () => {
    const input: any = { type: 'agent', instructions: '# Task', agent: 'k8s-assistant', model: 'gpt-5' };
    const result = normalizeWorkSpec(input);
    assert.strictEqual((result as any).agent, 'k8s-assistant');
    assert.strictEqual((result as any).type, 'agent');
    assert.strictEqual((result as any).instructions, '# Task');
  });

  test('handles agent spec without agent field', () => {
    const input: any = { type: 'agent', instructions: '# Task' };
    const result = normalizeWorkSpec(input);
    assert.strictEqual((result as any).type, 'agent');
    assert.strictEqual((result as any).agent, undefined);
  });
});
