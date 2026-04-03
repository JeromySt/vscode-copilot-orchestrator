/**
 * @fileoverview Analysis Module Barrel Export
 *
 * Re-exports job complexity scoring utilities used for back-pressure
 * warnings during plan scaffolding.
 *
 * @module plan/analysis
 */

export { scoreComplexity, evaluateComplexity, WARN_THRESHOLD, DECOMPOSE_THRESHOLD } from './complexityScorer';
export type { ComplexityScore, DecompositionSuggestion } from './complexityScorer';
