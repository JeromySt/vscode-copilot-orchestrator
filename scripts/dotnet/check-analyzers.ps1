#Requires -Version 5.1
<#
.SYNOPSIS
    Verifies that no Roslyn analyzer errors are reported for a project.

.DESCRIPTION
    Runs dotnet build with ReportAnalyzer=true and WarningsAsErrors=true.
    Scans the build output for analyzer diagnostics (OE0xxxx codes) in the project subtree.
    Exits 1 if any such diagnostics are found.

.PARAMETER Project
    The project name (e.g., AiOrchestrator.Core).

.EXAMPLE
    pwsh ./scripts/dotnet/check-analyzers.ps1 -Project AiOrchestrator.Core
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Project
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$tmpDir   = Join-Path $repoRoot '.orchestrator' 'tmp'
$null = New-Item -ItemType Directory -Force -Path $tmpDir

$projectPath = Join-Path $repoRoot 'src' 'dotnet' $Project
if (-not (Test-Path $projectPath)) {
    Write-Error "Project path not found: $projectPath"
    exit 1
}

$logFile = Join-Path $tmpDir "aio-build-$Project.log"
Write-Host "Building $Project with analyzers enabled..." -ForegroundColor Cyan

& dotnet build $projectPath `
    /p:ReportAnalyzer=true `
    /p:WarningsAsErrors=true `
    /v:n `
    --nologo `
    2>&1 | Tee-Object -FilePath $logFile

$buildExitCode = $LASTEXITCODE

$analyzerErrors = Select-String -Path $logFile -Pattern '\bOE0\d{4}\b' -ErrorAction SilentlyContinue

if ($analyzerErrors) {
    Write-Host ""
    Write-Host "Analyzer errors found in ${Project}:" -ForegroundColor Red
    $analyzerErrors | ForEach-Object { Write-Host "  $($_.Line.Trim())" -ForegroundColor Red }
    exit 1
}

if ($buildExitCode -ne 0) {
    Write-Error "Build failed for $Project. See $logFile for details."
    exit 1
}

Write-Host "Analyzer check PASSED for $Project." -ForegroundColor Green
exit 0
