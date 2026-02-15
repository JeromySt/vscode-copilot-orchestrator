# Instruction Enrichment Pipeline

## Overview

Copilot CLI **natively discovers** `.github/skills/*/SKILL.md` and auto-loads skills whose
`description` matches the current prompt. The orchestrator does not need to build a skill
registry, do keyword matching, or inject skill content into instruction files. Copilot
handles all of that.

The orchestrator's only job is to **maximize the chance that skills trigger**. It does this
by augmenting AgentSpec instructions at plan creation time — a single Copilot CLI call
reviews all AgentSpecs in the plan and rewrites their descriptions to include phrases that
align with the repo's skill descriptions.

### How Copilot CLI Loads Skills (Native Behavior)

```
Level 1 — Discovery:  Reads name + description from every .github/skills/*/SKILL.md
Level 2 — Loading:    When prompt matches a skill description, loads the SKILL.md body
Level 3 — Resources:  Accesses scripts/examples in the skill directory only when referenced
```

Skills can also be invoked explicitly via `/skill-name` slash commands, but the primary
mechanism is automatic description-based matching.

### Design Principles

1. **Let Copilot do the matching.** The orchestrator never decides which skills are relevant.
   Copilot CLI's built-in description matching handles skill selection at runtime.
2. **Augment once, at plan creation.** A single Copilot CLI call reviews all AgentSpecs and
   enriches their instructions with terms that will trigger the right skills. This happens
   once per plan, not per node, and operates over all specs in a single batch.
3. **WorkSpec controls augmentation.** The `augmentInstructions` flag lives on each
   `AgentSpec`, not on the plan. It defaults to `true`. MCP clients can set it to `false`
   per-node for full control. Non-agent workSpecs (ProcessSpec, ShellSpec) are never
   candidates for augmentation.

## Architecture

```
MCP Client                    Orchestrator                      Copilot CLI
    │                              │                                 │
    │  CreatePlan / UpdatePlan     │                                 │
    │  { nodes: [                  │                                 │
    │    { workSpec: AgentSpec,    │                                 │
    │      augmentInstructions:    │                                 │
    │      true },                 │                                 │
    │    { workSpec: ShellSpec },  │  ← excluded from augmentation  │
    │    { workSpec: AgentSpec,    │                                 │
    │      augmentInstructions:    │                                 │
    │      false },                │  ← excluded (opted out)        │
    │  ]}                          │                                 │
    │─────────────────────────────>│                                 │
    │                              │                                 │
    │                              │  1. Filter: collect AgentSpec   │
    │                              │     nodes where augment ≠ false │
    │                              │                                 │
    │                              │  2. Read .github/skills/*/SKILL.md
    │                              │     frontmatter (names + descriptions)
    │                              │                                 │
    │                              │  3. Single CLI call with        │
    │                              │     filtered agents + skills    │
    │                              │────────────────────────────────>│
    │                              │                                 │
    │                              │  4. Apply augmented instructions│
    │                              │     back to matching nodes      │
    │                              │<────────────────────────────────│
    │                              │                                 │
    │                              │  5. Save plan (all nodes,       │
    │                              │     some with augmented instr.) │
    │                              │                                 │
    │  { planId, nodes: [...] }    │                                 │
    │<─────────────────────────────│                                 │

              ... later, at execution time ...

    Copilot CLI (in worktree)
         │
         │  Discovers .github/skills/ (inherited from repo via worktree)
         │  Matches augmented instructions against skill descriptions
         │  Auto-loads relevant skills into context
         │  Executes task with full skill knowledge
```

## MCP API

### AgentSpec.augmentInstructions

The `augmentInstructions` flag lives on the **AgentSpec workSpec**, not on the plan. This
is because plans can contain a mix of agent, process, and shell workSpecs — only agent
workSpecs benefit from augmentation, and each can opt in/out independently.

