/**
 * @fileoverview Unit tests for folder validation
 *
 * Tests cover:
 * - validateAllowedFolders passes when all folders exist and are directories
 * - validateAllowedFolders fails when folder does not exist
 * - validateAllowedFolders fails when path is a file, not a directory
 * - validateAllowedFolders validates folders in nested groups
 * - validateAllowedFolders skips validation for non-agent work types
 * - validateAllowedFolders passes when agent has no allowedFolders
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateAllowedFolders } from '../../../mcp/validation/validator';

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

suite('validateAllowedFolders', () => {
  let quiet: { restore: () => void };
  let tempDir: string;
  let existingFolder: string;
  let nonExistentPath: string;
  let existingFile: string;

  setup(async () => {
    quiet = silenceConsole();
    
    // Create temporary directory structure for testing
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'folder-validation-test-'));
    existingFolder = path.join(tempDir, 'existing-folder');
    nonExistentPath = path.join(tempDir, 'non-existent-path');
    existingFile = path.join(tempDir, 'existing-file.txt');
    
    // Create test folder and file
    await fs.promises.mkdir(existingFolder);
    await fs.promises.writeFile(existingFile, 'test content');
  });

  teardown(async () => {
    quiet.restore();
    
    // Clean up temporary directory
    if (tempDir && fs.existsSync(tempDir)) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('should pass when all folders exist and are directories', async () => {
    const input = {
      jobs: [{
        producer_id: 'test',
        task: 'Test',
        work: {
          type: 'agent',
          instructions: 'Do something',
          allowedFolders: [existingFolder, tempDir]
        }
      }]
    };
    
    const result = await validateAllowedFolders(input, 'create_copilot_plan');
    assert.strictEqual(result.valid, true);
  });

  test('should fail when folder does not exist', async () => {
    const input = {
      jobs: [{
        producer_id: 'test',
        task: 'Test',
        work: {
          type: 'agent',
          instructions: 'Do something',
          allowedFolders: [nonExistentPath]
        }
      }]
    };
    
    const result = await validateAllowedFolders(input, 'create_copilot_plan');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes('does not exist'));
    assert.ok(result.error?.includes(nonExistentPath));
    assert.ok(result.error?.includes('/jobs/0/work/allowedFolders[0]'));
  });

  test('should fail when path is a file, not a directory', async () => {
    const input = {
      jobs: [{
        producer_id: 'test',
        task: 'Test',
        work: {
          type: 'agent',
          instructions: 'Do something',
          allowedFolders: [existingFile]
        }
      }]
    };
    
    const result = await validateAllowedFolders(input, 'create_copilot_plan');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes('not a directory'));
    assert.ok(result.error?.includes(existingFile));
  });

  test('should validate folders in nested groups', async () => {
    const input = {
      jobs: [],
      groups: [{
        name: 'backend',
        jobs: [{
          producer_id: 'test',
          task: 'Test',
          work: {
            type: 'agent',
            instructions: 'X',
            allowedFolders: [nonExistentPath]
          }
        }]
      }]
    };
    
    const result = await validateAllowedFolders(input, 'create_copilot_plan');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes('/groups/0/jobs/0/work/allowedFolders[0]'));
  });

  test('should skip validation for non-agent work types', async () => {
    const input = {
      jobs: [{
        producer_id: 'test',
        task: 'Test',
        work: {
          type: 'shell',
          command: 'echo hello',
          allowedFolders: [nonExistentPath]  // This should be ignored
        }
      }]
    };
    
    const result = await validateAllowedFolders(input, 'create_copilot_plan');
    assert.strictEqual(result.valid, true);
  });

  test('should pass when agent has no allowedFolders', async () => {
    const input = {
      jobs: [{
        producer_id: 'test',
        task: 'Test',
        work: { type: 'agent', instructions: 'Do something' }
      }]
    };
    
    const result = await validateAllowedFolders(input, 'create_copilot_plan');
    assert.strictEqual(result.valid, true);
  });

  test('should fail when path is not absolute', async () => {
    const input = {
      jobs: [{
        producer_id: 'test',
        task: 'Test',
        work: {
          type: 'agent',
          instructions: 'Do something',
          allowedFolders: ['relative/path']
        }
      }]
    };
    
    const result = await validateAllowedFolders(input, 'create_copilot_plan');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes('must be absolute'));
    assert.ok(result.error?.includes('relative/path'));
  });
});