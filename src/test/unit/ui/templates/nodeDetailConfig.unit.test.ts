/**
 * @fileoverview Tests for node detail config template functions
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import { gitInfoSectionHtml } from '../../../../ui/templates/nodeDetail/configTemplate';

suite('nodeDetail/configTemplate', () => {
  suite('gitInfoSectionHtml', () => {
    test('should return empty string when no git data provided', () => {
      const result = gitInfoSectionHtml({});
      assert.strictEqual(result, '');
    });

    test('should show basic git information with commits only', () => {
      const result = gitInfoSectionHtml({
        baseCommit: 'abc123456789',
        completedCommit: 'def789012345',
      });
      
      assert.ok(result.includes('Git Information'));
      assert.ok(result.includes('Base Commit'));
      assert.ok(result.includes('abc123456789'.slice(0, 12)));
      assert.ok(result.includes('Completed Commit'));
      assert.ok(result.includes('def789012345'.slice(0, 12)));
    });

    test('should show branch information when provided', () => {
      const result = gitInfoSectionHtml({
        baseBranch: 'main',
        targetBranch: 'feature/test',
        baseCommit: 'abc123456789',
      });
      
      assert.ok(result.includes('Base Branch'));
      assert.ok(result.includes('main'));
      assert.ok(result.includes('Target Branch'));
      assert.ok(result.includes('feature/test'));
    });

    test('should show work commit when different from completed commit', () => {
      const result = gitInfoSectionHtml({
        workCommit: 'work123456789',
        completedCommit: 'complete789012345',
      });
      
      assert.ok(result.includes('Work Commit'));
      assert.ok(result.includes('work123456789'.slice(0, 12)));
      assert.ok(result.includes('Completed Commit'));
      assert.ok(result.includes('complete789012345'.slice(0, 12)));
    });

    test('should show merge status when provided', () => {
      const resultMerged = gitInfoSectionHtml({
        baseCommit: 'abc123',
        mergedToTarget: true,
      });
      
      const resultPending = gitInfoSectionHtml({
        baseCommit: 'abc123',
        mergedToTarget: false,
      });
      
      assert.ok(resultMerged.includes('Merged to Target'));
      assert.ok(resultMerged.includes('✅ Yes'));
      
      assert.ok(resultPending.includes('Merged to Target'));
      assert.ok(resultPending.includes('⏳ Pending'));
    });

    test('should show worktree path with normal styling when not cleaned up', () => {
      const result = gitInfoSectionHtml({
        worktreePath: '/path/to/worktree',
        worktreeCleanedUp: false,
      });
      
      assert.ok(result.includes('Worktree (detached HEAD)'));
      assert.ok(result.includes('/path/to/worktree'));
      assert.ok(!result.includes('line-through'));
      assert.ok(!result.includes('opacity: 0.6'));
    });

    test('should show worktree path with strikethrough when cleaned up', () => {
      const result = gitInfoSectionHtml({
        worktreePath: '/path/to/worktree',
        worktreeCleanedUp: true,
      });
      
      assert.ok(result.includes('Worktree (cleaned up)'));
      assert.ok(result.includes('/path/to/worktree'));
      assert.ok(result.includes('line-through'));
      assert.ok(result.includes('opacity: 0.6'));
    });

    test('should handle special characters in branch names', () => {
      const result = gitInfoSectionHtml({
        baseBranch: 'feature/fix-<script>alert("xss")</script>',
        targetBranch: 'users/test-&-development',
      });
      
      // Should escape HTML in branch names
      assert.ok(result.includes('&lt;script&gt;'));
      assert.ok(result.includes('&amp;'));
      assert.ok(!result.includes('<script>alert("xss")</script>'));
    });

    test('should show all fields when fully populated', () => {
      const result = gitInfoSectionHtml({
        baseBranch: 'main',
        targetBranch: 'feature/complete',
        baseCommit: 'abc123456789',
        workCommit: 'work789012345',
        completedCommit: 'final567890123',
        mergedToTarget: true,
        worktreePath: '/path/to/worktree',
        worktreeCleanedUp: false,
      });
      
      assert.ok(result.includes('Base Branch'));
      assert.ok(result.includes('main'));
      assert.ok(result.includes('Target Branch'));
      assert.ok(result.includes('feature/complete'));
      assert.ok(result.includes('Base Commit'));
      assert.ok(result.includes('abc123456789'.slice(0, 12)));
      assert.ok(result.includes('Work Commit'));
      assert.ok(result.includes('work789012345'.slice(0, 12)));
      assert.ok(result.includes('Completed Commit'));
      assert.ok(result.includes('final567890123'.slice(0, 12)));
      assert.ok(result.includes('✅ Yes'));
      assert.ok(result.includes('Worktree (detached HEAD)'));
      assert.ok(result.includes('/path/to/worktree'));
    });

    test('should show partial information when some fields missing', () => {
      const result = gitInfoSectionHtml({
        baseBranch: 'main',
        baseCommit: 'abc123456789',
        // Missing: targetBranch, workCommit, completedCommit, mergedToTarget, worktreePath
      });
      
      assert.ok(result.includes('Base Branch'));
      assert.ok(result.includes('main'));
      assert.ok(result.includes('Base Commit'));
      assert.ok(!result.includes('Target Branch'));
      assert.ok(!result.includes('Work Commit'));
      assert.ok(!result.includes('Completed Commit'));
      assert.ok(!result.includes('Merged to Target'));
      assert.ok(!result.includes('Worktree'));
    });

    test('should handle undefined merge status correctly', () => {
      const result = gitInfoSectionHtml({
        baseCommit: 'abc123',
        mergedToTarget: undefined,
      });
      
      assert.ok(!result.includes('Merged to Target'));
      assert.ok(!result.includes('✅'));
      assert.ok(!result.includes('⏳'));
    });

    test('should show git info when only worktree path provided', () => {
      const result = gitInfoSectionHtml({
        worktreePath: '/path/to/worktree',
      });
      
      assert.ok(result.includes('Git Information'));
      assert.ok(result.includes('Worktree (detached HEAD)'));
      assert.ok(result.includes('/path/to/worktree'));
    });

    test('should show git info when only branch provided', () => {
      const result = gitInfoSectionHtml({
        baseBranch: 'main',
      });
      
      assert.ok(result.includes('Git Information'));
      assert.ok(result.includes('Base Branch'));
      assert.ok(result.includes('main'));
    });

    test('should not show work commit when same as completed commit', () => {
      const result = gitInfoSectionHtml({
        workCommit: 'same123456789',
        completedCommit: 'same123456789',
      });
      
      // Should only show completed commit, not work commit
      assert.ok(!result.includes('Work Commit'));
      assert.ok(result.includes('Completed Commit'));
      
      // Hash should appear only once (truncated to 12 chars)
      const hashCount = (result.match(/same12345678/g) || []).length;
      assert.strictEqual(hashCount, 1, 'Hash should appear exactly once for completed commit');
    });
  });
});