#Requires -Version 5.1
<#
.SYNOPSIS
    Verifies that every class implementing an AiOrchestrator.Abstractions interface is registered in CompositionRoot.

.DESCRIPTION
    For every internal or public sealed class in src/dotnet/<Project>/**/*.cs that implements
    an interface declared in AiOrchestrator.Abstractions, verifies that a registration exists
    in any partial CompositionRoot.*.cs file. Exits 1 on missing registrations.

.PARAMETER Project
    The project name (e.g., AiOrchestrator.Core).

.EXAMPLE
    pwsh ./scripts/dotnet/check-composition.ps1 -Project AiOrchestrator.Core
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Project
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$srcDir      = Join-Path $repoRoot 'src' 'dotnet' $Project
$compRootDir = Join-Path $repoRoot 'src' 'dotnet' 'AiOrchestrator.Composition'

if (-not (Test-Path $srcDir)) {
    Write-Error "Source directory not found: $srcDir"
    exit 1
}

# Gather all CompositionRoot partial files
$compRootFiles = @(Get-ChildItem -Path $compRootDir -Filter 'CompositionRoot.*.cs' -Recurse -ErrorAction SilentlyContinue)
$compRootContent = if ($compRootFiles.Count -gt 0) {
    $compRootFiles | ForEach-Object { Get-Content $_.FullName -Raw } | Out-String
} else {
    ""
}

$csFiles   = @(Get-ChildItem -Path $srcDir -Filter '*.cs' -Recurse -ErrorAction SilentlyContinue)
$violations = @()

foreach ($file in $csFiles) {
    $content = Get-Content $file.FullName -Raw

    # Find classes that implement interfaces (heuristic: implements I<Name>)
    $classMatches = [System.Text.RegularExpressions.Regex]::Matches(
        $content,
        '(?:internal|public)\s+sealed\s+class\s+(\w+)\s*(?::[^{]+\bI[A-Z]\w+)'
    )

    foreach ($match in $classMatches) {
        $className = $match.Groups[1].Value

        # Check if it implements an Abstractions interface
        $implMatch = [System.Text.RegularExpressions.Regex]::Match(
            $match.Value,
            'I[A-Z][A-Za-z0-9]+'
        )

        if (-not $implMatch.Success) { continue }
        $interfaceName = $implMatch.Value

        # Verify registration in any CompositionRoot.*.cs
        $isRegistered = $compRootContent -match [regex]::Escape($className)

        if (-not $isRegistered) {
            $violations += [PSCustomObject]@{
                Class     = $className
                Interface = $interfaceName
                File      = $file.Name
            }
        }
    }
}

if ($violations.Count -gt 0) {
    Write-Host ""
    Write-Host "Composition registration missing for $Project:" -ForegroundColor Red
    foreach ($v in $violations) {
        Write-Host "  $($v.Class) : $($v.Interface) (in $($v.File)) — not registered in CompositionRoot" -ForegroundColor Red
    }
    exit 1
}

Write-Host "Composition check PASSED for $Project." -ForegroundColor Green
exit 0
