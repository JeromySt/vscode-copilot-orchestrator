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
});
