/**
 * @fileoverview Extra unit tests for releasePreparation.ts covering
 * executeAIReview failure path (lines 334-336) and getOrCreateReleaseInstructions
 * with existing file (lines 408-415) and after auto-generation (lines 445-453).
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  executeTask,
  getOrCreateReleaseInstructions,
} from '../../../plan/releasePreparation';
import type { PreparationTask } from '../../../plan/types/releasePrep';
import type { ReleaseDefinition } from '../../../plan/types/release';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

let tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-prep-extra-'));
  tmpDirs.push(dir);
  return dir;
}

function makeMockRelease(overrides?: Partial<ReleaseDefinition>): ReleaseDefinition {
  return {
    id: 'rel-1', name: 'Test Release',
    flowType: 'from-plans', source: 'from-plans',
    planIds: ['plan-1'], releaseBranch: 'release/v1.0.0',
    targetBranch: 'main', repoPath: '/repo',
    status: 'drafting', stateHistory: [], createdAt: Date.now(),
    ...overrides,
  };
}

suite('releasePreparation - extra coverage', () => {
  let sandbox: sinon.SinonSandbox;
  let silence: ReturnType<typeof silenceConsole>;

  setup(() => {
    sandbox = sinon.createSandbox();
    silence = silenceConsole();
  });

  teardown(() => {
    sandbox.restore();
    silence.restore();
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    tmpDirs = [];
  });

  suite('executeTask - ai-review failure (lines 334-336)', () => {
    test('should handle ai-review failure and return pending status', async () => {
      const release = makeMockRelease();
      const task: PreparationTask = {
        id: 'ai-review',
        type: 'ai-review',
        title: 'AI Review',
        description: 'Quality review',
        status: 'pending',
        required: false,
        automatable: true,
      };

      const mockCopilot: any = {
        run: sinon.stub().resolves({
          success: false,
          error: 'AI agent failed to complete review',
          sessionId: 'test-session',
          metrics: { requestCount: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 100 },
        }),
        isAvailable: sinon.stub().returns(true),
      };

      const result = await executeTask(task, release, mockCopilot, '/repo');

      // Error path in executeAIReview: throws, caught by executeTask, returns pending
      assert.strictEqual(result.status, 'pending');
      assert.ok(result.error, 'Should have an error message');
      assert.ok(result.error!.includes('AI review failed') || result.error!.includes('agent failed'), 
        `Error message should mention failure: ${result.error}`);
    });

    test('should handle run-checks failure (lines 305-307)', async () => {
      const dir = makeTmpDir();
      // Create package.json so the check proceeds to run
      fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"test"}');

      const release = makeMockRelease({ repoPath: dir });
      const task: PreparationTask = {
        id: 'run-checks',
        type: 'run-checks',
        title: 'Run Checks',
        description: 'Build and test',
        status: 'pending',
        required: true,
        automatable: true,
      };

      const mockCopilot: any = {
        run: sinon.stub().resolves({
          success: false,
          error: 'Tests failed',
          sessionId: 'test',
          metrics: { requestCount: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 500 },
        }),
        isAvailable: sinon.stub().returns(true),
      };

      const result = await executeTask(task, release, mockCopilot, dir);
      assert.strictEqual(result.status, 'pending');
      assert.ok(result.error?.includes('Checks failed') || result.error?.includes('Tests failed'));
    });
  });

  suite('getOrCreateReleaseInstructions - with existing file (lines 408-415)', () => {
    test('should return existing instructions when file already exists', async () => {
      const dir = makeTmpDir();
      const instructionsDir = path.join(dir, '.github', 'instructions');
      fs.mkdirSync(instructionsDir, { recursive: true });
      const instructionsPath = path.join(instructionsDir, 'release.instructions.md');
      const content = '# Release Instructions\n\nFollow these steps for release.';
      fs.writeFileSync(instructionsPath, content, 'utf-8');

      const mockCopilot: any = {
        run: sinon.stub().resolves({ success: true, sessionId: 'test', metrics: {} }),
        isAvailable: sinon.stub().returns(true),
      };

      const result = await getOrCreateReleaseInstructions(dir, mockCopilot);

      assert.strictEqual(result.filePath, instructionsPath);
      assert.strictEqual(result.content, content);
      assert.strictEqual(result.source, 'existing');
      // Copilot should NOT be called when file already exists
      assert.ok(mockCopilot.run.notCalled, 'Copilot should not run if file exists');
    });

    test('should return existing instructions for different content', async () => {
      const dir = makeTmpDir();
      const instructionsDir = path.join(dir, '.github', 'instructions');
      fs.mkdirSync(instructionsDir, { recursive: true });
      const instructionsPath = path.join(instructionsDir, 'release.instructions.md');
      const content = '---\napplyTo: "releases"\n---\n# Custom Release Process';
      fs.writeFileSync(instructionsPath, content, 'utf-8');

      const mockCopilot: any = {
        run: sinon.stub().resolves({ success: true }),
        isAvailable: sinon.stub().returns(true),
      };

      const result = await getOrCreateReleaseInstructions(dir, mockCopilot);
      assert.strictEqual(result.source, 'existing');
      assert.strictEqual(result.content, content);
    });
  });

  suite('getOrCreateReleaseInstructions - after auto-generation (lines 445-453)', () => {
    test('should return auto-generated instructions when copilot creates the file', async () => {
      const dir = makeTmpDir();
      const instructionsDir = path.join(dir, '.github', 'instructions');
      const instructionsPath = path.join(instructionsDir, 'release.instructions.md');
      const generatedContent = '# Generated Release Instructions\n\nAuto-generated by Copilot.';

      // File doesn't exist initially - copilot will create it
      const mockCopilot: any = {
        run: sinon.stub().callsFake(async () => {
          // Simulate copilot creating the file
          fs.mkdirSync(instructionsDir, { recursive: true });
          fs.writeFileSync(instructionsPath, generatedContent, 'utf-8');
          return {
            success: true,
            sessionId: 'gen-session',
            metrics: { requestCount: 1, inputTokens: 200, outputTokens: 500, costUsd: 0.02, durationMs: 3000 },
          };
        }),
        isAvailable: sinon.stub().returns(true),
      };

      const result = await getOrCreateReleaseInstructions(dir, mockCopilot);

      assert.strictEqual(result.filePath, instructionsPath);
      assert.strictEqual(result.content, generatedContent);
      assert.strictEqual(result.source, 'auto-generated');
      assert.ok(mockCopilot.run.calledOnce, 'Copilot should be called to generate the file');
    });

    test('should throw when copilot does not create the file', async () => {
      const dir = makeTmpDir();
      // No file created - neither before nor after copilot runs

      const mockCopilot: any = {
        run: sinon.stub().resolves({
          success: true,
          sessionId: 'test',
          metrics: { requestCount: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 100 },
        }),
        isAvailable: sinon.stub().returns(true),
      };

      await assert.rejects(
        async () => getOrCreateReleaseInstructions(dir, mockCopilot),
        (err: any) => {
          assert.ok(
            err.message.includes('not created') || err.message.includes('instructions'),
            `Expected error about file not created, got: ${err.message}`
          );
          return true;
        }
      );
    });

    test('should throw when copilot run fails', async () => {
      const dir = makeTmpDir();

      const mockCopilot: any = {
        run: sinon.stub().resolves({
          success: false,
          error: 'Copilot unavailable',
          sessionId: 'test',
          metrics: {},
        }),
        isAvailable: sinon.stub().returns(true),
      };

      await assert.rejects(
        async () => getOrCreateReleaseInstructions(dir, mockCopilot),
        (err: any) => {
          assert.ok(
            err.message.includes('Failed to generate') || err.message.includes('Copilot'),
            `Expected failure error, got: ${err.message}`
          );
          return true;
        }
      );
    });
  });
});
