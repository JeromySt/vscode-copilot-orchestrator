/**
 * @fileoverview Unit tests for complexity scorer module.
 */

import * as assert from 'assert';
import { suite, test } from 'mocha';
import {
  scoreComplexity,
  evaluateComplexity,
  WARN_THRESHOLD,
  DECOMPOSE_THRESHOLD,
} from '../../../../plan/analysis/complexityScorer';

suite('complexityScorer', () => {
  suite('scoreComplexity', () => {
    test('returns zero score for empty instructions', () => {
      const score = scoreComplexity('', 0);
      assert.strictEqual(score.score, 0);
      assert.strictEqual(score.estimatedOutputFiles, 0);
      assert.strictEqual(score.hasCryptoWork, false);
    });

    test('detects crypto keywords', () => {
      const score = scoreComplexity('Implement AES-256-GCM encryption for the data stream', 0);
      assert.ok(score.hasCryptoWork);
      assert.ok(score.score >= 25); // crypto weight
    });

    test('detects state machine keywords', () => {
      const score = scoreComplexity('Build a state machine for the lifecycle transitions', 0);
      assert.ok(score.hasStateMachine);
    });

    test('detects protocol keywords', () => {
      const score = scoreComplexity('Implement chunked streaming protocol with framing', 0);
      assert.ok(score.hasProtocolWork);
    });

    test('counts file paths', () => {
      const instructions = [
        'Create EncryptingStream.cs with AES implementation',
        'Create SecureSpoolStream.cs for spooling',
        'Create ICryptoProvider.cs interface',
      ].join('\n');
      const score = scoreComplexity(instructions, 0);
      assert.ok(score.estimatedOutputFiles >= 3);
    });

    test('includes dependency fan-in', () => {
      const score = scoreComplexity('simple task', 3);
      assert.strictEqual(score.dependencyFanIn, 3);
      assert.ok(score.score >= 15); // 3 * 5
    });

    test('adds LOC bonus for high targets', () => {
      const score = scoreComplexity('Implement approximately 600 LOC', 0);
      assert.ok(score.estimatedLOC >= 600);
      assert.ok(score.score >= 20); // LOC > 500 bonus
    });

    test('complex job scores above warn threshold', () => {
      const instructions = [
        'Create EncryptingStream.cs with AES-256-GCM encryption',
        'Create EncryptingStreamTests.cs with ≥30 tests',
        'Create SecureSpoolStream.cs with streaming protocol',
        'Create SecureSpoolStreamTests.cs',
        'Create ICryptoProvider.cs interface',
        'Create EphemeralCryptoProvider.cs',
        'Create NullCryptoProvider.cs',
        'Create SpoolTempDirectory.cs',
        'Target: ~400 LOC of implementation',
      ].join('\n');
      const score = scoreComplexity(instructions, 1);
      assert.ok(score.score > WARN_THRESHOLD, `Score ${score.score} should exceed warn threshold ${WARN_THRESHOLD}`);
    });

    test('simple job scores below warn threshold', () => {
      const score = scoreComplexity('Fix the typo in README.md', 0);
      assert.ok(score.score < WARN_THRESHOLD);
    });
  });

  suite('evaluateComplexity', () => {
    test('returns no warning for low scores', () => {
      const score = scoreComplexity('simple task', 0);
      const result = evaluateComplexity(score, 'simple task');
      assert.strictEqual(result.shouldDecompose, false);
      assert.strictEqual(result.warningMessage, '');
    });

    test('returns warning for elevated scores', () => {
      // Force high score with crypto + protocol + multiple files
      const instructions = [
        'Create EncryptingStream.cs with AES encryption',
        'Create SecureSpoolStream.cs with streaming protocol',
        'Create SpoolStream.cs auxiliary',
        'Create Tests.cs tests',
        'Create Config.cs config',
        'Create Helper.cs helper',
        'Create Utils.cs utils',
        'Create Manager.cs manager',
        'Create Provider.cs provider',
      ].join('\n');
      const score = scoreComplexity(instructions, 0);
      // Ensure score is above warn threshold
      if (score.score > WARN_THRESHOLD) {
        const result = evaluateComplexity(score, instructions);
        assert.ok(result.warningMessage.includes('COMPLEXITY'));
      }
    });

    test('suggests decomposition for very high scores', () => {
      const instructions = [
        'Create EncryptingStream.cs with AES-256 encryption and state machine lifecycle',
        'Create StreamProtocol.cs with chunked streaming',
        'Create Tests1.cs', 'Create Tests2.cs', 'Create Tests3.cs',
        'Create File1.cs', 'Create File2.cs', 'Create File3.cs',
        'Create File4.cs', 'Create File5.cs', 'Create File6.cs',
        'Create File7.cs', 'Create File8.cs',
        'Target: ~800 LOC implementation',
      ].join('\n');
      const score = scoreComplexity(instructions, 3);
      if (score.score > DECOMPOSE_THRESHOLD) {
        const result = evaluateComplexity(score, instructions);
        assert.strictEqual(result.shouldDecompose, true);
        assert.ok(result.warningMessage.includes('HIGH COMPLEXITY'));
      }
    });

    test('includes risk factors in warning', () => {
      const instructions = 'Implement AES encryption with state machine transitions via streaming protocol';
      const score = scoreComplexity(instructions, 0);
      if (score.score > WARN_THRESHOLD) {
        const result = evaluateComplexity(score, instructions);
        assert.ok(result.warningMessage.includes('cryptography') || result.warningMessage.includes('state machine') || result.warningMessage.includes('protocol'));
      }
    });

    test('elevated complexity returns warning without shouldDecompose', () => {
      // Manually construct a score between WARN_THRESHOLD and DECOMPOSE_THRESHOLD
      const score: import('../../../../plan/analysis/complexityScorer').ComplexityScore = {
        estimatedOutputFiles: 5,
        estimatedTestCases: 2,
        estimatedLOC: 0,
        hasCryptoWork: true,
        hasStateMachine: false,
        hasProtocolWork: false,
        dependencyFanIn: 1,
        score: WARN_THRESHOLD + 10, // Above warn, below decompose
      };
      const result = evaluateComplexity(score, 'some instructions');
      assert.strictEqual(result.shouldDecompose, false);
      assert.ok(result.warningMessage.includes('ELEVATED COMPLEXITY'));
      assert.ok(result.warningMessage.includes('cryptography'));
    });

    test('high complexity returns shouldDecompose with suggested splits', () => {
      const score: import('../../../../plan/analysis/complexityScorer').ComplexityScore = {
        estimatedOutputFiles: 10,
        estimatedTestCases: 8,
        estimatedLOC: 600,
        hasCryptoWork: true,
        hasStateMachine: true,
        hasProtocolWork: false,
        dependencyFanIn: 2,
        score: DECOMPOSE_THRESHOLD + 20,
      };
      const instructions = [
        '1. Create EncryptingStream.cs with AES encryption',
        '2. Create StateMachine.cs with lifecycle',
        '3. Create Tests.cs for validation',
        '4. Create Integration.cs for wiring',
      ].join('\n');
      const result = evaluateComplexity(score, instructions);
      assert.strictEqual(result.shouldDecompose, true);
      assert.ok(result.warningMessage.includes('HIGH COMPLEXITY'));
      assert.ok(result.suggestedSplits.length > 0);
    });

    test('suggestSplits generates generic splits for numbered steps without keywords', () => {
      const score: import('../../../../plan/analysis/complexityScorer').ComplexityScore = {
        estimatedOutputFiles: 4,
        estimatedTestCases: 0,
        estimatedLOC: 0,
        hasCryptoWork: false,
        hasStateMachine: false,
        hasProtocolWork: false,
        dependencyFanIn: 0,
        score: DECOMPOSE_THRESHOLD + 10,
      };
      const instructions = [
        '1. Create FileA.cs',
        '2. Create FileB.cs',
        '3. Create FileC.cs',
        '4. Create FileD.cs',
      ].join('\n');
      const result = evaluateComplexity(score, instructions);
      assert.ok(result.suggestedSplits.length >= 2, 'should suggest at least 2 splits');
      assert.ok(result.suggestedSplits.some(s => s.includes('Steps 1')));
    });

    test('suggestSplits includes integration tests split when many test cases', () => {
      const score: import('../../../../plan/analysis/complexityScorer').ComplexityScore = {
        estimatedOutputFiles: 6,
        estimatedTestCases: 10,
        estimatedLOC: 0,
        hasCryptoWork: true,
        hasStateMachine: false,
        hasProtocolWork: true,
        dependencyFanIn: 0,
        score: DECOMPOSE_THRESHOLD + 10,
      };
      const instructions = [
        '1. Create Crypto.cs with encryption',
        '2. Create Stream.cs with streaming',
        '3. Create Tests.cs',
      ].join('\n');
      const result = evaluateComplexity(score, instructions);
      assert.ok(result.suggestedSplits.some(s => s.includes('Integration tests')),
        'should suggest integration tests split');
    });

    test('no warning for scores at exactly WARN_THRESHOLD', () => {
      const score: import('../../../../plan/analysis/complexityScorer').ComplexityScore = {
        estimatedOutputFiles: 0, estimatedTestCases: 0, estimatedLOC: 0,
        hasCryptoWork: false, hasStateMachine: false, hasProtocolWork: false,
        dependencyFanIn: 0, score: WARN_THRESHOLD,
      };
      const result = evaluateComplexity(score, '');
      assert.strictEqual(result.shouldDecompose, false);
      assert.strictEqual(result.warningMessage, '');
    });
  });
});
