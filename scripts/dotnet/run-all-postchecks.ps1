#Requires -Version 5.1
<#
.SYNOPSIS
    Orchestrates all post-check scripts (PC-1 through PC-N) for a given project.

.DESCRIPTION
    Runs all applicable post-check scripts in order, aggregates their JSON reports,
    and produces a single summary JSON consumed by the orchestrator.
    Exits 0 only if all checks pass.

.PARAMETER Project
    The project name (e.g., AiOrchestrator.Core).

.PARAMETER SpecFile
    Path to the job spec markdown file (required for contract-tests and public-api checks).

.PARAMETER SkipCoverage
    Skip the coverage check (useful for projects without tests).

.EXAMPLE
    pwsh ./scripts/dotnet/run-all-postchecks.ps1 -Project AiOrchestrator.Core `
        -SpecFile .github/instructions/orchestrator-job-5c24ca565ac8.instructions.md
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Project,

    [Parameter(Mandatory = $false)]
    [string]$SpecFile = "",

    [Parameter(Mandatory = $false)]
    [switch]$SkipCoverage
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scriptsDir = $PSScriptRoot
$tmpDir    = Join-Path $repoRoot '.orchestrator' 'tmp'
$null = New-Item -ItemType Directory -Force -Path $tmpDir

$checks = [ordered]@{
    'PC-1-analyzers'        = @{ Script = 'check-analyzers.ps1';       Args = @('-Project', $Project) }
    'PC-2-banned-apis'      = @{ Script = 'check-banned-apis.ps1';     Args = @('-Project', $Project) }
    'PC-3-composition'      = @{ Script = 'check-composition.ps1';     Args = @('-Project', $Project) }
    'PC-4-contract-tests'   = @{ Script = 'check-contract-tests.ps1';  Args = @('-Project', $Project) + $(if ($SpecFile) { @('-SpecFile', $SpecFile) } else { @() }) }
    'PC-5-public-api'       = @{ Script = 'check-public-api.ps1';      Args = @('-Project', $Project) + $(if ($SpecFile) { @('-SpecFile', $SpecFile) } else { @() }) }
}

if (-not $SkipCoverage) {
    $checks['PC-6-coverage'] = @{ Script = 'check-coverage.ps1'; Args = @('-Project', $Project) }
}

$results  = [ordered]@{}
$allPassed = $true

foreach ($checkName in $checks.Keys) {
    $check     = $checks[$checkName]
    $scriptPath = Join-Path $scriptsDir $check.Script

    Write-Host ""
    Write-Host "=== $checkName ===" -ForegroundColor Cyan

    if (-not (Test-Path $scriptPath)) {
        Write-Host "  SKIP — script not found: $($check.Script)" -ForegroundColor Yellow
        $results[$checkName] = @{ status = 'skipped'; reason = 'script not found' }
        continue
    }

    $checkLog = Join-Path $tmpDir "postcheck-$checkName-$Project.log"
    $exitCode = 0

    try {
        & pwsh -NoProfile -NonInteractive -File $scriptPath @($check.Args) 2>&1 |
            Tee-Object -FilePath $checkLog
        $exitCode = $LASTEXITCODE
    } catch {
        $exitCode = 1
        $_ | Out-File $checkLog -Append
    }

    if ($exitCode -eq 0) {
        $results[$checkName] = @{ status = 'passed' }
        Write-Host "  PASSED" -ForegroundColor Green
    } else {
        $results[$checkName] = @{ status = 'failed'; log = $checkLog }
        Write-Host "  FAILED (see $checkLog)" -ForegroundColor Red
        $allPassed = $false
    }
}

$summary = [ordered]@{
    project   = $Project
    passed    = $allPassed
    timestamp = (Get-Date -Format 'o')
    checks    = $results
}

$summaryJson = $summary | ConvertTo-Json -Depth 5
$summaryPath = Join-Path $tmpDir "postchecks-summary-$Project.json"
$summaryJson | Set-Content -Path $summaryPath -Encoding UTF8

Write-Host ""
Write-Host "=== SUMMARY ===" -ForegroundColor Cyan
Write-Host $summaryJson

if (-not $allPassed) {
    Write-Error "One or more post-checks FAILED for $Project."
    exit 1
}

Write-Host "All post-checks PASSED for $Project." -ForegroundColor Green
exit 0
