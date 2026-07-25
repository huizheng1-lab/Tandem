param(
    [string]$Workspace = "C:\Users\huizh\Apps\HZ code",
    [string]$StateDir = "",
    [switch]$Acknowledge
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($StateDir)) {
    $StateDir = Join-Path $Workspace ".tandem\handoff-done-review-watch"
}

$handoffsDir = Join-Path $Workspace "handoffs"
$seenPath = Join-Path $StateDir "seen.json"
$statusPath = Join-Path $StateDir "status.json"
$wakeupPath = Join-Path $StateDir "wakeup.json"

New-Item -ItemType Directory -Path $StateDir -Force | Out-Null

function Get-DoneFiles {
    if (-not (Test-Path -LiteralPath $handoffsDir)) { return @() }
    return @(
        Get-ChildItem -LiteralPath $handoffsDir -File -Filter "D*_done.txt" |
            Where-Object { $_.Name -match '^D(\d+)_done\.txt$' } |
            ForEach-Object {
                if ($_.Name -notmatch '^D(\d+)_done\.txt$') { return }
                [pscustomobject]@{
                    round = [int]$Matches[1]
                    name = $_.Name
                    path = $_.FullName
                    lastWriteTimeUtc = $_.LastWriteTimeUtc.ToString("o")
                }
            } |
            Sort-Object round, name
    )
}

function Read-Seen {
    if (-not (Test-Path -LiteralPath $seenPath)) { return @() }
    try {
        return @((Get-Content -Raw -LiteralPath $seenPath | ConvertFrom-Json).names)
    } catch {
        throw "Invalid done-review watcher state: $seenPath"
    }
}

function Write-Seen([string[]]$Names) {
    [ordered]@{
        names = @($Names | Sort-Object -Unique)
        updatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $seenPath -Encoding UTF8
}

$files = @(Get-DoneFiles)
$seen = @(Read-Seen)

if (-not (Test-Path -LiteralPath $seenPath)) {
    Write-Seen @($files.name)
    $seen = @($files.name)
}

if ($Acknowledge) {
    if (Test-Path -LiteralPath $wakeupPath) {
        $packet = Get-Content -Raw -LiteralPath $wakeupPath | ConvertFrom-Json
        Write-Seen @($seen + @($packet.files.name))
        Remove-Item -LiteralPath $wakeupPath -Force
    }
    exit 0
}

$newFiles = @($files | Where-Object { $_.name -notin $seen })
$status = [ordered]@{
    workspace = $Workspace
    checkedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    seenCount = $seen.Count
    newCount = $newFiles.Count
    newRounds = @($newFiles | ForEach-Object { $_.round })
    wakeupPath = $wakeupPath
}
$status | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statusPath -Encoding UTF8

if ($newFiles.Count -gt 0) {
    [ordered]@{
        reason = "new-handoff-done-files"
        createdAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        files = $newFiles
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $wakeupPath -Encoding UTF8
} else {
    Remove-Item -LiteralPath $wakeupPath -Force -ErrorAction SilentlyContinue
}
