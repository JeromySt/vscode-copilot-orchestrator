#!/usr/bin/env pwsh
# Fix remaining missing ProjectReferences using `dotnet add reference`
# which properly handles csproj formatting.

$root = 'c:\src\repos\vscode-copilot-orchestrator'
Set-Location $root
$origBranch = 'pre-release/1.0.0'

# Build project-name -> current absolute csproj path
$projMap = @{}
Get-ChildItem dotnet -Recurse -Filter '*.csproj' | ForEach-Object {
    $projMap[$_.BaseName] = $_.FullName
}

function Get-OrigContent([string]$name) {
    foreach ($prefix in @('src/dotnet', 'tests/dotnet')) {
        $oldPath = "$prefix/$name/$name.csproj"
        $content = git show "${origBranch}:${oldPath}" 2>$null
        if ($LASTEXITCODE -eq 0 -and $content) { return $content }
    }
    return $null
}

$totalAdded = 0
foreach ($proj in (Get-ChildItem dotnet -Recurse -Filter '*.csproj')) {
    $name = $proj.BaseName
    $csprojPath = $proj.FullName
    
    $origContent = Get-OrigContent $name
    if (-not $origContent) { continue }
    
    # Get original ref names (skip analyzer refs with OutputItemType)
    $origRefMatches = [regex]::Matches($origContent, '<ProjectReference\s+Include="[^"]*\\([^"\\]+)\.csproj"\s*/>')
    $origRefNames = @($origRefMatches | ForEach-Object { $_.Groups[1].Value })
    if ($origRefNames.Count -eq 0) { continue }
    
    # Get current ref names
    $currContent = Get-Content $csprojPath -Raw
    $currRefMatches = [regex]::Matches($currContent, '<ProjectReference\s+Include="[^"]*([^"\\]+)\.csproj"')
    $currRefNames = @($currRefMatches | ForEach-Object { $_.Groups[1].Value })
    
    # Find missing
    $missing = @($origRefNames | Where-Object { $_ -notin $currRefNames })
    if ($missing.Count -eq 0) { continue }
    
    foreach ($refName in $missing) {
        if (-not $projMap.ContainsKey($refName)) {
            Write-Host "  SKIP: $refName not found (needed by $name)"
            continue
        }
        $targetCsproj = $projMap[$refName]
        Write-Host "  Adding $refName to $name"
        dotnet add $csprojPath reference $targetCsproj 2>$null | Out-Null
        $totalAdded++
    }
}

Write-Host "`nAdded $totalAdded references total"

# Special: SampleConsumer needs Eventing + Models but not as standard refs
$sc = $projMap['AiOrchestrator.Eventing.Generators.SampleConsumer']
if ($sc) {
    $content = Get-Content $sc -Raw
    if ($content -notmatch 'AiOrchestrator\.Models\.csproj') {
        $mp = $projMap['AiOrchestrator.Models']
        if ($mp) { dotnet add $sc reference $mp 2>$null | Out-Null; Write-Host "Added Models to SampleConsumer" }
    }
    if ($content -notmatch 'AiOrchestrator\.Eventing\.csproj') {
        $ep = $projMap['AiOrchestrator.Eventing']
        if ($ep) { dotnet add $sc reference $ep 2>$null | Out-Null; Write-Host "Added Eventing to SampleConsumer" }
    }
}

# Key ceremony tool
$kc = $projMap['AiOrchestrator.Tools.KeyCeremony']
if ($kc) {
    $origKC = git show "${origBranch}:tools/key-ceremony/AiOrchestrator.Tools.KeyCeremony/AiOrchestrator.Tools.KeyCeremony.csproj" 2>$null
    if (-not $origKC) { $origKC = git show "${origBranch}:src/dotnet/AiOrchestrator.Tools.KeyCeremony/AiOrchestrator.Tools.KeyCeremony.csproj" 2>$null }
    if ($origKC) {
        $origRefs = [regex]::Matches($origKC, '<ProjectReference\s+Include="[^"]*\\([^"\\]+)\.csproj"\s*/>')
        $kcContent = Get-Content $kc -Raw
        foreach ($m in $origRefs) {
            $refName = $m.Groups[1].Value
            if ($kcContent -notmatch [regex]::Escape("$refName.csproj") -and $projMap.ContainsKey($refName)) {
                dotnet add $kc reference $projMap[$refName] 2>$null | Out-Null
                Write-Host "Added $refName to KeyCeremony"
            }
        }
    }
}

Write-Host "Done."
