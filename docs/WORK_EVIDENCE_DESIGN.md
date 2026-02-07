# Work Evidence Design

## Problem Statement

Work nodes must produce evidence that results in a commit. Currently, nodes that make no file changes can incorrectly succeed if an agent exits cleanly without doing work. The existing validation in `commitChanges()` (`src/plan/executor.ts:878-923`) catches the case where there are literally no commits and no uncommitted changes, but it cannot distinguish between "node legitimately has nothing to commit" and "node silently failed to produce output."

Some node types legitimately produce no file changes (e.g., a validation-only node, a node that updates an external system). These nodes currently fail with: `"No commits made and no uncommitted changes found. The job produced no work."` — which is correct for most work nodes but wrong for intentionally side-effect-free nodes.

## Goals

1. **Nodes that should produce changes MUST produce evidence** — file modifications that result in a commit, or an explicit evidence file.
2. **Nodes that intentionally produce no changes can declare this** via `expectsNoChanges: true`.
3. **Evidence validation is centralized** in the commit phase, keeping the rest of the executor pipeline unchanged.
4. **The system is testable** — evidence validation is behind an interface for DI.

## Current Flow (Baseline)

```
execute()                               src/plan/executor.ts:105
  ├─ prechecks (optional)               :134
  ├─ work (shell/process/agent)         :163
  ├─ postchecks (optional)              :218
  └─ commitChanges()                    :257
       ├─ hasUncommittedChanges()?      :903
       │   YES → stageAll + commit      :927-932
       │   NO  → HEAD != baseCommit?    :913
       │          YES → return HEAD     :916
       │          NO  → FAIL            :920
       └─ computeWorkSummary()          :278
```

**Gap:** There is no mechanism for a node to declare "I intentionally produce no changes" or to produce a lightweight evidence artifact that proves work was done without modifying tracked files.

---

## Design

### 1. New Node Spec Property: `expectsNoChanges`

Add an optional boolean to `JobNodeSpec` (`src/plan/types/nodes.ts:79`):

```typescript
export interface JobNodeSpec {
  // ... existing properties ...

  /**
   * When true, this node is expected to produce no file changes.
   * The commit phase will succeed with an empty commit instead of failing.
   * Use for validation-only nodes, external-system updates, or analysis tasks.
   */
  expectsNoChanges?: boolean;
}
```

This propagates to the internal `JobNode` type. The executor reads it during `commitChanges()`.

**Behavior when `expectsNoChanges: true`:**
- If there are no uncommitted changes AND no commits since `baseCommit`, the node **succeeds** with no commit (returns `{ success: true, commit: undefined }`).
- If there ARE changes, the node still commits them normally (the flag is permissive, not prohibitive).
- `workSummary` is populated with zero counts and a note: `"Node declared expectsNoChanges"`.

### 2. Evidence Files

Agents or scripts that perform work but don't modify tracked source files can drop an **evidence file** to prove work was done. This is the escape hatch for nodes that do real work but whose output isn't source code (e.g., sending a notification, updating a database, running an analysis).

#### Evidence Directory

```
.orchestrator/evidence/
```

This directory lives in the worktree root. It is **gitignored in the repository** but **not gitignored in worktrees** — the executor explicitly stages it before the commit check.

#### Evidence File Format

```
.orchestrator/evidence/<nodeId>.json
```

```typescript
interface EvidenceFile {
  /** Schema version for forward compatibility */
  version: 1;

  /** Node ID that produced this evidence */
  nodeId: string;

  /** ISO 8601 timestamp of evidence creation */
  timestamp: string;

  /** What the node did — required, shown in work summary */
  summary: string;

  /** Structured outcome data (node-type-specific) */
  outcome?: Record<string, unknown>;

  /**
   * Evidence type classification.
   * - "file_changes": Normal code changes (default, no evidence file needed)
   * - "external_effect": Work affected an external system
   * - "analysis": Work produced analysis/report but no code changes
   * - "validation": Work validated state without modifying it
   */
  type?: 'file_changes' | 'external_effect' | 'analysis' | 'validation';
}
```

