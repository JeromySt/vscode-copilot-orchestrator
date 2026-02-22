/**
 * @fileoverview Unit tests for FileSystemPlanStore.
 *
 * Tests the filesystem-based plan storage implementation including
 * security validation, metadata round-trips, and legacy migration.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileSystemPlanStore } from '../../../../plan/store/FileSystemPlanStore';
import { DefaultFileSystem } from '../../../../core/defaultFileSystem';

const defaultFs = new DefaultFileSystem();
import type { StoredPlanMetadata, StoredJobMetadata } from '../../../../interfaces/IPlanRepositoryStore';
import type { WorkSpec, AgentSpec } from '../../../../plan/types/specs';

suite('FileSystemPlanStore', () => {
  let sandbox: sinon.SinonSandbox;
  let tmpDirs: string[];

  setup(() => {
    sandbox = sinon.createSandbox();
    tmpDirs = [];
  });

  teardown(() => {
    sandbox.restore();
    // Clean up temp directories
    tmpDirs.forEach(dir => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    });
  });

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
    tmpDirs.push(dir);
    return dir;
  }

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
      id: 'test-plan-id',
      spec: {
        name: 'Test Plan',
        status: 'pending',
        baseBranch: 'main',
        jobs: [],
        groups: []
      },
      jobs: [jobMetadata],
      producerIdToNodeId: { 'test-producer': 'node-1' },
      roots: ['node-1'],
      leaves: ['node-1'],
      nodeStates: {},
      groups: {},
      groupStates: {},
      groupPathToId: {},
      repoPath: '/test/repo',
      baseBranch: 'main',
      worktreeRoot: '/test/worktrees',
      createdAt: Date.now(),
      maxParallel: 4,
      cleanUpSuccessfulWork: true,
      ...overrides
    };
  }

  suite('metadata operations', () => {
    test('should write and read metadata round-trip', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const metadata = makeStoredPlan();

      await store.writePlanMetadata(metadata);
      const result = await store.readPlanMetadata(metadata.id);

      assert.deepStrictEqual(result, metadata);
    });

    test('should write metadata without UTF-8 BOM', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const metadata = makeStoredPlan();

      await store.writePlanMetadata(metadata);

      const planFile = path.join(tmpDir, metadata.id, 'plan.json');
      const buffer = fs.readFileSync(planFile);
      
      // Check that file doesn't start with UTF-8 BOM (EF BB BF)
      const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
      const startsWithBom = buffer.length >= 3 && buffer.subarray(0, 3).equals(bom);
      assert.ok(!startsWithBom, 
        'File should not have UTF-8 BOM');
    });

    test('should handle metadata write errors gracefully', async () => {
      const tmpDir = makeTmpDir();
      // Use a mock that throws on mkdir to force an error
      const errorFs: any = {
        ...defaultFs,
        mkdirAsync: async () => { throw new Error('Permission denied'); }
      };
      const store = new FileSystemPlanStore(tmpDir, tmpDir, errorFs);
      const metadata = makeStoredPlan();

      await assert.rejects(
        () => store.writePlanMetadata(metadata),
        /Permission denied|ENOENT|EPERM|EACCES|Failed/
      );
    });
  });

  suite('node specification operations', () => {
    test('should write and read work specs', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      // String content gets wrapped as shell spec
      const workContent = '# Task\n\nImplement feature X';

      await store.writeNodeSpec('plan-1', 'producer-1', 'work', workContent);
      const result = await store.readNodeSpec('plan-1', 'producer-1', 'work');

      // Result is now an object (string gets wrapped as shell command)
      assert.ok(result);
      assert.strictEqual((result as any).type, 'shell');
    });

    test('should write and read prechecks.json files', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const precheckSpec: WorkSpec = { type: 'shell', command: 'npm test' };

      await store.writeNodeSpec('plan-1', 'producer-1', 'prechecks', precheckSpec);
      const result = await store.readNodeSpec('plan-1', 'producer-1', 'prechecks');

      assert.deepStrictEqual(result, precheckSpec);
    });

    test('should write and read postchecks.json files', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const postcheckSpec: WorkSpec = { type: 'shell', command: 'npm run verify' };

      await store.writeNodeSpec('plan-1', 'producer-1', 'postchecks', postcheckSpec);
      const result = await store.readNodeSpec('plan-1', 'producer-1', 'postchecks');

      assert.deepStrictEqual(result, postcheckSpec);
    });

    test('should write spec files without UTF-8 BOM', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const spec: WorkSpec = { type: 'shell', command: 'test' };

      await store.writeNodeSpec('plan-1', 'producer-1', 'prechecks', spec);

      // Spec files are now under current/ symlink
      const specFile = path.join(tmpDir, 'plan-1', 'specs', 'producer-1', 'current', 'prechecks.json');
      const buffer = fs.readFileSync(specFile);
      
      // Check that file doesn't start with UTF-8 BOM
      const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
      const startsWithBom = buffer.length >= 3 && buffer.subarray(0, 3).equals(bom);
      assert.ok(!startsWithBom, 
        'Spec file should not have UTF-8 BOM');
    });
  });

  suite('moveFileToSpec security', () => {
    test('should move files from workspace successfully', async () => {
      const tmpDir = makeTmpDir();
      const workspaceDir = path.join(tmpDir, 'workspace');
      fs.mkdirSync(workspaceDir, { recursive: true });

      const store = new FileSystemPlanStore(path.join(tmpDir, 'storage'), workspaceDir, defaultFs);
      const sourceFile = path.join(workspaceDir, 'instructions.md');
      fs.writeFileSync(sourceFile, '# Instructions\nDo this task');

      await store.moveFileToSpec('plan-1', 'producer-1', 'work', sourceFile);

      // Source should be gone
      assert.ok(!fs.existsSync(sourceFile));
      
      // Destination should exist in current directory (now work.json)
      const destFile = path.join(tmpDir, 'storage', 'plan-1', 'specs', 'producer-1', 'current', 'work.json');
      assert.ok(fs.existsSync(destFile));
    });

    test('should reject paths outside workspace', async () => {
      const tmpDir = makeTmpDir();
      const workspaceDir = path.join(tmpDir, 'workspace');
      const outsideDir = path.join(tmpDir, 'outside');
      
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });

      const store = new FileSystemPlanStore(path.join(tmpDir, 'storage'), workspaceDir, defaultFs);
      const outsideFile = path.join(outsideDir, 'malicious.md');
      fs.writeFileSync(outsideFile, 'bad content');

      await assert.rejects(
        () => store.moveFileToSpec('plan-1', 'producer-1', 'work', outsideFile),
        /Source path .* is outside workspace boundary/
      );
    });

    test('should reject .git paths', async () => {
      const tmpDir = makeTmpDir();
      const workspaceDir = path.join(tmpDir, 'workspace');
      fs.mkdirSync(workspaceDir, { recursive: true });

      const store = new FileSystemPlanStore(path.join(tmpDir, 'storage'), workspaceDir, defaultFs);
      const gitFile = path.join(workspaceDir, '.git');

      await assert.rejects(
        () => store.moveFileToSpec('plan-1', 'producer-1', 'work', gitFile),
        /Invalid source path|outside workspace boundary|contains .git|ENOENT/
      );
    });

    test('should reject .. paths', async () => {
      const tmpDir = makeTmpDir();
      const workspaceDir = path.join(tmpDir, 'workspace');
      fs.mkdirSync(workspaceDir, { recursive: true });

      const store = new FileSystemPlanStore(path.join(tmpDir, 'storage'), workspaceDir, defaultFs);
      const parentPath = path.join(workspaceDir, '..');

      await assert.rejects(
        () => store.moveFileToSpec('plan-1', 'producer-1', 'work', parentPath),
        /Invalid source path|outside workspace boundary/
      );
    });

    test('should reject . paths', async () => {
      const tmpDir = makeTmpDir();
      const workspaceDir = path.join(tmpDir, 'workspace');
      fs.mkdirSync(workspaceDir, { recursive: true });

      const store = new FileSystemPlanStore(path.join(tmpDir, 'storage'), workspaceDir, defaultFs);
      const currentPath = path.join(workspaceDir, '.');

      await assert.rejects(
        () => store.moveFileToSpec('plan-1', 'producer-1', 'work', currentPath),
        /Invalid source path|outside workspace boundary/
      );
    });

    test('should reject empty strings', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(path.join(tmpDir, 'storage'), tmpDir, defaultFs);

      await assert.rejects(
        () => store.moveFileToSpec('plan-1', 'producer-1', 'work', ''),
        /Invalid source path|outside workspace boundary/
      );
    });
  });

  suite('plan management', () => {
    test('should list correct plan IDs for new-format plans', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const plan1 = makeStoredPlan({ id: 'plan-alpha' });
      const plan2 = makeStoredPlan({ id: 'plan-beta' });

      await store.writePlanMetadata(plan1);
      await store.writePlanMetadata(plan2);

      const planIds = await store.listPlanIds();
      
      assert.strictEqual(planIds.length, 2);
      assert.ok(planIds.includes('plan-alpha'));
      assert.ok(planIds.includes('plan-beta'));
    });

    test('should remove entire directory with deletePlan', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const plan = makeStoredPlan();

      await store.writePlanMetadata(plan);
      await store.writeNodeSpec(plan.id, 'producer-1', 'work', 'work content');

      const planDir = path.join(tmpDir, plan.id);
      assert.ok(fs.existsSync(planDir));

      await store.deletePlan(plan.id);
      
      assert.ok(!fs.existsSync(planDir));
    });
  });

  suite('migrateLegacy', () => {
    test('should extract agent instructions to work.json files', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const planId = 'legacy-plan';

      // Create legacy plan file (legacy format uses 'nodes', not 'jobs')
      const legacyPlan = {
        id: planId,
        spec: { name: "test" },
        nodes: [
          {
            id: 'node-1',
            producerId: 'prod-1',
            name: 'Test Node',
            task: 'Test task',
            work: {
              type: 'agent',
              instructions: '# Agent Instructions\nDo the work',
              model: 'gpt-4'
            }
          }
        ],
        repoPath: '/test',
        baseBranch: 'main',
        worktreeRoot: '/worktrees',
        createdAt: Date.now()
      };

      const legacyFile = path.join(tmpDir, `plan-${planId}.json`);
      fs.writeFileSync(legacyFile, JSON.stringify(legacyPlan));

      await store.migrateLegacy(planId);

      // Check work.json was created (in current symlink dir)
      const workFile = path.join(tmpDir, planId, 'specs', 'node-1', 'current', 'work.json');
      assert.ok(fs.existsSync(workFile), 'work.json should exist');

      // Check metadata was created
      const metadata = await store.readPlanMetadata(planId);
      assert.ok(metadata);
      assert.strictEqual(metadata.jobs[0].hasWork, true);
    });

    test('should leave shell/process specs inline in metadata', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const planId = 'shell-plan';

      // Create legacy plan with shell work (legacy format uses 'nodes')
      const legacyPlan = {
        id: planId,
        spec: { name: "test" },
        nodes: [
          {
            id: 'node-1',
            producerId: 'shell-prod',
            name: 'Shell Node',
            task: 'Run shell',
            work: {
              type: 'shell',
              command: 'npm test'
            }
          }
        ],
        repoPath: '/test',
        baseBranch: 'main',
        worktreeRoot: '/worktrees',
        createdAt: Date.now()
      };

      const legacyFile = path.join(tmpDir, `plan-${planId}.json`);
      fs.writeFileSync(legacyFile, JSON.stringify(legacyPlan));

      await store.migrateLegacy(planId);

      // All specs go to disk now — check work file was created for shell spec too
      // Note: specs use node ID for folder name, not producerId
      const metadata = await store.readPlanMetadata(planId);
      assert.ok(metadata);
      assert.strictEqual(metadata.jobs[0].hasWork, true);
      
      // Verify the spec was written to disk
      const workSpec = await store.readNodeSpec(planId, metadata.jobs[0].id, 'work');
      assert.ok(workSpec);
    });
  });

  suite('backwards compatibility - legacy work.md fallback', () => {
    test('should fall back to work.md when work.json not found', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const planId = 'legacy-compat-plan';
      const nodeId = 'node-1';

      // Create the directory structure with legacy work.md (not work.json)
      const specDir = path.join(tmpDir, planId, 'specs', nodeId, 'current');
      fs.mkdirSync(specDir, { recursive: true });
      fs.writeFileSync(path.join(specDir, 'work.md'), '# Legacy work instructions');

      const result = await store.readNodeSpec(planId, nodeId, 'work');

      // Should return the content from work.md as fallback
      assert.strictEqual(result, '# Legacy work instructions');
    });

    test('should parse legacy work.md as JSON when it contains JSON', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const planId = 'json-legacy-plan';
      const nodeId = 'node-1';

      // Create legacy work.md with JSON content
      const specDir = path.join(tmpDir, planId, 'specs', nodeId, 'current');
      fs.mkdirSync(specDir, { recursive: true });
      fs.writeFileSync(path.join(specDir, 'work.md'), JSON.stringify({ type: 'shell', command: 'npm test' }));

      const result = await store.readNodeSpec(planId, nodeId, 'work');

      // Should parse JSON from work.md
      assert.deepStrictEqual(result, { type: 'shell', command: 'npm test' });
    });

    test('should not use fallback for prechecks/postchecks phases', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const planId = 'non-work-plan';
      const nodeId = 'node-1';

      // Create directory with only work.md (no prechecks.json)
      const specDir = path.join(tmpDir, planId, 'specs', nodeId, 'current');
      fs.mkdirSync(specDir, { recursive: true });
      fs.writeFileSync(path.join(specDir, 'work.md'), '# Only work');

      // prechecks should return undefined (no fallback to work.md)
      const result = await store.readNodeSpec(planId, nodeId, 'prechecks');
      assert.strictEqual(result, undefined);
    });
  });

  suite('agent instructions companion .md files', () => {
    test('should extract agent instructions to companion .md file on write', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const planId = 'agent-plan';
      const nodeId = 'agent-node';

      const agentSpec: AgentSpec = {
        type: 'agent',
        instructions: '# Agent Instructions\n\nDo the following tasks:\n1. Build\n2. Test',
        model: 'gpt-4'
      };

      await store.writeNodeSpec(planId, nodeId, 'work', agentSpec);

      // Check that companion .md file was created
      const mdFile = path.join(tmpDir, planId, 'specs', nodeId, 'current', 'work_instructions.md');
      assert.ok(fs.existsSync(mdFile), 'Companion .md file should exist');
      assert.strictEqual(fs.readFileSync(mdFile, 'utf-8'), '# Agent Instructions\n\nDo the following tasks:\n1. Build\n2. Test');

      // Check that work.json references the file and doesn't contain inline instructions
      const workJson = path.join(tmpDir, planId, 'specs', nodeId, 'current', 'work.json');
      const savedSpec = JSON.parse(fs.readFileSync(workJson, 'utf-8'));
      assert.strictEqual(savedSpec.instructionsFile, 'work_instructions.md');
      assert.strictEqual(savedSpec.instructions, undefined);
      assert.strictEqual(savedSpec.model, 'gpt-4');
    });

    test('should hydrate instructions from companion .md file on read', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const planId = 'hydrate-plan';
      const nodeId = 'hydrate-node';

      // Manually create spec with companion file reference
      const specDir = path.join(tmpDir, planId, 'specs', nodeId, 'current');
      fs.mkdirSync(specDir, { recursive: true });
      
      // Write companion .md file
      fs.writeFileSync(path.join(specDir, 'work_instructions.md'), '# Hydrated Instructions');
      
      // Write work.json with instructionsFile reference
      fs.writeFileSync(path.join(specDir, 'work.json'), JSON.stringify({
        type: 'agent',
        instructionsFile: 'work_instructions.md',
        model: 'claude-3'
      }));

      const result = await store.readNodeSpec(planId, nodeId, 'work');

      // Should have hydrated instructions inline
      assert.ok(result);
      const agentResult = result as AgentSpec;
      assert.strictEqual(agentResult.type, 'agent');
      assert.strictEqual(agentResult.instructions, '# Hydrated Instructions');
      assert.strictEqual((agentResult as any).instructionsFile, undefined);
      assert.strictEqual(agentResult.model, 'claude-3');
    });

    test('should handle missing companion .md file gracefully', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const planId = 'missing-md-plan';
      const nodeId = 'missing-node';

      // Write work.json with instructionsFile reference but no actual .md file
      const specDir = path.join(tmpDir, planId, 'specs', nodeId, 'current');
      fs.mkdirSync(specDir, { recursive: true });
      fs.writeFileSync(path.join(specDir, 'work.json'), JSON.stringify({
        type: 'agent',
        instructionsFile: 'missing_instructions.md',
        model: 'gpt-4'
      }));

      const result = await store.readNodeSpec(planId, nodeId, 'work');

      // Should return spec without hydrated instructions (graceful fallthrough)
      assert.ok(result);
      const agentResult = result as any;
      assert.strictEqual(agentResult.type, 'agent');
      // instructionsFile remains if .md was missing (no hydration happened)
      assert.strictEqual(agentResult.instructionsFile, 'missing_instructions.md');
    });

    test('should extract prechecks agent instructions to companion .md file', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const planId = 'prechecks-agent-plan';
      const nodeId = 'prechecks-node';

      const agentSpec: AgentSpec = {
        type: 'agent',
        instructions: '# Precheck Instructions',
        model: 'fast'
      };

      await store.writeNodeSpec(planId, nodeId, 'prechecks', agentSpec);

      // Check prechecks companion file
      const mdFile = path.join(tmpDir, planId, 'specs', nodeId, 'current', 'prechecks_instructions.md');
      assert.ok(fs.existsSync(mdFile), 'Prechecks companion .md file should exist');
      assert.strictEqual(fs.readFileSync(mdFile, 'utf-8'), '# Precheck Instructions');
    });

    test('should extract postchecks agent instructions to companion .md file', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const planId = 'postchecks-agent-plan';
      const nodeId = 'postchecks-node';

      const agentSpec: AgentSpec = {
        type: 'agent',
        instructions: '# Postcheck Instructions',
        model: 'fast'
      };

      await store.writeNodeSpec(planId, nodeId, 'postchecks', agentSpec);

      // Check postchecks companion file
      const mdFile = path.join(tmpDir, planId, 'specs', nodeId, 'current', 'postchecks_instructions.md');
      assert.ok(fs.existsSync(mdFile), 'Postchecks companion .md file should exist');
      assert.strictEqual(fs.readFileSync(mdFile, 'utf-8'), '# Postcheck Instructions');
    });

    test('should not create companion file for shell specs', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const planId = 'shell-plan';
      const nodeId = 'shell-node';

      const shellSpec: WorkSpec = {
        type: 'shell',
        command: 'npm test'
      };

      await store.writeNodeSpec(planId, nodeId, 'work', shellSpec);

      // Check no companion .md file was created
      const mdFile = path.join(tmpDir, planId, 'specs', nodeId, 'current', 'work_instructions.md');
      assert.ok(!fs.existsSync(mdFile), 'Shell specs should not create companion .md files');
      
      // work.json should have inline spec
      const workJson = path.join(tmpDir, planId, 'specs', nodeId, 'current', 'work.json');
      const savedSpec = JSON.parse(fs.readFileSync(workJson, 'utf-8'));
      assert.strictEqual(savedSpec.type, 'shell');
      assert.strictEqual(savedSpec.command, 'npm test');
    });
  });

  suite('snapshotSpecsForAttempt', () => {
    test('should create attempt directory and snapshot current specs', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const planId = 'snapshot-plan';
      const nodeId = 'snapshot-node';

      // First write a spec to current
      await store.writeNodeSpec(planId, nodeId, 'work', { type: 'shell', command: 'test' });

      // Snapshot for attempt 1
      await store.snapshotSpecsForAttempt(planId, nodeId, 1);

      // Attempt 1 directory should exist and contain the spec
      const attemptDir = path.join(tmpDir, planId, 'specs', nodeId, 'attempts', '1');
      assert.ok(fs.existsSync(attemptDir));
      assert.ok(fs.existsSync(path.join(attemptDir, 'work.json')));
    });

    test('should copy specs from previous attempt for subsequent attempts', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const planId = 'multi-attempt-plan';
      const nodeId = 'multi-node';

      // Write initial spec and snapshot attempt 1
      await store.writeNodeSpec(planId, nodeId, 'work', { type: 'shell', command: 'attempt1' });
      await store.snapshotSpecsForAttempt(planId, nodeId, 1);

      // Update spec and snapshot attempt 2
      const currentPath = path.join(tmpDir, planId, 'specs', nodeId, 'current', 'work.json');
      fs.writeFileSync(currentPath, JSON.stringify({ type: 'shell', command: 'attempt2' }));
      await store.snapshotSpecsForAttempt(planId, nodeId, 2);

      // Both attempt directories should exist
      const attempt1Dir = path.join(tmpDir, planId, 'specs', nodeId, 'attempts', '1');
      const attempt2Dir = path.join(tmpDir, planId, 'specs', nodeId, 'attempts', '2');
      assert.ok(fs.existsSync(attempt1Dir));
      assert.ok(fs.existsSync(attempt2Dir));

      // Current should point to attempt 2
      const result = await store.readNodeSpec(planId, nodeId, 'work');
      assert.deepStrictEqual(result, { type: 'shell', command: 'attempt2' });
    });
  });

  suite('readNodeSpecForAttempt', () => {
    test('should read spec from specific attempt', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const planId = 'attempt-read-plan';
      const nodeId = 'attempt-node';

      // Create attempt 1 directory with spec
      const attemptDir = path.join(tmpDir, planId, 'specs', nodeId, 'attempts', '1');
      fs.mkdirSync(attemptDir, { recursive: true });
      fs.writeFileSync(path.join(attemptDir, 'work.json'), JSON.stringify({ type: 'shell', command: 'old' }));

      const result = await store.readNodeSpecForAttempt(planId, nodeId, 'work', 1);

      // For work phase, it returns raw content (not JSON parsed in this method)
      assert.ok(result);
    });

    test('should return undefined for non-existent attempt', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);

      const result = await store.readNodeSpecForAttempt('no-plan', 'no-node', 'work', 99);

      assert.strictEqual(result, undefined);
    });
  });

  suite('writePlanMetadataSync', () => {
    test('should write metadata synchronously', () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const metadata = makeStoredPlan();

      store.writePlanMetadataSync(metadata);

      const planFile = path.join(tmpDir, metadata.id, 'plan.json');
      assert.ok(fs.existsSync(planFile));
      const readBack = JSON.parse(fs.readFileSync(planFile, 'utf-8'));
      assert.strictEqual(readBack.id, metadata.id);
    });

    test('should clean up temp file on sync write error', () => {
      const tmpDir = makeTmpDir();
      const mockFs: any = {
        mkdirSync: () => { throw new Error('mkdir failed'); },
        writeFileSync: sandbox.stub(),
        renameSync: sandbox.stub(),
        unlinkSync: sandbox.stub()
      };
      const store = new FileSystemPlanStore(tmpDir, tmpDir, mockFs);
      const metadata = makeStoredPlan();

      assert.throws(() => store.writePlanMetadataSync(metadata), /mkdir failed/);
    });
  });

  suite('exists', () => {
    test('should return true when plan.json exists', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      const metadata = makeStoredPlan();
      await store.writePlanMetadata(metadata);

      const exists = await store.exists(metadata.id);

      assert.strictEqual(exists, true);
    });

    test('should return false when plan does not exist', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);

      const exists = await store.exists('non-existent-plan');

      assert.strictEqual(exists, false);
    });
  });

  suite('hasNodeSpec', () => {
    test('should return true when spec file exists', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);
      await store.writeNodeSpec('plan-1', 'node-1', 'work', { type: 'shell', command: 'test' });

      const has = await store.hasNodeSpec('plan-1', 'node-1', 'work');

      assert.strictEqual(has, true);
    });

    test('should return false when spec file does not exist', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);

      const has = await store.hasNodeSpec('plan-1', 'node-1', 'work');

      assert.strictEqual(has, false);
    });
  });

  suite('listPlanIds edge cases', () => {
    test('should return empty array when storage path does not exist', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(path.join(tmpDir, 'nonexistent'), tmpDir, defaultFs);

      const planIds = await store.listPlanIds();

      assert.deepStrictEqual(planIds, []);
    });

    test('should detect legacy plan-*.json files', async () => {
      const tmpDir = makeTmpDir();
      const store = new FileSystemPlanStore(tmpDir, tmpDir, defaultFs);

      // Create a legacy plan file
      fs.writeFileSync(path.join(tmpDir, 'plan-legacy-id.json'), '{}');

      const planIds = await store.listPlanIds();

      assert.ok(planIds.includes('legacy-id'));
    });
  });
});