# Verify and Fix Tests Task Plan

## Overview
Fix tests after recent changes to the execution engine's merge methods and add tests for new phase executors.

## Steps

### Step 1: Compile Check
- Run `npx tsc --noEmit` to identify type errors
- Fix any compilation issues

### Step 2: Test Execution  
- Run `npm test` to identify failing tests
- Analyze failures related to merge method changes

### Step 3: Fix Broken Tests
- Update tests that mock removed merge methods:
  - `src/test/unit/plan/executionEngine.unit.test.ts`
  - `src/test/unit/plan/executor.test.ts` 
  - Any tests stubbing `forwardIntegrateMerge` or `reverseIntegrateMerge`

### Step 4: Add New Tests
- Add smoke tests for new phase executors:
  - `MergeFiPhaseExecutor` (clean merge, conflict with resolution)
  - `MergeRiPhaseExecutor` (no changes skip, clean merge, conflict with resolution)

### Step 5: Final Verification
- Ensure `npx tsc --noEmit` passes
- Ensure `npm test` passes with no failures
- Commit changes

## Current Status
Starting Step 1...