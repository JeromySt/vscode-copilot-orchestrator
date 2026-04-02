/**
 * @fileoverview Job Complexity Scorer
 *
 * Analyzes job work instructions to estimate complexity and warn when
 * a job may be too large for a single AI agent context window.
 *
 * @module plan/analysis/complexityScorer
 */

/**
 * Complexity score breakdown for a job.
 */
export interface ComplexityScore {
  /** Count of file creation/path mentions */
  estimatedOutputFiles: number;
  /** Count of test case mentions */
  estimatedTestCases: number;
  /** LOC targets mentioned (e.g., "≥30 tests", "~400 LOC") */
  estimatedLOC: number;
  /** Whether job involves crypto/encryption/hashing */
  hasCryptoWork: boolean;
  /** Whether job involves state machines/lifecycle/transitions */
  hasStateMachine: boolean;
  /** Whether job involves protocol/streaming/framing */
  hasProtocolWork: boolean;
  /** Number of dependencies */
  dependencyFanIn: number;
  /** Weighted composite score */
  score: number;
}

/**
 * Decomposition suggestion returned when a job exceeds the threshold.
 */
export interface DecompositionSuggestion {
  /** Whether decomposition is recommended */
  shouldDecompose: boolean;
  /** Warning message for the user */
  warningMessage: string;
  /** Suggested sub-job boundaries (description only — not auto-wired) */
  suggestedSplits: string[];
}

// ── Pattern constants ──

const FILE_PATH_PATTERNS = [
  /[A-Z][a-zA-Z0-9]*\.[a-z]{1,5}\b/g,             // PascalCase.ext (e.g., EncryptingStream.cs)
  /[a-z][a-zA-Z0-9]*\.[a-z]{1,5}\b/g,               // camelCase.ext
  /[a-z_-]+\.[a-z]{1,5}\b/g,                          // snake_case.ext or kebab-case.ext
  /(?:src|lib|test|spec)\/[^\s,)]+\.[a-z]+/gi,      // path/to/file.ext
];

