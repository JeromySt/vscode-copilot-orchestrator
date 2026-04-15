/**
 * @fileoverview Unit tests for DefaultJobSplitter.
 *
 * Tests buildChunks (suggestedSplits primary, naive fallback, empty, maxSubJobs cap),
 * buildSubJobSpec (agent prompt wrapping, fallback instructions, constant fields),
 * and buildFanInSpec (dependencies, postchecks, autoHeal).
 */

import * as assert from 'assert';
import { suite, test } from 'mocha';
import { DefaultJobSplitter } from '../../../../plan/analysis/jobSplitter';
import type {
  CheckpointManifest,
  ManifestCompletedFile,
  ManifestRemainingItem,
  ManifestSuggestedSplit,
} from '../../../../interfaces/IJobSplitter';
import type { JobNodeSpec } from '../../../../plan/types/nodes';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeConfig(maxSubJobs = 8): { getConfig: <T>(_s: string, _k: string, def: T) => T } {
  return {
    getConfig<T>(_s: string, key: string, def: T): T {
      if (key === 'contextPressure.maxSubJobs') {
        return maxSubJobs as unknown as T;
      }
      return def;
    },
  };
}

function completed(file: string, summary = 'done'): ManifestCompletedFile {
  return { file, summary };
}

function remaining(file: string, description = 'implement'): ManifestRemainingItem {
  return { file, description };
}

function split(name: string, files: string[], prompt: string, priority?: number): ManifestSuggestedSplit {
  return { name, files, prompt, priority };
}

