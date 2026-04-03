import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { GitignoreDebouncer, BRANCH_CHANGE_DELAY_MS } from '../../../core/gitignoreDebouncer';

suite('GitignoreDebouncer', () => {
  let sandbox: sinon.SinonSandbox;
  let clock: sinon.SinonFakeTimers;
  let mockGit: any;
  let debouncer: GitignoreDebouncer;

  setup(() => {
    sandbox = sinon.createSandbox();
    clock = sinon.useFakeTimers();
    mockGit = {
      gitignore: {
        ensureGitignoreEntries: sandbox.stub().resolves(),
      },
    };
    debouncer = new GitignoreDebouncer(mockGit);
  });

  teardown(() => {
    debouncer.dispose();
    clock.restore();
    sandbox.restore();
  });

  suite('ensureEntries — no recent branch change', () => {
    test('writes entries immediately when no branch change has occurred', async () => {
      // Advance time past the initial 0 timestamp to simulate no recent branch change
      await clock.tickAsync(31000);
      
      const promise = debouncer.ensureEntries('/repo', ['entry1', 'entry2']);
      
      // Should be called synchronously
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledOnce);
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledWith('/repo', ['entry1', 'entry2']));
      
      await promise;
    });

    test('writes entries immediately when branch change was >30s ago', async () => {
      debouncer.notifyBranchChange('/repo');
      await clock.tickAsync(31000); // 31 seconds
      
      mockGit.gitignore.ensureGitignoreEntries.resetHistory();
      
      const promise = debouncer.ensureEntries('/repo', ['entry1']);
      
      // Should be called immediately
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledOnce);
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledWith('/repo', ['entry1']));
      
      await promise;
    });

    test('rejects when immediate write fails', async () => {
      // Advance time past the initial 0 timestamp to simulate no recent branch change
      await clock.tickAsync(31000);
      
      mockGit.gitignore.ensureGitignoreEntries.rejects(new Error('Write failed'));
      
      // Should reject with the write error (consistent with deferred path behaviour)
      await assert.rejects(() => debouncer.ensureEntries('/repo', ['entry1']), /Write failed/);
      
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledOnce);
    });
  });

  suite('ensureEntries — within branch change window', () => {
    test('defers write when branch change was recent', async () => {
      debouncer.notifyBranchChange('/repo');
      
      const promise = debouncer.ensureEntries('/repo', ['entry1']);
      
      // Should NOT be called yet
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.notCalled);
      
      // Advance time by 30 seconds
      await clock.tickAsync(30000);
      
      // Now should be called
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledOnce);
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledWith('/repo', ['entry1']));
      
      await promise;
    });

    test('defers write for exactly the remaining time', async () => {
      debouncer.notifyBranchChange('/repo');
      await clock.tickAsync(10000); // 10 seconds after branch change
      
      const promise = debouncer.ensureEntries('/repo', ['entry1']);
      
      // Should NOT be called yet
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.notCalled);
      
      // Advance by 19 seconds (total 29s)
      await clock.tickAsync(19000);
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.notCalled);
      
      // Advance by 1 more second (total 30s)
      await clock.tickAsync(1000);
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledOnce);
      
      await promise;
    });

    test('merges multiple pending entry sets', async () => {
      debouncer.notifyBranchChange('/repo');
      
      const promise1 = debouncer.ensureEntries('/repo', ['a', 'b']);
      const promise2 = debouncer.ensureEntries('/repo', ['b', 'c']);
      
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.notCalled);
      
      await clock.tickAsync(30000);
      
      // Should be called once with merged, deduplicated entries
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledOnce);
      const callArgs = mockGit.gitignore.ensureGitignoreEntries.firstCall.args;
      assert.strictEqual(callArgs[0], '/repo');
      
      // Verify all unique entries are present
      const entries = callArgs[1];
      assert.ok(entries.includes('a'));
      assert.ok(entries.includes('b'));
      assert.ok(entries.includes('c'));
      assert.strictEqual(entries.length, 3);
      
      await Promise.all([promise1, promise2]);
    });

    test('resolves all pending promises when timer fires', async () => {
      debouncer.notifyBranchChange('/repo');
      
      let resolved1 = false;
      let resolved2 = false;
      let resolved3 = false;
      
      const promise1 = debouncer.ensureEntries('/repo', ['a']).then(() => { resolved1 = true; });
      const promise2 = debouncer.ensureEntries('/repo', ['b']).then(() => { resolved2 = true; });
      const promise3 = debouncer.ensureEntries('/repo', ['c']).then(() => { resolved3 = true; });
      
      assert.strictEqual(resolved1, false);
      assert.strictEqual(resolved2, false);
      assert.strictEqual(resolved3, false);
      
      await clock.tickAsync(30000);
      
      await Promise.all([promise1, promise2, promise3]);
      
      assert.strictEqual(resolved1, true);
      assert.strictEqual(resolved2, true);
      assert.strictEqual(resolved3, true);
    });

    test('rejects all pending promises when deferred write fails', async () => {
      mockGit.gitignore.ensureGitignoreEntries.rejects(new Error('Write failed'));
      
      debouncer.notifyBranchChange('/repo');
      const promise = debouncer.ensureEntries('/repo', ['entry1']);
      
      await clock.tickAsync(30000);
      
      // Should reject with the write error
      await assert.rejects(() => promise, /Write failed/);
      
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledOnce);
    });

    test('rejects all pending callers when deferred write fails', async () => {
      mockGit.gitignore.ensureGitignoreEntries.rejects(new Error('Disk full'));
      
      debouncer.notifyBranchChange('/repo');
      const promise1 = debouncer.ensureEntries('/repo', ['a']);
      const promise2 = debouncer.ensureEntries('/repo', ['b']);
      
      await clock.tickAsync(30000);
      
      // Both should reject
      await assert.rejects(() => promise1, /Disk full/);
      await assert.rejects(() => promise2, /Disk full/);
    });

    test('resets timer when new entries arrive during delay', async () => {
      debouncer.notifyBranchChange('/repo');
      
      const promise1 = debouncer.ensureEntries('/repo', ['a']);
      
      await clock.tickAsync(15000); // 15 seconds
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.notCalled);
      
      // New entry arrives, should reset the timer to the full remaining time
      const promise2 = debouncer.ensureEntries('/repo', ['b']);
      
      // Advance to what would have been the original timer's end
      await clock.tickAsync(15000); // Total 30s from branch change
      
      // Should be called now (timer was reset to 15s remaining when second entry arrived)
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledOnce);
      
      await Promise.all([promise1, promise2]);
    });
  });

  suite('notifyBranchChange', () => {
    test('sets the branch change timestamp', async () => {
      // Verified implicitly by deferred write tests
      debouncer.notifyBranchChange('/repo');
      
      const promise = debouncer.ensureEntries('/repo', ['entry1']);
      
      // Should be deferred
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.notCalled);
      
      await clock.tickAsync(30000);
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledOnce);
      
      await promise;
    });

    test('can be called multiple times', async () => {
      debouncer.notifyBranchChange('/repo');
      await clock.tickAsync(10000); // 10s
      
      debouncer.notifyBranchChange('/repo'); // Second call resets the timestamp
      
      const promise = debouncer.ensureEntries('/repo', ['entry1']);
      
      // Should use the latest timestamp, so need full 30s from second call
      await clock.tickAsync(20000); // Total 30s from first call
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.notCalled);
      
      await clock.tickAsync(10000); // 30s from second call
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledOnce);
      
      await promise;
    });
  });

  suite('dispose', () => {
    test('clears pending timer', async () => {
      debouncer.notifyBranchChange('/repo');
      debouncer.ensureEntries('/repo', ['entry1']);
      
      debouncer.dispose();
      
      await clock.tickAsync(30000);
      
      // Should NOT be called
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.notCalled);
    });

    test('resolves pending promises on dispose', async () => {
      debouncer.notifyBranchChange('/repo');
      
      let resolved = false;
      const promise = debouncer.ensureEntries('/repo', ['entry1']).then(() => { resolved = true; });
      
      assert.strictEqual(resolved, false);
      
      debouncer.dispose();
      
      await promise;
      
      assert.strictEqual(resolved, true);
      // Git should not be called
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.notCalled);
    });

    test('is safe to call multiple times', () => {
      debouncer.dispose();
      debouncer.dispose();
      
      // Should not throw
      assert.ok(true);
    });

    test('is safe when no pending operations', () => {
      debouncer.dispose();
      
      // Should not throw
      assert.ok(true);
    });
  });

  suite('edge cases', () => {
    test('BRANCH_CHANGE_DELAY_MS is 30000', () => {
      assert.strictEqual(BRANCH_CHANGE_DELAY_MS, 30000);
    });

    test('handles empty entries array', async () => {
      // Advance time past the initial 0 timestamp to simulate no recent branch change
      await clock.tickAsync(31000);
      
      await debouncer.ensureEntries('/repo', []);
      
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledOnce);
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledWith('/repo', []));
    });

    test('works after dispose and re-creation', async () => {
      debouncer.dispose();
      
      // Advance time past the initial 0 timestamp to simulate no recent branch change
      await clock.tickAsync(31000);
      
      const newDebouncer = new GitignoreDebouncer(mockGit);
      
      await newDebouncer.ensureEntries('/repo', ['entry1']);
      
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledOnce);
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledWith('/repo', ['entry1']));
      
      newDebouncer.dispose();
    });

    test('branch change in repo A does not defer writes for repo B', async () => {
      // Advance clock past initial 0 timestamp so repo-b (no branch change recorded)
      // has elapsed > 30s when we call ensureEntries
      await clock.tickAsync(31000);

      // Notify branch change for repo-a only (at current time t=31000)
      debouncer.notifyBranchChange('/repo-a');
      
      // Write for repo-B should be immediate: no branch change was recorded for it,
      // so elapsed = (31000 - 0) = 31000ms >= BRANCH_CHANGE_DELAY_MS
      await debouncer.ensureEntries('/repo-b', ['entry1']);
      
      // Should write immediately for repo-B
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledOnce);
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledWith('/repo-b', ['entry1']));
      
      // Write for repo-A should be deferred: branch change at t=31000, elapsed = 0
      mockGit.gitignore.ensureGitignoreEntries.resetHistory();
      const promise = debouncer.ensureEntries('/repo-a', ['entry2']);
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.notCalled);
      
      await clock.tickAsync(30000);
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledOnce);
      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledWith('/repo-a', ['entry2']));
      
      await promise;
    });
  });
});

