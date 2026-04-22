#!/usr/bin/env pwsh
# Fix all ProjectReference paths after the folder restructure.
# Strategy: build a map of project-name -> absolute-csproj-path, then rewrite
# every ProjectReference Include to use the correct relative path.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')

# 1) Build project-name -> absolute-path map
$projMap = @{}
Get-ChildItem (Join-Path $root 'dotnet') -Recurse -Filter '*.csproj' | ForEach-Object {
    $name = $_.BaseName                       # e.g. AiOrchestrator.Models
    if ($projMap.ContainsKey($name)) {
        Write-Warning "Duplicate project name: $name`n  existing: $($projMap[$name])`n  new:      $($_.FullName)"
    }
    $projMap[$name] = $_.FullName
}
Write-Host "Found $($projMap.Count) projects in dotnet/"

# 2) Walk every csproj and fix ProjectReference Include paths
$fixedFiles = 0; $fixedRefs = 0; $emptyRemoved = 0

Get-ChildItem (Join-Path $root 'dotnet') -Recurse -Filter '*.csproj' | ForEach-Object {
    $csprojPath = $_.FullName
    $csprojDir  = $_.DirectoryName
    $content    = Get-Content $csprojPath -Raw
    $original   = $content
    $changed    = $false

    # --- Fix broken/stale Include paths ---
    $content = [regex]::Replace($content,
        '(<ProjectReference\s+Include=")([^"]+)(")',
        {
            param($m)
            $prefix  = $m.Groups[1].Value
            $oldPath = $m.Groups[2].Value
            $suffix  = $m.Groups[3].Value

            # Resolve what the old path points to
            $resolvedOld = [System.IO.Path]::GetFullPath(
                [System.IO.Path]::Combine($csprojDir, $oldPath))

            if (Test-Path $resolvedOld) {
                # Already valid, leave it alone
                return $m.Value
            }

            # Extract target project name from the old path
            $targetName = [System.IO.Path]::GetFileNameWithoutExtension($oldPath)
            if (-not $projMap.ContainsKey($targetName)) {
                Write-Warning "  Cannot resolve '$targetName' referenced in $($_.Name)"
                return $m.Value
            }

            # Compute correct relative path
            $targetAbsolute = $projMap[$targetName]
            $relPath = [System.IO.Path]::GetRelativePath($csprojDir, $targetAbsolute)
            $relPath = $relPath -replace '/', '\'

            $script:fixedRefs++
            $script:changed = $true
            return "${prefix}${relPath}${suffix}"
        })

    # --- Remove empty Include="" ProjectReference elements ---
    # Self-closing: <ProjectReference Include="" ... />
    $before = $content
    $content = $content -replace '(?m)^\s*<ProjectReference\s+Include=""\s*[^/]*/>\s*\r?\n?', ''
    # Open/close: <ProjectReference Include="">...</ProjectReference>
    $content = $content -replace '(?s)<ProjectReference\s+Include=""[^>]*>.*?</ProjectReference>\s*\r?\n?', ''
    if ($content -ne $before) {
        $emptyRemoved++
        $changed = $true
    }

    # --- Clean up empty ItemGroups ---
    $content = $content -replace '(?m)^\s*<ItemGroup>\s*\r?\n\s*</ItemGroup>\s*\r?\n?', ''

    if ($content -ne $original) {
        Set-Content $csprojPath $content -NoNewline
        $fixedFiles++
    }
}

Write-Host "`nDone. Fixed $fixedRefs refs across $fixedFiles files. Removed $emptyRemoved empty-include elements."

# 3) Verify — report any remaining broken refs
Write-Host "`n--- Verification ---"
$stillBroken = 0
Get-ChildItem (Join-Path $root 'dotnet') -Recurse -Filter '*.csproj' | ForEach-Object {
    $dir = $_.DirectoryName
    $matches2 = [regex]::Matches((Get-Content $_.FullName -Raw),
        '<ProjectReference\s+Include="([^"]*)"')
    foreach ($m in $matches2) {
        $inc = $m.Groups[1].Value
        if ([string]::IsNullOrWhiteSpace($inc)) {
            Write-Host "  EMPTY Include in $($_.Name)"
            $stillBroken++
            continue
        }
        $resolved = [System.IO.Path]::GetFullPath(
            [System.IO.Path]::Combine($dir, $inc))
        if (-not (Test-Path $resolved)) {
            Write-Host "  BROKEN: $($_.Name) -> $inc"
            $stillBroken++
        }
    }
}
if ($stillBroken -eq 0) {
    Write-Host "All ProjectReference paths are valid!"
} else {
    Write-Host "$stillBroken broken references remain."
}
