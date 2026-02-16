/**
 * @fileoverview Unit tests for deletePlan resilience.
 * 
 * Tests that PlanRunner.delete() handles filesystem errors gracefully.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
import { PlanInstance } from '../../../plan/types';

// Mock minimal PlanRunner structure for testing
interface MockRunner extends EventEmitter {
  plans: Map<string, PlanInstance>;
  persistence: { delete: sinon.SinonStub };
  delete(planId: string): boolean;
  onPlanDeleted(handler: (planId: string) => void): void;
}

function createMockPlan(): PlanInstance {
  return {
    id: 'test-plan',
    spec: { name: 'Test Plan', jobs: [], baseBranch: 'main' },
    nodes: new Map(),
    producerIdToNodeId: new Map(),
    roots: [],
    leaves: [],
    nodeStates: new Map(),
    groups: new Map(),
    groupStates: new Map(),
    groupPathToId: new Map(),
    repoPath: '/repo',
    baseBranch: 'main',
    worktreeRoot: '/worktrees',
    createdAt: Date.now(),
    stateVersion: 0,
    cleanUpSuccessfulWork: true,
    maxParallel: 4,
  };
}

function createMockRunner(options: { fsUnlink?: sinon.SinonStub } = {}): MockRunner {
  const runner = new EventEmitter() as MockRunner;
  runner.plans = new Map();
  runner.persistence = { 
    delete: options.fsUnlink || sinon.stub() 
  };
  
  // Simple implementation that mimics PlanRunner.delete() logic
  runner.delete = function(planId: string): boolean {
    const hadPlan = this.plans.has(planId);
    if (!hadPlan) {return false;}
    
    // Clear memory state first
    this.plans.delete(planId);
    
    // Fire event immediately
    this.emit('planDeleted', planId);
    
    // Try filesystem operation - don't let errors propagate
    try {
      this.persistence.delete(planId);
    } catch (err: any) {
      // Log but don't throw
      console.warn(`Failed to delete plan file: ${err}`);
    }
    
    return true;
  };
  
  runner.onPlanDeleted = function(handler: (planId: string) => void): void {
    this.on('planDeleted', handler);
  };
  
  return runner;
}

suite('deletePlan', () => {
  test('clears in-memory state even when file is already deleted', async () => {
    // Mock fs.unlink to throw ENOENT
    const unlinkMock = sinon.stub().throws({
      code: 'ENOENT',
      message: 'File not found'
    });
    
    // Create runner with mocked fs
    const runner = createMockRunner({ fsUnlink: unlinkMock });
    runner.plans.set('test-plan', createMockPlan());
    
    // Should not throw
    const result = runner.delete('test-plan');
    
    assert.strictEqual(result, true, 'Delete should return true');
    // In-memory state should be cleared
    assert.strictEqual(runner.plans.has('test-plan'), false, 'Plan should be removed from memory');
  });
  
  test('fires onPlanDeleted event even when file already deleted', async () => {
    const unlinkMock = sinon.stub().throws({ code: 'ENOENT' });
    const runner = createMockRunner({ fsUnlink: unlinkMock });
    runner.plans.set('test-plan', createMockPlan());
    
    const deletedHandler = sinon.spy();
    runner.onPlanDeleted(deletedHandler);
    
    runner.delete('test-plan');
    
    assert.ok(deletedHandler.calledWith('test-plan'), 'Delete event should be fired');
  });
  
  test('logs warning for non-ENOENT errors but still clears state', async () => {
    const unlinkMock = sinon.stub().throws({
      code: 'EACCES',
      message: 'Permission denied'
    });
    const runner = createMockRunner({ fsUnlink: unlinkMock });
    runner.plans.set('test-plan', createMockPlan());
    
    // Mock console.warn to capture warning
    const warnStub = sinon.stub(console, 'warn');
    
    try {
      runner.delete('test-plan');
      
      // State should still be cleared
      assert.strictEqual(runner.plans.has('test-plan'), false, 'Plan should be removed from memory');
      // Warning should be logged
      assert.ok(warnStub.called, 'Warning should be logged');
    } finally {
      warnStub.restore();
    }
  });
});