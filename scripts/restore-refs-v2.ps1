#!/usr/bin/env pwsh
# Use `dotnet add reference` to restore missing ProjectReferences.
# This is slower but reliable since dotnet CLI handles csproj XML properly.

$root = 'c:\src\repos\vscode-copilot-orchestrator'
Set-Location $root
$origBranch = 'pre-release/1.0.0'

# Build project-name -> current absolute csproj path
$projMap = @{}
Get-ChildItem dotnet -Recurse -Filter '*.csproj' | ForEach-Object {
    $projMap[$_.BaseName] = $_.FullName
}
Write-Host "Mapped $($projMap.Count) projects"

$totalAdded = 0
$skipped = @()

foreach ($proj in (Get-ChildItem dotnet -Recurse -Filter '*.csproj')) {
    $name = $proj.BaseName
    $csprojPath = $proj.FullName
    
    # Find original content from git
    $origContent = $null
    foreach ($prefix in @('src/dotnet', 'tests/dotnet')) {
        $oldPath = "$prefix/$name/$name.csproj"
        try {
            $result = & git show "${origBranch}:${oldPath}" 2>&1
            if ($LASTEXITCODE -eq 0) { $origContent = $result -join "`n"; break }
        } catch { }
    }
    if (-not $origContent) { continue }
    
    # Get original simple ProjectReference names (not analyzer/OutputItemType refs)
    $origRefNames = @()
    $origRefMatches = [regex]::Matches($origContent, '<ProjectReference\s+Include="[^"]*?([^"\\]+)\.csproj"\s*/>')
    foreach ($m in $origRefMatches) { $origRefNames += $m.Groups[1].Value }
    if ($origRefNames.Count -eq 0) { continue }
    
    # Get current ref names (all ProjectReference includes)
    $currContent = Get-Content $csprojPath -Raw
    $currRefNames = @()
    $currMatches = [regex]::Matches($currContent, '([^"\\]+)\.csproj')
    foreach ($m in $currMatches) { $currRefNames += $m.Groups[1].Value }
    
    # Find missing
    $missing = @($origRefNames | Where-Object { $_ -notin $currRefNames })
    if ($missing.Count -eq 0) { continue }
    
    foreach ($refName in $missing) {
        if (-not $projMap.ContainsKey($refName)) {
            $skipped += "$name needs $refName (not found)"
            continue
        }
        $targetCsproj = $projMap[$refName]
        & dotnet add $csprojPath reference $targetCsproj 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $totalAdded++
        } else {
            $skipped += "$name -> $refName (dotnet add failed)"
        }
    }
    if ($missing.Count -gt 0) {
        Write-Host "  $name +$($missing.Count) refs ($($missing -join ', '))"
    }
}

Write-Host "`nAdded $totalAdded references via dotnet CLI"
if ($skipped.Count -gt 0) {
    Write-Host "Skipped:"
    $skipped | ForEach-Object { Write-Host "  $_" }
}
