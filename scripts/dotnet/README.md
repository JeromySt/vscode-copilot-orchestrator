# dotnet Post-Check Helper Scripts

This directory contains PowerShell helper scripts for post-check validation of .NET projects in the AiOrchestrator solution.

All scripts:
- Accept `-Project <name>` as their primary parameter
- Exit `0` on success, `1` on failure
- Are idempotent and read-only against `src/`
- Are compatible with PowerShell 5.1 and PowerShell 7+

## Scripts

| Script | Purpose | Key Parameters |
|--------|---------|----------------|
| `check-analyzers.ps1` | Runs `dotnet build` with analyzers enabled and fails on any OE0xxxx diagnostics | `-Project` |
| `check-banned-apis.ps1` | Scans source files for banned API usages from `build/banned.txt` | `-Project`, `-AllowedOverrides` |
| `check-composition.ps1` | Verifies all services implementing Abstractions interfaces are registered in CompositionRoot | `-Project` |
| `check-contract-tests.ps1` | Parses job spec for acceptance tests and verifies they exist with `[ContractTest]` attribute | `-Project`, `-SpecFile` |
| `check-coverage.ps1` | Runs `dotnet test` with XPlat coverage and checks line/branch rates | `-Project`, `-MinLine`, `-MinBranch` |
| `check-public-api.ps1` | Diffs `PublicAPI.Unshipped.txt` against the spec's Public API surface section | `-Project`, `-SpecFile` |
| `run-all-postchecks.ps1` | Orchestrates all post-checks and produces a summary JSON | `-Project`, `-SpecFile`, `-SkipCoverage` |

## Usage

```powershell
# Run all post-checks for a project
pwsh ./scripts/dotnet/run-all-postchecks.ps1 -Project AiOrchestrator.Core `
    -SpecFile .github/instructions/orchestrator-job-<id>.instructions.md

# Run individual checks
pwsh ./scripts/dotnet/check-coverage.ps1 -Project AiOrchestrator.Core -MinLine 0.90 -MinBranch 0.80
pwsh ./scripts/dotnet/check-banned-apis.ps1 -Project AiOrchestrator.Core
pwsh ./scripts/dotnet/check-analyzers.ps1 -Project AiOrchestrator.Core
```

## Invariants

- **INV-5**: All scripts are idempotent and read-only against `src/`. They may write to `.orchestrator/tmp/` for reports and logs.
- Temp output goes to `.orchestrator/tmp/` (never `$env:TEMP` or `/tmp`).
- JSON reports are written alongside logs for orchestrator consumption.
