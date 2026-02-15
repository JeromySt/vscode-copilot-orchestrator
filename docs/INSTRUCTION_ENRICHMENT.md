# Design: Instruction Enrichment Pipeline

## Problem

When the orchestrator spawns Copilot CLI agents, each agent receives a minimal instruction file
containing only the task description and 4 generic guidelines. Agents have no knowledge of
repo-specific patterns (DI architecture, test conventions, security rules, phase ordering).

The repo-level `.github/copilot-instructions.md` provides some context, but it's static and
not task-type-aware. A "write tests" task should receive test-writing conventions; a "refactor
to DI" task should receive the full DI pipeline guide.

## Proposed Solution

### Two-Phase Instruction Enhancement

```
Plan created
    ↓
For each job node:
    ↓
Phase 1: STATIC ENRICHMENT (zero LLM cost)
    ├─ Detect task type via keyword matching on instructions text
    ├─ Load matching skill templates from resources/agent-skills/*.md
    └─ Append skill content to the instruction file
    ↓
Phase 2: LLM ENRICHMENT (optional, configurable)
    ├─ One-shot Copilot CLI call (--max-turns 1, non-orchestrated)
    ├─ Input: task + skill templates + repo structure summary
    ├─ Output: Enhanced instruction file with repo-specific guidance
    └─ Replace instruction file with enriched version
    ↓
Work agent executes with enriched instructions
```

### Phase 1: Static Skill Matching (MVP)

Keyword-based detection maps task descriptions to skill templates:

```typescript
interface SkillTemplate {
  id: string;
  keywords: string[];
  filePath: string;     // resources/agent-skills/{id}.md
  priority: number;     // Higher = appended later (builds on prior context)
}

const SKILL_REGISTRY: SkillTemplate[] = [
  { id: 'test-writer',       keywords: ['test', 'coverage', 'spec', 'unit test', 'mocha'], priority: 10, ... },
  { id: 'di-refactor',       keywords: ['dependency injection', 'DI', 'refactor', 'interface', 'token'], priority: 10, ... },
  { id: 'security-hardener', keywords: ['security', 'sanitize', 'validate', 'path traversal', 'sandbox'], priority: 10, ... },
  { id: 'auto-heal',         keywords: ['fix', 'heal', 'error', 'failed'], priority: 20, ... },
  { id: 'documentation-writer', keywords: ['document', 'readme', 'changelog', 'docs'], priority: 10, ... },
];
```

Detection logic:
```typescript
function detectSkills(instructions: string): SkillTemplate[] {
  const lower = instructions.toLowerCase();
  return SKILL_REGISTRY
    .filter(s => s.keywords.some(k => lower.includes(k)))
    .sort((a, b) => a.priority - b.priority);
}
```

Instruction file structure after enrichment:
```markdown
---
applyTo: 'worktreeParent/worktreeName/**'
---

# Current Task
{original task instructions}

## Additional Context
{original context if any}

## Repository Skills

### Test Writing Conventions
{content from resources/agent-skills/test-writer.md}

### DI Architecture
{content from resources/agent-skills/di-refactor.md}

## Guidelines
- Focus only on the task described above
- ...
```

### Phase 2: LLM Enrichment (Future)

**Anti-recursion safeguards:**
1. Enrichment uses a **direct CLI call**, not the orchestrator — no plan, no phases, no auto-heal
2. Set `--max-turns 1` — single generation, no tool use
3. Add environment flag `ORCHESTRATOR_ENRICHMENT=true` — agents skip enrichment when this is set
4. Hard timeout: 30 seconds max, fallback to static-only if timeout
5. Never enrich an enrichment call (check flag before enriching)

**Enrichment prompt template:**
```
You are enhancing instructions for an AI agent that will work in this repository.

Repository: {repo name}
Task type: {detected skill types}
Original instructions: {task text}

Repo conventions loaded:
{skill template contents}

Produce an enhanced version of the instructions that:
1. Keeps the original task exactly as specified
2. Adds specific file paths, function names, and patterns from THIS repo
3. Warns about known pitfalls (e.g., "Logger.for() is the only allowed service locator")
4. Suggests relevant contextFiles the agent should read

Output only the enhanced instructions in Markdown format.
```

### Configuration

```jsonc
// settings.json
{
  "copilotOrchestrator.instructionEnrichment.enabled": true,    // master toggle
  "copilotOrchestrator.instructionEnrichment.staticSkills": true, // Phase 1 (default: true)
  "copilotOrchestrator.instructionEnrichment.llmEnrichment": false, // Phase 2 (default: false)
  "copilotOrchestrator.instructionEnrichment.llmTimeoutMs": 30000,
  "copilotOrchestrator.instructionEnrichment.skillsPath": "resources/agent-skills"
}
```

### Custom Repo Skills

Repos can define their own skills by placing Markdown files in `resources/agent-skills/`:
```
resources/agent-skills/
├── test-writer.md           # Built-in
├── di-refactor.md           # Built-in
├── security-hardener.md     # Built-in
├── auto-heal.md             # Built-in
├── documentation-writer.md  # Built-in
└── my-custom-skill.md       # User-defined (detected by custom keywords in frontmatter)
```

Custom skill frontmatter:
```yaml
---
keywords: ['graphql', 'resolver', 'schema']
priority: 10
---
# Skill: GraphQL Conventions
...
```

## Implementation Plan

### Phase 1: Static Skill Matching
1. Add `SkillTemplate` interface and `SKILL_REGISTRY` to `src/agent/skillRegistry.ts`
2. Add `detectSkills(instructions)` function
3. Add `loadSkillContent(skillId)` to read from `resources/agent-skills/`
4. Modify `CopilotCliRunner.writeInstructionsFile()` to call detectSkills + append
5. Add config: `copilotOrchestrator.instructionEnrichment.staticSkills` (default: true)
6. Unit tests for skill detection and instruction assembly
7. Custom skill frontmatter parsing for user-defined skills

### Phase 2: LLM Enrichment
1. Add `enrichInstructions()` in `src/agent/instructionEnricher.ts`
2. Implement one-shot CLI call with anti-recursion flag
3. Add timeout + fallback to static-only
4. Add config: `copilotOrchestrator.instructionEnrichment.llmEnrichment` (default: false)
5. Telemetry: track enrichment success/timeout/skip rates
6. Unit tests with mocked CLI calls

## Open Questions

1. Should skill detection be fuzzy (embedding similarity) or keyword-only?
2. Should enrichment results be cached per (task-hash, repo-commit) pair?
3. Should the user be able to force-select skills via AgentSpec (e.g., `skills: ['test-writer']`)?
4. Token budget: how much skill content can we append before hitting context limits?
