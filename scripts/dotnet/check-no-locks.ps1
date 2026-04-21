#Requires -Version 5.1
<#
.SYNOPSIS
    Verifies that the named methods in a source file contain none of `lock`, `Monitor.Enter`,
    or `SemaphoreSlim`. Used to enforce INV-7 (no locks on the publish hot path).

.PARAMETER File
    Path to the .cs file to scan, relative to repo root or absolute.

.PARAMETER Methods
    One or more method names whose body must be lock-free.

.EXAMPLE
    pwsh ./scripts/dotnet/check-no-locks.ps1 -File src/dotnet/AiOrchestrator.Eventing/EventBus.cs -Methods PublishAsync
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$File,

    [Parameter(Mandatory = $true)]
    [string[]]$Methods
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$path = if ([System.IO.Path]::IsPathRooted($File)) { $File } else { Join-Path $repoRoot $File }
if (-not (Test-Path $path)) {
    Write-Error "File not found: $path"
    exit 1
}

$src = Get-Content $path -Raw
$forbidden = @('lock\s*\(', 'Monitor\.Enter', 'SemaphoreSlim')

$violations = @()
foreach ($method in $Methods) {
    # Find the method declaration. Look for "<returnType> <method><whitespace_or_generic>" then matching braces.
    $rx = [regex]::new("\b$([regex]::Escape($method))\s*[<(]")
    $m = $rx.Match($src)
    if (-not $m.Success) {
        Write-Host "WARN: method '$method' not found in $path" -ForegroundColor Yellow
        continue
    }

    # Locate first '{' after the match, then walk to matching close brace.
    $open = $src.IndexOf('{', $m.Index)
    if ($open -lt 0) { continue }
    $depth = 0
    $end = -1
    for ($i = $open; $i -lt $src.Length; $i++) {
        $c = $src[$i]
        if ($c -eq '{') { $depth++ }
        elseif ($c -eq '}') {
            $depth--
            if ($depth -eq 0) { $end = $i; break }
        }
    }
    if ($end -lt 0) { continue }
    $body = $src.Substring($open, $end - $open + 1)

    foreach ($pat in $forbidden) {
        if ([regex]::IsMatch($body, $pat)) {
            $violations += "Method '$method' contains forbidden pattern '$pat'"
        }
    }
}

if ($violations.Count -gt 0) {
    Write-Host ""
    Write-Host "No-locks check FAILED for ${path}:" -ForegroundColor Red
    foreach ($v in $violations) { Write-Host "  $v" -ForegroundColor Red }
    exit 1
}

Write-Host "No-locks check PASSED for $path (methods: $($Methods -join ', '))." -ForegroundColor Green
exit 0
