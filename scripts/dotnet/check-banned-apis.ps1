#Requires -Version 5.1
<#
.SYNOPSIS
    Verifies that no banned API usages appear in a project's source files.

.DESCRIPTION
    Reads build/banned.txt to obtain the list of banned API patterns.
    For each pattern, scans src/dotnet/<Project>/**/*.cs using Select-String.
    Exits 1 if any banned API is found outside its explicitly-allowed owning project.

.PARAMETER Project
    The project name (e.g., AiOrchestrator.Core). Source files under src/dotnet/<Project>/ are scanned.

.PARAMETER AllowedOverrides
    Hashtable mapping banned pattern to the project that is allowed to use it.
    E.g., @{ 'Process.Start' = 'AiOrchestrator.Process' }

.EXAMPLE
    pwsh ./scripts/dotnet/check-banned-apis.ps1 -Project AiOrchestrator.Core
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Project,

    [Parameter(Mandatory = $false)]
    [hashtable]$AllowedOverrides = @{
        'System.Diagnostics.Process.Start' = 'AiOrchestrator.Process'
    }
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot   = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$bannedFile = Join-Path $repoRoot 'src' 'dotnet' 'build' 'banned.txt'
$srcDir     = Join-Path $repoRoot 'src' 'dotnet' $Project

if (-not (Test-Path $bannedFile)) {
    Write-Error "banned.txt not found at: $bannedFile"
    exit 1
}

if (-not (Test-Path $srcDir)) {
    Write-Error "Source directory not found: $srcDir"
    exit 1
}

$bannedLines = Get-Content $bannedFile | Where-Object { $_ -match '^M:' }
$csFiles = @(Get-ChildItem -Path $srcDir -Filter '*.cs' -Recurse -ErrorAction SilentlyContinue)

if ($csFiles.Count -eq 0) {
    Write-Host "No .cs files found in $srcDir — skipping banned API check." -ForegroundColor Yellow
    exit 0
}

$violations = @()

foreach ($entry in $bannedLines) {
    $parts = $entry -split ';', 2
    $apiSignature = $parts[0] -replace '^M:', ''
    $reason       = if ($parts.Count -gt 1) { $parts[1] } else { '' }

    # Derive a simple class.method search term from the full signature
    $searchTerm = $apiSignature -replace '\(.*\)', '' -replace '^.*\.(?=[A-Z])', ''

    # Check if this project is allowed to use the API
    $allowedProject = $null
    foreach ($key in $AllowedOverrides.Keys) {
        if ($apiSignature -like "*$key*") {
            $allowedProject = $AllowedOverrides[$key]
            break
        }
    }

    if ($allowedProject -and $allowedProject -eq $Project) {
        continue
    }

    $matches = Select-String -Path $csFiles.FullName -Pattern ([regex]::Escape($searchTerm)) -ErrorAction SilentlyContinue
    if ($matches) {
        foreach ($match in $matches) {
            $violations += [PSCustomObject]@{
                File      = $match.Filename
                Line      = $match.LineNumber
                Content   = $match.Line.Trim()
                BannedApi = $apiSignature
                Reason    = $reason
            }
        }
    }
}

if ($violations.Count -gt 0) {
    Write-Host ""
    Write-Host "Banned API violations found in $Project:" -ForegroundColor Red
    foreach ($v in $violations) {
        Write-Host "  $($v.File):$($v.Line) — $($v.BannedApi)" -ForegroundColor Red
        Write-Host "    $($v.Content)" -ForegroundColor DarkRed
        Write-Host "    Reason: $($v.Reason)" -ForegroundColor Yellow
    }
    exit 1
}

Write-Host "Banned API check PASSED for $Project." -ForegroundColor Green
exit 0
