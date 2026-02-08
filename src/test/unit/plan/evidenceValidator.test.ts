/**
 * @fileoverview Unit tests for DefaultEvidenceValidator
 *
 * Tests cover:
 * - hasEvidenceFile: returns true/false based on file existence
 * - readEvidence: parses valid JSON, rejects invalid schemas
 * - validate: returns correct results for each method type
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DefaultEvidenceValidator } from '../../../plan/evidenceValidator';
import type { EvidenceFile } from '../../../plan/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
}

function writeEvidenceFile(worktreePath: string, nodeId: string, content: any): void {
  const evidenceDir = path.join(worktreePath, '.orchestrator', 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, `${nodeId}.json`),
    JSON.stringify(content),
    'utf-8'
  );
}

function cleanUp(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

const validEvidence: EvidenceFile = {
  version: 1,
  nodeId: 'test-node',
  timestamp: '2026-02-07T16:00:00.000Z',
  summary: 'Deployed to staging',
  type: 'external_effect',
  outcome: { env: 'staging' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('DefaultEvidenceValidator', () => {
  let tempDir: string;
  let validator: DefaultEvidenceValidator;

  setup(() => {
    tempDir = createTempDir();
    validator = new DefaultEvidenceValidator();
  });

  teardown(() => {
    cleanUp(tempDir);
  });

  // =========================================================================
  // hasEvidenceFile
  // =========================================================================
  suite('hasEvidenceFile', () => {
    test('returns false when no evidence file exists', async () => {
      const result = await validator.hasEvidenceFile(tempDir, 'node-1');
      assert.strictEqual(result, false);
    });

    test('returns true when evidence file exists', async () => {
      writeEvidenceFile(tempDir, 'node-1', validEvidence);
      const result = await validator.hasEvidenceFile(tempDir, 'node-1');
      assert.strictEqual(result, true);
    });

    test('returns false for a different node ID', async () => {
      writeEvidenceFile(tempDir, 'node-1', validEvidence);
      const result = await validator.hasEvidenceFile(tempDir, 'node-2');
      assert.strictEqual(result, false);
    });
  });

  // =========================================================================
  // readEvidence
  // =========================================================================
  suite('readEvidence', () => {
    test('returns undefined when file does not exist', async () => {
      const result = await validator.readEvidence(tempDir, 'node-1');
      assert.strictEqual(result, undefined);
    });

    test('parses valid evidence file', async () => {
      writeEvidenceFile(tempDir, 'node-1', validEvidence);
      const result = await validator.readEvidence(tempDir, 'node-1');
      assert.ok(result);
      assert.strictEqual(result.version, 1);
      assert.strictEqual(result.nodeId, 'test-node');
      assert.strictEqual(result.summary, 'Deployed to staging');
      assert.strictEqual(result.type, 'external_effect');
    });

    test('returns undefined for invalid JSON', async () => {
      const evidenceDir = path.join(tempDir, '.orchestrator', 'evidence');
      fs.mkdirSync(evidenceDir, { recursive: true });
      fs.writeFileSync(path.join(evidenceDir, 'node-1.json'), 'not json', 'utf-8');
      const result = await validator.readEvidence(tempDir, 'node-1');
      assert.strictEqual(result, undefined);
    });

    test('returns undefined when version is not 1', async () => {
      writeEvidenceFile(tempDir, 'node-1', { ...validEvidence, version: 2 });
      const result = await validator.readEvidence(tempDir, 'node-1');
      assert.strictEqual(result, undefined);
    });

    test('returns undefined when required fields are missing', async () => {
      writeEvidenceFile(tempDir, 'node-1', { version: 1, nodeId: 'x' });
      const result = await validator.readEvidence(tempDir, 'node-1');
      assert.strictEqual(result, undefined);
    });

    test('returns undefined when summary is empty', async () => {
      writeEvidenceFile(tempDir, 'node-1', {
        version: 1,
        nodeId: 'x',
        timestamp: '2026-01-01T00:00:00Z',
        summary: '',
      });
      const result = await validator.readEvidence(tempDir, 'node-1');
      assert.strictEqual(result, undefined);
    });
  });

  // =========================================================================
  // validate
  // =========================================================================
  suite('validate', () => {
    test('returns valid with evidence_file method when evidence exists', async () => {
      writeEvidenceFile(tempDir, 'node-1', validEvidence);
      const result = await validator.validate(tempDir, 'node-1', false);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.method, 'evidence_file');
      assert.ok(result.evidence);
      assert.ok(result.reason.includes('Deployed to staging'));
    });

    test('returns valid with expects_no_changes method when flag is true', async () => {
      const result = await validator.validate(tempDir, 'node-1', true);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.method, 'expects_no_changes');
      assert.strictEqual(result.evidence, undefined);
    });

    test('returns invalid with none method when no evidence and flag false', async () => {
      const result = await validator.validate(tempDir, 'node-1', false);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.method, 'none');
      assert.ok(result.reason.includes('No work evidence'));
    });

    test('evidence file takes priority over expectsNoChanges flag', async () => {
      writeEvidenceFile(tempDir, 'node-1', validEvidence);
      const result = await validator.validate(tempDir, 'node-1', true);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.method, 'evidence_file');
    });

    test('invalid evidence file falls through to expectsNoChanges', async () => {
      // Write invalid evidence (wrong version)
      writeEvidenceFile(tempDir, 'node-1', { ...validEvidence, version: 99 });
      const result = await validator.validate(tempDir, 'node-1', true);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.method, 'expects_no_changes');
    });

    test('invalid evidence file with flag false returns invalid', async () => {
      writeEvidenceFile(tempDir, 'node-1', { ...validEvidence, version: 99 });
      const result = await validator.validate(tempDir, 'node-1', false);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.method, 'none');
    });
  });
});
