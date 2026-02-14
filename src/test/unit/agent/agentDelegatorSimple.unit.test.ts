/**
 * @fileoverview Simple unit tests for AgentDelegator core logic
 * 
 * Tests for private methods that can be tested in isolation:
 * - extractSessionId
 * - classifyModel functionality through imports
 */

import * as assert from 'assert';
import { AgentDelegator } from '../../../agent/agentDelegator';
import type { IGitOperations } from '../../../interfaces/IGitOperations';
import { classifyModel, parseModelChoices } from '../../../agent/modelDiscovery';

const mockGitOps = {} as any as IGitOperations;

suite('AgentDelegator Core Functions', () => {
  let delegator: AgentDelegator;

  setup(() => {
    const logger = { log: () => {} };
    delegator = new AgentDelegator(logger, mockGitOps);
  });

  suite('extractSessionId method', () => {
    test('extracts UUID from "Session ID: <uuid>" format', () => {
      const sessionId = '12345678-1234-5678-9abc-123456789abc';
      const result = (delegator as any).extractSessionId(`Session ID: ${sessionId}`);
      assert.strictEqual(result, sessionId);
    });

    test('extracts UUID from "session: <uuid>" format', () => {
      const sessionId = 'abcd1234-5678-9012-3456-789abcdef012';
      const result = (delegator as any).extractSessionId(`session: ${sessionId}`);
      assert.strictEqual(result, sessionId);
    });

    test('extracts UUID from "Starting session: <uuid>" format', () => {
      const sessionId = 'fedcba09-8765-4321-0987-654321fedcba';
      const result = (delegator as any).extractSessionId(`Starting session: ${sessionId}`);
      assert.strictEqual(result, sessionId);
    });

    test('returns undefined for non-matching lines', () => {
      const result = (delegator as any).extractSessionId('Some random log line without session ID');
      assert.strictEqual(result, undefined);
    });

    test('handles case insensitive matching', () => {
      const sessionId = '12345678-1234-5678-9abc-123456789abc';
      const result = (delegator as any).extractSessionId(`session id: ${sessionId}`);
      assert.strictEqual(result, sessionId);
    });

    test('handles UUID in different formats', () => {
      const sessionId = '12345678-1234-5678-9abc-123456789abc';
      
      // With colons and spaces
      assert.strictEqual((delegator as any).extractSessionId(`Session ID: ${sessionId}`), sessionId);
      assert.strictEqual((delegator as any).extractSessionId(`Session ID:${sessionId}`), sessionId);
      assert.strictEqual((delegator as any).extractSessionId(`Session ID   :   ${sessionId}`), sessionId);
      
      // Different session patterns
      assert.strictEqual((delegator as any).extractSessionId(`session ${sessionId}`), sessionId);
      assert.strictEqual((delegator as any).extractSessionId(`Starting session ${sessionId}`), sessionId);
    });
  });

  suite('constructor and basic API', () => {
    test('constructor accepts logger and callbacks', () => {
      const logger = { log: () => {} };
      const callbacks = { onProcessSpawned: () => {} };
      const testDelegator = new AgentDelegator(logger, mockGitOps, callbacks);
      assert.ok(testDelegator);
    });

    test('constructor works with only logger (no callbacks)', () => {
      const logger = { log: () => {} };
      const testDelegator = new AgentDelegator(logger, mockGitOps);
      assert.ok(testDelegator);
    });

    test('isCopilotAvailable method exists', () => {
      assert.ok(typeof delegator.isCopilotAvailable === 'function');
    });
  });
});

