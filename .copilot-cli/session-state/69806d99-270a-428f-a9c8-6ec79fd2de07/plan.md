# Test Coverage Improvement Plan

## Objective
Improve test coverage for 6 low-coverage files to reach 95%+ target coverage.

## Files to Cover

1. **src/git/DefaultGitOperations.ts** (60.94% → 95%+)
   - Pattern: Delegation tests - verify pass-through to underlying functions

2. **src/plan/workSummaryHelper.ts** (52.05% → 95%+)  
   - Pattern: Aggregation logic, edge cases (empty commits, no changes)

3. **src/mcp/handlers/plan/createPlanHandler.ts** (61.35% → 95%+)
   - Pattern: Validation logic, group flattening, dependency resolution, error paths

4. **src/core/powerManager.ts** (77.72% → 95%+)
   - Pattern: Hibernate detection, sleep/wake cycles, process monitoring integration

5. **src/process/processMonitor.ts** (83.27% → 95%+)
   - Pattern: Snapshot gathering, tree building, PID tracking edge cases

6. **src/mcp/handlers/utils.ts** (73.16% → 95%+)
   - Pattern: Branch resolution, plan/node lookup helpers

## Approach
1. Read source code for each file
2. Examine existing tests
3. Add targeted tests for uncovered paths
4. Use sinon stubs for external dependencies
5. Follow Mocha TDD patterns (suite/test)

## Verification
- `npm run compile:tsc` then `npm run test:unit` must pass
- `npm run test:coverage` to verify 95%+ coverage reached