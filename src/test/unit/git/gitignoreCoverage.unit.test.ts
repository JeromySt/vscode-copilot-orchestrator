/**
 * @fileoverview Coverage tests for gitignore.ts — isDiffOnlyOrchestratorChanges
 */
import { suite, test } from 'mocha';
import * as assert from 'assert';
import { isDiffOnlyOrchestratorChanges } from '../../../git/core/gitignore';

suite('isDiffOnlyOrchestratorChanges', () => {
  test('returns true for diff with only orchestrator entries', () => {
    const diff = [
      'diff --git a/.gitignore b/.gitignore',
      'index abc..def 100644',
      '--- a/.gitignore',
      '+++ b/.gitignore',
      '@@ -1,3 +1,5 @@',
      ' node_modules/',
      '+.worktrees/',
      '+.orchestrator/',
    ].join('\n');
    assert.strictEqual(isDiffOnlyOrchestratorChanges(diff), true);
  });

  test('returns false for diff with non-orchestrator changes', () => {
    const diff = [
      'diff --git a/.gitignore b/.gitignore',
      '--- a/.gitignore',
      '+++ b/.gitignore',
      '@@ -1,3 +1,5 @@',
      '+.worktrees/',
      '+custom-user-entry/',
    ].join('\n');
    assert.strictEqual(isDiffOnlyOrchestratorChanges(diff), false);
  });

  test('returns true for empty diff', () => {
    assert.strictEqual(isDiffOnlyOrchestratorChanges(''), true);
  });

  test('handles removed orchestrator lines', () => {
    const diff = [
      'diff --git a/.gitignore b/.gitignore',
      '--- a/.gitignore',
      '+++ b/.gitignore',
      '@@ -1,3 +1,2 @@',
      '-.worktrees/',
      '-.orchestrator/',
    ].join('\n');
    assert.strictEqual(isDiffOnlyOrchestratorChanges(diff), true);
  });
});
