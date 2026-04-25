#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Collects code coverage for the AiOrchestrator .NET solution.

.DESCRIPTION
    Runs tests with XPlat Code Coverage (coverlet), merges results, and generates
    a text summary + optional HTML report. Filters out auto-generated code.

.PARAMETER Project
    Optional: a project name (e.g. "AiOrchestrator.Plan.Store") to collect
    coverage for just that project's tests. If omitted, collects for all.

.PARAMETER Threshold
    Minimum line coverage percentage. Exits with code 1 if below. Default: 90.

.PARAMETER Html
    If set, also generates an HTML report in dotnet/coverage-results/report/.

.EXAMPLE
    .\build\collect-coverage.ps1
    .\build\collect-coverage.ps1 -Project AiOrchestrator.Plan.Store
    .\build\collect-coverage.ps1 -Threshold 85 -Html
#>
param(
    [string]$Project,
    [double]$Threshold = 90.0,
    [switch]$Html
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

# ── Clean previous results ──────────────────────────────────────────
$resultsDir = Join-Path $root 'dotnet' 'coverage-results'
if (Test-Path $resultsDir) {
    Remove-Item $resultsDir -Recurse -Force
}

# ── Determine test target ───────────────────────────────────────────
$testTarget = Join-Path $root 'dotnet' 'AiOrchestrator.slnx'
if ($Project) {
    $csproj = Get-ChildItem (Join-Path $root 'dotnet' 'tests') -Recurse -Filter "$Project.csproj" | Select-Object -First 1
    if (-not $csproj) {
        # Try with .Tests suffix
        $csproj = Get-ChildItem (Join-Path $root 'dotnet' 'tests') -Recurse -Filter "$Project.Tests.csproj" | Select-Object -First 1
    }
    if (-not $csproj) {
        Write-Error "Test project '$Project' not found under dotnet/tests/"
        exit 1
    }
    $testTarget = $csproj.FullName
    Write-Host "Collecting coverage for: $($csproj.Name)" -ForegroundColor Cyan
}

# ── Coverlet exclusion filters ──────────────────────────────────────
# Exclude auto-generated code, test projects, and tooling
$excludeFilters = @(
    '[AiOrchestrator.*.Tests]*'
    '[AiOrchestrator.TestKit]*'
    '[AiOrchestrator.Acceptance]*'
    '[AiOrchestrator.Benchmarks]*'
)
$excludeByFile = @(
    '**/obj/**'
    '**/*.g.cs'
    '**/*.Generated.cs'
    '**/Migrations/**'
)
$excludeByAttr = @(
    'System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute'
    'System.Runtime.CompilerServices.CompilerGeneratedAttribute'
)

# Build the runsettings XML inline
$runSettings = @"
<?xml version="1.0" encoding="utf-8"?>
<RunSettings>
  <DataCollectionRunSettings>
    <DataCollectors>
      <DataCollector friendlyName="XPlat Code Coverage">
        <Configuration>
          <Format>cobertura</Format>
          <Exclude>$($excludeFilters -join ',')</Exclude>
          <ExcludeByFile>$($excludeByFile -join ',')</ExcludeByFile>
          <ExcludeByAttribute>$($excludeByAttr -join ',')</ExcludeByAttribute>
          <IncludeTestAssembly>false</IncludeTestAssembly>
          <SingleHit>false</SingleHit>
          <UseSourceLink>false</UseSourceLink>
        </Configuration>
      </DataCollector>
    </DataCollectors>
  </DataCollectionRunSettings>
</RunSettings>
"@

$runSettingsPath = Join-Path $resultsDir '.runsettings'
New-Item -ItemType Directory -Path $resultsDir -Force | Out-Null
Set-Content $runSettingsPath $runSettings -Encoding UTF8

# ── Run tests with coverage ─────────────────────────────────────────
Write-Host "`n═══ Running tests with coverage ═══" -ForegroundColor Yellow

$testArgs = @(
    'test'
    $testTarget
    '--verbosity', 'minimal'
    '--collect:XPlat Code Coverage'
    "--settings:$runSettingsPath"
    "--results-directory:$resultsDir"
)

& dotnet @testArgs
$testExitCode = $LASTEXITCODE

if ($testExitCode -ne 0) {
    Write-Warning "Some tests failed (exit code $testExitCode). Coverage still collected."
}

# ── Merge coverage reports ──────────────────────────────────────────
$coberturaFiles = Get-ChildItem $resultsDir -Recurse -Filter 'coverage.cobertura.xml'
if ($coberturaFiles.Count -eq 0) {
    Write-Error "No coverage.cobertura.xml files found in $resultsDir"
    exit 1
}

Write-Host "`nFound $($coberturaFiles.Count) coverage files" -ForegroundColor Cyan

# Ensure reportgenerator is available
$rgTool = Get-Command reportgenerator -ErrorAction SilentlyContinue
if (-not $rgTool) {
    Write-Host "Installing reportgenerator..." -ForegroundColor Yellow
    & dotnet tool install -g dotnet-reportgenerator-globaltool 2>$null
}

$reports = ($coberturaFiles | ForEach-Object { $_.FullName }) -join ';'
$reportDir = Join-Path $resultsDir 'report'

$reportTypes = 'TextSummary'
if ($Html) {
    $reportTypes = 'TextSummary;Html'
}

Write-Host "`n═══ Generating coverage report ═══" -ForegroundColor Yellow
& reportgenerator `
    "-reports:$reports" `
    "-targetdir:$reportDir" `
    "-reporttypes:$reportTypes" `
    '-assemblyfilters:-AiOrchestrator.*.Tests;-AiOrchestrator.TestKit;-AiOrchestrator.Acceptance;-AiOrchestrator.Benchmarks' `
    '-filefilters:-**/obj/**;-**/*.g.cs;-**/*.Generated.cs' 2>&1 | Out-Null

# ── Display summary ─────────────────────────────────────────────────
$summaryPath = Join-Path $reportDir 'Summary.txt'
if (Test-Path $summaryPath) {
    Write-Host "`n═══ Coverage Summary ═══" -ForegroundColor Green
    
    # Extract line coverage percentage
    $summaryContent = Get-Content $summaryPath -Raw
    if ($summaryContent -match 'Line coverage:\s+([\d.]+)%') {
        $lineCoverage = [double]$Matches[1]
        Write-Host "Line coverage: $lineCoverage%" -ForegroundColor $(if ($lineCoverage -ge $Threshold) { 'Green' } else { 'Red' })
    }
    if ($summaryContent -match 'Branch coverage:\s+([\d.]+)%') {
        Write-Host "Branch coverage: $($Matches[1])%"
    }
    if ($summaryContent -match 'Covered lines:\s+(\d+)') {
        Write-Host "Covered lines: $($Matches[1])"
    }
    if ($summaryContent -match 'Total lines:\s+(\d+)') {
        Write-Host "Total lines: $($Matches[1])"
    }

    # Show per-assembly breakdown
    Write-Host "`nPer-assembly coverage:" -ForegroundColor Cyan
    $lines = Get-Content $summaryPath
    $inAssembly = $false
    foreach ($line in $lines) {
        if ($line -match '^AiOrchestrator\.\S+\s+[\d.]+%$') {
            $parts = $line.Trim() -split '\s+'
            $name = $parts[0]
            $pct = $parts[-1]
            $pctNum = [double]($pct -replace '%','')
            $color = if ($pctNum -ge 90) { 'Green' } elseif ($pctNum -ge 70) { 'Yellow' } else { 'Red' }
            Write-Host "  $($name.PadRight(50)) $pct" -ForegroundColor $color
        }
    }

    # ── Gate check ──────────────────────────────────────────────────
    if ($lineCoverage -lt $Threshold) {
        Write-Host "`n❌ COVERAGE GATE FAILED: $lineCoverage% < $Threshold% threshold" -ForegroundColor Red
        exit 1
    }
    else {
        Write-Host "`n✅ COVERAGE GATE PASSED: $lineCoverage% ≥ $Threshold% threshold" -ForegroundColor Green
    }
}
else {
    Write-Warning "Summary.txt not generated"
    exit 1
}

if ($Html) {
    $htmlReport = Join-Path $reportDir 'index.html'
    if (Test-Path $htmlReport) {
        Write-Host "`nHTML report: $htmlReport" -ForegroundColor Cyan
    }
}

Write-Host "`nResults directory: $resultsDir" -ForegroundColor Cyan
