#Requires -Version 5.1
<#
.SYNOPSIS
    Verifies .NET code coverage for a specified project meets minimum thresholds.

.DESCRIPTION
    Runs dotnet test with XPlat Code Coverage if a fresh coverage report is not already present.
    Parses the resulting cobertura XML and checks line and branch rates against thresholds.
    Writes a JSON report with results.

.PARAMETER Project
    The project name (e.g., AiOrchestrator.Core).

.PARAMETER MinLine
    Minimum acceptable line coverage rate (0.0–1.0). Default: 0.80.

.PARAMETER MinBranch
    Minimum acceptable branch coverage rate (0.0–1.0). Default: 0.70.

.PARAMETER ResultsDir
    Directory for coverage results. Defaults to a temp dir under the repo's .orchestrator/tmp.

.EXAMPLE
    pwsh ./scripts/dotnet/check-coverage.ps1 -Project AiOrchestrator.Core -MinLine 0.90 -MinBranch 0.80
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Project,

    [Parameter(Mandatory = $false)]
    [double]$MinLine = 0.80,

    [Parameter(Mandatory = $false)]
    [double]$MinBranch = 0.70,

    [Parameter(Mandatory = $false)]
    [string]$ResultsDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$tmpDir = Join-Path $repoRoot '.orchestrator' 'tmp'

if ([string]::IsNullOrEmpty($ResultsDir)) {
    $ResultsDir = Join-Path $tmpDir "aio-cov-$Project"
}

$coberturaPattern = Join-Path $ResultsDir '**' 'coverage.cobertura.xml'
$coberturaFiles = @(Get-ChildItem -Path $ResultsDir -Filter 'coverage.cobertura.xml' -Recurse -ErrorAction SilentlyContinue)

if ($coberturaFiles.Count -eq 0) {
    Write-Host "Running dotnet test for $Project to collect coverage..." -ForegroundColor Cyan
    $testProj = Join-Path $repoRoot 'tests' 'dotnet' "$Project.Tests"
    if (-not (Test-Path $testProj)) {
        $testProj = Join-Path $repoRoot 'src' 'dotnet' $Project
    }

    $logFile = Join-Path $tmpDir "aio-cov-run-$Project.log"
    $null = New-Item -ItemType Directory -Force -Path $ResultsDir

    & dotnet test $testProj `
        --collect:"XPlat Code Coverage" `
        --results-directory $ResultsDir `
        --nologo `
        2>&1 | Tee-Object -FilePath $logFile

    if ($LASTEXITCODE -ne 0) {
        Write-Error "dotnet test failed. See $logFile for details."
        exit 1
    }

    $coberturaFiles = @(Get-ChildItem -Path $ResultsDir -Filter 'coverage.cobertura.xml' -Recurse -ErrorAction SilentlyContinue)
    if ($coberturaFiles.Count -eq 0) {
        Write-Error "No coverage.cobertura.xml found in $ResultsDir after test run."
        exit 1
    }
}

$coberturaFile = $coberturaFiles[0].FullName
Write-Host "Parsing coverage report: $coberturaFile" -ForegroundColor Cyan

[xml]$cobertura = Get-Content $coberturaFile
$projectFilter = "src/dotnet/$Project"

$totalLines = 0
$coveredLines = 0
$totalBranches = 0
$coveredBranches = 0

foreach ($package in $cobertura.coverage.packages.package) {
    foreach ($class in $package.classes.class) {
        $filename = $class.filename -replace '\\', '/'
        if ($filename -notlike "*$Project*") { continue }

        foreach ($line in $class.lines.line) {
            $totalLines++
            if ([int]$line.hits -gt 0) { $coveredLines++ }

            $condition = $line.'condition-coverage'
            if ($condition) {
                if ($condition -match '(\d+)/(\d+)') {
                    $coveredBranches += [int]$Matches[1]
                    $totalBranches   += [int]$Matches[2]
                }
            }
        }
    }
}

$lineRate   = if ($totalLines -gt 0)    { [double]$coveredLines / $totalLines }       else { 1.0 }
$branchRate = if ($totalBranches -gt 0) { [double]$coveredBranches / $totalBranches } else { 1.0 }

$report = [ordered]@{
    project    = $Project
    lineRate   = [math]::Round($lineRate, 4)
    branchRate = [math]::Round($branchRate, 4)
    minLine    = $MinLine
    minBranch  = $MinBranch
    passed     = ($lineRate -ge $MinLine) -and ($branchRate -ge $MinBranch)
    details    = @{
        totalLines       = $totalLines
        coveredLines     = $coveredLines
        totalBranches    = $totalBranches
        coveredBranches  = $coveredBranches
    }
}

$reportJson = $report | ConvertTo-Json -Depth 5
$reportPath = Join-Path $tmpDir "coverage-report-$Project.json"
$reportJson | Set-Content -Path $reportPath -Encoding UTF8
Write-Host $reportJson

if (-not $report.passed) {
    Write-Error "Coverage check FAILED for $Project. Line: $([math]::Round($lineRate * 100, 1))% (min $([math]::Round($MinLine * 100, 1))%), Branch: $([math]::Round($branchRate * 100, 1))% (min $([math]::Round($MinBranch * 100, 1))%)"
    exit 1
}

Write-Host "Coverage check PASSED for $Project." -ForegroundColor Green
exit 0