**Example:**

```json
{
  "version": 1,
  "nodeId": "deploy-staging",
  "timestamp": "2026-02-07T16:00:00.000Z",
  "summary": "Deployed build #1234 to staging environment",
  "type": "external_effect",
  "outcome": {
    "environment": "staging",
    "buildId": "1234",
    "url": "https://staging.example.com"
  }
}
```

The evidence file itself constitutes a file change, so it will be committed by the normal `stageAll() + commit()` path. No special handling is needed beyond checking for its existence as an alternative to source file changes.

### 3. Validation Logic Changes

The `commitChanges()` method in `DefaultJobExecutor` (`src/plan/executor.ts:881`) is modified to implement a three-tier evidence check:

```
commitChanges(node, worktreePath, executionKey, baseCommit)
  │
  ├─ hasUncommittedChanges?
  │   YES → stageAll + commit (existing path, unchanged)
  │
  ├─ HEAD != baseCommit?
  │   YES → return HEAD (existing path, unchanged)
  │
  ├─ evidenceFileExists?                          ◄── NEW
  │   YES → stageAll + commit (evidence file is the change)
  │
  ├─ node.expectsNoChanges?                       ◄── NEW
  │   YES → return { success: true, commit: undefined }
  │
  └─ FAIL: "No work evidence produced"            ◄── UPDATED message
```

#### Pseudocode

```typescript
private async commitChanges(
  node: JobNode,
  worktreePath: string,
  executionKey: string,
  baseCommit: string
): Promise<{ success: boolean; commit?: string; error?: string }> {
  
  const hasChanges = await git.repository.hasUncommittedChanges(worktreePath);
  
  if (!hasChanges) {
    // Check for commits made during work stage
    const head = await git.worktrees.getHeadCommit(worktreePath);
    if (head && head !== baseCommit) {
      return { success: true, commit: head };
    }
    
    // NEW: Check for evidence file
    const hasEvidence = await this.evidenceValidator.hasEvidenceFile(
      worktreePath, node.id
    );
    if (hasEvidence) {
      this.logInfo(executionKey, 'commit', 'Evidence file found, staging...');
      await git.repository.stageAll(worktreePath);
      const message = `[Plan] ${node.task} (evidence only)`;
      await git.repository.commit(worktreePath, message);
      const commit = await git.worktrees.getHeadCommit(worktreePath);
      return { success: true, commit: commit || undefined };
    }
    
    // NEW: Check expectsNoChanges flag
    if (node.expectsNoChanges) {
      this.logInfo(executionKey, 'commit', 
        'Node declares expectsNoChanges — succeeding without commit');
      return { success: true, commit: undefined };
    }
    
    // No evidence — fail
    const error = 
      'No work evidence produced. The node must either:\n' +
      '  1. Modify files (results in a commit)\n' +
      '  2. Create an evidence file at .orchestrator/evidence/<nodeId>.json\n' +
      '  3. Declare expectsNoChanges: true in the node spec';
    return { success: false, error };
  }
  
  // Normal path: stage + commit (unchanged)
  await git.repository.stageAll(worktreePath);
  const message = `[Plan] ${node.task}`;
  await git.repository.commit(worktreePath, message);
  const commit = await git.worktrees.getHeadCommit(worktreePath);
  return { success: true, commit: commit || undefined };
}
```

### 4. Error Messages for Agents

When a node fails evidence validation, the error message must be actionable for both human operators and AI agents that may retry the node.

#### Failure Message (No Evidence)

```
No work evidence produced. The node must either:
  1. Modify files (results in a commit)
  2. Create an evidence file at .orchestrator/evidence/<nodeId>.json
  3. Declare expectsNoChanges: true in the node spec

Node: <nodeId> (<nodeName>)
Task: <node.task>
Worktree: <worktreePath>
```

#### Agent Instructions Addendum

