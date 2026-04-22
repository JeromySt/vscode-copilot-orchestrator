#Requires -Version 5.1
<#
.SYNOPSIS
    Verifies that a Roslyn source generator emits byte-identical output across two consecutive builds.

.DESCRIPTION
    Builds the test project for a generator twice with EmitCompilerGeneratedFiles=true
    into two distinct intermediate output directories, then compares every *.g.cs
    file produced. Fails if any byte differs. Implements post-check J14-PC-4.

.PARAMETER Generator
    The short generator name (e.g., "Eventing.Generators"). The script looks for
    src/dotnet/AiOrchestrator.<Generator> and tests/dotnet/AiOrchestrator.<Generator>.Tests.

.EXAMPLE
    pwsh ./scripts/dotnet/check-generator-determinism.ps1 -Generator Eventing.Generators
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Generator
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$tmpDir   = Join-Path $repoRoot '.orchestrator' 'tmp'
$null = New-Item -ItemType Directory -Force -Path $tmpDir

$genProj  = Join-Path $repoRoot 'src'   'dotnet' "AiOrchestrator.$Generator"      "AiOrchestrator.$Generator.csproj"
$testProj = Join-Path $repoRoot 'tests' 'dotnet' "AiOrchestrator.$Generator.SampleConsumer" "AiOrchestrator.$Generator.SampleConsumer.csproj"
if (-not (Test-Path $testProj)) {
    # Fall back to the .Tests project for generators that do not ship a SampleConsumer.
    $testProj = Join-Path $repoRoot 'tests' 'dotnet' "AiOrchestrator.$Generator.Tests" "AiOrchestrator.$Generator.Tests.csproj"
}

if (-not (Test-Path $genProj))  { Write-Error "Generator project not found: $genProj";  exit 1 }
if (-not (Test-Path $testProj)) { Write-Error "Test project not found: $testProj"; exit 1 }

function Build-Once {
    param([string]$OutDir)
    $null = New-Item -ItemType Directory -Force -Path $OutDir
    $log = Join-Path $tmpDir ("determ-build-{0}.log" -f (Split-Path -Leaf $OutDir))

    # Force a clean build so the generator re-runs and rewrites obj/.../generated/.
    $sampleObj = Join-Path (Split-Path -Parent $testProj) 'obj'
    $sampleBin = Join-Path (Split-Path -Parent $testProj) 'bin'
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $sampleObj
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $sampleBin

    & dotnet build $testProj `
        /p:EmitCompilerGeneratedFiles=true `
        /p:Deterministic=true `
        --nologo `
        2>&1 | Tee-Object -FilePath $log | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Build failed for determinism check pass. See $log"
        exit 1
    }

    # Copy generated output into the per-pass directory for comparison.
    $generatedSrc = Join-Path (Split-Path -Parent $testProj) 'obj' 'Debug' 'net10.0' 'generated'
    if (Test-Path $generatedSrc) {
        Copy-Item -Recurse -Force -Path (Join-Path $generatedSrc '*') -Destination $OutDir
    }
}

$out1 = Join-Path $tmpDir "determ-$Generator-1"
$out2 = Join-Path $tmpDir "determ-$Generator-2"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $out1
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $out2

Write-Host "Pass 1: building with generator output -> $out1" -ForegroundColor Cyan
Build-Once -OutDir $out1
Write-Host "Pass 2: building with generator output -> $out2" -ForegroundColor Cyan
Build-Once -OutDir $out2

$files1 = @(Get-ChildItem -Path $out1 -Recurse -Include '*.g.cs' -ErrorAction SilentlyContinue)
$files2 = @(Get-ChildItem -Path $out2 -Recurse -Include '*.g.cs' -ErrorAction SilentlyContinue)

if ($files1.Count -eq 0) {
    Write-Error "No generated *.g.cs files found in $out1; generator did not run."
    exit 1
}

$rel1 = $files1 | ForEach-Object { $_.FullName.Substring($out1.Length).TrimStart('\','/') } | Sort-Object
$rel2 = $files2 | ForEach-Object { $_.FullName.Substring($out2.Length).TrimStart('\','/') } | Sort-Object

$diff = Compare-Object $rel1 $rel2 -SyncWindow 0
if ($null -ne $diff -and @($diff).Count -gt 0) {
    Write-Error "Generated file set differs between passes: $($diff | Out-String)"
    exit 1
}

$mismatches = @()
foreach ($rel in $rel1) {
    $h1 = (Get-FileHash (Join-Path $out1 $rel) -Algorithm SHA256).Hash
    $h2 = (Get-FileHash (Join-Path $out2 $rel) -Algorithm SHA256).Hash
    if ($h1 -ne $h2) { $mismatches += $rel }
}

$report = [ordered]@{
    generator = $Generator
    files     = $rel1.Count
    passed    = ($mismatches.Count -eq 0)
    mismatches = $mismatches
}
$reportJson = $report | ConvertTo-Json -Depth 5
$reportPath = Join-Path $tmpDir "determinism-report-$Generator.json"
$reportJson | Set-Content -Path $reportPath -Encoding UTF8
Write-Host $reportJson

if (-not $report.passed) {
    Write-Error "Determinism check FAILED for $Generator. Mismatched files: $($mismatches -join ', ')"
    exit 1
}

Write-Host "Determinism check PASSED for $Generator ($($rel1.Count) generated files match byte-for-byte)." -ForegroundColor Green
exit 0
