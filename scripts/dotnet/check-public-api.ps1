#Requires -Version 5.1
<#
.SYNOPSIS
    Verifies that a project's public API surface matches the spec's "Public API surface" section.

.DESCRIPTION
    Uses the PublicAPI.Shipped.txt and PublicAPI.Unshipped.txt baseline files from the project.
    Diffs the unshipped API list against the "Public API surface" section of the job spec.
    Exits 1 if there is drift between the two.

.PARAMETER Project
    The project name (e.g., AiOrchestrator.Core).

.PARAMETER SpecFile
    Path to the job spec markdown file containing a ## Public API surface section.

.EXAMPLE
    pwsh ./scripts/dotnet/check-public-api.ps1 -Project AiOrchestrator.Core `
        -SpecFile .github/instructions/orchestrator-job-5c24ca565ac8.instructions.md
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Project,

    [Parameter(Mandatory = $false)]
    [string]$SpecFile = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot   = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$projectDir = Join-Path $repoRoot 'src' 'dotnet' $Project

if (-not (Test-Path $projectDir)) {
    Write-Error "Project directory not found: $projectDir"
    exit 1
}

$unshippedFile = Join-Path $projectDir 'PublicAPI.Unshipped.txt'
$shippedFile   = Join-Path $projectDir 'PublicAPI.Shipped.txt'

if (-not (Test-Path $unshippedFile)) {
    Write-Host "No PublicAPI.Unshipped.txt found for $Project — skipping public API check." -ForegroundColor Yellow
    exit 0
}

$unshippedApis = @(Get-Content $unshippedFile | Where-Object { $_ -notmatch '^\s*#' -and $_.Trim() -ne '' -and $_.Trim() -ne '#nullable enable' })

if ([string]::IsNullOrEmpty($SpecFile)) {
    Write-Host "No spec file provided. Reporting $($unshippedApis.Count) unshipped APIs for $Project." -ForegroundColor Yellow
    $unshippedApis | ForEach-Object { Write-Host "  $_" }
    exit 0
}

$specPath = if ([System.IO.Path]::IsPathRooted($SpecFile)) { $SpecFile } else { Join-Path $repoRoot $SpecFile }
if (-not (Test-Path $specPath)) {
    Write-Error "Spec file not found: $specPath"
    exit 1
}

$specContent  = Get-Content $specPath -Raw
$apiSection   = $specContent -replace '(?s).*## Public API surface\s*\r?\n', '' -replace '(?s)\r?\n## .*', ''
$specApis     = @($apiSection -split '\r?\n' | Where-Object { $_ -match '^\s*[A-Z]' } | ForEach-Object { $_.Trim() })

$missing  = @($specApis  | Where-Object { $_ -notin $unshippedApis })
$extra    = @($unshippedApis | Where-Object { $_ -notin $specApis })

$hasDrift = ($missing.Count -gt 0) -or ($extra.Count -gt 0)

if ($hasDrift) {
    Write-Host ""
    Write-Host "Public API drift detected for $Project:" -ForegroundColor Red
    foreach ($m in $missing) { Write-Host "  MISSING from unshipped: $m" -ForegroundColor Red }
    foreach ($e in $extra)   { Write-Host "  EXTRA in unshipped (not in spec): $e" -ForegroundColor Yellow }
    exit 1
}

Write-Host "Public API check PASSED for $Project. No drift detected." -ForegroundColor Green
exit 0
