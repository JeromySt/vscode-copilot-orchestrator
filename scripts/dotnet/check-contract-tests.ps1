#Requires -Version 5.1
<#
.SYNOPSIS
    Verifies that all contract tests declared in a job spec markdown are present in the test project.

.DESCRIPTION
    Parses the job spec markdown file for the ## Acceptance tests section.
    For each listed test name, greps the test project source for both the method name
    and a [ContractTest("...")] attribute. Exits 1 if any are missing.

.PARAMETER Project
    The project name (e.g., AiOrchestrator.Core). Test files under tests/dotnet/<Project>.Tests/ are scanned.

.PARAMETER SpecFile
    Path to the job spec markdown file containing ## Acceptance tests.

.EXAMPLE
    pwsh ./scripts/dotnet/check-contract-tests.ps1 -Project AiOrchestrator.Foundation `
        -SpecFile .github/instructions/orchestrator-job-5c24ca565ac8.instructions.md
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Project,

    [Parameter(Mandatory = $true)]
    [string]$SpecFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

$specPath = if ([System.IO.Path]::IsPathRooted($SpecFile)) { $SpecFile } else { Join-Path $repoRoot $SpecFile }
if (-not (Test-Path $specPath)) {
    Write-Error "Spec file not found: $specPath"
    exit 1
}

$testDir = Join-Path $repoRoot 'tests' 'dotnet' "$Project.Tests"
if (-not (Test-Path $testDir)) {
    Write-Error "Test directory not found: $testDir"
    exit 1
}

# Parse the ## Acceptance tests section from the markdown
$specContent = Get-Content $specPath -Raw
$acceptanceSection = $specContent -replace '(?s).*## Acceptance tests\s*\r?\n', '' -replace '(?s)\r?\n## .*', ''

# Extract method names (lines starting with "- `MethodName`")
$testNames = [System.Collections.Generic.List[string]]::new()
foreach ($line in ($acceptanceSection -split '\r?\n')) {
    if ($line -match '-\s+`([A-Za-z_][A-Za-z0-9_]+)`') {
        $testNames.Add($Matches[1])
    }
}

if ($testNames.Count -eq 0) {
    Write-Host "No acceptance tests found in spec file. Nothing to verify." -ForegroundColor Yellow
    exit 0
}

Write-Host "Checking $($testNames.Count) contract test(s) in $testDir..." -ForegroundColor Cyan

$csFiles = @(Get-ChildItem -Path $testDir -Filter '*.cs' -Recurse -ErrorAction SilentlyContinue)
$missing = @()

foreach ($testName in $testNames) {
    $methodFound    = $false
    $contractFound  = $false

    foreach ($file in $csFiles) {
        $content = Get-Content $file.FullName -Raw

        if ($content -match [regex]::Escape($testName)) {
            $methodFound = $true
        }

        if ($content -match '\[ContractTest\(') {
            $contractFound = $true
        }
    }

    if (-not $methodFound) {
        $missing += "Missing test method: $testName"
    } elseif (-not $contractFound) {
        $missing += "Missing [ContractTest(...)] attribute near: $testName"
    }
}

if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "Contract test check FAILED for ${Project}:" -ForegroundColor Red
    foreach ($m in $missing) {
        Write-Host "  $m" -ForegroundColor Red
    }
    exit 1
}

Write-Host "Contract test check PASSED for $Project. All $($testNames.Count) test(s) present." -ForegroundColor Green
exit 0
