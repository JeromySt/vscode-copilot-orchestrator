/**
 * @fileoverview Unit tests for model validation in MCP
 *
 * Tests cover:
 * - validateAgentModels function behavior
 * - Model validation with valid and invalid models
 * - Validation in nested groups and prechecks/postchecks
 * - Graceful degradation when model discovery fails
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { validateAgentModels } from '../../../mcp/validation/validator';
import * as modelDiscovery from '../../../agent/modelDiscovery';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Suppress Logger console output to avoid hanging test workers. */
function silenceConsole(): { restore: () => void } {
  const origLog = console.log;
  const origDebug = console.debug;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = () => {};
  console.debug = () => {};
  console.warn = () => {};
  console.error = () => {};
  return {
    restore() {
      console.log = origLog;
      console.debug = origDebug;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('validateAgentModels', () => {
  let quiet: { restore: () => void };
  let getCachedModelsStub: sinon.SinonStub;

  setup(() => {
    quiet = silenceConsole();
    
    // Mock the getCachedModels function
    getCachedModelsStub = sinon.stub(modelDiscovery, 'getCachedModels').resolves({
      models: [
        { id: 'gpt-5', vendor: 'openai' as const, family: 'gpt', tier: 'standard' as const },
        { id: 'claude-sonnet-4', vendor: 'anthropic' as const, family: 'claude', tier: 'standard' as const },
        { id: 'claude-haiku-4.5', vendor: 'anthropic' as const, family: 'claude', tier: 'fast' as const }
      ],
      rawChoices: ['gpt-5', 'claude-sonnet-4', 'claude-haiku-4.5'],
      discoveredAt: Date.now()
    });
  });

  teardown(() => {
    quiet.restore();
    sinon.restore();
  });

  test('should pass when model is valid', async () => {
    const input = {
      jobs: [{
        producerId: 'test',
        task: 'Test',
        work: { type: 'agent', instructions: 'Do something', model: 'gpt-5' }
      }]
    };
    const result = await validateAgentModels(input, 'create_copilot_plan');
    assert.strictEqual(result.valid, true);
  });

  test('should fail when model is invalid', async () => {
    const input = {
      jobs: [{
        producerId: 'test',
        task: 'Test',
        work: { type: 'agent', instructions: 'Do something', model: 'invalid-model' }
      }]
    };
    const result = await validateAgentModels(input, 'create_copilot_plan');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error);
    assert.ok(result.error.includes('invalid-model'));
    assert.ok(result.error.includes('jobs[0].work.model'));
    assert.ok(result.error.includes('gpt-5'));
  });

  test('should validate models in nested groups', async () => {
    const input = {
      jobs: [],
      groups: [{
        name: 'backend',
        jobs: [{
          producerId: 'test',
          task: 'Test',
          work: { type: 'agent', instructions: 'X', model: 'bad-model' }
        }]
      }]
    };
    const result = await validateAgentModels(input, 'create_copilot_plan');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error);
    assert.ok(result.error.includes('groups[0].jobs[0].work.model'));
  });

  test('should validate models in prechecks and postchecks', async () => {
    const input = {
      jobs: [{
        producerId: 'test',
        task: 'Test',
        work: 'echo hello',
        prechecks: { type: 'agent', instructions: 'Check', model: 'fake-model' }
      }]
    };
    const result = await validateAgentModels(input, 'create_copilot_plan');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error);
    assert.ok(result.error.includes('jobs[0].prechecks.model'));
  });

  test('should skip validation when agent spec has no model', async () => {
    const input = {
      jobs: [{
        producerId: 'test',
        task: 'Test',
        work: { type: 'agent', instructions: 'Do something' } // no model = use default
      }]
    };
    const result = await validateAgentModels(input, 'create_copilot_plan');
    assert.strictEqual(result.valid, true);
  });

  test('should pass with warning when model discovery returns no models', async () => {
    // Override the mock to return empty results
    getCachedModelsStub.resolves({
      models: [],
      rawChoices: [],
      discoveredAt: Date.now()
    });

    const input = {
      jobs: [{
        producerId: 'test',
        task: 'Test',
        work: { type: 'agent', instructions: 'X', model: 'anything' }
      }]
    };
    const result = await validateAgentModels(input, 'create_copilot_plan');
    assert.strictEqual(result.valid, true);
  });

  test('should pass with warning when model discovery throws', async () => {
    // Override the mock to throw an error
    getCachedModelsStub.rejects(new Error('Model discovery failed'));

    const input = {
      jobs: [{
        producerId: 'test',
        task: 'Test',
        work: { type: 'agent', instructions: 'X', model: 'anything' }
      }]
    };
    const result = await validateAgentModels(input, 'create_copilot_plan');
    assert.strictEqual(result.valid, true);
  });

  test('should skip validation when validateModels setting is disabled', async () => {
    const mockConfig: any = {
      getConfig: sinon.stub().returns(false),
    };

    const input = {
      jobs: [{
        producerId: 'test',
        task: 'Test',
        work: { type: 'agent', instructions: 'X', model: 'nonexistent-model' }
      }]
    };
    const result = await validateAgentModels(input, 'create_copilot_plan', mockConfig);
    assert.strictEqual(result.valid, true);
    // getCachedModels should not have been called
    assert.strictEqual(getCachedModelsStub.callCount, 0);
  });

  test('should still validate when validateModels setting is enabled', async () => {
    const mockConfig: any = {
      getConfig: sinon.stub().returns(true),
    };

    const input = {
      jobs: [{
        producerId: 'test',
        task: 'Test',
        work: { type: 'agent', instructions: 'X', model: 'nonexistent-model' }
      }]
    };
    const result = await validateAgentModels(input, 'create_copilot_plan', mockConfig);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error);
    assert.ok(result.error.includes('nonexistent-model'));
  });
});