param(
    [string]$SourceRoot = (Join-Path (Split-Path $PSScriptRoot -Parent) "dashboard-source\reciprocal-control-panel"),
    [string]$TargetRoot = "C:\Users\huizh\Apps\Tandem Reciprocal\dashboard",
    [int]$Port = 4782,
    [switch]$DryRun,
    [switch]$VerifyOnly,
    [switch]$NoRestart
)

$ErrorActionPreference = "Stop"

function Get-FileSha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Read-Manifest([string]$Root) {
    $manifestPath = Join-Path $Root "manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Missing dashboard manifest: $manifestPath"
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if (-not $manifest.files -or $manifest.files.Count -eq 0) {
        throw "Dashboard manifest has no managed files."
    }
    return $manifest
}

function Assert-RelativeManagedPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "Manifest contains an empty path." }
    if ([IO.Path]::IsPathRooted($Path)) { throw "Manifest path must be relative: $Path" }
    $normalized = $Path.Replace("\", "/")
    if ($normalized -match "(^|/)\.\.(/|$)") { throw "Manifest path may not escape source root: $Path" }
}

function Resolve-ManagedPath([string]$Root, [string]$RelativePath) {
    Assert-RelativeManagedPath $RelativePath
    $full = [IO.Path]::GetFullPath((Join-Path $Root $RelativePath))
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Resolved path escaped root: $RelativePath"
    }
    return $full
}

function Test-SourceManifest($Manifest, [string]$Root) {
    foreach ($file in $Manifest.files) {
        $relative = [string]$file.path
        $expected = ([string]$file.sha256).ToUpperInvariant()
        $source = Resolve-ManagedPath $Root $relative
        $actual = Get-FileSha256 $source
        if (-not $actual) { throw "Managed source file is missing: $relative" }
        if ($actual -ne $expected) {
            throw "Managed source hash mismatch for ${relative}: expected $expected, got $actual"
        }
    }
}

function Get-Verification($Manifest, [string]$SourceRoot, [string]$TargetRoot) {
    $items = foreach ($file in $Manifest.files) {
        $relative = [string]$file.path
        $expected = ([string]$file.sha256).ToUpperInvariant()
        $target = Resolve-ManagedPath $TargetRoot $relative
        $actual = Get-FileSha256 $target
        [pscustomobject]@{
            path = $relative
            expected = $expected
            actual = $actual
            matches = $actual -eq $expected
            exists = [bool]$actual
        }
    }
    [pscustomobject]@{
        ok = -not ($items | Where-Object { -not $_.matches })
        files = @($items)
        sourceRoot = [IO.Path]::GetFullPath($SourceRoot)
        targetRoot = [IO.Path]::GetFullPath($TargetRoot)
    }
}

function Copy-ManagedFiles($Manifest, [string]$SourceRoot, [string]$TargetRoot) {
    $timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
    $stagingRoot = Join-Path $TargetRoot ".deploy-staging\$timestamp"
    $backupRoot = Join-Path $TargetRoot ".deploy-backups\$timestamp"
    New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

    foreach ($file in $Manifest.files) {
        $relative = [string]$file.path
        $source = Resolve-ManagedPath $SourceRoot $relative
        $staged = Resolve-ManagedPath $stagingRoot $relative
        New-Item -ItemType Directory -Path (Split-Path $staged -Parent) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $staged -Force
    }

    Test-SourceManifest $Manifest $stagingRoot

    foreach ($file in $Manifest.files) {
        $relative = [string]$file.path
        $target = Resolve-ManagedPath $TargetRoot $relative
        $backup = Resolve-ManagedPath $backupRoot $relative
        if (Test-Path -LiteralPath $target -PathType Leaf) {
            New-Item -ItemType Directory -Path (Split-Path $backup -Parent) -Force | Out-Null
            Copy-Item -LiteralPath $target -Destination $backup -Force
        }
    }

    foreach ($file in $Manifest.files) {
        $relative = [string]$file.path
        $staged = Resolve-ManagedPath $stagingRoot $relative
        $target = Resolve-ManagedPath $TargetRoot $relative
        New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
        Copy-Item -LiteralPath $staged -Destination $target -Force
    }

    [pscustomobject]@{
        stagingRoot = $stagingRoot
        backupRoot = $backupRoot
    }
}

function Restart-Dashboard([string]$TargetRoot, [int]$Port) {
    $relayRoot = [IO.Path]::GetFullPath((Join-Path $TargetRoot ".."))
    $stopSignal = Join-Path $relayRoot "control\dashboard-stop-$Port.signal"
    New-Item -ItemType File -Path $stopSignal -Force | Out-Null
    Start-Sleep -Seconds 2
    $startScript = Join-Path $TargetRoot "start-dashboard.ps1"
    & $startScript -Port $Port -NoBrowser | Out-Null
    $deadline = (Get-Date).AddSeconds(15)
    do {
        try {
            $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/status" -Method Get -TimeoutSec 3
            if ($status.relayRoot) { return $status }
        } catch {}
        Start-Sleep -Milliseconds 250
    } until ((Get-Date) -gt $deadline)
    throw "Dashboard did not return /api/status after restart."
}

$manifest = Read-Manifest $SourceRoot
Test-SourceManifest $manifest $SourceRoot
$before = Get-Verification $manifest $SourceRoot $TargetRoot

if ($DryRun -or $VerifyOnly) {
    $mode = if ($VerifyOnly) { "verify" } else { "dry-run" }
    [pscustomobject]@{
        ok = if ($VerifyOnly) { $before.ok } else { $true }
        mode = $mode
        sourceRoot = [IO.Path]::GetFullPath($SourceRoot)
        targetRoot = [IO.Path]::GetFullPath($TargetRoot)
        managedFileCount = $manifest.files.Count
        verification = $before
        plannedUpdates = @($before.files | Where-Object { -not $_.matches } | Select-Object -ExpandProperty path)
    } | ConvertTo-Json -Depth 6
    if ($VerifyOnly -and -not $before.ok) { exit 2 }
    exit 0
}

$copy = Copy-ManagedFiles $manifest $SourceRoot $TargetRoot
$after = Get-Verification $manifest $SourceRoot $TargetRoot
if (-not $after.ok) {
    throw "Dashboard deploy completed copy phase but target manifest verification failed."
}

$status = $null
if (-not $NoRestart) {
    $status = Restart-Dashboard $TargetRoot $Port
}

[pscustomobject]@{
    ok = $true
    mode = "deploy"
    sourceRoot = [IO.Path]::GetFullPath($SourceRoot)
    targetRoot = [IO.Path]::GetFullPath($TargetRoot)
    managedFileCount = $manifest.files.Count
    stagingRoot = $copy.stagingRoot
    backupRoot = $copy.backupRoot
    verification = $after
    restarted = -not $NoRestart
    status = if ($status) {
        [pscustomobject]@{
            phase = $status.state.phase
            activeRole = $status.state.activeRole
            stableCommit = $status.state.stableCommit
            relayRoot = $status.relayRoot
        }
    } else { $null }
} | ConvertTo-Json -Depth 6
