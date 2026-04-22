#!/usr/bin/env pwsh
# Restore lost ProjectReferences by reading originals from pre-release/1.0.0
# and computing corrected paths for the new themed folder structure.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-RelPath([string]$from, [string]$to) {
    # Compute relative path from directory $from to file $to
    $fromParts = $from.Replace('/', '\').TrimEnd('\').Split('\')
    $toParts   = $to.Replace('/', '\').Split('\')
    $common = 0
    $max = [Math]::Min($fromParts.Length, $toParts.Length)
    for ($i = 0; $i -lt $max; $i++) {
        if ($fromParts[$i] -ieq $toParts[$i]) { $common++ } else { break }
    }
    $ups = $fromParts.Length - $common
    $parts = @()
    for ($i = 0; $i -lt $ups; $i++) { $parts += '..' }
    for ($i = $common; $i -lt $toParts.Length; $i++) { $parts += $toParts[$i] }
    return $parts -join '\'
}

$root = 'c:\src\repos\vscode-copilot-orchestrator'
Set-Location $root
$origBranch = 'pre-release/1.0.0'

# 1) Build project-name -> current absolute csproj path
$projMap = @{}
Get-ChildItem dotnet -Recurse -Filter '*.csproj' | ForEach-Object {
    $projMap[$_.BaseName] = $_.FullName
}
Write-Host "Mapped $($projMap.Count) projects"

# 2) For each current csproj, get original from git and restore missing ProjectReferences
$fixed = 0
foreach ($proj in (Get-ChildItem dotnet -Recurse -Filter '*.csproj')) {
    $name = $proj.BaseName
    $csprojDir = $proj.DirectoryName
    
    # Try old flat path - try src/dotnet and tests/dotnet
    $origContent = $null
    foreach ($prefix in @('src/dotnet', 'tests/dotnet')) {
        $oldPath = "$prefix/$name/$name.csproj"
        try {
            $origContent = git show "${origBranch}:${oldPath}" 2>&1
            if ($LASTEXITCODE -eq 0) { break } else { $origContent = $null }
        } catch { $origContent = $null }
    }
    if (-not $origContent) { continue }
    
    # Extract original ProjectReference names (not analyzer refs)
    $origRefs = [regex]::Matches($origContent, '<ProjectReference\s+Include="[^"]*\\([^"\\]+)\.csproj"')
    if ($origRefs.Count -eq 0) { continue }
    
    $origRefNames = @()
    foreach ($m in $origRefs) {
        $origRefNames += $m.Groups[1].Value
    }
    
    # Check current content for existing refs
    $currContent = Get-Content $proj.FullName -Raw
    $currRefNames = @()
    $currMatches = [regex]::Matches($currContent, '<ProjectReference\s+Include="[^"]*\\([^"\\]+)\.csproj"')
    foreach ($m in $currMatches) {
        $currRefNames += $m.Groups[1].Value
    }
    
    # Find missing refs
    $missing = @($origRefNames | Where-Object { $_ -notin $currRefNames })
    if ($missing.Count -eq 0) { continue }
    
    # Build the new ItemGroup with correct relative paths
    $newRefs = @()
    foreach ($refName in $missing) {
        if (-not $projMap.ContainsKey($refName)) {
            Write-Warning "  Cannot find project $refName (referenced by $name)"
            continue
        }
        $targetPath = $projMap[$refName]
        $relPath = Get-RelPath $csprojDir $targetPath
        $newRefs += "    <ProjectReference Include=`"$relPath`" />"
    }
    
    if ($newRefs.Count -eq 0) { continue }
    
    # Insert into csproj - add to existing ItemGroup with ProjectReferences, or create new one
    if ($currContent -match '<ItemGroup>\s*\r?\n\s*<ProjectReference') {
        # Add to existing ProjectReference ItemGroup
        $currContent = $currContent -replace '(<ItemGroup>\s*\r?\n)(\s*<ProjectReference)', "`$1$($newRefs -join "`n")`n`$2"
    } elseif ($currContent -match '</PropertyGroup>\s*\r?\n') {
        # No existing ItemGroup - add after last PropertyGroup
        # But check if there are any ItemGroups at all
        if ($currContent -match '(</Project>)') {
            $itemGroup = "`n  <ItemGroup>`n$($newRefs -join "`n")`n  </ItemGroup>`n"
            $currContent = $currContent -replace '</Project>', "$itemGroup</Project>"
        }
    }
    
    Set-Content $proj.FullName $currContent -NoNewline
    $fixed++
    Write-Host "Restored $($newRefs.Count) refs in $name"
}
Write-Host "`nFixed $fixed project files"

# 3) Also handle special analyzer ProjectReferences that use OutputItemType
# Check SampleConsumer and Analyzers.Tests separately
$sampleConsumer = $projMap['AiOrchestrator.Eventing.Generators.SampleConsumer']
if ($sampleConsumer) {
    $content = Get-Content $sampleConsumer -Raw
    $generators = $projMap['AiOrchestrator.Eventing.Generators']
    $models = $projMap['AiOrchestrator.Models']
    $eventing = $projMap['AiOrchestrator.Eventing']
    $dir = Split-Path $sampleConsumer
    
    # Check if it needs Models and Eventing refs (for the EventV attribute and IEventMigration)
    $needsRefs = @()
    if ($models -and $content -notmatch 'AiOrchestrator\.Models\.csproj') {
        $rel = Get-RelPath $dir $models
        $needsRefs += "    <ProjectReference Include=`"$rel`" />"
    }
    if ($eventing -and $content -notmatch 'AiOrchestrator\.Eventing\.csproj') {
        $rel = Get-RelPath $dir $eventing
        $needsRefs += "    <ProjectReference Include=`"$rel`" />"
    }
    if ($needsRefs.Count -gt 0) {
        $itemGroup = "`n  <ItemGroup>`n$($needsRefs -join "`n")`n  </ItemGroup>"
        $content = $content -replace '</Project>', "$itemGroup`n</Project>"
        Set-Content $sampleConsumer $content -NoNewline
        Write-Host "Added Models/Eventing refs to SampleConsumer"
    }
}

Write-Host "`nDone. Rebuild now."