When the executor detects that work is being delegated to an agent (`AgentSpec`), the agent's instructions should include guidance about evidence. This is injected into the system prompt or task file:

```markdown
## Work Evidence

Your changes must result in at least one modified, added, or deleted file.
If your task does not require file changes (e.g., analysis, validation),
create an evidence file:

Path: .orchestrator/evidence/<nodeId>.json
Format:
{
  "version": 1,
  "nodeId": "<nodeId>",
  "timestamp": "<ISO 8601>",
  "summary": "<what you did>",
  "type": "analysis" | "validation" | "external_effect"
}
```

### 5. Interface Design for DI/Testing

#### IEvidenceValidator Interface

```typescript
/**
 * Validates that a work node produced evidence of work.
 * Extracted as an interface for dependency injection and testing.
 */
export interface IEvidenceValidator {
  /**
   * Check whether an evidence file exists for the given node.
   * 
   * @param worktreePath - Root of the worktree
   * @param nodeId - Node identifier
   * @returns true if .orchestrator/evidence/<nodeId>.json exists and is valid
   */
  hasEvidenceFile(worktreePath: string, nodeId: string): Promise<boolean>;

  /**
   * Read and parse the evidence file for a node.
   * Returns undefined if the file doesn't exist or is invalid.
   */
  readEvidence(worktreePath: string, nodeId: string): Promise<EvidenceFile | undefined>;

  /**
   * Perform the full evidence validation check.
   * Called during the commit phase after determining there are no 
   * uncommitted changes and no commits since baseCommit.
   * 
   * @returns ValidationResult indicating pass/fail and reason
   */
  validate(
    worktreePath: string,
    nodeId: string,
    expectsNoChanges: boolean
  ): Promise<EvidenceValidationResult>;
}

interface EvidenceValidationResult {
  /** Whether evidence validation passed */
  valid: boolean;
  
  /** Why validation passed or failed */
  reason: string;
  
  /** The evidence file contents, if one was found */
  evidence?: EvidenceFile;
  
  /** How the node satisfied evidence requirements */
  method?: 'file_changes' | 'evidence_file' | 'expects_no_changes' | 'none';
}
```

#### Default Implementation

```typescript
// src/plan/evidenceValidator.ts

export class DefaultEvidenceValidator implements IEvidenceValidator {
  private readonly evidenceDir = '.orchestrator/evidence';

  async hasEvidenceFile(worktreePath: string, nodeId: string): Promise<boolean> {
    const filePath = path.join(worktreePath, this.evidenceDir, `${nodeId}.json`);
    return fs.existsSync(filePath);
  }

  async readEvidence(
    worktreePath: string, 
    nodeId: string
  ): Promise<EvidenceFile | undefined> {
    const filePath = path.join(worktreePath, this.evidenceDir, `${nodeId}.json`);
    if (!fs.existsSync(filePath)) return undefined;

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as EvidenceFile;
      
      // Basic schema validation
      if (parsed.version !== 1) return undefined;
      if (!parsed.nodeId || !parsed.timestamp || !parsed.summary) return undefined;
      
      return parsed;
    } catch {
      return undefined;
    }
  }

  async validate(
    worktreePath: string,
    nodeId: string,
    expectsNoChanges: boolean
  ): Promise<EvidenceValidationResult> {
    // Check for evidence file
    const evidence = await this.readEvidence(worktreePath, nodeId);
    if (evidence) {
      return {
        valid: true,
        reason: `Evidence file found: ${evidence.summary}`,
        evidence,
        method: 'evidence_file',
      };
    }

    // Check expectsNoChanges flag
    if (expectsNoChanges) {
      return {
        valid: true,
        reason: 'Node declares expectsNoChanges',
        method: 'expects_no_changes',
      };
    }

    // No evidence
    return {
      valid: false,
      reason: 'No work evidence produced',
      method: 'none',
    };
  }
}
```

#### Integration with DefaultJobExecutor

