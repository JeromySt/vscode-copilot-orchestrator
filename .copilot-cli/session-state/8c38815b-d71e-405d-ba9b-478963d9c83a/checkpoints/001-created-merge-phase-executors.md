<overview>
The user requested completion of a task to create merge phase executors, moving merge-FI and merge-RI phases from executionEngine.ts into proper phase executors within the executor's phase pipeline. This refactoring enables process monitoring, ActiveExecution tracking, and consistent step status reporting for merge operations. The approach involved extracting existing merge logic into dedicated phase executor classes while preserving all functionality and integrating with the existing phase pipeline system.
</overview>

<history>
1. The user asked to complete the task described in orchestrator-job-4daf324a.instructions.md
   - Read the instruction file detailing the creation of merge phase executors
   - Analyzed existing code structure including executionEngine.ts merge methods and IPhaseExecutor interface
   - Created a plan and used SQL todos to track progress through 8 main steps

2. Extended interfaces and created shared utilities
   - Extended PhaseContext interface with merge-specific fields (dependencyCommits, repoPath, targetBranch, etc.)
   - Created mergeHelper.ts with shared resolveMergeConflictWithCopilot function for both phases
   - Fixed TypeScript compilation errors related to interface changes and untyped function calls

3. Created the merge phase executors
   - Implemented MergeFiPhaseExecutor for forward integration (merging dependency commits into worktree)
   - Implemented MergeRiPhaseExecutor for reverse integration (merging completed work to target branch)
   - Both executors implement IPhaseExecutor interface and use PhaseContext for process tracking

4. Updated the execution pipeline
   - Modified executor.ts to include merge-fi and merge-ri in the phase order
   - Extended ExecutionContext type with merge-specific fields
   - Updated phase pipeline to pass merge context data to executors
   - Updated exports from phases/index.ts

5. Verified and committed changes
   - Ran TypeScript compilation which passed successfully
   - Attempted to run tests but encountered VS Code update issue
   - Committed all changes with descriptive commit message
   - Started removing old merge methods from executionEngine.ts (partially completed)
</history>

<work_done>
Files created:
- src/plan/phases/mergeHelper.ts - Shared merge conflict resolution utility
- src/plan/phases/mergeFiPhase.ts - Forward integration merge phase executor
- src/plan/phases/mergeRiPhase.ts - Reverse integration merge phase executor

Files modified:
- src/interfaces/IPhaseExecutor.ts - Extended PhaseContext with merge-specific fields
- src/plan/phases/index.ts - Added exports for new merge executors and helper
- src/plan/executor.ts - Updated phase order and pipeline to include merge phases
- src/plan/types/plan.ts - Extended ExecutionContext with merge parameters
- src/plan/executionEngine.ts - Updated context passing, partially removed old merge methods

Work completed:
- [x] Analyzed current code structure and requirements
- [x] Extended PhaseContext interface with merge fields
- [x] Created shared merge helper utility with process tracking
- [x] Implemented MergeFiPhaseExecutor with dependency merge logic
- [x] Implemented MergeRiPhaseExecutor with target branch merge logic
- [x] Updated executor pipeline to include new merge phases
- [x] Extended ExecutionContext with merge-specific data
- [x] Updated module exports
- [x] Verified TypeScript compilation
- [x] Committed changes
- [ ] Remove remaining old merge methods from executionEngine.ts (in progress)
</work_done>

<technical_details>
- ExecutionPhase type already included 'merge-fi' and 'merge-ri' phases, along with proper step status tracking
- Forward Integration (FI) merges additional dependency commits into the worktree after the base commit
- Reverse Integration (RI) merges completed leaf node work back to the target branch
- The merge conflict resolution uses Copilot CLI with specialized instructions for conflict resolution only
- PhaseContext.setProcess() is critical for tracking spawned Copilot CLI processes for cancellation/monitoring
- The executor pipeline runs phases in order: merge-fi, prechecks, work, commit, postchecks, merge-ri
- Dependency acknowledgment logic remains in executionEngine.ts to handle cleanup timing correctly
- Config manager methods needed to drop type parameters (getConfig vs getConfig<T>) to avoid compilation errors
- The hasChangesBetween method exists in git.repository for diff checking (not hasDiff)
- CopilotCliLogger interface was not exported, required direct object creation instead
</technical_details>

<important_files>
- src/plan/phases/mergeFiPhase.ts
  - Implements forward integration merge logic extracted from mergeSourcesIntoWorktree
  - Handles merging multiple dependency commits with conflict resolution
  - Lines 65-90 contain main merge loop with Copilot CLI integration

- src/plan/phases/mergeRiPhase.ts  
  - Implements reverse integration merge logic extracted from mergeLeafToTarget
  - Handles merge-tree operations and conflict resolution for target branch merges
  - Lines 67-75 contain diff checking, lines 85-140 handle conflict-free merges

- src/plan/phases/mergeHelper.ts
  - Shared conflict resolution utility using Copilot CLI
  - Lines 86-118 contain the CLI runner setup and process tracking
  - Provides merge-specific instructions for conflict resolution

- src/plan/executor.ts
  - Updated phase pipeline to include merge phases
  - Lines 103-105 define new phase order including merge-fi and merge-ri
  - Lines 125-141 implement merge-fi phase execution
  - Lines 189-203 implement merge-ri phase execution

- src/plan/executionEngine.ts
  - Partially updated to remove old merge methods (mergeLeafToTarget removed)
  - Lines 335-355 show updated ExecutionContext creation with merge data
  - Still contains mergeSourcesIntoWorktree, resolveMergeConflictWithCopilot, mergeWithConflictResolution methods to be removed
</important_files>

<next_steps>
Remaining work:
- Remove remaining old merge methods from executionEngine.ts:
  - mergeSourcesIntoWorktree (starts around line 1500)
  - resolveMergeConflictWithCopilot (starts around line 1609)  
  - mergeWithConflictResolution (starts around line 1707)
- Test the implementation to ensure merge phases work correctly
- Verify that process monitoring and tracking work as expected

Immediate next steps:
- Continue removing old merge methods from executionEngine.ts systematically
- Remove any references to the deleted methods
- Run tests once VS Code update issue is resolved
- Verify end-to-end functionality of the new merge phase pipeline
</next_steps>