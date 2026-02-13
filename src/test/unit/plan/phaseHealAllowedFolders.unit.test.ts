/**
 * @fileoverview Tests for phase heal allowed folders inheritance.
 * 
 * Tests that phase heal properly inherits allowedFolders and allowedUrls from
 * work spec during failure recovery, and validates worktree inclusion.
 */

import * as assert from 'assert';
import { AgentSpec, WorkSpec, JobNode, normalizeWorkSpec } from '../../../plan/types';

// Mock implementation based on runner.ts heal logic
function createPhaseHealSpec(
  failedPhase: string,
  node: JobNode,
  worktreePath: string,
  failedSpec: WorkSpec | undefined
): AgentSpec {
  // Get security settings from the original failed spec
  const normalizedFailedSpec = normalizeWorkSpec(failedSpec || undefined);
  const originalAgentSpec = normalizedFailedSpec?.type === 'agent' ? normalizedFailedSpec : null;

  // Build allowedFolders - always include worktree, plus inherit from work spec
  const allowedFolders: string[] = [worktreePath];
  const allowedUrls: string[] = [];
  
  // Inherit from work spec if it's an agent
  const normalizedWorkSpec = normalizeWorkSpec(node.work);
  if (normalizedWorkSpec?.type === 'agent') {
    if (normalizedWorkSpec.allowedFolders) {
      allowedFolders.push(...normalizedWorkSpec.allowedFolders);
    }
    if (normalizedWorkSpec.allowedUrls) {
      allowedUrls.push(...normalizedWorkSpec.allowedUrls);
    }
  }
  
  // Also inherit from original failed spec if it was an agent
  if (originalAgentSpec?.allowedFolders) {
    allowedFolders.push(...originalAgentSpec.allowedFolders);
  }
  if (originalAgentSpec?.allowedUrls) {
    allowedUrls.push(...originalAgentSpec.allowedUrls);
  }
  
  // Deduplicate
  const uniqueFolders = [...new Set(allowedFolders)];
  const uniqueUrls = [...new Set(allowedUrls)];

  return {
    type: 'agent',
    instructions: `# Auto-Heal: Fix Failed ${failedPhase} Phase\n\nPlease diagnose and fix the issue.`,
    // Always include worktree, inherit from work spec and original failed spec
    allowedFolders: uniqueFolders.length > 0 ? uniqueFolders : undefined,
    allowedUrls: uniqueUrls.length > 0 ? uniqueUrls : undefined,
  };
}

function createTestNode(overrides: Partial<JobNode> = {}): JobNode {
  return {
    id: 'test-node',
    producerId: 'test-node',
    name: 'Test Node',
    type: 'job',
    task: 'test task',
    dependencies: [],
    dependents: [],
    work: { type: 'shell', command: 'echo test' },
    ...overrides
  };
}

suite('Phase Heal AllowedFolders', () => {
  const worktreeDir = '/worktrees/test-node';
  
  suite('Prechecks heal', () => {
    test('should include worktreeDir in allowedFolders', () => {
      const node = createTestNode({
        prechecks: { type: 'shell', command: 'npm test' }  // Shell command, not agent
      });
      
      const healSpec = createPhaseHealSpec('prechecks', node, worktreeDir, node.prechecks!);
      
      assert.ok(healSpec.allowedFolders);
      assert.ok(healSpec.allowedFolders.includes(worktreeDir));
    });
    
    test('should inherit allowedFolders from work spec if agent', () => {
      const node = createTestNode({
        work: {
          type: 'agent',
          instructions: 'Do work',
          allowedFolders: ['/some/other/path']
        }
      });
      
      const healSpec = createPhaseHealSpec('prechecks', node, worktreeDir, undefined);
      
      assert.ok(healSpec.allowedFolders);
      assert.ok(healSpec.allowedFolders.includes(worktreeDir));
      assert.ok(healSpec.allowedFolders.includes('/some/other/path'));
    });
    
    test('should inherit allowedUrls from work spec if agent', () => {
      const node = createTestNode({
        work: {
          type: 'agent',
          instructions: 'Do work',
          allowedUrls: ['http://api.example.com']
        }
      });
      
      const healSpec = createPhaseHealSpec('prechecks', node, worktreeDir, undefined);
      
      assert.ok(healSpec.allowedUrls);
      assert.ok(healSpec.allowedUrls.includes('http://api.example.com'));
    });
    
    test('should not duplicate worktreeDir if already in work allowedFolders', () => {
      const node = createTestNode({
        work: {
          type: 'agent',
          instructions: 'Do work',
          allowedFolders: [worktreeDir, '/other']
        }
      });
      
      const healSpec = createPhaseHealSpec('prechecks', node, worktreeDir, undefined);
      
      assert.ok(healSpec.allowedFolders);
      const worktreeCount = healSpec.allowedFolders.filter(f => f === worktreeDir).length;
      assert.strictEqual(worktreeCount, 1);  // No duplicates
    });
  });
  
  suite('Postchecks heal', () => {
    test('should include worktreeDir in allowedFolders', () => {
      const node = createTestNode({
        postchecks: { type: 'shell', command: 'npm run lint' }
      });
      
      const healSpec = createPhaseHealSpec('postchecks', node, worktreeDir, node.postchecks!);
      
      assert.ok(healSpec.allowedFolders);
      assert.ok(healSpec.allowedFolders.includes(worktreeDir));
    });
    
    test('should inherit from work spec for postchecks heal', () => {
      const node = createTestNode({
        work: {
          type: 'agent',
          instructions: 'Do work',
          allowedFolders: ['/data/models'],
          allowedUrls: ['http://docs.example.com']
        },
        postchecks: { type: 'shell', command: 'npm test' }
      });
      
      const healSpec = createPhaseHealSpec('postchecks', node, worktreeDir, node.postchecks!);
      
      assert.ok(healSpec.allowedFolders);
      assert.ok(healSpec.allowedFolders.includes(worktreeDir));
      assert.ok(healSpec.allowedFolders.includes('/data/models'));
      assert.ok(healSpec.allowedUrls);
      assert.ok(healSpec.allowedUrls.includes('http://docs.example.com'));
    });
  });
  
  suite('Work heal (for completeness)', () => {
    test('should include worktreeDir and inherit from original work spec', () => {
      const node = createTestNode({
        work: {
          type: 'agent',
          instructions: 'Original work',
          allowedFolders: ['/resources'],
          allowedUrls: ['http://api.test.com']
        }
      });
      
      const healSpec = createPhaseHealSpec('work', node, worktreeDir, node.work);
      
      assert.ok(healSpec.allowedFolders);
      assert.ok(healSpec.allowedFolders.includes(worktreeDir));
      assert.ok(healSpec.allowedFolders.includes('/resources'));
      assert.ok(healSpec.allowedUrls);
      assert.ok(healSpec.allowedUrls.includes('http://api.test.com'));
    });
  });
});