```typescript
interface AgentSpec {
  type: 'agent';
  instructions: string;              // Augmented instructions (used at runtime)
  originalInstructions?: string;     // Pre-augmentation snapshot (set by orchestrator)
  context?: string;
  augmentInstructions?: boolean;     // Default: true
  // ... other AgentSpec fields
}

interface ProcessSpec {
  type: 'process';
  command: string;
  // No augmentInstructions — not applicable
}

interface ShellSpec {
  type: 'shell';
  script: string;
  // No augmentInstructions — not applicable
}
```

When augmentation runs, the orchestrator:
1. Copies `instructions` → `originalInstructions` before augmenting
2. Replaces `instructions` with the augmented version
3. The UI can diff `originalInstructions` vs `instructions` to show what changed

If `augmentInstructions` is `false` or no skills exist, `originalInstructions` is never set
(it remains `undefined`), signaling to the UI that no augmentation occurred.

### Plan Creation / Update / Node Update Flow

Augmentation is triggered by any MCP API that accepts an AgentSpec workSpec:

| MCP Method | Augmentation Behavior |
|---|---|
| `create_copilot_plan` | Batch — all opted-in AgentSpec nodes in one CLI call |
| `update_copilot_plan` | Batch — all opted-in AgentSpec nodes being updated in one CLI call |
| `update_copilot_plan_node` | Single — the one AgentSpec node being updated (if opted in) |

> **API Simplification**: The `create_copilot_job` and `create_copilot_node` MCP methods
> are removed in favor of `create_copilot_plan` and `update_copilot_plan`. A single-node
> plan is just a plan with one node — the "job" shorthand added no value and complicated
> the API surface. All plan/node creation goes through the plan-level APIs.

**Batch flow** (CreatePlan / UpdatePlan):

1. Orchestrator collects all nodes whose workSpec is `AgentSpec` **and**
   `augmentInstructions !== false` (default is `true`)
2. If the filtered list is empty, skip augmentation entirely
3. If skills exist in `.github/skills/`, snapshot each filtered node's `instructions`
   into `originalInstructions`, then make a **single** Copilot CLI call with the
   filtered AgentSpec nodes + skill descriptions
4. Apply augmented instructions back to the matching nodes' `instructions` field
5. Save the plan (with both `instructions` and `originalInstructions` persisted)

**Single-node flow** (UpdatePlanNode):

1. If the node's workSpec is `AgentSpec` and `augmentInstructions !== false`:
   - Snapshot `instructions` → `originalInstructions`
   - Make a single CLI call with just this one node + skill descriptions
   - Apply augmented instructions
2. If the node is not an AgentSpec or `augmentInstructions` is `false`, save as-is

Nodes with `augmentInstructions: false`, or with non-agent workSpecs (ProcessSpec, ShellSpec),
are never sent to the augmentation call and are saved as-is.

## Augmentation Call

### Input: Filtered AgentSpecs + Skill Descriptions

The orchestrator sends **only** the opted-in AgentSpec nodes to the CLI call. Non-agent
nodes and opted-out agent nodes are excluded from the payload entirely.

```typescript
interface AugmentationInput {
  skills: Array<{ name: string; description: string }>;
  agents: Array<{
    id: string;
    title: string;
    instructions: string;
  }>;
}
```

The `agents` array contains only AgentSpec nodes where `augmentInstructions !== false`.
The response maps `id` → augmented `instructions`, which the orchestrator applies back
to the corresponding plan nodes before saving.

### Augmentation Prompt

```
You are rewriting task instructions for AI coding agents to maximize alignment with
the repository's available skills. Your goal is to rephrase existing instructions so
that Copilot's skill-matching will trigger the correct skills at runtime.

## Available Skills
{{#each skills}}
- **{{name}}**: {{description}}
{{/each}}

## Agent Tasks
```json
{{json agents}}
```

## Rules
1. DO NOT add new work, scope, or requirements — if the task doesn't call for unit tests,
   don't add unit tests. If it doesn't mention security, don't add security checks.
2. DO rephrase, restructure, or add terminology from matching skill descriptions so that
   skills which are already relevant to the task's intent will trigger reliably
3. Only align with skills that genuinely match what the task already asks for
4. Preserve the exact same deliverable — the agent should produce the same output
5. Return ONLY nodes whose instructions were actually modified

## Output Format
Return a JSON array: [{ "id": "node-id", "instructions": "rewritten text" }, ...]
Only include nodes whose instructions were modified.
```