const TEST_CASE_PATTERNS = [
  /\btest[_\s]+[A-Z][a-zA-Z]+/g,       // test_MethodName or test MethodName
  /\bshould\s+[a-z]+/gi,                // should handle, should throw
  /\bit\s*\(\s*['"][^'"]+/g,            // it('description
  /\btest\s*\(\s*['"][^'"]+/g,          // test('description
  /\[(?:Fact|Theory|Test)\]/g,           // .NET test attributes
  /def\s+test_\w+/g,                     // pytest test functions
  /func\s+Test[A-Z]\w+/g,               // Go test functions
];

const LOC_PATTERNS = [
  /(\d+)\s*(?:LOC|lines?\s*of\s*code)/gi,
  /(?:≥|>=|~|approximately|about|around)\s*(\d+)\s*(?:tests?|specs?)/gi,
  /(\d+)\+?\s*(?:unit|integration)?\s*tests?/gi,
];

const CRYPTO_KEYWORDS = [
  /\bcrypt(?:o|ography)\b/i,
  /\bencrypt(?:ion|ing|ed)?\b/i,
  /\bdecrypt(?:ion|ing|ed)?\b/i,
  /\bAES\b/,
  /\bGCM\b/,
  /\bRSA\b/,
  /\bHMAC\b/,
  /\bSHA[-\s]?\d{3}\b/i,
  /\bhash(?:ing|ed)?\b/i,
  /\bcipher\b/i,
  /\bcertificate\b/i,
  /\bsigning\b/i,
  /\bkey\s*(?:derivation|exchange|pair|management)\b/i,
];

const STATE_MACHINE_KEYWORDS = [
  /\bstate\s*machine\b/i,
  /\blifecycle\b/i,
  /\bstate\s*transition(?:s)?\b/i,
  /\bfinite\s*automaton\b/i,
  /\bFSM\b/,
  /\bworkflow\s*engine\b/i,
];

const PROTOCOL_KEYWORDS = [
  /\bprotocol\b/i,
  /\bstreaming\b/i,
  /\bchunked\b/i,
  /\bframing\b/i,
  /\bbuffered?\s*(?:reader|writer|stream)\b/i,
  /\bserialization\b/i,
  /\bwire\s*format\b/i,
  /\bpacket\b/i,
];

// ── Scoring weights ──

const WEIGHT_FILE = 10;
const WEIGHT_TEST = 3;
const WEIGHT_CRYPTO = 25;
const WEIGHT_STATE_MACHINE = 25;
const WEIGHT_PROTOCOL = 25;
const WEIGHT_DEPENDENCY = 5;
const WEIGHT_LOC_HIGH = 20; // LOC > 500

/** Score threshold for warning */
export const WARN_THRESHOLD = 80;
/** Score threshold for auto-decompose suggestion */
export const DECOMPOSE_THRESHOLD = 120;

/**
 * Count unique regex matches in text.
 */
function countUniqueMatches(text: string, patterns: RegExp[]): number {
  const seen = new Set<string>();
  for (const pattern of patterns) {
    // Reset lastIndex for global patterns
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      seen.add(match[0].toLowerCase());
    }
  }
  return seen.size;
}

/**
 * Check if text matches any keyword pattern.
 */
function hasKeyword(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

/**
 * Extract the highest LOC/test count mentioned in text.
 */
function extractLOC(text: string): number {
  let maxLoc = 0;
  for (const pattern of LOC_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      const val = parseInt(match[1], 10);
      if (!isNaN(val) && val > maxLoc) { maxLoc = val; }
    }
  }
  return maxLoc;
}

/**
 * Compute complexity score for a job's work instructions.
 *
 * @param instructions - The combined work instructions text (from AgentSpec.instructions or task + instructions).
 * @param dependencyCount - Number of dependencies this job has.
 * @returns Detailed complexity score.
 */
export function scoreComplexity(instructions: string, dependencyCount: number = 0): ComplexityScore {
  if (!instructions) {
    return {
      estimatedOutputFiles: 0, estimatedTestCases: 0, estimatedLOC: 0,
      hasCryptoWork: false, hasStateMachine: false, hasProtocolWork: false,
      dependencyFanIn: dependencyCount, score: dependencyCount * WEIGHT_DEPENDENCY,
    };
  }

  const estimatedOutputFiles = countUniqueMatches(instructions, FILE_PATH_PATTERNS);
  const estimatedTestCases = countUniqueMatches(instructions, TEST_CASE_PATTERNS);
  const estimatedLOC = extractLOC(instructions);
  const hasCryptoWork = hasKeyword(instructions, CRYPTO_KEYWORDS);
  const hasStateMachine = hasKeyword(instructions, STATE_MACHINE_KEYWORDS);
  const hasProtocolWork = hasKeyword(instructions, PROTOCOL_KEYWORDS);

  let score = 0;
  score += estimatedOutputFiles * WEIGHT_FILE;
  score += estimatedTestCases * WEIGHT_TEST;
  if (hasCryptoWork) { score += WEIGHT_CRYPTO; }
  if (hasStateMachine) { score += WEIGHT_STATE_MACHINE; }
  if (hasProtocolWork) { score += WEIGHT_PROTOCOL; }
  score += dependencyCount * WEIGHT_DEPENDENCY;
  if (estimatedLOC > 500) { score += WEIGHT_LOC_HIGH; }

  return {
    estimatedOutputFiles,
    estimatedTestCases,
    estimatedLOC,
    hasCryptoWork,
    hasStateMachine,
    hasProtocolWork,
    dependencyFanIn: dependencyCount,
    score,
  };
}

/**
 * Evaluate a complexity score and suggest decomposition if needed.
 *
 * @param score - The complexity score to evaluate.
 * @param instructions - Original instructions (for split analysis).
 * @returns A decomposition suggestion with message.
 */
export function evaluateComplexity(score: ComplexityScore, instructions: string): DecompositionSuggestion {
  if (score.score <= WARN_THRESHOLD) {
    return { shouldDecompose: false, warningMessage: '', suggestedSplits: [] };
  }

  const riskFactors: string[] = [];
  if (score.hasCryptoWork) { riskFactors.push('cryptography/encryption'); }
  if (score.hasStateMachine) { riskFactors.push('state machine/lifecycle'); }
  if (score.hasProtocolWork) { riskFactors.push('protocol/streaming'); }
  if (score.estimatedOutputFiles > 6) { riskFactors.push(`${score.estimatedOutputFiles} output files`); }
  if (score.estimatedLOC > 500) { riskFactors.push(`~${score.estimatedLOC} LOC target`); }

  const suggestedSplits = suggestSplits(instructions, score);

  if (score.score > DECOMPOSE_THRESHOLD) {
    return {
      shouldDecompose: true,
      warningMessage: [
        `⚠️ HIGH COMPLEXITY (score: ${score.score}): This job has high risk of incomplete AI output.`,
        `Risk factors: ${riskFactors.join(', ')}.`,
        `Recommendation: Split into ${suggestedSplits.length || '2+'} sub-jobs to reduce context pressure.`,
      ].join(' '),
      suggestedSplits,
    };
  }

  return {
    shouldDecompose: false,
    warningMessage: [
      `⚠️ ELEVATED COMPLEXITY (score: ${score.score}): This job may produce incomplete output.`,
      `Risk factors: ${riskFactors.join(', ')}.`,
      `Consider splitting at logical boundaries for more reliable results.`,
    ].join(' '),
    suggestedSplits,
  };
}

/**
 * Analyze instructions for logical split boundaries.
 */
function suggestSplits(instructions: string, score: ComplexityScore): string[] {
  const splits: string[] = [];

  // Look for numbered steps or file groupings
  const numberedSteps = instructions.match(/^\s*\d+\.\s+.+$/gm);
  if (numberedSteps && numberedSteps.length >= 3) {
    // Group by concept (crypto first, then composition, then tests)
    if (score.hasCryptoWork) {
      splits.push('Sub-job 1: Core crypto/encryption implementation + unit tests');
    }
    if (score.hasProtocolWork) {
      splits.push(`Sub-job ${splits.length + 1}: Protocol/streaming implementation + unit tests`);
    }
    if (score.hasStateMachine) {
      splits.push(`Sub-job ${splits.length + 1}: State machine/lifecycle implementation + unit tests`);
    }
    if (splits.length === 0) {
      // Generic split by numbered steps
      const half = Math.ceil(numberedSteps.length / 2);
      splits.push(`Sub-job 1: Steps 1-${half}`);
      splits.push(`Sub-job 2: Steps ${half + 1}-${numberedSteps.length}`);
    }
    if (score.estimatedTestCases > 5) {
      splits.push(`Sub-job ${splits.length + 1}: Integration tests + validation`);
    }
  }

  return splits;
}
