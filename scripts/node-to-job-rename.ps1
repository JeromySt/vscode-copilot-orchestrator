$path = (Resolve-Path (Join-Path $PSScriptRoot '..\docs\DOTNET_CORE_REARCHITECTURE_PLAN.md')).Path
$bytes = [System.IO.File]::ReadAllBytes($path)
$hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
$txt = [System.Text.Encoding]::UTF8.GetString($bytes)
if ($hasBom) { $txt = $txt.TrimStart([char]0xFEFF) }
$orig = $txt
$protectPatterns = @('Node\.js','AiOrchestrator\.Bindings\.Node','Bindings\.Node','@ai-orchestrator/native','NodeBindingClient','nodeBindingClient','NodeBinding','NodeBind\b','INodeBinding\w*','NODE_OPTIONS','node_modules','node-options-scrub','Node bindings?','Node Binding','Node runtime','Node consumers?','node binding','\.node\b','svNodeBuilder(?:\.ts)?')
$ph  = New-Object 'System.Collections.Generic.Dictionary[string,string]'
$ctr = 0
foreach ($pat in $protectPatterns) {
    $rx = [regex]$pat
    $txt = $rx.Replace($txt, {
        param($m)
        $key = "`u{E000}K$($script:ctr)`u{E001}"
        $script:ph[$key] = $m.Value
        $script:ctr++
        $key
    })
}
Write-Host "Protected $ctr"
$txt = $txt -creplace '([a-z])Node([A-Z]\w*)', '$1Job$2'
$txt = $txt -creplace '([a-z])Nodes\b',         '$1Jobs'
$txt = $txt -creplace '([a-z])Node\b',          '$1Job'
$txt = $txt -creplace '\bINode([A-Z][A-Za-z0-9]*)', 'IJob$1'
$txt = $txt -creplace '\bNode([A-Z][A-Za-z0-9]*)',  'Job$1'
$txt = $txt -creplace '\bnode([A-Z][A-Za-z0-9]*)',  'job$1'
$txt = $txt -creplace '\bNodes\b', 'Jobs'
$txt = $txt -creplace '\bnodes\b', 'jobs'
$txt = $txt -creplace '\bnode8\b', 'job8'
$txt = $txt -creplace '\bNode8\b', 'Job8'
$txt = $txt -creplace '\bNode\b',  'Job'
$txt = $txt -creplace '\bnode\b',  'job'
foreach ($k in $ph.Keys) { $txt = $txt.Replace($k, $ph[$k]) }
if ($txt.IndexOf([char]0xE000) -ge 0) { Write-Error "leak"; exit 1 }
$bn = ([regex]::Matches($orig, '[Nn]ode\w*')).Count
$an = ([regex]::Matches($txt , '[Nn]ode\w*')).Count
Write-Host "Node tokens: $bn -> $an"
$enc = New-Object 'System.Text.UTF8Encoding' $hasBom
[System.IO.File]::WriteAllText($path, $txt, $enc)
Write-Host "Wrote BOM=$hasBom"
# One-shot Node->Job rename for docs/DOTNET_CORE_REARCHITECTURE_PLAN.md.
# Uses sentinel-protected regex replace with byte-level UTF-8 round-trip.
