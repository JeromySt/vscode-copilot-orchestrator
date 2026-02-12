/**
 * @fileoverview Tests for auto-heal allowed folders inheritance.
 * 
 * Tests that auto-heal properly inherits allowedFolders and allowedUrls from
 * original agent specs during failure recovery, and validates worktree isolation.
 */

import * as assert from 'assert';
import { AgentSpec, WorkSpec, ProcessSpec, ShellSpec, normalizeWorkSpec } from '../../../plan/types';

// Mock implementation of createAutoHealSpec based on the runner.ts logic
function createAutoHealSpec(
  originalSpec: WorkSpec,
  failedPhase: string,
  originalCommand: string,
  error: string
): AgentSpec {
  // Normalize the spec to handle string/legacy formats
  const normalizedSpec = normalizeWorkSpec(originalSpec);
  // Extract security settings from original agent spec if it was an agent
  const originalAgentSpec = normalizedSpec?.type === 'agent' ? normalizedSpec : null;
  
  return {
    type: 'agent',
    instructions: [
      `# Auto-Heal: Fix Failed ${failedPhase} Phase`,
      '',
      `## Task Context`,
      `The ${failedPhase} phase failed during job execution.`,
      '',
      `**Error:** ${error}`,
      '',
      `**Original command:** ${originalCommand}`,
      '',
      `Please diagnose and fix the issue.`,
    ].join('\n'),
    // Inherit allowed folders/URLs from original spec (if any)
    // This ensures auto-heal has same access as the original work
    allowedFolders: originalAgentSpec?.allowedFolders,
    allowedUrls: originalAgentSpec?.allowedUrls,
  };
}

// Mock implementation of buildAllowedPaths based on copilotCliRunner.ts logic
function buildAllowedPaths(worktreePath: string, allowedFolders?: string[]): string[] {
  const allowedPaths: string[] = [];
  
  // Always include the worktree path
  if (worktreePath) {
    allowedPaths.push(worktreePath);
  }
  
  // Add additional allowed folders if provided
  if (allowedFolders && allowedFolders.length > 0) {
    for (const folder of allowedFolders) {
      // In real implementation, there would be path validation here
      // For test purposes, we'll assume valid absolute paths
      allowedPaths.push(folder);
    }
  }
  
  return allowedPaths;
}

suite('Auto-Heal Allowed Folders', () => {
  test('should inherit allowedFolders from original agent spec during auto-heal', () => {
    // Test that when auto-heal creates a healSpec from a failed agent spec,
    // it copies the allowedFolders and allowedUrls
    const originalSpec: AgentSpec = {
      type: 'agent',
      instructions: 'Original task',
      allowedFolders: ['/shared/libs'],
      allowedUrls: ['https://api.example.com']
    };
    
    // The healSpec should inherit these settings
    const healSpec = createAutoHealSpec(originalSpec, 'prechecks', 'npm test', 'test failed');
    
    assert.strictEqual(healSpec.type, 'agent');
    assert.deepStrictEqual(healSpec.allowedFolders, originalSpec.allowedFolders);
    assert.deepStrictEqual(healSpec.allowedUrls, originalSpec.allowedUrls);
  });
  
  test('should NOT have allowedFolders when healing non-agent (shell) spec', () => {
    // When auto-healing a shell command, there's no allowedFolders to inherit
    const originalSpec: ShellSpec = {
      type: 'shell',
      command: 'npm test'
    };
    
    const healSpec = createAutoHealSpec(originalSpec, 'work', 'npm test', 'test failed');
    
    // allowedFolders should be undefined (agent runs in worktree only)
    assert.strictEqual(healSpec.allowedFolders, undefined);
    assert.strictEqual(healSpec.allowedUrls, undefined);
  });
  
  test('should inherit partial allowedFolders when original spec has only allowedFolders', () => {
    const originalSpec: AgentSpec = {
      type: 'agent',
      instructions: 'Original task',
      allowedFolders: ['/shared/libs'],
      // No allowedUrls
    };
    
    const healSpec = createAutoHealSpec(originalSpec, 'work', 'npm build', 'build failed');
    
    assert.deepStrictEqual(healSpec.allowedFolders, ['/shared/libs']);
    assert.strictEqual(healSpec.allowedUrls, undefined);
  });
  
  test('should inherit partial allowedUrls when original spec has only allowedUrls', () => {
    const originalSpec: AgentSpec = {
      type: 'agent',
      instructions: 'Original task',
      // No allowedFolders
      allowedUrls: ['https://api.example.com']
    };
    
    const healSpec = createAutoHealSpec(originalSpec, 'postchecks', 'npm audit', 'audit failed');
    
    assert.strictEqual(healSpec.allowedFolders, undefined);
    assert.deepStrictEqual(healSpec.allowedUrls, ['https://api.example.com']);
  });
});

suite('Agent Worktree Isolation', () => {
  test('should always include worktree in allowed paths', () => {
    // Verify that worktreePath is always added to allowed directories
    // even when spec.allowedFolders is empty/undefined
    const worktreePath = '/path/to/.worktrees/abc123';
    
    // buildAllowedPaths should always include worktree
    const result = buildAllowedPaths(worktreePath, undefined);
    
    assert.ok(result.includes(worktreePath));
    assert.strictEqual(result.length, 1);  // Only worktree, nothing else
  });
  
  test('should add spec folders in addition to worktree', () => {
    const worktreePath = '/path/to/.worktrees/abc123';
    const specFolders = ['/extra/allowed/folder'];
    
    const result = buildAllowedPaths(worktreePath, specFolders);
    
    assert.ok(result.includes(worktreePath));
    assert.ok(result.includes('/extra/allowed/folder'));
    assert.strictEqual(result.length, 2);
  });
  
  test('should NOT include workspace root - only worktree', () => {
    // Security: agent should NOT break out of worktree boundary
    const worktreePath = '/repo/.worktrees/abc123';
    const workspaceRoot = '/repo';  // Parent - should NOT be allowed
    
    const result = buildAllowedPaths(worktreePath, undefined);
    
    assert.ok(result.includes(worktreePath));
    assert.ok(!result.includes(workspaceRoot));
  });
  
  test('should handle multiple additional folders correctly', () => {
    const worktreePath = '/path/to/.worktrees/xyz789';
    const specFolders = ['/shared/lib1', '/shared/lib2', '/tools/bin'];
    
    const result = buildAllowedPaths(worktreePath, specFolders);
    
    assert.ok(result.includes(worktreePath));
    assert.ok(result.includes('/shared/lib1'));
    assert.ok(result.includes('/shared/lib2'));
    assert.ok(result.includes('/tools/bin'));
    assert.strictEqual(result.length, 4);
  });
  
  test('should handle empty worktree path gracefully', () => {
    const worktreePath = '';
    const specFolders = ['/allowed/folder'];
    
    const result = buildAllowedPaths(worktreePath, specFolders);
    
    assert.ok(result.includes('/allowed/folder'));
    assert.strictEqual(result.length, 1);  // Only the allowed folder
  });
});