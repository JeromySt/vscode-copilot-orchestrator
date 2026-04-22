#Requires -Version 5.1
<#
.SYNOPSIS
    Asserts every `uses:` line in .github/workflows/*.yml pins the action by 40-char hex SHA.
.DESCRIPTION
    Floating tags (@v1, @main, @master, @latest) are forbidden per INV-10 and J43-PC-4.
    Trailing comments like '# v4.2.0' (Dependabot convention) are allowed.
#>
[CmdletBinding()]
param(
    [string]$WorkflowsDir = (Join-Path $PSScriptRoot '..\..\.github\workflows')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedDir = Resolve-Path $WorkflowsDir
Write-Host "Scanning workflows under: $resolvedDir"

$violations = @()
$files = Get-ChildItem -Path $resolvedDir -Filter '*.yml' -File
foreach ($file in $files) {
    $lineNo = 0
    foreach ($line in Get-Content $file.FullName) {
        $lineNo++
        if ($line -match '^\s*-?\s*uses:\s*([^\s#]+)') {
            $ref = $Matches[1].Trim()
            # Must be in form owner/repo@<40hex>  (or owner/repo/path@<40hex>)
            if ($ref -notmatch '@[0-9a-fA-F]{40}$') {
                $violations += "$($file.Name):${lineNo}: '$ref' is not pinned by 40-char SHA"
            }
        }
    }
}

if ($violations.Count -gt 0) {
    Write-Host "FAIL: $($violations.Count) workflow uses are not pinned by SHA:" -ForegroundColor Red
    $violations | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    exit 1
}

Write-Host "OK: all $($files.Count) workflow files have SHA-pinned 'uses:' references." -ForegroundColor Green
exit 0
