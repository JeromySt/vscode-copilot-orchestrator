#Requires -Version 5.1
<#
.SYNOPSIS
    Verifies that the portability manifest.json and the diagnose manifest.json share a common
    unified schema (INV-1 / PORT-1).

.DESCRIPTION
    Scans the SerializeManifest helpers in both AiOrchestrator.Diagnose\Diagnoser.cs and
    AiOrchestrator.Plan.Portability\PlanExporter.cs for the set of top-level keys emitted
    in the manifest. The set of shared keys must include every one of the required shared
    keys (aioVersion, createdAt, dotnetRuntimeVersion, entries, kind, schemaVersion, warnings).
    Kind-specific keys (pseudonymizationMode, recipientPubKeyFingerprint) are allowed on
    the diagnose side only.

.EXAMPLE
    pwsh ./scripts/dotnet/check-bundle-schema-shared.ps1
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

$diagFile = Join-Path $repoRoot 'src/dotnet/AiOrchestrator.Diagnose/Diagnoser.cs'
$portFile = Join-Path $repoRoot 'src/dotnet/AiOrchestrator.Plan.Portability/PlanExporter.cs'

foreach ($file in @($diagFile, $portFile)) {
    if (-not (Test-Path $file)) {
        Write-Error "Source file not found: $file"
        exit 1
    }
}

function Get-ManifestKeys {
    param(
        [Parameter(Mandatory=$true)][string]$Path
    )
    $content = Get-Content $Path -Raw
    # Extract the SerializeManifest method body
    $match = [regex]::Match(
        $content,
        'SerializeManifest\s*\([^)]*\)\s*\{(?:[^{}]|\{[^{}]*\})*\bSortedDictionary<string,\s*object\?>\s*\(StringComparer\.Ordinal\)\s*\{(?<body>(?:[^{}]|\{[^{}]*\})*?)\}\s*;',
        'Singleline'
    )
    if (-not $match.Success) {
        # Fallback: find all ["<key>"] = occurrences inside the file and rely on dedup.
        $keyMatches = [regex]::Matches($content, '\["(?<k>[a-zA-Z]+)"\]\s*=')
        $keys = @{}
        foreach ($m in $keyMatches) { $keys[$m.Groups['k'].Value] = $true }
        return $keys.Keys | Sort-Object
    }
    $body = $match.Groups['body'].Value
    $keyMatches = [regex]::Matches($body, '\["(?<k>[a-zA-Z]+)"\]\s*=')
    $keys = @{}
    foreach ($m in $keyMatches) { $keys[$m.Groups['k'].Value] = $true }
    return $keys.Keys | Sort-Object
}

$diagKeys = Get-ManifestKeys -Path $diagFile
$portKeys = Get-ManifestKeys -Path $portFile

$requiredShared = @('aioVersion', 'createdAt', 'dotnetRuntimeVersion', 'entries', 'kind', 'schemaVersion', 'warnings')

$missingDiag = @($requiredShared | Where-Object { $diagKeys -notcontains $_ })
$missingPort = @($requiredShared | Where-Object { $portKeys -notcontains $_ })

$fail = $false
if ($missingDiag.Count -gt 0) {
    Write-Host "Diagnose manifest is missing shared keys: $($missingDiag -join ', ')" -ForegroundColor Red
    $fail = $true
}
if ($missingPort.Count -gt 0) {
    Write-Host "Portability manifest is missing shared keys: $($missingPort -join ', ')" -ForegroundColor Red
    $fail = $true
}

if ($fail) {
    Write-Host ""
    Write-Host "Diagnose keys:     $($diagKeys -join ', ')"
    Write-Host "Portability keys:  $($portKeys -join ', ')"
    exit 1
}

Write-Host "Bundle schemas share the unified manifest structure." -ForegroundColor Green
Write-Host "Shared keys: $($requiredShared -join ', ')" -ForegroundColor Green
Write-Host "Diagnose-only keys: $(($diagKeys | Where-Object { $requiredShared -notcontains $_ }) -join ', ')"
Write-Host "Portability-only keys: $(($portKeys | Where-Object { $requiredShared -notcontains $_ }) -join ', ')"
exit 0