The `DefaultJobExecutor` receives an `IEvidenceValidator` via constructor or setter injection, matching the existing pattern used for `agentDelegator`:

```typescript
export class DefaultJobExecutor implements JobExecutor {
  private evidenceValidator: IEvidenceValidator;

  constructor(evidenceValidator?: IEvidenceValidator) {
    this.evidenceValidator = evidenceValidator ?? new DefaultEvidenceValidator();
  }

  // ... or via setter, matching existing pattern:
  setEvidenceValidator(validator: IEvidenceValidator): void {
    this.evidenceValidator = validator;
  }
}
```

### 6. Work Summary Integration

When a node succeeds via evidence file or `expectsNoChanges`, the `computeWorkSummary()` method (`src/plan/executor.ts:989`) should reflect this:

```typescript
// For evidence-file nodes:
{
  nodeId: "deploy-staging",
  nodeName: "Deploy to Staging",
  commits: 1,
  filesAdded: 1,            // the evidence file itself
  filesModified: 0,
  filesDeleted: 0,
  description: "Deployed build #1234 to staging environment",
  commitDetails: [/* normal commit detail for the evidence commit */]
}

// For expectsNoChanges nodes:
{
  nodeId: "validate-schema",
  nodeName: "Validate Schema",
  commits: 0,
  filesAdded: 0,
  filesModified: 0,
  filesDeleted: 0,
  description: "Node declared expectsNoChanges",
  commitDetails: []
}
```

The `NodeExecutionState.completedCommit` (`src/plan/types/plan.ts:78`) will be:
- **Set** for evidence-file nodes (they produce a real commit).
- **Undefined** for `expectsNoChanges` nodes (no commit to reference).

This means `expectsNoChanges` nodes cannot participate in Forward Integration (FI) merges as sources — which is correct, since they have no changes to merge. The plan runner's FI logic (`mergeSourcesIntoWorktree`) already handles `undefined` completed commits by skipping the source.

---

## File Changes Summary

| File | Change |
|------|--------|
| `src/plan/types/nodes.ts` | Add `expectsNoChanges?: boolean` to `JobNodeSpec` and `JobNode` |
| `src/plan/types/plan.ts` | Add `EvidenceFile` and `EvidenceValidationResult` types |
| `src/plan/evidenceValidator.ts` | New file: `DefaultEvidenceValidator` implementing `IEvidenceValidator` |
| `src/interfaces/IEvidenceValidator.ts` | New file: `IEvidenceValidator` interface |
| `src/interfaces/index.ts` | Re-export `IEvidenceValidator` |
| `src/plan/executor.ts` | Modify `commitChanges()` to use `IEvidenceValidator` |
| `src/agent/agentDelegator.ts` | Add evidence instructions to agent system prompts |

## Migration & Backward Compatibility

- **No breaking changes.** `expectsNoChanges` defaults to `undefined`/`false`. Existing plans behave identically.
- The evidence file path `.orchestrator/evidence/` is new and won't conflict with existing files.
- The error message for "no work produced" changes from a single line to a multi-line actionable message. This is a non-breaking UX improvement.

## Testing Strategy

1. **Unit tests for `DefaultEvidenceValidator`:**
   - `hasEvidenceFile` returns `true`/`false` based on file existence
   - `readEvidence` parses valid JSON, rejects invalid schemas
   - `validate` returns correct results for each method type

2. **Unit tests for modified `commitChanges()`:**
   - Mock `IEvidenceValidator` to test each branch:
     - Normal file changes → commit (existing behavior)
     - Agent commits during work → return HEAD (existing behavior)
     - Evidence file present, no other changes → stage + commit
     - `expectsNoChanges: true`, no changes → succeed without commit
     - No evidence, no changes, no flag → fail with actionable error

3. **Integration tests:**
   - End-to-end plan with a mix of normal nodes, evidence-only nodes, and `expectsNoChanges` nodes
   - Verify FI merge correctly skips `expectsNoChanges` sources
   - Verify RI merge works with evidence-only commits