suite('Model Discovery Pure Functions', () => {
  suite('classifyModel', () => {
    test('classifies Claude models correctly', () => {
      const result = classifyModel('claude-sonnet-4.5');
      assert.strictEqual(result.vendor, 'anthropic');
      assert.strictEqual(result.family, 'claude');
      assert.strictEqual(result.tier, 'standard');
    });

    test('classifies GPT models correctly', () => {
      const result = classifyModel('gpt-5');
      assert.strictEqual(result.vendor, 'openai');
      assert.strictEqual(result.family, 'gpt');
      assert.strictEqual(result.tier, 'standard');
    });

    test('classifies Gemini models correctly', () => {
      const result = classifyModel('gemini-3-pro');
      assert.strictEqual(result.vendor, 'google');
      assert.strictEqual(result.family, 'gemini');
      assert.strictEqual(result.tier, 'standard');
    });

    test('classifies unknown models', () => {
      const result = classifyModel('some-unknown-model');
      assert.strictEqual(result.vendor, 'unknown');
      assert.strictEqual(result.family, 'some-unknown-model');
      assert.strictEqual(result.tier, 'standard');
    });

    test('identifies fast tier models (mini, haiku)', () => {
      assert.strictEqual(classifyModel('gpt-5-mini').tier, 'fast');
      assert.strictEqual(classifyModel('claude-haiku-4').tier, 'fast');
    });

    test('identifies premium tier models (opus, max)', () => {
      assert.strictEqual(classifyModel('claude-opus-4.5').tier, 'premium');
      assert.strictEqual(classifyModel('gpt-5.1-codex-max').tier, 'premium');
    });

    test('handles case insensitive matching', () => {
      assert.strictEqual(classifyModel('CLAUDE-OPUS-4').vendor, 'anthropic');
      assert.strictEqual(classifyModel('GPT-5-MINI').tier, 'fast');
    });

    test('uses word boundaries to avoid false positives', () => {
      // 'gemini' should not match 'mini' tier
      assert.strictEqual(classifyModel('gemini-3').tier, 'standard');
      assert.strictEqual(classifyModel('miniaturized-model').tier, 'standard');
    });

    test('complex model names', () => {
      assert.strictEqual(classifyModel('gpt-5.1-codex-mini').tier, 'fast');
      assert.strictEqual(classifyModel('claude-haiku-4.5-fast').tier, 'fast');
      assert.strictEqual(classifyModel('gpt-5-opus-like').tier, 'premium');
    });
  });

  suite('parseModelChoices', () => {
    test('parses model choices from help output', () => {
      const helpOutput = `
Usage: copilot [OPTIONS]

Options:
  --model <model>    Model to use (choices: "claude-sonnet-4.5", "gpt-5", "claude-opus-4.5")
      `;
      const result = parseModelChoices(helpOutput);
      assert.deepStrictEqual(result, ['claude-sonnet-4.5', 'gpt-5', 'claude-opus-4.5']);
    });

    test('returns empty array when no model section found', () => {
      const helpOutput = 'Usage: copilot [OPTIONS]\n\nSome other content';
      const result = parseModelChoices(helpOutput);
      assert.deepStrictEqual(result, []);
    });

    test('handles different spacing and formatting', () => {
      const helpOutput = `
  --model   <type>     Model selection (choices:   "model-a", "model-b"  , "model-c")
      `;
      const result = parseModelChoices(helpOutput);
      assert.deepStrictEqual(result, ['model-a', 'model-b', 'model-c']);
    });

    test('extracts models with special characters', () => {
      const helpOutput = '--model <str> Choose model (choices: "gpt-5.1-codex", "claude-sonnet-4.5")';
      const result = parseModelChoices(helpOutput);
      assert.deepStrictEqual(result, ['gpt-5.1-codex', 'claude-sonnet-4.5']);
    });

    test('handles single model choice', () => {
      const helpOutput = '--model <model> (choices: "gpt-5")';
      const result = parseModelChoices(helpOutput);
      assert.deepStrictEqual(result, ['gpt-5']);
    });

    test('handles no quotes around choices', () => {
      const helpOutput = '--model <model> (choices: gpt-5, claude-sonnet-4)';
      const result = parseModelChoices(helpOutput);
      // Should only pick up quoted strings, so empty array
      assert.deepStrictEqual(result, []);
    });

    test('handles mixed quoted and unquoted', () => {
      const helpOutput = '--model <model> (choices: "gpt-5", unquoted, "claude-sonnet-4")';
      const result = parseModelChoices(helpOutput);
      assert.deepStrictEqual(result, ['gpt-5', 'claude-sonnet-4']);
    });

    test('handles multiline output', () => {
      const helpOutput = `
Usage: copilot [OPTIONS]

Options:
  --model <model>    Model selection (choices: "model-1", "model-2")
      `;
      const result = parseModelChoices(helpOutput);
      assert.deepStrictEqual(result, ['model-1', 'model-2']);
    });
  });
});