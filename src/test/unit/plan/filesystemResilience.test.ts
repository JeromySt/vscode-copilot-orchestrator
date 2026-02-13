/**
 * @fileoverview Unit tests for filesystem resilience.
 * 
 * Tests that core functions handle missing directories gracefully.
 * Uses real filesystem operations with temporary directories.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ensureOrchestratorDirs } from '../../../core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

/** Create a fresh temp directory for one test and track it for cleanup. */
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filesystem-resilience-test-'));
  tmpDirs.push(dir);
  return dir;
}

/** Remove a directory tree (best-effort). */
function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore – CI clean-up is best-effort
  }
}

suite('Filesystem Resilience', () => {
  // Clean up all temp dirs after each test to avoid cross-test contamination.
  teardown(() => {
    for (const d of tmpDirs) {
      rmrf(d);
    }
    tmpDirs = [];
  });
  
  suite('ensureOrchestratorDirs', () => {
    test('creates all required directories when .orchestrator is missing', () => {
      const testWorkspace = makeTmpDir();
      const orchestratorPath = path.join(testWorkspace, '.orchestrator');
      
      // Verify orchestrator directory doesn't exist initially
      assert.strictEqual(fs.existsSync(orchestratorPath), false);
      
      // Call the function
      const resultPath = ensureOrchestratorDirs(testWorkspace);
      
      // Verify orchestrator directory was created
      assert.strictEqual(fs.existsSync(orchestratorPath), true);
      assert.strictEqual(resultPath, orchestratorPath);
      
      // Verify all subdirectories were created
      assert.strictEqual(fs.existsSync(path.join(orchestratorPath, 'plans')), true);
      assert.strictEqual(fs.existsSync(path.join(orchestratorPath, 'logs')), true);
      assert.strictEqual(fs.existsSync(path.join(orchestratorPath, 'evidence')), true);
      assert.strictEqual(fs.existsSync(path.join(orchestratorPath, '.copilot')), true);
    });
    
    test('does not recreate existing directories', () => {
      const testWorkspace = makeTmpDir();
      const orchestratorPath = path.join(testWorkspace, '.orchestrator');
      const plansPath = path.join(orchestratorPath, 'plans');
      
      // Manually create orchestrator directory structure
      fs.mkdirSync(orchestratorPath, { recursive: true });
      fs.mkdirSync(plansPath, { recursive: true });
      
      // Store creation time for verification
      const beforeStat = fs.statSync(plansPath);
      
      // Call the function
      ensureOrchestratorDirs(testWorkspace);
      
      // Directory should still exist
      assert.strictEqual(fs.existsSync(orchestratorPath), true);
      assert.strictEqual(fs.existsSync(plansPath), true);
      
      // Creation time should be the same (directory wasn't recreated)
      const afterStat = fs.statSync(plansPath);
      assert.strictEqual(afterStat.birthtime.getTime(), beforeStat.birthtime.getTime());
    });
    
    test('creates missing subdirectories when orchestrator exists but subdirs are missing', () => {
      const testWorkspace = makeTmpDir();
      const orchestratorPath = path.join(testWorkspace, '.orchestrator');
      const logsPath = path.join(orchestratorPath, 'logs');
      
      // Create only the orchestrator directory, but not subdirectories
      fs.mkdirSync(orchestratorPath, { recursive: true });
      
      // Verify logs subdirectory doesn't exist
      assert.strictEqual(fs.existsSync(logsPath), false);
      
      // Call the function
      ensureOrchestratorDirs(testWorkspace);
      
      // Verify logs subdirectory was created
      assert.strictEqual(fs.existsSync(logsPath), true);
    });
  });
});