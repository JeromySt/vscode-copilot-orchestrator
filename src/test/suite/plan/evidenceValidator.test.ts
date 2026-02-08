/**
 * @fileoverview Tests for DefaultEvidenceValidator (src/plan/evidenceValidator.ts).
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DefaultEvidenceValidator } from '../../../plan/evidenceValidator';

function silenceConsole() {
  sinon.stub(console, 'error');
  sinon.stub(console, 'warn');
}

suite('DefaultEvidenceValidator', () => {
  let tmpDir: string;
  let validator: DefaultEvidenceValidator;

  setup(() => {
    silenceConsole();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
    validator = new DefaultEvidenceValidator();
  });

  teardown(() => {
    sinon.restore();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  function writeEvidence(nodeId: string, content: any) {
    const dir = path.join(tmpDir, '.orchestrator', 'evidence');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${nodeId}.json`), JSON.stringify(content));
  }

  // =========================================================================
  // hasEvidenceFile
  // =========================================================================

  suite('hasEvidenceFile', () => {
    test('returns false when no evidence file', async () => {
      assert.strictEqual(await validator.hasEvidenceFile(tmpDir, 'node-1'), false);
    });

    test('returns true when evidence file exists', async () => {
      writeEvidence('node-1', { version: 1, nodeId: 'node-1', timestamp: Date.now(), summary: 'done' });
      assert.strictEqual(await validator.hasEvidenceFile(tmpDir, 'node-1'), true);
    });
  });

  // =========================================================================
  // readEvidence
  // =========================================================================

  suite('readEvidence', () => {
    test('returns undefined when file does not exist', async () => {
      const result = await validator.readEvidence(tmpDir, 'node-1');
      assert.strictEqual(result, undefined);
    });

    test('returns parsed evidence on valid file', async () => {
      const evidence = { version: 1, nodeId: 'node-1', timestamp: Date.now(), summary: 'completed task' };
      writeEvidence('node-1', evidence);
      const result = await validator.readEvidence(tmpDir, 'node-1');
      assert.ok(result);
      assert.strictEqual(result!.nodeId, 'node-1');
      assert.strictEqual(result!.summary, 'completed task');
    });

    test('returns undefined for invalid version', async () => {
      writeEvidence('node-1', { version: 99, nodeId: 'node-1', timestamp: Date.now(), summary: 'x' });
      const result = await validator.readEvidence(tmpDir, 'node-1');
      assert.strictEqual(result, undefined);
    });

    test('returns undefined for missing required fields', async () => {
      writeEvidence('node-1', { version: 1 });
      const result = await validator.readEvidence(tmpDir, 'node-1');
      assert.strictEqual(result, undefined);
    });

    test('returns undefined for corrupt JSON', async () => {
      const dir = path.join(tmpDir, '.orchestrator', 'evidence');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'node-1.json'), '{ invalid json');
      const result = await validator.readEvidence(tmpDir, 'node-1');
      assert.strictEqual(result, undefined);
    });
  });

  // =========================================================================
  // validate
  // =========================================================================

  suite('validate', () => {
    test('returns valid with evidence file', async () => {
      writeEvidence('node-1', { version: 1, nodeId: 'node-1', timestamp: Date.now(), summary: 'did work' });
      const result = await validator.validate(tmpDir, 'node-1', false);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.method, 'evidence_file');
    });

    test('returns valid when expectsNoChanges is true', async () => {
      const result = await validator.validate(tmpDir, 'node-1', true);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.method, 'expects_no_changes');
    });

    test('returns invalid when no evidence and not expectsNoChanges', async () => {
      const result = await validator.validate(tmpDir, 'node-1', false);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.method, 'none');
    });
  });
});
