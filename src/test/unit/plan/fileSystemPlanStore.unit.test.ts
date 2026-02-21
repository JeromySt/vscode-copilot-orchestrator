/**
 * @fileoverview Unit tests for FileSystemPlanStore.
 *
 * Uses real temporary directories to test the actual filesystem
 * code paths and verify the plan storage interface implementation.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileSystemPlanStore } from '../../../plan/store/FileSystemPlanStore';
import { DefaultFileSystem } from '../../../core/defaultFileSystem';
import type { StoredPlanMetadata, StoredJobMetadata } from '../../../interfaces/IPlanRepositoryStore';
import type { WorkSpec, AgentSpec } from '../../../plan/types/specs';

const defaultFs = new DefaultFileSystem();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

/** Create a fresh temp directory for one test and track it for cleanup. */
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filesystem-plan-store-test-'));
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

/** Build a minimal valid StoredPlanMetadata for testing. */
function makeStoredPlan(overrides: Partial<StoredPlanMetadata> = {}): StoredPlanMetadata {
  const jobMetadata: StoredJobMetadata = {
    id: 'node-1',
    producerId: 'test-producer',
    name: 'Test Node',
    task: 'Test task',
    dependencies: [],
    hasWork: false,
    hasPrechecks: false,
    hasPostchecks: false,
  };

  return {
    id: 'test-plan-123',
    spec: { version: '1.0' },
    jobs: [jobMetadata],
    producerIdToNodeId: { 'test-producer': 'node-1' },
    roots: ['node-1'],
    leaves: ['node-1'],
    nodeStates: { 'node-1': { status: 'pending', version: 1, attempts: 0 } },
    repoPath: '/tmp/test-repo',
    baseBranch: 'main',
    targetBranch: 'feature-branch',
    worktreeRoot: '/tmp/test-worktree',
    createdAt: Date.now(),
    cleanUpSuccessfulWork: true,
    maxParallel: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

suite('FileSystemPlanStore', () => {
  
  teardown(() => {
    // Clean up temp dirs after each test
    tmpDirs.forEach(rmrf);
    tmpDirs = [];
  });

  test('constructor should initialize with storage and workspace paths', () => {
    const storagePath = '/tmp/storage';
    const workspacePath = '/tmp/workspace';
    const store = new FileSystemPlanStore(storagePath, workspacePath, defaultFs);
    assert.ok(store);
  });

  test('writePlanMetadata and readPlanMetadata should work correctly', async () => {
    const tmpDir = makeTmpDir();
    const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
    const metadata = makeStoredPlan();

    // Write metadata
    await store.writePlanMetadata(metadata);

    // Verify file exists
    const planFile = path.join(tmpDir, metadata.id, 'plan.json');
    assert.ok(fs.existsSync(planFile), 'Plan file should exist');

    // Read metadata back
    const readMetadata = await store.readPlanMetadata(metadata.id);
    assert.deepStrictEqual(readMetadata, metadata);
  });

  test('writePlanMetadataSync should work correctly', () => {
    const tmpDir = makeTmpDir();
    const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
    const metadata = makeStoredPlan();

    // Write metadata synchronously
    store.writePlanMetadataSync(metadata);

    // Verify file exists
    const planFile = path.join(tmpDir, metadata.id, 'plan.json');
    assert.ok(fs.existsSync(planFile), 'Plan file should exist');

    // Verify content
    const content = fs.readFileSync(planFile, 'utf-8');
    const readMetadata = JSON.parse(content);
    assert.deepStrictEqual(readMetadata, metadata);
  });

  test('readPlanMetadata should return undefined for non-existent plan', async () => {
    const tmpDir = makeTmpDir();
    const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);

    const result = await store.readPlanMetadata('non-existent-plan');
    assert.strictEqual(result, undefined);
  });

  test('writeNodeSpec and readNodeSpec should work for work specs', async () => {
    const tmpDir = makeTmpDir();
    const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
    const planId = 'test-plan';
    const producerId = 'test-producer';
    const workSpec = '# Task Description\n\nImplement feature X';

    // Write work spec (stored as shell spec when string is passed)
    await store.writeNodeSpec(planId, producerId, 'work', workSpec);

    // Verify file exists (now work.json, not work.md)
    const specDir = path.join(tmpDir, planId, 'specs', producerId, 'current');
    const specFile = path.join(specDir, 'work.json');
    assert.ok(fs.existsSync(specFile), 'Work spec file should exist');

    // Read spec back - now returns parsed object
    const readSpec = await store.readNodeSpec(planId, producerId, 'work');
    assert.ok(readSpec);
  });

  test('writeNodeSpec and readNodeSpec should work for JSON specs', async () => {
    const tmpDir = makeTmpDir();
    const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
    const planId = 'test-plan';
    const producerId = 'test-producer';
    const precheckSpec: WorkSpec = {
      type: 'shell',
      command: 'npm test',
    };

    // Write precheck spec
    await store.writeNodeSpec(planId, producerId, 'prechecks', precheckSpec);

    // Verify file exists in current symlink/junction path
    const specDir = path.join(tmpDir, planId, 'specs', producerId, 'current');
    const specFile = path.join(specDir, 'prechecks.json');
    assert.ok(fs.existsSync(specFile), 'Precheck spec file should exist');

    // Read spec back
    const readSpec = await store.readNodeSpec(planId, producerId, 'prechecks');
    assert.deepStrictEqual(readSpec, precheckSpec);
  });

  test('hasNodeSpec should work correctly', async () => {
    const tmpDir = makeTmpDir();
    const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
    const planId = 'test-plan';
    const producerId = 'test-producer';

    // Should return false for non-existent spec
    let hasSpec = await store.hasNodeSpec(planId, producerId, 'work');
    assert.strictEqual(hasSpec, false);

    // Write a spec
    await store.writeNodeSpec(planId, producerId, 'work', 'some work');

    // Should return true now
    hasSpec = await store.hasNodeSpec(planId, producerId, 'work');
    assert.strictEqual(hasSpec, true);
  });

  test('exists should work correctly', async () => {
    const tmpDir = makeTmpDir();
    const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
    const metadata = makeStoredPlan();

    // Should return false for non-existent plan
    let exists = await store.exists(metadata.id);
    assert.strictEqual(exists, false);

    // Write metadata
    await store.writePlanMetadata(metadata);

    // Should return true now
    exists = await store.exists(metadata.id);
    assert.strictEqual(exists, true);
  });

  test('listPlanIds should work for new format plans', async () => {
    const tmpDir = makeTmpDir();
    const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
    const plan1 = makeStoredPlan({ id: 'plan-1' });
    const plan2 = makeStoredPlan({ id: 'plan-2' });

    // Write two plans
    await store.writePlanMetadata(plan1);
    await store.writePlanMetadata(plan2);

    // List plans
    const planIds = await store.listPlanIds();
    assert.strictEqual(planIds.length, 2);
    assert.ok(planIds.includes('plan-1'));
    assert.ok(planIds.includes('plan-2'));
  });

  test('listPlanIds should work for legacy format plans', async () => {
    const tmpDir = makeTmpDir();
    const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);

    // Create legacy plan files
    fs.writeFileSync(path.join(tmpDir, 'plan-legacy-1.json'), '{"id":"legacy-1"}');
    fs.writeFileSync(path.join(tmpDir, 'plan-legacy-2.json'), '{"id":"legacy-2"}');

    // List plans
    const planIds = await store.listPlanIds();
    assert.strictEqual(planIds.length, 2);
    assert.ok(planIds.includes('legacy-1'));
    assert.ok(planIds.includes('legacy-2'));
  });

  test('deletePlan should remove plan directory', async () => {
    const tmpDir = makeTmpDir();
    const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
    const metadata = makeStoredPlan();

    // Write metadata and spec
    await store.writePlanMetadata(metadata);
    await store.writeNodeSpec(metadata.id, 'test-producer', 'work', 'test work');

    // Verify files exist
    const planDir = path.join(tmpDir, metadata.id);
    assert.ok(fs.existsSync(planDir));

    // Delete plan
    await store.deletePlan(metadata.id);

    // Verify directory is gone
    assert.ok(!fs.existsSync(planDir));
  });

  test('moveFileToSpec should move files with security validation', async () => {
    const tmpDir = makeTmpDir();
    const workspaceDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    
    const store = new FileSystemPlanStore(path.join(tmpDir, 'storage'), workspaceDir, defaultFs);
    
    // Create a source file in workspace
    const sourceFile = path.join(workspaceDir, 'test-spec.md');
    fs.writeFileSync(sourceFile, '# Test Instructions');

    // Move file to spec
    await store.moveFileToSpec('test-plan', 'test-producer', 'work', sourceFile);

    // Verify file was moved
    assert.ok(!fs.existsSync(sourceFile), 'Source file should be gone');
    
    // Now stored as work.json in current directory
    const destFile = path.join(tmpDir, 'storage', 'test-plan', 'specs', 'test-producer', 'current', 'work.json');
    assert.ok(fs.existsSync(destFile), 'Destination file should exist');
  });

  test('moveFileToSpec should reject paths outside workspace', async () => {
    const tmpDir = makeTmpDir();
    const workspaceDir = path.join(tmpDir, 'workspace');
    const outsideDir = path.join(tmpDir, 'outside');
    
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    
    const store = new FileSystemPlanStore(path.join(tmpDir, 'storage'), workspaceDir, defaultFs);
    
    // Create file outside workspace
    const outsideFile = path.join(outsideDir, 'malicious.md');
    fs.writeFileSync(outsideFile, 'malicious content');

    // Should throw error
    await assert.rejects(
      async () => store.moveFileToSpec('test-plan', 'test-producer', 'work', outsideFile),
      /Source path .* is outside workspace boundary/
    );
  });

  test('moveFileToSpec should reject dangerous paths', async () => {
    const tmpDir = makeTmpDir();
    const workspaceDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    
    const store = new FileSystemPlanStore(path.join(tmpDir, 'storage'), workspaceDir, defaultFs);

    // Test various dangerous paths
    const dangerousPaths = [
      path.join(workspaceDir, '..', 'outside.txt'),
      path.join(workspaceDir, '.git', 'config'),
      workspaceDir, // Directory itself
    ];

    for (const dangerousPath of dangerousPaths) {
      await assert.rejects(
        async () => store.moveFileToSpec('test-plan', 'test-producer', 'work', dangerousPath),
        /Invalid source path|outside workspace boundary|contains .git|ENOENT|EISDIR/
      );
    }
  });

});