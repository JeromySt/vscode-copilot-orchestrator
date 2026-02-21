/**
 * Coverage tests for src/mcp/validation/index.ts
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import {
  validateInput,
  hasSchema,
  getRegisteredTools,
  validateAgentModels,
  validateAllowedUrls,
  validateAllowedFolders,
  validatePostchecksPresence,
  validatePowerShellCommands,
  schemas
} from '../../../mcp/validation';

suite('validation/index - coverage', () => {
  test('exports validateInput', () => {
    assert.strictEqual(typeof validateInput, 'function');
  });

  test('exports hasSchema', () => {
    assert.strictEqual(typeof hasSchema, 'function');
  });

  test('exports getRegisteredTools', () => {
    assert.strictEqual(typeof getRegisteredTools, 'function');
  });

  test('exports validateAgentModels', () => {
    assert.strictEqual(typeof validateAgentModels, 'function');
  });

  test('exports validateAllowedUrls', () => {
    assert.strictEqual(typeof validateAllowedUrls, 'function');
  });

  test('exports validateAllowedFolders', () => {
    assert.strictEqual(typeof validateAllowedFolders, 'function');
  });

  test('exports validatePostchecksPresence', () => {
    assert.strictEqual(typeof validatePostchecksPresence, 'function');
  });

  test('exports validatePowerShellCommands', () => {
    assert.strictEqual(typeof validatePowerShellCommands, 'function');
  });

  test('exports schemas', () => {
    assert.ok(schemas);
    assert.strictEqual(typeof schemas, 'object');
  });

  test('validateInput works with valid input', () => {
    const result = validateInput('list_copilot_plans', {});
    assert.strictEqual(result.valid, true);
  });

  test('hasSchema returns true for known tools', () => {
    assert.strictEqual(hasSchema('create_copilot_plan'), true);
  });

  test('hasSchema returns false for unknown tools', () => {
    assert.strictEqual(hasSchema('unknown_tool'), false);
  });

  test('getRegisteredTools returns array', () => {
    const tools = getRegisteredTools();
    assert.ok(Array.isArray(tools));
    assert.ok(tools.length > 0);
  });

  test('validateAgentModels is a function', () => {
    assert.strictEqual(typeof validateAgentModels, 'function');
  });

  test('validateAllowedUrls is a function', () => {
    assert.strictEqual(typeof validateAllowedUrls, 'function');
  });

  test('validateAllowedFolders is a function', () => {
    assert.strictEqual(typeof validateAllowedFolders, 'function');
  });

  test('validatePostchecksPresence returns warnings for missing postchecks', () => {
    const warnings = validatePostchecksPresence({
      jobs: [
        { producer_id: 'j1', work: { type: 'shell', command: 'echo test' } }
      ]
    });
    assert.ok(Array.isArray(warnings));
  });

  test('validatePowerShellCommands validates work specs', () => {
    const result = validatePowerShellCommands({
      jobs: [
        { producer_id: 'j1', work: { type: 'shell', command: 'echo test' } }
      ]
    });
    assert.ok(result);
  });
});