function baseManifest(overrides?: Partial<CheckpointManifest>): CheckpointManifest {
  return {
    status: 'checkpointed',
    completed: [completed('src/a.ts', 'implemented A')],
    remaining: [],
    summary: 'partial progress',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

suite('DefaultJobSplitter', () => {

  // ── buildChunks ─────────────────────────────────────────────────────

  suite('buildChunks', () => {

    test('suggestedSplits: 3 splits sorted by priority → 3 WorkChunks in order', () => {
      const splitter = new DefaultJobSplitter(makeConfig() as any);
      const manifest = baseManifest({
        suggestedSplits: [
          split('low', ['c.ts'], 'do C', 3),
          split('high', ['a.ts'], 'do A', 1),
          split('mid', ['b.ts'], 'do B', 2),
        ],
      });

      const chunks = splitter.buildChunks(manifest, '');

      assert.strictEqual(chunks.length, 3);
      assert.strictEqual(chunks[0].name, 'high');
      assert.strictEqual(chunks[0].priority, 1);
      assert.strictEqual(chunks[1].name, 'mid');
      assert.strictEqual(chunks[1].priority, 2);
      assert.strictEqual(chunks[2].name, 'low');
      assert.strictEqual(chunks[2].priority, 3);
      assert.strictEqual(chunks[0].prompt, 'do A');
      assert.deepStrictEqual(chunks[1].files, ['b.ts']);
    });

    test('fallback: no suggestedSplits, 1 inProgress + 3 remaining → inProgress first, remaining batched by 2', () => {
      const splitter = new DefaultJobSplitter(makeConfig() as any);
      const manifest = baseManifest({
        inProgress: { file: 'wip.ts', completedParts: 'half', remainingParts: 'other half' },
        remaining: [
          remaining('r1.ts', 'first'),
          remaining('r2.ts', 'second'),
          remaining('r3.ts', 'third'),
        ],
      });

      const chunks = splitter.buildChunks(manifest, '');

      // inProgress gets its own chunk (priority 1), then 2 batches of remaining
      assert.strictEqual(chunks.length, 3);
      assert.deepStrictEqual(chunks[0].files, ['wip.ts']);
      assert.strictEqual(chunks[0].priority, 1);
      // remaining batched by 2
      assert.deepStrictEqual(chunks[1].files, ['r1.ts', 'r2.ts']);
      assert.strictEqual(chunks[1].priority, 2);
      assert.deepStrictEqual(chunks[2].files, ['r3.ts']);
      assert.strictEqual(chunks[2].priority, 3);
    });

    test('empty: no inProgress, no remaining → empty array', () => {
      const splitter = new DefaultJobSplitter(makeConfig() as any);
      const manifest = baseManifest({ remaining: [] });

      const chunks = splitter.buildChunks(manifest, '');

      assert.strictEqual(chunks.length, 0);
    });

    test('maxSubJobs cap: 12 remaining items with maxSubJobs=8 → 8 chunks', () => {
      const splitter = new DefaultJobSplitter(makeConfig(8) as any);
      const items: ManifestRemainingItem[] = [];
      for (let i = 0; i < 12; i++) {
        items.push(remaining(`file${i}.ts`, `task ${i}`));
      }
      const manifest = baseManifest({ remaining: items });

      const chunks = splitter.buildChunks(manifest, '');

      // 12 items batched by 2 = 6 naive chunks, which is < 8, so all 6 survive.
      // But if we use suggestedSplits with 12 entries instead, we test the cap.
      assert.ok(chunks.length <= 8, `expected ≤8 chunks, got ${chunks.length}`);
    });

    test('maxSubJobs cap with suggestedSplits: 12 splits capped to 8', () => {
      const splitter = new DefaultJobSplitter(makeConfig(8) as any);
      const splits: ManifestSuggestedSplit[] = [];
      for (let i = 0; i < 12; i++) {
        splits.push(split(`split-${i}`, [`f${i}.ts`], `do ${i}`, i + 1));
      }
      const manifest = baseManifest({ suggestedSplits: splits });

      const chunks = splitter.buildChunks(manifest, '');

      assert.strictEqual(chunks.length, 8);
      // First 8 by priority order preserved
      assert.strictEqual(chunks[0].name, 'split-0');
      assert.strictEqual(chunks[7].name, 'split-7');
    });

  });

  // ── buildSubJobSpec ─────────────────────────────────────────────────

  suite('buildSubJobSpec', () => {

    test('with agent prompt: instructions contain "Your Assignment (from the prior agent)" + completed list + rules', () => {
      const splitter = new DefaultJobSplitter(makeConfig() as any);
      const manifest = baseManifest({
        completed: [completed('src/a.ts', 'built module A')],
      });
      const chunk = {
        name: 'chunk-1',
        files: ['src/b.ts'],
        description: 'build B',
        prompt: 'Implement module B using patterns from A',
        priority: 1,
      };

      const spec = splitter.buildSubJobSpec(chunk, manifest, 'node-123');

      assert.ok(spec.instructions.includes('Your Assignment (from the prior agent)'));
      assert.ok(spec.instructions.includes('Implement module B using patterns from A'));
      assert.ok(spec.instructions.includes('src/a.ts'));
      assert.ok(spec.instructions.includes('built module A'));
      assert.ok(spec.instructions.includes('DO NOT modify completed files'));
    });

    test('fallback: no prompt → instructions contain "Original Specification" reference to parent instruction file', () => {
      const splitter = new DefaultJobSplitter(makeConfig() as any);
      const manifest = baseManifest({
        completed: [completed('src/a.ts', 'done')],
      });
      const chunk = {
        files: ['src/c.ts'],
        description: 'implement C',
        priority: 2,
      };

      const spec = splitter.buildSubJobSpec(chunk, manifest, 'node-456');

      assert.ok(spec.instructions.includes('Original Specification'));
      assert.ok(spec.instructions.includes('orchestrator-job-node-456.md'));
      assert.ok(spec.instructions.includes('src/c.ts'));
      assert.ok(!spec.instructions.includes('Your Assignment (from the prior agent)'));
    });

    test('always sets resumeSession: false and modelTier: premium', () => {
      const splitter = new DefaultJobSplitter(makeConfig() as any);
      const manifest = baseManifest();

      const withPrompt = splitter.buildSubJobSpec(
        { name: 'x', files: ['f.ts'], description: 'd', prompt: 'do it', priority: 1 },
        manifest,
        'n1',
      );
      const withoutPrompt = splitter.buildSubJobSpec(
        { files: ['f.ts'], description: 'd', priority: 1 },
        manifest,
        'n2',
      );

      assert.strictEqual(withPrompt.resumeSession, false);
      assert.strictEqual(withPrompt.modelTier, 'premium');
      assert.strictEqual(withoutPrompt.resumeSession, false);
      assert.strictEqual(withoutPrompt.modelTier, 'premium');
    });

  });

  // ── buildFanInSpec ──────────────────────────────────────────────────

  suite('buildFanInSpec', () => {

    test('work = shell "true", postchecks = parent postchecks, autoHeal = true', () => {
      const splitter = new DefaultJobSplitter(makeConfig() as any);
      const parent: JobNodeSpec = {
        producerId: 'parent-job',
        name: 'Parent Job',
        task: 'do stuff',
        postchecks: { type: 'shell', command: 'npm test' },
        dependencies: [],
      };

      const fanIn = splitter.buildFanInSpec(parent, ['sub-1', 'sub-2']);

      assert.deepStrictEqual(fanIn.work, { type: 'shell', command: 'true' });
      assert.deepStrictEqual(fanIn.postchecks, { type: 'shell', command: 'npm test' });
      assert.strictEqual(fanIn.autoHeal, true);
      assert.strictEqual(fanIn.producerId, 'parent-job-fan-in');
      assert.ok(fanIn.name!.includes('Parent Job'));
    });

    test('dependencies: receives subJobProducerIds array', () => {
      const splitter = new DefaultJobSplitter(makeConfig() as any);
      const parent: JobNodeSpec = {
        producerId: 'p',
        task: 'task',
        dependencies: [],
      };
      const ids = ['sub-a', 'sub-b', 'sub-c'];

      const fanIn = splitter.buildFanInSpec(parent, ids);

      assert.deepStrictEqual(fanIn.dependencies, ['sub-a', 'sub-b', 'sub-c']);
    });

  });
});
