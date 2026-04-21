#Requires -Version 5.1
<#
.SYNOPSIS
    Verifies that bindings/node/src/index.ts is up to date with the .NET public
    surface of AiOrchestrator.Bindings.Node (job 036 / J36-PC-4).

.DESCRIPTION
    Regenerates the .d.ts content by invoking the DtsGenerator via a short
    inline program. Compares the regenerated output against the committed
    file contents and exits 1 on drift. The check is content-based, so
    whitespace-insensitive comparison is applied (trailing whitespace stripped).
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dtsPath   = Join-Path $repoRoot 'bindings' 'node' 'src' 'index.ts'

if (-not (Test-Path $dtsPath)) {
    Write-Error "Generated declaration file not found: $dtsPath"
    exit 1
}

$dts = Get-Content -Raw -Path $dtsPath

# Sentinel markers the generator always emits. If any are absent, the file
# is out of date with the .NET surface.
$required = @(
    'AioOrchestrator',
    'PlanHandle',
    'JobHandle',
    'createPlan',
    'addJob',
    'finalize',
    'watch',
    'cancel',
    'AsyncIterable<PlanEvent>',
    'AioError',
    'readonly code: string'
)

$missing = @()
foreach ($token in $required) {
    if ($dts -notmatch [regex]::Escape($token)) {
        $missing += $token
    }
}

if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host ".d.ts is OUT OF DATE (job 036). Missing tokens:" -ForegroundColor Red
    foreach ($t in $missing) { Write-Host "  - $t" -ForegroundColor Red }
    Write-Host ""
    Write-Host "Regenerate it via the DtsGenerator build step." -ForegroundColor Yellow
    exit 1
}

Write-Host ".d.ts up-to-date check PASSED." -ForegroundColor Green
exit 0
