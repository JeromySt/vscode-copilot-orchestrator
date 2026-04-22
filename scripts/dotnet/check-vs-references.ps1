#Requires -Version 5.1
<#
.SYNOPSIS
    Verifies INV-1 of job 040: only AiOrchestrator.VsCode.Transport may reference Microsoft.VisualStudio.* packages.

.DESCRIPTION
    Scans every src/dotnet/**/*.csproj for <PackageReference Include="Microsoft.VisualStudio.*" /> entries.
    Any reference in a project other than AiOrchestrator.VsCode.Transport is a violation and causes exit 1.

.EXAMPLE
    pwsh ./scripts/dotnet/check-vs-references.ps1
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$srcDir   = Join-Path $repoRoot 'src' 'dotnet'

if (-not (Test-Path $srcDir)) {
    Write-Error "Source directory not found: $srcDir"
    exit 1
}

$allowed = 'AiOrchestrator.VsCode.Transport'
$csprojFiles = @(Get-ChildItem -Path $srcDir -Filter '*.csproj' -Recurse -ErrorAction SilentlyContinue)

$violations = @()

foreach ($file in $csprojFiles) {
    $projectName = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    $content     = Get-Content $file.FullName -Raw

    $matches = [System.Text.RegularExpressions.Regex]::Matches(
        $content,
        '<PackageReference\s+Include="(Microsoft\.VisualStudio\.[^"]+)"'
    )

    foreach ($match in $matches) {
        $pkg = $match.Groups[1].Value
        if ($projectName -ne $allowed) {
            $violations += [PSCustomObject]@{
                Project = $projectName
                Package = $pkg
                File    = $file.FullName
            }
        }
    }
}

if ($violations.Count -gt 0) {
    Write-Host ""
    Write-Host "INV-1 violated — Microsoft.VisualStudio.* package references outside '$allowed':" -ForegroundColor Red
    foreach ($v in $violations) {
        Write-Host "  $($v.Project) references $($v.Package)" -ForegroundColor Red
        Write-Host "    in $($v.File)" -ForegroundColor DarkRed
    }
    exit 1
}

Write-Host "check-vs-references PASSED. No Microsoft.VisualStudio.* references outside '$allowed'." -ForegroundColor Green
exit 0
