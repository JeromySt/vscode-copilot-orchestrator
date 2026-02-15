/**
 * @fileoverview Unit tests for instructionAugmenter.
 *
 * Tests cover:
 * - YAML frontmatter parsing
 * - Skill description discovery
 * - Prompt building
 * - Output parsing and validation
 * - Anti-recursion guard
 * - augmentInstructions end-to-end flow
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseYamlFrontmatter,
  readSkillDescriptions,
  buildAugmentationPrompt,
  parseAugmentedOutput,
  augmentInstructions,
} from '../../../agent/instructionAugmenter';
import type { AugmentableNode } from '../../../agent/instructionAugmenter';
import type { ICopilotRunner } from '../../../interfaces/ICopilotRunner';
import type { CopilotRunOptions, CopilotRunResult } from '../../../agent/copilotCliRunner';
import type { AgentSpec } from '../../../plan/types/specs';

// ============================================================================
// HELPERS
// ============================================================================

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'augmenter-test-'));
}

function createSkillFile(repoPath: string, skillName: string, frontmatter: string): void {
  const dir = path.join(repoPath, '.github', 'skills', skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), frontmatter, 'utf-8');
}

function makeNode(id: string, instructions: string, augment?: boolean): AugmentableNode {
  const work: AgentSpec = { type: 'agent', instructions };
  if (augment !== undefined) {
    work.augmentInstructions = augment;
  }
  return { id, work };
}

function makeMockRunner(output: string, success = true): ICopilotRunner {
  return {
    run: async (options: CopilotRunOptions): Promise<CopilotRunResult> => {
      // Emit output lines via onOutput callback
      if (options.onOutput) {
        for (const line of output.split('\n')) {
          options.onOutput(line);
        }
      }
      return { success };
    },
    isAvailable: () => true,
    writeInstructionsFile: () => ({ filePath: '', dirPath: '' }),
    buildCommand: () => '',
    cleanupInstructionsFile: () => {},
  };
}

// ============================================================================
// TESTS
// ============================================================================

suite('instructionAugmenter', () => {
  // ── parseYamlFrontmatter ───────────────────────────────────────────
  suite('parseYamlFrontmatter', () => {
    test('parses basic frontmatter', () => {
      const content = `---
name: test-skill
description: A test skill
---
# Body`;
      const result = parseYamlFrontmatter(content);
      assert.strictEqual(result.name, 'test-skill');
      assert.strictEqual(result.description, 'A test skill');
    });

    test('strips surrounding quotes', () => {
      const content = `---
name: "quoted-name"
description: 'single quoted'
---`;
      const result = parseYamlFrontmatter(content);
      assert.strictEqual(result.name, 'quoted-name');
      assert.strictEqual(result.description, 'single quoted');
    });

    test('returns empty for no frontmatter', () => {
      const result = parseYamlFrontmatter('# Just a heading');
      assert.deepStrictEqual(result, {});
    });

    test('returns empty for unclosed frontmatter', () => {
      const result = parseYamlFrontmatter('---\nname: foo\n');
      assert.deepStrictEqual(result, {});
    });

    test('handles empty frontmatter', () => {
      const result = parseYamlFrontmatter('---\n---\n# Body');
      assert.deepStrictEqual(result, {});
    });

    test('handles multiple colons in value', () => {
      const content = `---
name: skill
description: A skill: with colons: in it
---`;
      const result = parseYamlFrontmatter(content);
      assert.strictEqual(result.description, 'A skill: with colons: in it');
    });
  });

  // ── readSkillDescriptions ──────────────────────────────────────────
  suite('readSkillDescriptions', () => {
    let tempDir: string;

    setup(() => {
      tempDir = makeTempDir();
    });

    teardown(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('returns empty array when skills dir missing', () => {
      const result = readSkillDescriptions(tempDir);
      assert.deepStrictEqual(result, []);
    });

    test('reads skill descriptions from SKILL.md files', () => {
      createSkillFile(tempDir, 'my-skill', `---
name: my-skill
description: Does cool things
---
# My Skill
Details here.`);

      const result = readSkillDescriptions(tempDir);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'my-skill');
      assert.strictEqual(result[0].description, 'Does cool things');
    });

    test('reads multiple skill descriptions', () => {
      createSkillFile(tempDir, 'skill-a', `---
name: skill-a
description: First skill
---`);
      createSkillFile(tempDir, 'skill-b', `---
name: skill-b
description: Second skill
---`);

      const result = readSkillDescriptions(tempDir);
      assert.strictEqual(result.length, 2);
      const names = result.map(s => s.name).sort();
      assert.deepStrictEqual(names, ['skill-a', 'skill-b']);
    });

    test('skips directories without SKILL.md', () => {
      const dir = path.join(tempDir, '.github', 'skills', 'empty-skill');
      fs.mkdirSync(dir, { recursive: true });

      const result = readSkillDescriptions(tempDir);
      assert.deepStrictEqual(result, []);
    });

    test('skips SKILL.md without name or description', () => {
      createSkillFile(tempDir, 'incomplete', `---
name: only-name
---`);

      const result = readSkillDescriptions(tempDir);
      assert.deepStrictEqual(result, []);
    });
  });

  // ── buildAugmentationPrompt ────────────────────────────────────────
  suite('buildAugmentationPrompt', () => {
    test('includes skills in prompt', () => {
      const skills = [{ name: 'test', description: 'A test skill' }];
      const nodes = [makeNode('n1', 'Do something')];
      const prompt = buildAugmentationPrompt(skills, nodes);
      assert.ok(prompt.includes('**test**: A test skill'));
    });

    test('includes node instructions in prompt', () => {
      const nodes = [makeNode('n1', 'Build the widget')];
      const prompt = buildAugmentationPrompt([], nodes);
      assert.ok(prompt.includes('Node "n1"'));
      assert.ok(prompt.includes('Build the widget'));
    });

    test('handles no skills', () => {
      const nodes = [makeNode('n1', 'Do it')];
      const prompt = buildAugmentationPrompt([], nodes);
      assert.ok(prompt.includes('No project skills defined'));
    });

    test('includes multiple nodes', () => {
      const nodes = [makeNode('a', 'Task A'), makeNode('b', 'Task B')];
      const prompt = buildAugmentationPrompt([], nodes);
      assert.ok(prompt.includes('Node "a"'));
      assert.ok(prompt.includes('Node "b"'));
    });

    test('requests JSON array response', () => {
      const prompt = buildAugmentationPrompt([], [makeNode('x', 'y')]);
      assert.ok(prompt.includes('JSON array'));
    });
  });

  // ── parseAugmentedOutput ───────────────────────────────────────────
  suite('parseAugmentedOutput', () => {
    test('parses valid JSON array', () => {
      const output = '[{"id": "n1", "instructions": "enriched"}]';
      const result = parseAugmentedOutput(output);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, 'n1');
      assert.strictEqual(result[0].instructions, 'enriched');
    });

    test('extracts JSON from surrounding text', () => {
      const output = 'Some log line\n[{"id": "n1", "instructions": "new"}]\nMore text';
      const result = parseAugmentedOutput(output);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, 'n1');
    });

    test('returns empty for no JSON', () => {
      const result = parseAugmentedOutput('No JSON here');
      assert.deepStrictEqual(result, []);
    });

    test('returns empty for invalid JSON', () => {
      const result = parseAugmentedOutput('[not valid json]');
      assert.deepStrictEqual(result, []);
    });

    test('filters out items missing id', () => {
      const output = '[{"instructions": "no id"}, {"id": "n1", "instructions": "ok"}]';
      const result = parseAugmentedOutput(output);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, 'n1');
    });

    test('filters out items missing instructions', () => {
      const output = '[{"id": "n1"}, {"id": "n2", "instructions": "ok"}]';
      const result = parseAugmentedOutput(output);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, 'n2');
    });

    test('filters out items with empty id or instructions', () => {
      const output = '[{"id": "", "instructions": "x"}, {"id": "n1", "instructions": ""}]';
      const result = parseAugmentedOutput(output);
      assert.deepStrictEqual(result, []);
    });

    test('returns empty for non-array JSON', () => {
      const result = parseAugmentedOutput('{"id": "n1", "instructions": "x"}');
      assert.deepStrictEqual(result, []);
    });
  });

  // ── augmentInstructions ────────────────────────────────────────────
  suite('augmentInstructions', () => {
    let tempDir: string;

    setup(() => {
      tempDir = makeTempDir();
      delete process.env.ORCHESTRATOR_AUGMENTATION;
    });

    teardown(() => {
      delete process.env.ORCHESTRATOR_AUGMENTATION;
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('anti-recursion: skips when ORCHESTRATOR_AUGMENTATION is set', async () => {
      process.env.ORCHESTRATOR_AUGMENTATION = 'true';
      const node = makeNode('n1', 'original');
      let runCalled = false;
      const runner = makeMockRunner('');
      const origRun = runner.run;
      runner.run = async (opts) => { runCalled = true; return origRun(opts); };

      await augmentInstructions({ nodes: [node], repoPath: tempDir, runner });

      assert.strictEqual(runCalled, false, 'Runner should not be called');
      assert.strictEqual(node.work.instructions, 'original');
    });

    test('skips nodes with augmentInstructions === false', async () => {
      const node = makeNode('n1', 'original', false);
      let runCalled = false;
      const runner = makeMockRunner('');
      const origRun = runner.run;
      runner.run = async (opts) => { runCalled = true; return origRun(opts); };

      await augmentInstructions({ nodes: [node], repoPath: tempDir, runner });

      assert.strictEqual(runCalled, false, 'Runner should not be called for no eligible nodes');
    });

    test('applies augmented instructions and snapshots original', async () => {
      const node = makeNode('n1', 'original instructions');
      const output = '[{"id": "n1", "instructions": "augmented instructions"}]';
      const runner = makeMockRunner(output);

      await augmentInstructions({ nodes: [node], repoPath: tempDir, runner });

      assert.strictEqual(node.work.originalInstructions, 'original instructions');
      assert.strictEqual(node.work.instructions, 'augmented instructions');
    });

    test('does not modify nodes when CLI fails', async () => {
      const node = makeNode('n1', 'original');
      const runner = makeMockRunner('', false);

      await augmentInstructions({ nodes: [node], repoPath: tempDir, runner });

      assert.strictEqual(node.work.instructions, 'original');
      assert.strictEqual(node.work.originalInstructions, undefined);
    });

    test('does not modify nodes when output has no valid JSON', async () => {
      const node = makeNode('n1', 'original');
      const runner = makeMockRunner('some random output');

      await augmentInstructions({ nodes: [node], repoPath: tempDir, runner });

      assert.strictEqual(node.work.instructions, 'original');
    });

    test('only modifies matched nodes', async () => {
      const node1 = makeNode('n1', 'instr 1');
      const node2 = makeNode('n2', 'instr 2');
      const output = '[{"id": "n1", "instructions": "new 1"}]';
      const runner = makeMockRunner(output);

      await augmentInstructions({ nodes: [node1, node2], repoPath: tempDir, runner });

      assert.strictEqual(node1.work.instructions, 'new 1');
      assert.strictEqual(node1.work.originalInstructions, 'instr 1');
      assert.strictEqual(node2.work.instructions, 'instr 2');
      assert.strictEqual(node2.work.originalInstructions, undefined);
    });

    test('passes maxTurns=1 and timeout=30000 to runner', async () => {
      const node = makeNode('n1', 'test');
      let capturedOptions: CopilotRunOptions | undefined;
      const runner: ICopilotRunner = {
        run: async (opts) => { capturedOptions = opts; return { success: true }; },
        isAvailable: () => true,
        writeInstructionsFile: () => ({ filePath: '', dirPath: '' }),
        buildCommand: () => '',
        cleanupInstructionsFile: () => {},
      };

      await augmentInstructions({ nodes: [node], repoPath: tempDir, runner });

      assert.ok(capturedOptions);
      assert.strictEqual(capturedOptions!.maxTurns, 1);
      assert.strictEqual(capturedOptions!.timeout, 30_000);
      assert.strictEqual(capturedOptions!.skipInstructionsFile, true);
    });

    test('sets ORCHESTRATOR_AUGMENTATION env during run and restores after', async () => {
      const node = makeNode('n1', 'test');
      let envDuringRun: string | undefined;
      const runner: ICopilotRunner = {
        run: async () => {
          envDuringRun = process.env.ORCHESTRATOR_AUGMENTATION;
          return { success: true };
        },
        isAvailable: () => true,
        writeInstructionsFile: () => ({ filePath: '', dirPath: '' }),
        buildCommand: () => '',
        cleanupInstructionsFile: () => {},
      };

      assert.strictEqual(process.env.ORCHESTRATOR_AUGMENTATION, undefined);
      await augmentInstructions({ nodes: [node], repoPath: tempDir, runner });

      assert.strictEqual(envDuringRun, 'true');
      assert.strictEqual(process.env.ORCHESTRATOR_AUGMENTATION, undefined);
    });

    test('restores env even when runner throws', async () => {
      const node = makeNode('n1', 'test');
      const runner: ICopilotRunner = {
        run: async () => { throw new Error('boom'); },
        isAvailable: () => true,
        writeInstructionsFile: () => ({ filePath: '', dirPath: '' }),
        buildCommand: () => '',
        cleanupInstructionsFile: () => {},
      };

      await assert.rejects(
        () => augmentInstructions({ nodes: [node], repoPath: tempDir, runner }),
        /boom/,
      );
      assert.strictEqual(process.env.ORCHESTRATOR_AUGMENTATION, undefined);
    });

    test('passes repoPath as cwd to runner', async () => {
      const node = makeNode('n1', 'test');
      let capturedCwd: string | undefined;
      const runner: ICopilotRunner = {
        run: async (opts) => { capturedCwd = opts.cwd; return { success: true }; },
        isAvailable: () => true,
        writeInstructionsFile: () => ({ filePath: '', dirPath: '' }),
        buildCommand: () => '',
        cleanupInstructionsFile: () => {},
      };

      await augmentInstructions({ nodes: [node], repoPath: tempDir, runner });
      assert.strictEqual(capturedCwd, tempDir);
    });

    test('includes skill descriptions in prompt sent to runner', async () => {
      createSkillFile(tempDir, 'cool-skill', `---
name: cool-skill
description: Does cool things
---`);

      const node = makeNode('n1', 'task instructions');
      let capturedTask = '';
      const runner: ICopilotRunner = {
        run: async (opts) => { capturedTask = opts.task; return { success: true }; },
        isAvailable: () => true,
        writeInstructionsFile: () => ({ filePath: '', dirPath: '' }),
        buildCommand: () => '',
        cleanupInstructionsFile: () => {},
      };

      await augmentInstructions({ nodes: [node], repoPath: tempDir, runner });

      assert.ok(capturedTask.includes('cool-skill'));
      assert.ok(capturedTask.includes('Does cool things'));
      assert.ok(capturedTask.includes('task instructions'));
    });
  });
});
