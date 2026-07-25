param(
    [string]$Workspace = "C:\Users\huizh\Apps\HZ code",
    [string]$HandoffsDir = "",
    [string]$StateDir = "",
    [switch]$Once,
    [int]$PollSeconds = 15
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($HandoffsDir)) {
    $HandoffsDir = Join-Path $Workspace "handoffs"
}
if ([string]::IsNullOrWhiteSpace($StateDir)) {
    $StateDir = Join-Path $Workspace ".tandem\handoff-watch"
}

function Get-HandoffRound {
    param([string]$Name)
    if ($Name -match '^HANDOFF(?:_GPT5)?_D(\d+)\.md$') {
        return [int]$Matches[1]
    }
    return $null
}

function Get-DoneRound {
    param([string]$Name)
    if ($Name -match '^D(\d+)_done\.txt$') {
        return [int]$Matches[1]
    }
    return $null
}

function Get-Baseline {
    $rounds = New-Object System.Collections.Generic.List[int]

    if (Test-Path -LiteralPath $HandoffsDir) {
        Get-ChildItem -LiteralPath $HandoffsDir -File -Filter "D*_done.txt" -ErrorAction SilentlyContinue |
            ForEach-Object {
                $n = Get-DoneRound $_.Name
                if ($null -ne $n) { $rounds.Add($n) }
            }
    }

    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) {
        try {
            $subjects = & git -C $Workspace log --all --max-count=300 --pretty=format:'%s' 2>$null
            foreach ($line in $subjects) {
                if ($line -match '^D(\d+)(?:-\d+)?[: -]') {
                    $rounds.Add([int]$Matches[1])
                }
            }
        } catch { }
    }

    if ($rounds.Count -eq 0) { return 0 }
    return ($rounds | Sort-Object -Descending | Select-Object -First 1)
}

function Get-NextHandoff {
    param([int]$Baseline)

    if (-not (Test-Path -LiteralPath $HandoffsDir)) {
        return $null
    }

    $handoffs = Get-ChildItem -LiteralPath $HandoffsDir -File -ErrorAction SilentlyContinue |
        ForEach-Object {
            $n = Get-HandoffRound $_.Name
            if ($null -ne $n) {
                [pscustomobject]@{
                    N = $n
                    Path = $_.FullName
                    Name = $_.Name
                    LastWriteTimeUtc = $_.LastWriteTimeUtc
                }
            }
        } |
        Sort-Object N, Name

    if (-not $handoffs) { return $null }

    $expected = $Baseline + 1
    $candidate = $handoffs | Where-Object { $_.N -eq $expected } | Select-Object -First 1
    if (-not $candidate) { return $null }

    try {
        $head = Get-Content -LiteralPath $candidate.Path -TotalCount 30 -ErrorAction SilentlyContinue
        if ($head -match 'STATUS:\s*DEFERRED') { return $null }
    } catch { }

    return $candidate
}

function Write-WatchState {
    param(
        [int]$Baseline,
        [object]$Next,
        [bool]$Triggered
    )

    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null

    $status = [ordered]@{
        workspace = $Workspace
        handoffsDir = $HandoffsDir
        baseline = $Baseline
        expectedNext = $Baseline + 1
        checkedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        triggered = $Triggered
        nextRound = if ($Next) { $Next.N } else { $null }
        nextPath = if ($Next) { $Next.Path } else { $null }
    }

    $statusPath = Join-Path $StateDir "status.json"
    $status | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statusPath -Encoding UTF8

    $triggerPath = Join-Path $StateDir "wakeup.json"
    $promptPath = Join-Path $StateDir "wakeup-prompt.txt"

    if ($Next) {
        $payload = [ordered]@{
            reason = "next-handoff-ready"
            round = $Next.N
            handoffPath = $Next.Path
            baseline = $Baseline
            createdAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        }
        $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $triggerPath -Encoding UTF8

        @"
Local watcher found D$($Next.N) ready.

Read the full handoff at:
$($Next.Path)

Implement rounds in strict numeric order from D$($Next.N), run the requested checks plus npm run typecheck, npm test, and git diff --check, commit with D$($Next.N)-prefixed message(s), then create and commit handoffs/D$($Next.N)_done.txt with round number, commit hash(es), and verification summary.
"@ | Set-Content -LiteralPath $promptPath -Encoding UTF8
    } else {
        Remove-Item -LiteralPath $triggerPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $promptPath -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Scan {
    $baseline = Get-Baseline
    $next = Get-NextHandoff -Baseline $baseline
    Write-WatchState -Baseline $baseline -Next $next -Triggered ([bool]$next)

    if ($next) {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] D$($next.N) is ready: $($next.Path)"
        return 0
    }

    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] no next handoff; baseline D$baseline"
    return 0
}

if ($Once) {
    exit (Invoke-Scan)
}

while ($true) {
    Invoke-Scan | Out-Null
    Start-Sleep -Seconds $PollSeconds
}
