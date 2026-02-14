# Create Merge Phase Executors

## Task Overview
Move merge-FI and merge-RI phases from executionEngine.ts into proper phase executors to get:
- Process monitoring
- ActiveExecution tracking  
- Consistent step status reporting

## Steps to Complete

1. **Analyze existing code structure**
   - Examine current executionEngine.ts merge methods
   - Review IPhaseExecutor interface and existing phase implementations
   - Understand PhaseContext structure

2. **Extend PhaseContext interface**
   - Add fields for dependency commits (FI phase)
   - Add fields for RI merge parameters

3. **Create MergeFiPhaseExecutor** 
   - Extract forwardIntegrateMerge() logic
   - Implement IPhaseExecutor interface
   - Use ctx.setProcess() for copilot spawning

4. **Create MergeRiPhaseExecutor**
   - Extract reverseIntegrateMerge() and mergeWithConflictResolution() logic  
   - Implement IPhaseExecutor interface

5. **Create merge helper utility**
   - Extract resolveMergeConflictWithCopilot() as shared utility

6. **Update executor pipeline**
   - Change phase order to include merge-fi and merge-ri
   - Wire new executors in phaseDeps()

7. **Update executionEngine.ts**
   - Remove extracted methods
   - Update executeJobNode() to use full pipeline

8. **Update exports and verify**
   - Export new executors from phases/index.ts
   - Run tsc --noEmit and tests

## Current Status
Starting analysis phase