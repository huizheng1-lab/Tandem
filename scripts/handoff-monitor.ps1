# Scans for unhandled handoff files. Supports both naming conventions used across rounds:
#   - HANDOFF_GPT5_D*.md   (older rounds D6-D50)
#   - HANDOFF_D*.md        (rounds D51+)
# A round is considered handled if EITHER:
#   - a D<n>_done.txt marker exists in the repo root, OR
#   - the git log has a "D<n>-<sub>: ..." commit anywhere (the upstream convention).
# Prints the highest unhandled round and exits 1 when work exists, 0 otherwise.
$ErrorActionPreference = "Stop"
$workspace = "C:\Users\huizh\Apps\HZ code"
Set-Location $workspace

# Both naming conventions. Newer HANDOFF_D*.md first since it's the current scheme.
$handoffs = @(
    Get-ChildItem -Path $workspace -Filter "HANDOFF_D*.md" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.BaseName -ne "HANDOFF_DOT" }
    Get-ChildItem -Path $workspace -Filter "HANDOFF_GPT5_D*.md" -File -ErrorAction SilentlyContinue
)
# Deduplicate by full path (a single HANDOFF_D51.md would only appear under one filter anyway,
# but be defensive).
$handoffs = $handoffs | Sort-Object -Property FullName -Unique

$doneFiles = Get-ChildItem -Path $workspace -Filter "D*_done.txt" -File -ErrorAction SilentlyContinue

$handled = @{}
foreach ($d in $doneFiles) {
    if ($d.BaseName -match '^D(\d+)_done$') { $handled[[int]$Matches[1]] = $true }
}

$git = (Get-Command git -ErrorAction SilentlyContinue)
if ($git) {
    try {
        $commits = & git -C $workspace log --all --pretty=format:'%s' 2>$null
        foreach ($line in $commits) {
            # Commit messages look like "D<n>-<sub>: ..." e.g. "D51-1: add /loop...".
            # The literal `\d+` must be a regex digit-class (previous bug had a bare `d+`).
            if ($line -match '^D(\d+)-\d+[: ]') { $handled[[int]$Matches[1]] = $true }
        }
    } catch { }
}

$unhandled = @()
foreach ($h in $handoffs) {
    # Accept both "HANDOFF_GPT5_D<n>" and "HANDOFF_D<n>" base names.
    $matchesGpt5 = $h.BaseName -match '^HANDOFF_GPT5_D(\d+)$'
    $matchesBare  = $h.BaseName -match '^HANDOFF_D(\d+)$'
    if (-not ($matchesGpt5 -or $matchesBare)) { continue }
    # If a file matches both filters (shouldn't happen because the two patterns are disjoint
    # except via $h.BaseName equality) prefer the GPT5 one once, but we already deduped above.
    $n = [int]$Matches[1]
    if (-not $handled.ContainsKey($n)) {
        $statusDeferred = $false
        try {
            $firstLines = Get-Content $h.FullName -TotalCount 30 -ErrorAction SilentlyContinue
            if ($firstLines -match 'STATUS:\s*DEFERRED') { $statusDeferred = $true }
        } catch { }
        if (-not $statusDeferred) {
            $unhandled += [pscustomobject]@{ N = $n; Path = $h.FullName }
        }
    }
}

if ($unhandled.Count -eq 0) {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] no unhandled handoffs"
    exit 0
}

$unhandled = $unhandled | Sort-Object N
$next = $unhandled[0]
Write-Host "[$(Get-Date -Format 'HH:mm:ss')] unhandled handoff(s): $($unhandled.N -join ', ')"
Write-Host "=== D$($next.N) (highest priority) ==="
$head = Get-Content $next.Path -TotalCount 5 -ErrorAction SilentlyContinue
if ($head) { $head | ForEach-Object { Write-Host $_ } }
Write-Host "(see $($next.Path) for full)"
exit 1