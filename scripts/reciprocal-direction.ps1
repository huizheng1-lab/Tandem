param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Show", "Add", "Remove", "Start", "Candidate", "Complete", "Block", "Requeue")]
    [string]$Action,

    [string]$Text,

    [ValidateSet("P0", "P1", "P2", "P3")]
    [string]$Priority = "P1",

    [string]$Id,

    [ValidateSet("A", "B")]
    [string]$Role,

    [string]$Commit,

    [string]$Note,

    [string]$ControlPath
)

$ErrorActionPreference = "Stop"

function Get-GitValue([string[]]$Arguments) {
    $output = @(& git @Arguments 2>$null)
    if ($LASTEXITCODE -ne 0 -or $output.Count -eq 0) { return $null }
    return $output[0].Trim()
}

if (-not $ControlPath) {
    $workspace = Get-GitValue @("rev-parse", "--show-toplevel")
    if (-not $workspace) { throw "Run this command inside the Tandem repository or pass -ControlPath." }
    $localPath = Join-Path $workspace ".tandem\shared-control\SHARED_DIRECTION.md"
    if (Test-Path -LiteralPath (Split-Path $localPath -Parent)) {
        $ControlPath = $localPath
    } else {
        $commonRaw = Get-GitValue @("rev-parse", "--git-common-dir")
        $commonDir = if ([IO.Path]::IsPathRooted($commonRaw)) { $commonRaw } else { [IO.Path]::GetFullPath((Join-Path $workspace $commonRaw)) }
        $adminRepo = Split-Path $commonDir -Parent
        $relayRoot = Join-Path (Split-Path $adminRepo -Parent) "Tandem Reciprocal"
        $ControlPath = Join-Path $relayRoot "control\SHARED_DIRECTION.md"
    }
}

$ControlPath = [IO.Path]::GetFullPath($ControlPath)
$controlDir = Split-Path $ControlPath -Parent
New-Item -ItemType Directory -Path $controlDir -Force | Out-Null

if (-not (Test-Path -LiteralPath $ControlPath)) {
    $workspace = Get-GitValue @("rev-parse", "--show-toplevel")
    $template = if ($workspace) { Join-Path $workspace "process\reciprocal\SHARED_DIRECTION_TEMPLATE.md" } else { $null }
    if (-not $template -or -not (Test-Path -LiteralPath $template)) {
        throw "Shared direction file is missing and its template could not be found."
    }
    Copy-Item -LiteralPath $template -Destination $ControlPath
}

$sha = [Security.Cryptography.SHA256]::Create()
try {
    $hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($ControlPath.ToLowerInvariant()))
} finally {
    $sha.Dispose()
}
$hashText = ([BitConverter]::ToString($hashBytes)).Replace("-", "")
$mutex = [Threading.Mutex]::new($false, "Local\TandemDirection-" + $hashText.Substring(0, 20))
if (-not $mutex.WaitOne(5000)) { throw "Timed out waiting for the shared direction lock." }

