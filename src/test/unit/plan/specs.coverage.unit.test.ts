/**
 * @fileoverview Additional coverage tests for specs.ts (src/plan/types/specs.ts)
 * 
 * Focuses on edge cases and paths not covered by the basic specs.test.ts.
 */

import * as assert from 'assert';
import { suite, test } from 'mocha';
import { normalizeWorkSpec } from '../../../plan/types/specs';

suite('specs.ts - Coverage', () => {
  suite('normalizeWorkSpec - JSON parsing edge cases', () => {
    test('handles empty string', () => {
      const result = normalizeWorkSpec('');
      assert.deepStrictEqual(result, { type: 'shell', command: '' });
    });

    test('handles whitespace-only string', () => {
      const result = normalizeWorkSpec('   ');
      assert.deepStrictEqual(result, { type: 'shell', command: '   ' });
    });

    test('handles string with only opening brace', () => {
      const result = normalizeWorkSpec('{');
      assert.deepStrictEqual(result, { type: 'shell', command: '{' });
    });

    test('handles JSON array (not object)', () => {
      const result = normalizeWorkSpec('["test"]');
      assert.deepStrictEqual(result, { type: 'shell', command: '["test"]' });
    });

    test('handles JSON null', () => {
      const result = normalizeWorkSpec('null');
      assert.deepStrictEqual(result, { type: 'shell', command: 'null' });
    });

    test('handles JSON number', () => {
      const result = normalizeWorkSpec('123');
      assert.deepStrictEqual(result, { type: 'shell', command: '123' });
    });

    test('handles JSON boolean', () => {
      const result = normalizeWorkSpec('true');
      assert.deepStrictEqual(result, { type: 'shell', command: 'true' });
    });

    test('recursively normalizes nested JSON string', () => {
      // JSON string that parses to object, which then gets normalized
      const jsonStr = '{"type":"process","executable":"node","args":["test.js"]}';
      const result = normalizeWorkSpec(jsonStr);
      assert.ok(result);
      assert.strictEqual(result!.type, 'process');
      assert.strictEqual((result as any).executable, 'node');
      assert.deepStrictEqual((result as any).args, ['test.js']);
    });

    test('handles JSON with complex nested structure', () => {
      const jsonStr = JSON.stringify({
        type: 'agent',
        instructions: 'Complex task',
        contextFiles: ['file1.ts', 'file2.ts'],
        allowedFolders: ['/path/one', '/path/two'],
        env: { NODE_ENV: 'test' }
      });
      const result = normalizeWorkSpec(jsonStr);
      assert.ok(result);
      assert.strictEqual(result!.type, 'agent');
      assert.strictEqual((result as any).instructions, 'Complex task');
      assert.deepStrictEqual((result as any).contextFiles, ['file1.ts', 'file2.ts']);
      assert.deepStrictEqual((result as any).allowedFolders, ['/path/one', '/path/two']);
      assert.deepStrictEqual((result as any).env, { NODE_ENV: 'test' });
    });

    test('handles JSON with trailing non-JSON content (LLM artifacts)', () => {
      // The bugfix strips trailing content after the last '}' before parsing
      const result = normalizeWorkSpec('{"type":"shell"} extra');
      assert.strictEqual(result!.type, 'shell');
    });

    test('handles JSON with comments (invalid JSON)', () => {
      const result = normalizeWorkSpec('{ /* comment */ "type": "shell" }');
      assert.deepStrictEqual(result, { type: 'shell', command: '{ /* comment */ "type": "shell" }' });
    });

    test('handles tabs and newlines in JSON prefix', () => {
      const jsonStr = '\n\t  \t{"type":"shell","command":"test"}';
      const result = normalizeWorkSpec(jsonStr);
      assert.ok(result);
      assert.strictEqual(result!.type, 'shell');
      assert.strictEqual((result as any).command, 'test');
    });
  });

  suite('normalizeWorkSpec - @agent variations', () => {
    test('handles @agent with case variation', () => {
      const result = normalizeWorkSpec('@agent Task');
      assert.strictEqual(result!.type, 'agent');
      assert.strictEqual((result as any).instructions, 'Task');
    });

    test('handles @agent with extra whitespace', () => {
      const result = normalizeWorkSpec('@agent     multiple   spaces');
      assert.strictEqual(result!.type, 'agent');
      assert.strictEqual((result as any).instructions, 'multiple   spaces');
    });

    test('handles @agent with newlines in instructions', () => {
      const result = normalizeWorkSpec('@agent Line 1\nLine 2\nLine 3');
      assert.strictEqual(result!.type, 'agent');
      assert.ok((result as any).instructions.includes('Line 1'));
      assert.ok((result as any).instructions.includes('Line 2'));
    });

    test('handles @agent at end with whitespace', () => {
      const result = normalizeWorkSpec('@agent   ');
      assert.strictEqual(result!.type, 'agent');
      assert.strictEqual((result as any).instructions, 'Complete the task as specified');
    });
  });

  suite('normalizeWorkSpec - snake_case conversion edge cases', () => {
    test('handles spec with only on_failure', () => {
      const spec = {
        type: 'shell' as const,
        command: 'test',
        on_failure: { message: 'Failed' }
      };
      const result = normalizeWorkSpec(spec as any);
      assert.ok((result as any).onFailure);
      assert.strictEqual((result as any).onFailure.message, 'Failed');
    });

    test('handles spec with only model_tier', () => {
      const spec = {
        type: 'agent' as const,
        instructions: 'test',
        model_tier: 'standard' as const
      };
      const result = normalizeWorkSpec(spec as any);
      assert.strictEqual((result as any).modelTier, 'standard');
    });

    test('handles spec with only error_action', () => {
      const spec = {
        type: 'shell' as const,
        command: 'test',
        shell: 'pwsh' as const,
        error_action: 'SilentlyContinue' as const
      };
      const result = normalizeWorkSpec(spec as any);
      assert.strictEqual((result as any).errorAction, 'SilentlyContinue');
    });

    test('handles spec with all snake_case fields', () => {
      const spec = {
        type: 'agent' as const,
        instructions: 'test',
        model_tier: 'premium' as const,
        on_failure: {
          no_auto_heal: true,
          message: 'Error',
          resume_from_phase: 'work' as const
        }
      };
      const result = normalizeWorkSpec(spec as any);
      assert.strictEqual((result as any).modelTier, 'premium');
      assert.ok((result as any).onFailure);
      assert.strictEqual((result as any).onFailure.noAutoHeal, true);
      assert.strictEqual((result as any).onFailure.message, 'Error');
      assert.strictEqual((result as any).onFailure.resumeFromPhase, 'work');
    });

    test('does not convert when camelCase already present', () => {
      const spec = {
        type: 'agent' as const,
        instructions: 'test',
        modelTier: 'fast' as const,
        model_tier: 'slow' as const
      };
      const result = normalizeWorkSpec(spec as any);
      // Should keep camelCase value
      assert.strictEqual((result as any).modelTier, 'fast');
    });

    test('handles partial on_failure config', () => {
      const spec = {
        type: 'shell' as const,
        command: 'test',
        on_failure: {
          no_auto_heal: true
          // message and resume_from_phase omitted
        }
      };
      const result = normalizeWorkSpec(spec as any);
      assert.ok((result as any).onFailure);
      assert.strictEqual((result as any).onFailure.noAutoHeal, true);
      assert.strictEqual((result as any).onFailure.message, undefined);
      assert.strictEqual((result as any).onFailure.resumeFromPhase, undefined);
    });
  });

  suite('normalizeWorkSpec - object passthrough', () => {
    test('preserves ProcessSpec properties', () => {
      const spec = {
        type: 'process' as const,
        executable: 'node',
        args: ['test.js', '--verbose'],
        env: { NODE_ENV: 'test' },
        cwd: '/path/to/dir',
        timeout: 30000
      };
      const result = normalizeWorkSpec(spec);
      assert.strictEqual(result, spec);
    });

    test('preserves ShellSpec properties', () => {
      const spec = {
        type: 'shell' as const,
        command: 'npm test',
        shell: 'bash' as const,
        env: { CI: 'true' },
        cwd: './test',
        timeout: 60000
      };
      const result = normalizeWorkSpec(spec);
      assert.strictEqual(result, spec);
    });

    test('preserves AgentSpec properties', () => {
      const spec = {
        type: 'agent' as const,
        instructions: 'Fix bugs',
        model: 'gpt-4',
        contextFiles: ['src/'],
        maxTurns: 10,
        context: 'Extra context',
        resumeSession: false,
        allowedFolders: ['/shared'],
        allowedUrls: ['https://api.example.com']
      };
      const result = normalizeWorkSpec(spec);
      assert.strictEqual(result, spec);
    });

    test('preserves onFailure config in object', () => {
      const spec = {
        type: 'shell' as const,
        command: 'test',
        onFailure: {
          noAutoHeal: true,
          message: 'Test failed',
          resumeFromPhase: 'postchecks' as const
        }
      };
      const result = normalizeWorkSpec(spec);
      assert.strictEqual(result, spec);
    });
  });
});
