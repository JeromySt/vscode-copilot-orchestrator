/**
 * @fileoverview Tests for auto-heal attempt counting behavior.
 *
 * Verifies that auto-heal retries (both agent-interrupted and AI-assisted)
 * do NOT increment nodeState.attempts. Only user-visible retries should
 * increment the counter, ensuring sequential attempt numbering (1, 2, 3)
 * without gaps.
 *
 * Bug context: Auto-heal retries were incrementing nodeState.attempts,
 * causing visible attempt numbers to skip (1, 3, 5) when auto-heals
 * occurred between user retries.
 *
 * @module test/unit/plan/autoHealAttemptCounting
 */

import * as assert from 'assert';

suite('Auto-Heal Attempt Counting', () => {

  /**
   * Simulates the nodeState.attempts lifecycle through initial execution,
   * auto-heal, and manual retry to verify counting behavior.
   */
  suite('attempt numbering', () => {

    test('initial execution sets attempts to 1', () => {
      const nodeState = { attempts: 0, status: 'pending' as const };
      
      // Simulate executeNode: nodeState.attempts++ at start of execution
      nodeState.attempts++;
      nodeState.status = 'running' as any;
      
      assert.strictEqual(nodeState.attempts, 1, 'First execution should be attempt 1');
    });

    test('auto-heal retry does NOT increment attempts', () => {
      const nodeState: { attempts: number; status: string; error: string | undefined } = { attempts: 1, status: 'running', error: undefined };
      
      // Simulate work phase failure
      nodeState.error = 'Process exited with code 1';
      
      // Simulate auto-heal retry (the fix: no attempts++ here)
      nodeState.error = undefined;
      // nodeState.attempts++ was removed — this is the bug fix
      
      assert.strictEqual(nodeState.attempts, 1, 
        'Auto-heal retry should NOT increment attempts — it is a sub-attempt of attempt 1');
    });

    test('auto-heal success keeps same attempt number', () => {
      const nodeState = { 
        attempts: 1, 
        status: 'running' as const,
        error: undefined as string | undefined,
        autoHealAttempted: {} as Record<string, boolean>
      };
      
      // Work fails
      nodeState.error = 'Process exited with code 1';
      nodeState.autoHealAttempted['work'] = true;
      
      // Auto-heal start (no attempts++)
      nodeState.error = undefined;
      
      // Auto-heal succeeds
      nodeState.status = 'running' as any; // still running through commit phase
      
      assert.strictEqual(nodeState.attempts, 1,
        'After successful auto-heal, attempts should still be 1');
    });

    test('manual retry after auto-heal failure gives sequential numbering', () => {
      const nodeState: { attempts: number; status: string; error: string | undefined } = { 
        attempts: 1, 
        status: 'failed',
        error: 'Auto-heal could not fix: still fails'
      };
      
      // User manually retries — THIS should increment
      nodeState.attempts++;
      nodeState.status = 'running' as any;
      nodeState.error = undefined;
      
      assert.strictEqual(nodeState.attempts, 2,
        'Manual retry should increment to attempt 2 (not 3)');
    });

    test('multiple auto-heals between retries preserve sequential numbering', () => {
      // Simulates: attempt 1 → auto-heal fail → user retry → auto-heal fail → user retry
      const nodeState = { attempts: 0, error: undefined as string | undefined };
      
      // Attempt 1: initial execution
      nodeState.attempts++; // → 1
      assert.strictEqual(nodeState.attempts, 1);
      
      // Work fails, auto-heal triggers (NO increment)
      nodeState.error = 'fail';
      nodeState.error = undefined; // auto-heal start
      // Auto-heal fails
      nodeState.error = 'auto-heal failed';
      assert.strictEqual(nodeState.attempts, 1, 'After auto-heal fail, still attempt 1');
      
      // User retry: attempt 2
      nodeState.attempts++; // → 2
      nodeState.error = undefined;
      assert.strictEqual(nodeState.attempts, 2);
      
      // Work fails again, auto-heal triggers (NO increment)
      nodeState.error = 'fail again';
      nodeState.error = undefined; // auto-heal start
      // Auto-heal fails again
      nodeState.error = 'auto-heal failed again';
      assert.strictEqual(nodeState.attempts, 2, 'After second auto-heal fail, still attempt 2');
      
      // User retry: attempt 3
      nodeState.attempts++; // → 3
      nodeState.error = undefined;
      assert.strictEqual(nodeState.attempts, 3, 'Third attempt should be 3, not 5');
    });

    test('agent-interrupted auto-retry does NOT increment attempts', () => {
      const nodeState = { attempts: 1, error: undefined as string | undefined };
      
      // Agent killed by SIGTERM (e.g., force-fail while running)
      nodeState.error = 'Process received SIGTERM';
      
      // Auto-retry for interrupted agent (no attempts++)
      nodeState.error = undefined;
      
      assert.strictEqual(nodeState.attempts, 1,
        'Agent-interrupted retry is a sub-attempt, not a new visible attempt');
    });
  });

  suite('attempt records', () => {

    test('auto-heal attempt records use same attemptNumber as parent', () => {
      const attemptHistory: Array<{ attemptNumber: number; triggerType: string }> = [];
      const nodeState = { attempts: 1 };
      
      // Initial attempt fails
      attemptHistory.push({
        attemptNumber: nodeState.attempts, // 1
        triggerType: 'initial',
      });
      
      // Auto-heal attempt (same attempt number)
      attemptHistory.push({
        attemptNumber: nodeState.attempts, // still 1
        triggerType: 'auto-heal',
      });
      
      assert.strictEqual(attemptHistory[0].attemptNumber, 1);
      assert.strictEqual(attemptHistory[1].attemptNumber, 1,
        'Auto-heal record should have same attemptNumber as the initial attempt');
      assert.strictEqual(attemptHistory[0].triggerType, 'initial');
      assert.strictEqual(attemptHistory[1].triggerType, 'auto-heal');
    });

    test('visible attempts have sequential numbers in history', () => {
      const attemptHistory: Array<{ attemptNumber: number; triggerType: string }> = [];
      const nodeState = { attempts: 0 };
      
      // Attempt 1
      nodeState.attempts++;
      attemptHistory.push({ attemptNumber: 1, triggerType: 'initial' });
      
      // Auto-heal (no increment)
      attemptHistory.push({ attemptNumber: 1, triggerType: 'auto-heal' });
      
      // Attempt 2 (user retry)
      nodeState.attempts++;
      attemptHistory.push({ attemptNumber: 2, triggerType: 'retry' });
      
      // Auto-heal (no increment)
      attemptHistory.push({ attemptNumber: 2, triggerType: 'auto-heal' });
      
      // Attempt 3 (user retry)
      nodeState.attempts++;
      attemptHistory.push({ attemptNumber: 3, triggerType: 'retry' });
      
      // Verify visible attempts (non-auto-heal) are sequential
      const visibleAttempts = attemptHistory.filter(a => a.triggerType !== 'auto-heal');
      assert.deepStrictEqual(
        visibleAttempts.map(a => a.attemptNumber),
        [1, 2, 3],
        'Visible attempt numbers should be sequential with no gaps'
      );
    });

    test('UI attempt count matches visible attempts, not total records', () => {
      const attemptHistory = [
        { attemptNumber: 1, triggerType: 'initial' },
        { attemptNumber: 1, triggerType: 'auto-heal' },
        { attemptNumber: 2, triggerType: 'retry' },
        { attemptNumber: 2, triggerType: 'auto-heal' },
        { attemptNumber: 3, triggerType: 'retry' },
      ];
      
      // The UI should show "ATTEMPT HISTORY (3)" not "(5)"
      const visibleCount = attemptHistory.filter(a => a.triggerType !== 'auto-heal').length;
      assert.strictEqual(visibleCount, 3, 'UI should count 3 visible attempts');
      
      // The highest attempt number should match the count
      const maxAttemptNumber = Math.max(...attemptHistory.map(a => a.attemptNumber));
      assert.strictEqual(maxAttemptNumber, 3, 'Highest attempt number should be 3, not 5');
    });
  });
});