try {
    if ($Action -eq "Show") {
        Get-Content -LiteralPath $ControlPath -Raw
        exit 0
    }

    $lines = @(Get-Content -LiteralPath $ControlPath)
    $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

    if ($Action -eq "Add") {
        $cleanText = if ($null -eq $Text) { "" } else { ($Text -replace "\s+", " ").Trim().Replace("|", "/") }
        if (-not $cleanText) { throw "Add requires -Text." }
        $numbers = @($lines | ForEach-Object {
            if ($_ -match '^- \[(?: |x)\] W(\d{4}) \|' -or $_ -match '^- id=W(\d{4}) \| removed=') {
                [int]$Matches[1]
            }
        })
        $nextNumber = if ($numbers.Count) { ($numbers | Measure-Object -Maximum).Maximum + 1 } else { 1 }
        $Id = "W" + ([int]$nextNumber).ToString("D4")
        $marker = [Array]::IndexOf($lines, "<!-- wishlist-items -->")
        if ($marker -lt 0) { throw "Shared direction file is missing the wishlist marker." }
        $item = "- [ ] $Id | $Priority | $cleanText | QUEUED added=$now"
        $before = if ($marker -ge 0) { @($lines[0..$marker]) } else { @() }
        $after = if ($marker + 1 -lt $lines.Count) { @($lines[($marker + 1)..($lines.Count - 1)]) } else { @() }
        $lines = @($before + $item + $after)
    } else {
        if (-not $Id) { throw "$Action requires -Id." }
        $pattern = '^- \[(?: |x)\] ' + [regex]::Escape($Id) + ' \|'
        $matches = @(0..($lines.Count - 1) | Where-Object { $lines[$_] -match $pattern })
        if ($matches.Count -ne 1) { throw "Expected exactly one wishlist item $Id; found $($matches.Count)." }
        $index = $matches[0]
        $originalLine = $lines[$index]
        $parts = @($originalLine -split ' \| ')
        if ($parts.Count -lt 3) { throw "Wishlist item $Id is malformed." }
        $base = @($parts[0], $parts[1], $parts[2])

        switch ($Action) {
            "Remove" {
                $cleanNote = if ($null -eq $Note) { "" } else { ($Note -replace "\s+", " ").Trim().Replace("|", "/") }
                if (-not $cleanNote) { throw "Remove requires -Note." }
                $status = if ($parts.Count -ge 4) { ($parts[3] -split '\s+')[0] } else { "" }
                if ($status -eq "IN_PROGRESS") {
                    throw "Cannot remove $Id while it is IN_PROGRESS. Let the turn finish, requeue it, or end the turn first."
                }

                $before = if ($index -gt 0) { @($lines[0..($index - 1)]) } else { @() }
                $after = if ($index + 1 -lt $lines.Count) { @($lines[($index + 1)..($lines.Count - 1)]) } else { @() }
                $lines = @($before + $after)
                $removedHeader = [Array]::IndexOf($lines, "## Removed")
                if ($removedHeader -lt 0) {
                    $lines = @($lines + "" + "## Removed" + "")
                }
                $lines = @(
                    $lines +
                    "- id=$Id | removed=$now | note=$cleanNote" +
                    "  original: $originalLine"
                )
            }
            "Start" {
                if (-not $Role) { throw "Start requires -Role." }
                if ($base[0] -match '\[x\]') { throw "$Id is already complete." }
                $lines[$index] = ($base + "IN_PROGRESS role=$Role started=$now") -join " | "
            }
            "Candidate" {
                if (-not $Commit) { throw "Candidate requires -Commit." }
                $lines[$index] = ($base + "CANDIDATE commit=$Commit updated=$now") -join " | "
            }
            "Complete" {
                if (-not $Commit) { throw "Complete requires the accepted stable -Commit." }
                $base[0] = $base[0] -replace '^- \[ \]', '- [x]'
                $lines[$index] = ($base + "DONE stable=$Commit completed=$now") -join " | "
            }
            "Block" {
                $cleanNote = if ($null -eq $Note) { "" } else { ($Note -replace "\s+", " ").Trim().Replace("|", "/") }
                if (-not $cleanNote) { throw "Block requires -Note." }
                $lines[$index] = ($base + "BLOCKED note=$cleanNote updated=$now") -join " | "
            }
            "Requeue" {
                $base[0] = $base[0] -replace '^- \[x\]', '- [ ]'
                $cleanNote = if ($null -eq $Note) { "" } else { ($Note -replace "\s+", " ").Trim().Replace("|", "/") }
                $suffix = if ($cleanNote) { "QUEUED note=$cleanNote updated=$now" } else { "QUEUED updated=$now" }
                $lines[$index] = ($base + $suffix) -join " | "
            }
        }
    }

    $tempPath = "$ControlPath.tmp-$PID"
    [IO.File]::WriteAllLines($tempPath, [string[]]$lines, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tempPath -Destination $ControlPath -Force
    [ordered]@{ action = $Action; id = $Id; path = $ControlPath } | ConvertTo-Json
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
