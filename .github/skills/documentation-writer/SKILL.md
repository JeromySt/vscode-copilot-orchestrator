---
name: documentation-writer
description: Updating documentation for this VS Code extension. Use when asked to write or update README, CHANGELOG, architecture docs, DI guides, or any Markdown documentation files.
---

# Documentation Writing Guide

## Documentation Files

| File | Purpose |
|---|---|
| `README.md` | User-facing: features, installation, quick start, configuration |
| `CHANGELOG.md` | Version history with Keep a Changelog format |
| `CONTRIBUTING.md` | Developer setup, build commands, PR process |
| `docs/ARCHITECTURE.md` | System design, component diagram, data flow |
| `docs/DI_GUIDE.md` | DI patterns, token system, composition root |
| `docs/TESTING.md` | Test infrastructure, mocking patterns, coverage |
| `docs/WORKTREES_AND_MERGING.md` | Git worktree strategy, merge phases |
| `docs/COPILOT_INTEGRATION.md` | MCP protocol, agent delegation |
| `docs/GROUPS.md` | Node grouping and visual composition |
| `docs/INSTRUCTION_ENRICHMENT.md` | Agent skill enrichment pipeline design |

## Changelog Format

```markdown
## [0.10.0] - 2026-02-15

### Added
- Feature description (#PR)

### Changed
- Behavior change description

### Fixed
- Bug fix description (#issue)

### Security
- Security improvement description
```

## Architecture Documentation Rules

- Include Mermaid diagrams for component relationships
- Document the DI token → interface → implementation mapping
- Show the 7-phase execution pipeline with data flow
- Keep diagrams in sync with code (`src/composition.ts` is source of truth)

## Style

- **User-facing docs** (README, CHANGELOG): Clear, concise, no internal jargon
- **Developer docs** (ARCHITECTURE, DI_GUIDE): Technical depth, code examples, rationale
- **All docs**: Use present tense, active voice
- **Code examples**: Must be valid TypeScript that compiles

## What NOT to Include

- No agent/AI-generated planning notes or investigation logs
- No internal task tracking or debugging notes
- No credentials, secrets, or environment-specific paths
- No TODO comments that should be GitHub issues instead
