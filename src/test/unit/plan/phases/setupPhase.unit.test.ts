/**
 * @fileoverview Unit tests for SetupPhaseExecutor
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SetupPhaseExecutor, buildSkillContent, ORCHESTRATOR_SKILL_DIR, ORCHESTRATOR_SKILL_PATH } from '../../../../plan/phases/setupPhase';
import type { PhaseContext } from '../../../../interfaces/IPhaseExecutor';
import type { JobNode } from '../../../../plan/types';

let tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-test-'));
  tmpDirs.push(dir);
  return dir;
}

function createMockNode(overrides: Partial<JobNode> = {}): JobNode {
  return {
    id: 'test-node', producerId: 'test-node', name: 'Test Node', type: 'job',
    task: 'test task', work: { type: 'shell', command: 'echo test' },
    dependencies: [], dependents: [],
    ...overrides,
  };
}

function createMockContext(overrides: Partial<PhaseContext> = {}): PhaseContext {
  return {
    node: createMockNode(),
    worktreePath: makeTmpDir(),
    executionKey: 'test:node:1',
    phase: 'setup',
    logInfo: sinon.stub(),
    logError: sinon.stub(),
    logOutput: sinon.stub(),
    isAborted: () => false,
    setProcess: sinon.stub(),
    setStartTime: sinon.stub(),
    setIsAgentWork: sinon.stub(),
    ...overrides,
  };
}

suite('SetupPhaseExecutor', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => {
    sandbox.restore();
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs = [];
  });

  suite('execute', () => {
    test('creates SKILL.md in worktree with default config', async () => {
      const ctx = createMockContext();
      const executor = new SetupPhaseExecutor({});

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, true);
      const skillPath = path.join(ctx.worktreePath, ORCHESTRATOR_SKILL_PATH);
      assert.ok(fs.existsSync(skillPath), 'SKILL.md should exist');
      const content = fs.readFileSync(skillPath, 'utf-8');
      assert.ok(content.includes('name: orchestrator-context'));
      assert.ok(content.includes('**Job:** Test Node'));
      assert.ok(content.includes('**Task:** test task'));
      assert.ok(content.includes('**Node ID:** test-node'));
      assert.ok(content.includes('**Worktree Path:**'), 'Should include worktree path by default');
    });

    test('creates SKILL.md directory structure recursively', async () => {
      const ctx = createMockContext();
      const executor = new SetupPhaseExecutor({});

      await executor.execute(ctx);

      const skillDir = path.join(ctx.worktreePath, ORCHESTRATOR_SKILL_DIR);
      assert.ok(fs.existsSync(skillDir), 'skill directory should be created');
    });

    test('omits worktree path when projectWorktreeContext is false', async () => {
      const ctx = createMockContext();
      const configManager = {
        getConfig: sandbox.stub().returns(false),
      };
      const executor = new SetupPhaseExecutor({ configManager });

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, true);
      const skillPath = path.join(ctx.worktreePath, ORCHESTRATOR_SKILL_PATH);
      const content = fs.readFileSync(skillPath, 'utf-8');
      assert.ok(!content.includes('**Worktree Path:**'), 'Should not include worktree path');
      assert.ok(configManager.getConfig.calledWith(
        'copilotOrchestrator.setup',
        'projectWorktreeContext',
        true,
      ));
    });

    test('includes worktree path when projectWorktreeContext is true', async () => {
      const ctx = createMockContext();
      const configManager = {
        getConfig: sandbox.stub().returns(true),
      };
      const executor = new SetupPhaseExecutor({ configManager });

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, true);
      const skillPath = path.join(ctx.worktreePath, ORCHESTRATOR_SKILL_PATH);
      const content = fs.readFileSync(skillPath, 'utf-8');
      assert.ok(content.includes('**Worktree Path:**'));
    });

    test('defaults to true when configManager is undefined', async () => {
      const ctx = createMockContext();
      const executor = new SetupPhaseExecutor({});

      await executor.execute(ctx);

      const skillPath = path.join(ctx.worktreePath, ORCHESTRATOR_SKILL_PATH);
      const content = fs.readFileSync(skillPath, 'utf-8');
      assert.ok(content.includes('**Worktree Path:**'), 'Should default to including worktree path');
    });

    test('logs info messages during execution', async () => {
      const ctx = createMockContext();
      const executor = new SetupPhaseExecutor({});

      await executor.execute(ctx);

      const logInfo = ctx.logInfo as sinon.SinonStub;
      assert.ok(logInfo.calledWithMatch(/Writing projected orchestrator skill/));
      assert.ok(logInfo.calledWith('Setup phase complete'));
    });

    test('returns error on filesystem failure', async () => {
      const ctx = createMockContext();
      // Use a path that will fail (read-only or invalid)
      ctx.worktreePath = path.join(ctx.worktreePath, '\0invalid');
      const executor = new SetupPhaseExecutor({});

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
      const logError = ctx.logError as sinon.SinonStub;
      assert.ok(logError.called, 'Should log an error');
    });

    test('overwrites existing SKILL.md', async () => {
      const ctx = createMockContext();
      const skillDir = path.join(ctx.worktreePath, ORCHESTRATOR_SKILL_DIR);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(ctx.worktreePath, ORCHESTRATOR_SKILL_PATH), 'old content', 'utf-8');

      const executor = new SetupPhaseExecutor({});
      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, true);
      const content = fs.readFileSync(path.join(ctx.worktreePath, ORCHESTRATOR_SKILL_PATH), 'utf-8');
      assert.ok(content.includes('orchestrator-context'), 'Should overwrite old content');
      assert.ok(!content.includes('old content'));
    });
  });

  suite('buildSkillContent', () => {
    test('includes YAML frontmatter', () => {
      const content = buildSkillContent({ id: 'n1', name: 'Node 1', task: 'Do stuff' }, '/wt', true);
      assert.ok(content.startsWith('---\n'));
      assert.ok(content.includes('name: orchestrator-context'));
      assert.ok(content.includes('description:'));
      assert.ok(content.includes('---\n\n'));
    });

    test('includes node metadata', () => {
      const content = buildSkillContent({ id: 'abc', name: 'My Node', task: 'My task' }, '/wt', true);
      assert.ok(content.includes('**Job:** My Node'));
      assert.ok(content.includes('**Task:** My task'));
      assert.ok(content.includes('**Node ID:** abc'));
    });

    test('includes worktree path when enabled', () => {
      const content = buildSkillContent({ id: 'n1', name: 'N', task: 'T' }, '/my/worktree', true);
      assert.ok(content.includes('**Worktree Path:** /my/worktree'));
    });

    test('excludes worktree path when disabled', () => {
      const content = buildSkillContent({ id: 'n1', name: 'N', task: 'T' }, '/my/worktree', false);
      assert.ok(!content.includes('**Worktree Path:**'));
      assert.ok(!content.includes('/my/worktree'));
    });
  });

  suite('constants', () => {
    test('ORCHESTRATOR_SKILL_DIR is under .github/skills', () => {
      assert.ok(ORCHESTRATOR_SKILL_DIR.includes('.github'));
      assert.ok(ORCHESTRATOR_SKILL_DIR.includes('skills'));
      assert.ok(ORCHESTRATOR_SKILL_DIR.includes('.orchestrator'));
    });

    test('ORCHESTRATOR_SKILL_PATH ends with SKILL.md', () => {
      assert.ok(ORCHESTRATOR_SKILL_PATH.endsWith('SKILL.md'));
    });
  });
});
