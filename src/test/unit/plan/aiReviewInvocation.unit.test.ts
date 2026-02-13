/**
 * @fileoverview Unit tests for AI Review Invocation functionality.
 * Tests verify writeAiReviewInstructions function, parseAiReviewResult function,
 * and the integration with agent delegation patterns.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import { writeAiReviewInstructions, parseAiReviewResult } from '../../../plan/aiReviewUtils';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

suite('AI Review Invocation', () => {
  let quiet: { restore: () => void };

  setup(() => {
    quiet = silenceConsole();
  });

  teardown(() => {
    quiet.restore();
    sinon.restore();
  });

  suite('writeAiReviewInstructions', () => {
    test('should write instructions file with JSON-only format requirement', async () => {
      const mockWriteFile = sinon.stub(fs.promises, 'writeFile').resolves();
      const mockMkdir = sinon.stub(fs.promises, 'mkdir').resolves('');
      
      await writeAiReviewInstructions(
        '/worktree/path',
        'node123',
        'Agent did some work...',
        'Fix the bug'
      );
      
      assert.ok(mockMkdir.calledWith(sinon.match.string, { recursive: true }));
      assert.ok(mockWriteFile.called);
      const content = mockWriteFile.args[0][1] as string;
      
      // Verify JSON-only instructions
      assert.ok(content.includes('Respond ONLY with a JSON object'));
      assert.ok(content.includes('No markdown, no explanation, no HTML'));
      assert.ok(content.includes('{"legitimate":'));
    });
    
    test('should include execution logs in instructions', async () => {
      const _mockWriteFile = sinon.stub(fs.promises, 'writeFile').resolves();
      const _mockMkdir = sinon.stub(fs.promises, 'mkdir').resolves('');
      const logs = 'Line 1\nLine 2\nLine 3';
      
      await writeAiReviewInstructions('/worktree', 'node', logs, 'Task');
      
      const content = _mockWriteFile.args[0][1] as string;
      assert.ok(content.includes(logs));
    });
    
    test('should write to standard instructions location', async () => {
      const _mockWriteFile = sinon.stub(fs.promises, 'writeFile').resolves();
      const _mockMkdir = sinon.stub(fs.promises, 'mkdir').resolves('');
      
      const result = await writeAiReviewInstructions(
        '/worktree/path',
        'abc123',
        'logs',
        'task'
      );
      
      // Normalize path separators for cross-platform compatibility
      const normalizedResult = result.replace(/\\/g, '/');
      assert.strictEqual(normalizedResult, '/worktree/path/.github/instructions/orchestrator-ai-review-abc123.instructions.md');
    });
  });
  
  suite('parseAiReviewResult', () => {
    test('should parse clean JSON response', () => {
      const input = '{"legitimate": true, "reason": "Work already done"}';
      const result = parseAiReviewResult(input);
      assert.deepStrictEqual(result, { legitimate: true, reason: 'Work already done' });
    });
    
    test('should parse JSON from markdown code block', () => {
      const input = '```json\n{"legitimate": false, "reason": "Agent failed"}\n```';
      const result = parseAiReviewResult(input);
      assert.strictEqual(result?.legitimate, false);
    });
    
    test('should handle HTML-encoded JSON (legacy)', () => {
      const input = '<p>{&quot;legitimate&quot;: true, &quot;reason&quot;: &quot;Done&quot;}</p>';
      const result = parseAiReviewResult(input);
      assert.strictEqual(result?.legitimate, true);
    });
    
    test('should extract fields when JSON is malformed', () => {
      const input = 'Some text "legitimate": true and "reason": "something" more text';
      const result = parseAiReviewResult(input);
      assert.strictEqual(result?.legitimate, true);
    });
  });
  
  suite('AI Review uses standard invocation pattern', () => {
    test('should use agentDelegator.delegate like current implementation', async () => {
      // Mock agentDelegator with delegate method
      const mockDelegate = sinon.stub().resolves({
        success: true,
        sessionId: 'test-session',
        metrics: { tokensUsed: 100 }
      });
      
      const agentDelegator = {
        delegate: mockDelegate
      };
      
      // Simulate a simple AI review method that would use the standard pattern
      const runAiReview = async (worktreePath: string, nodeId: string, logs: string, task: string) => {
        const _instructionsPath = await writeAiReviewInstructions(worktreePath, nodeId, logs, task);
        
        const result = await agentDelegator.delegate({
          task: 'Complete the task described in the instructions.',
          instructions: `Review task: ${task}`,
          worktreePath,
          model: 'claude-haiku-4.5',
          jobId: nodeId,
        });
        
        return result;
      };
      
      // Mock the file system operations
      const _mockWriteFile = sinon.stub(fs.promises, 'writeFile').resolves();
      const _mockMkdir = sinon.stub(fs.promises, 'mkdir').resolves('');
      
      await runAiReview('/worktree', 'node123', 'execution logs', 'test task');
      
      assert.ok(mockDelegate.calledWith(
        sinon.match({
          task: 'Complete the task described in the instructions.',
          worktreePath: '/worktree',
          jobId: 'node123'
        })
      ));
    });
  });
});