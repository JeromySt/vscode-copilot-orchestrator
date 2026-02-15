/**
 * @fileoverview Unit tests for gitignore helper functions
 * 
 * Tests cover:
 * - Creating .gitignore if it doesn't exist
 * - Appending missing entries to existing .gitignore
 * - Handling files that already have all required entries
 * - Handling partial existing entries
 * - Windows line endings support
 */

import * as assert from 'assert';
import { ensureGitignoreEntries } from '../../../git/core/gitignore';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

suite('ensureGitignoreEntries', () => {
  let tempDir: string;
  
  setup(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gitignore-test-'));
  });
  
  teardown(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });
  
  test('creates .gitignore if not exists', async () => {
    const result = await ensureGitignoreEntries(tempDir);
    
    assert.strictEqual(result, true, 'Should return true when creating new file');
    const content = await fs.promises.readFile(path.join(tempDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('.worktrees'), 'Should include .worktrees entry');
    assert.ok(content.includes('.orchestrator'), 'Should include .orchestrator entry');
  });
  
  test('appends missing entries to existing .gitignore', async () => {
    // Create existing gitignore
    await fs.promises.writeFile(
      path.join(tempDir, '.gitignore'),
      'node_modules\n.env\n'
    );
    
    const result = await ensureGitignoreEntries(tempDir);
    
    assert.strictEqual(result, true, 'Should return true when adding entries');
    const content = await fs.promises.readFile(path.join(tempDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('node_modules'), 'Should preserve existing node_modules entry');
    assert.ok(content.includes('.env'), 'Should preserve existing .env entry');
    assert.ok(content.includes('.worktrees'), 'Should add .worktrees entry');
    assert.ok(content.includes('.orchestrator'), 'Should add .orchestrator entry');
  });
  
  test('returns false if entries already exist', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, '.gitignore'),
      'node_modules\n.worktrees/\n.orchestrator/\n.github/instructions/orchestrator-*.instructions.md\n'
    );
    
    const result = await ensureGitignoreEntries(tempDir);
    
    assert.strictEqual(result, false, 'Should return false when no changes needed');
  });
  
  test('handles partial existing entries', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, '.gitignore'),
      '.worktrees/\n'
    );
    
    const result = await ensureGitignoreEntries(tempDir);
    
    assert.strictEqual(result, true, 'Should return true when adding missing entries');
    const content = await fs.promises.readFile(path.join(tempDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('.orchestrator'), 'Should add .orchestrator entry');
    // Should not duplicate .worktrees
    const worktreesMatches = content.match(/\.worktrees\//g) || [];
    assert.strictEqual(worktreesMatches.length, 1, 'Should not duplicate .worktrees entry');
  });
  
  test('handles Windows line endings', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, '.gitignore'),
      'node_modules\r\n.env\r\n'
    );
    
    const result = await ensureGitignoreEntries(tempDir);
    
    assert.strictEqual(result, true, 'Should return true when adding entries');
    const content = await fs.promises.readFile(path.join(tempDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('.worktrees'), 'Should add .worktrees entry');
  });
  
  test('adds header comment for orchestrator entries', async () => {
    const result = await ensureGitignoreEntries(tempDir);
    
    assert.strictEqual(result, true, 'Should return true when creating new file');
    const content = await fs.promises.readFile(path.join(tempDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('# Copilot Orchestrator'), 'Should include header comment');
  });
  
  test('does not duplicate header comment', async () => {
    // First call
    await ensureGitignoreEntries(tempDir);
    
    // Modify to remove one entry
    let content = await fs.promises.readFile(path.join(tempDir, '.gitignore'), 'utf8');
    content = content.replace('.orchestrator\n', '');
    await fs.promises.writeFile(path.join(tempDir, '.gitignore'), content);
    
    // Second call should add missing entry but not duplicate header
    await ensureGitignoreEntries(tempDir);
    
    content = await fs.promises.readFile(path.join(tempDir, '.gitignore'), 'utf8');
    const headerMatches = content.match(/# Copilot Orchestrator/g) || [];
    assert.strictEqual(headerMatches.length, 1, 'Should not duplicate header comment');
  });
  
  test('handles custom entries', async () => {
    const result = await ensureGitignoreEntries(tempDir, ['.custom1', '.custom2']);
    
    assert.strictEqual(result, true, 'Should return true when adding entries');
    const content = await fs.promises.readFile(path.join(tempDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('.custom1'), 'Should include custom1 entry');
    assert.ok(content.includes('.custom2'), 'Should include custom2 entry');
  });
  
  test('preserves file structure and whitespace', async () => {
    const existingContent = '# My project\nnode_modules\n\n# Build output\ndist\n';
    await fs.promises.writeFile(
      path.join(tempDir, '.gitignore'),
      existingContent
    );
    
    await ensureGitignoreEntries(tempDir);
    
    const content = await fs.promises.readFile(path.join(tempDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('# My project'), 'Should preserve existing comments');
    assert.ok(content.includes('# Build output'), 'Should preserve existing comments');
    assert.ok(content.includes('node_modules'), 'Should preserve existing entries');
    assert.ok(content.includes('dist'), 'Should preserve existing entries');
  });
  
  test('handles file without trailing newline', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, '.gitignore'),
      'node_modules'
    );
    
    const result = await ensureGitignoreEntries(tempDir);
    
    assert.strictEqual(result, true, 'Should return true when adding entries');
    const content = await fs.promises.readFile(path.join(tempDir, '.gitignore'), 'utf8');
    // Should not have multiple blank lines
    assert.ok(!content.includes('\n\n\n'), 'Should not add excessive newlines');
    assert.ok(content.includes('.worktrees'), 'Should add .worktrees entry');
  });
  
  test('ignores comment lines when checking for duplicates', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, '.gitignore'),
      '# .worktrees is for temporary worktrees\nnode_modules\n'
    );
    
    const result = await ensureGitignoreEntries(tempDir);
    
    assert.strictEqual(result, true, 'Should return true when adding entries');
    const content = await fs.promises.readFile(path.join(tempDir, '.gitignore'), 'utf8');
    // Comment should be preserved and actual entry should be added
    assert.ok(content.includes('# .worktrees is for'), 'Should preserve comment');
    assert.ok(content.match(/^\.worktrees\/$/m), 'Should add actual .worktrees entry');
  });
  
  test('handles empty lines correctly', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, '.gitignore'),
      '\n\nnode_modules\n\n\n.env\n\n'
    );
    
    const result = await ensureGitignoreEntries(tempDir);
    
    assert.strictEqual(result, true, 'Should return true when adding entries');
    const content = await fs.promises.readFile(path.join(tempDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('.worktrees'), 'Should add .worktrees entry');
    assert.ok(content.includes('.orchestrator'), 'Should add .orchestrator entry');
  });
});