### Example

**Before augmentation:**
```json
{
  "id": "fix-login",
  "instructions": "Fix the login form validation bug where empty email passes"
}
```

**After augmentation** (with `security-hardener` skill in repo whose description mentions
"input validation" and "sanitization"):
```json
{
  "id": "fix-login",
  "instructions": "Fix the login form input validation bug where empty email bypasses sanitization checks"
}
```

The rephrased instructions ("input validation", "sanitization checks") align with the
`security-hardener` skill description, causing Copilot CLI to auto-load that skill. Note
that no new work was added — the task is still "fix the validation bug", just rephrased
to trigger the relevant skill.

### Anti-Recursion Safeguards

1. **Direct CLI call** — not orchestrated. No plan, no phases, no auto-heal.
2. **`--max-turns 1`** — single generation, no tool use loops
3. **Environment flag** `ORCHESTRATOR_AUGMENTATION=true` — checked before augmenting;
   if already set, skip (prevents nesting)
4. **Hard timeout**: 30 seconds. On timeout or error, plan saves with original instructions.
5. **JSON validation**: Output must parse as valid JSON array with `id` + `instructions` fields.
   On parse failure, fall back to original instructions.

## Projected Orchestrator Skill

The orchestrator has worktree-specific context that doesn't belong in the user's repository
but should be available to Copilot CLI at runtime. This is projected as a temporary skill.

### Setup Phase

```
merge-fi → setup → prechecks → work → commit → postchecks → merge-ri → cleanup
```

The **setup** phase writes `.github/skills/.orchestrator/SKILL.md` into the worktree.
Copilot CLI discovers it alongside repo skills via its native Level 1 scan.

```markdown
---
name: orchestrator-worktree-context
description: >
  Context about the orchestrator worktree environment.
  Always use when working in an orchestrator-managed worktree.
---

# Orchestrator Worktree Context

You are working inside an isolated git worktree managed by Copilot Orchestrator.

## Environment
- **Worktree path**: {ctx.worktreePath}
- **Base branch**: {ctx.baseBranch}
- **Node ID**: {ctx.nodeId}
- **Plan ID**: {ctx.planId}

## Rules
1. Do not run `git checkout`, `git switch`, or `git push` — the orchestrator manages branches
2. Stage and commit all changes when your work is complete
3. Do not modify files outside this worktree — you are sandboxed
4. Shared directories (node_modules, .vscode) are symlinked — do not delete them
5. Your commit message should describe what you changed, not reference the orchestrator

## What Happens After You Finish
- The orchestrator runs postchecks (e.g., `tsc --noEmit`) on your changes
- If postchecks pass, your changes are squash-merged to the target branch
- If postchecks fail, an auto-heal agent may attempt to fix the errors
```

### Cleanup

Projected files are cleaned in **two places**:

1. **Before commit phase**: Remove `.github/skills/.orchestrator/` so orchestrator-internal
   files are never included in the user's commit.
2. **Worktree deletion**: When the worktree is removed after merge-ri, all projected files
   are deleted with it (belt-and-suspenders).

## Configuration

```jsonc
{
  // Augment AgentSpec instructions with skill-aligned terms at plan creation (default: true)
  "copilotOrchestrator.instructionEnrichment.augmentInstructions": true,

  // Timeout for the augmentation CLI call (default: 30000ms)
  "copilotOrchestrator.instructionEnrichment.augmentTimeoutMs": 30000,

  // Project orchestrator worktree context skill into worktrees (default: true)
  "copilotOrchestrator.instructionEnrichment.projectWorktreeContext": true
}
```

## Implementation Plan

### Milestone 1: API Simplification + Skill-Aware Augmentation
1. **Remove `create_copilot_job` and `create_copilot_node`** MCP tools — migrate callers to
   `create_copilot_plan` (with 1+ nodes) and `update_copilot_plan` (to add nodes). Remove
   associated schemas, handlers, tests, and UI references.
