#Requires -Version 5.1
<#
.SYNOPSIS
    Asserts CODEOWNERS covers the security-critical paths from job 043 (J43-PC-5).
#>
[CmdletBinding()]
param(
    [string]$CodeownersPath = (Join-Path $PSScriptRoot '..\..\.github\CODEOWNERS')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$required = @(
    'src/dotnet/AiOrchestrator.Audit/',
    'Credentials/Ipc/',
    'HookGate/Redirection/',
    'SkewManifest/Verification/',
    'tools/key-ceremony/'
)

if (-not (Test-Path $CodeownersPath)) {
    Write-Host "FAIL: CODEOWNERS not found at $CodeownersPath" -ForegroundColor Red
    exit 1
}

$content = Get-Content $CodeownersPath -Raw
$missing = @()
foreach ($p in $required) {
    if ($content -notmatch [regex]::Escape($p)) {
        $missing += $p
    }
}

if ($missing.Count -gt 0) {
    Write-Host "FAIL: CODEOWNERS missing required path coverage:" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    exit 1
}

Write-Host "OK: CODEOWNERS covers all $($required.Count) required path prefixes." -ForegroundColor Green
exit 0
