#Requires -Version 5.1
<#
.SYNOPSIS
    Verifies a baseline JSON file exists for every declared benchmark id.

.DESCRIPTION
    Scans tests/dotnet/AiOrchestrator.Benchmarks/Suites/*.cs for [Benchmark(Description = "...")]
    declarations and verifies a corresponding baselines/<id>.json file exists. Exits 1 if any
    baseline is missing.

.EXAMPLE
    pwsh ./scripts/dotnet/check-baselines-present.ps1
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$projectDir  = Join-Path $repoRoot 'tests' 'dotnet' 'AiOrchestrator.Benchmarks'
$suitesDir   = Join-Path $projectDir 'Suites'
$baselineDir = Join-Path $projectDir 'baselines'

if (-not (Test-Path $suitesDir)) {
    Write-Error "Suites directory not found: $suitesDir"
    exit 1
}

if (-not (Test-Path $baselineDir)) {
    Write-Error "Baselines directory not found: $baselineDir"
    exit 1
}

$ids = @()
$rx = [regex]'\[Benchmark\([^)]*Description\s*=\s*"([^"]+)"'
foreach ($file in Get-ChildItem -Path $suitesDir -Filter '*.cs' -Recurse) {
    $content = Get-Content $file.FullName -Raw
    foreach ($m in $rx.Matches($content)) {
        $ids += $m.Groups[1].Value
    }
}

$ids = $ids | Sort-Object -Unique
if ($ids.Count -eq 0) {
    Write-Error "No [Benchmark(Description = ...)] declarations found in $suitesDir."
    exit 1
}

$missing = @()
foreach ($id in $ids) {
    $path = Join-Path $baselineDir "$id.json"
    if (-not (Test-Path $path)) {
        $missing += $id
    }
}

if ($missing.Count -gt 0) {
    Write-Host "Missing baseline files:" -ForegroundColor Red
    foreach ($id in $missing) { Write-Host "  $id.json" -ForegroundColor Red }
    exit 1
}

Write-Host "Baseline check PASSED. $($ids.Count) benchmark id(s) all have baseline files." -ForegroundColor Green
exit 0