2. `src/agent/instructionAugmenter.ts` — reads `.github/skills/*/SKILL.md` frontmatter,
   builds augmentation prompt, makes single CLI call, parses JSON output, applies to AgentSpecs.
   Supports both batch (multiple nodes) and single-node modes via the same interface.
3. Add `augmentInstructions?: boolean` and `originalInstructions?: string` fields to
   `AgentSpec` type
4. Wire augmentation into remaining MCP handlers:
   - `create_copilot_plan` — batch augmentation across all opted-in agent nodes
   - `update_copilot_plan` — batch augmentation across updated opted-in agent nodes
   - `update_copilot_plan_node` — single-node augmentation when the node is an opted-in AgentSpec
5. Add `copilotOrchestrator.instructionEnrichment.*` configuration schema to `package.json`
6. Unit tests: batch augmentation with 0/1/N skills, single-node augmentation via
   UpdatePlanNode, mixed workSpec types filtered correctly, opted-out agents excluded,
   `originalInstructions` preserved, JSON parse/validation, timeout fallback
   (restores from `originalInstructions`), anti-recursion flag

### Milestone 2: UI — Augmentation Diff View
1. Expose `originalInstructions` in plan detail panel — when present, show a toggle or
   side-by-side diff between original and augmented instructions
2. Plan detail API already returns full node data; UI reads `originalInstructions` if set
3. Visual indicator on nodes that were augmented (e.g., icon or badge)

### Milestone 3: Setup Phase + Projected Orchestrator Skill
1. `src/plan/phases/setupPhase.ts` — new phase executor
2. Update phase ordering in `src/plan/executor.ts`: insert `setup` after `merge-fi`
3. Build `orchestrator-worktree-context` SKILL.md from `PhaseContext` data
4. Project into worktree `.github/skills/.orchestrator/SKILL.md`
5. Cleanup in commit phase: remove projected files before `git add`
6. Update `src/plan/types/` — add `setup` to phase type union
7. Unit tests: setup projection, cleanup before commit, phase ordering

## Open Questions

1. **Augmentation quality**: How well does a single-turn CLI call rephrase instructions in
   practice? May need prompt iteration based on real-world testing.
2. **AgentSpec.skills override**: Should users be able to force-select skills explicitly
   (e.g., `skills: ['test-writer']`) as a deterministic alternative to description matching?
3. **Token budget**: The augmentation call includes all opted-in AgentSpecs + all skill
   descriptions. For large plans with many skills, this could approach context limits.
   May need batching for plans with 20+ nodes.
4. **Re-augmentation on update**: If a user updates one node's instructions, should the
   orchestrator re-augment just that node or all nodes? (The `originalInstructions` field
   makes re-augmentation safe — always start from `originalInstructions` if present.)

## Resolved Decisions

1. ✅ **No SkillRegistry / keyword matching**: Copilot CLI handles skill discovery and
   matching natively. The orchestrator does not replicate this logic.
2. ✅ **No skill content in instruction files**: Instruction files contain the task only.
   Skills are loaded by Copilot CLI's Level 2 mechanism based on description matching.
3. ✅ **Batch augmentation**: A single CLI call processes all opted-in AgentSpecs at once
   rather than one call per node. This is faster and gives the LLM cross-node context.
4. ✅ **WorkSpec-level control**: `augmentInstructions` lives on `AgentSpec`, not the plan.
   Each agent node opts in/out independently. Non-agent workSpecs are never sent to the
   augmentation call.
5. ✅ **Plan-level, not per-invocation**: Augmentation happens once at plan creation,
   not on every Copilot CLI invocation. This avoids redundant CLI calls during execution.
6. ✅ **Original preserved**: `originalInstructions` stores the pre-augmentation snapshot.
   The UI can diff original vs. augmented for transparency. Re-augmentation always starts
   from `originalInstructions` to avoid drift.
7. ✅ **No scope creep**: Augmentation rephrases existing intent to trigger skills — it
   never adds new work, requirements, or deliverables beyond what the original asked for.
