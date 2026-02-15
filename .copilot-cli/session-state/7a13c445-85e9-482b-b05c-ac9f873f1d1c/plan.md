# Test Coverage Enhancement Plan: Merge Phase Executors

## Current Status
- TypeScript errors: Fixed
- Task: Enhance test coverage for 4 merge phase executor files to achieve 95%+

## Files to Enhance
1. `commitPhase.ts` (33.67% → 95%+) - Has tests, needs expansion
2. `mergeFiPhase.ts` (58.89% → 95%+) - Has tests, needs expansion  
3. `mergeRiPhase.ts` (27.72% → 95%+) - Has tests, needs expansion
4. `mergeHelper.ts` (34.37% → 95%+) - Missing test file completely

## Test Strategy

### 1. commitPhase.ts additional test cases:
- Git status edge cases (no dirty files, ignored files handling)
- AI review with parsing failures
- Error handling for git operations
- Different evidence file scenarios

### 2. mergeFiPhase.ts additional test cases:
- Multiple dependency commits
- Merge failure scenarios
- Error handling in merge operations
- Metrics accumulation

### 3. mergeRiPhase.ts additional test cases:
- Stash/checkout/restore flow scenarios
- Push failure handling
- updateBranchRef failure scenarios
- More comprehensive conflict resolution paths

### 4. mergeHelper.ts (new file needed):
- Copilot CLI invocation with different parameters
- Instruction file generation
- Timeout handling
- Error scenarios with metrics

## Implementation Plan
1. Run current tests to establish baseline
2. Check current coverage for each file
3. Create missing mergeHelper tests
4. Enhance existing test files systematically
5. Verify 95%+ coverage achieved
6. Run full test suite to ensure no regressions