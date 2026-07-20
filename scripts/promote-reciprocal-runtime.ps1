param(
    [string]$RelayRoot = "",
    [string]$Source = "",
    [string]$SourceSha = "",
    [string]$BuildRound = "D115",
    [string]$PromotedRound = "D118",
    [ValidateSet("A", "B", "Both")]
    [string]$TargetRole = "Both",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$commonRaw = (& git -C $repoRoot rev-parse --git-common-dir).Trim()
$commonDir = if ([IO.Path]::IsPathRooted($commonRaw)) { $commonRaw } else { [IO.Path]::GetFullPath((Join-Path $repoRoot $commonRaw)) }
$adminRepo = Split-Path $commonDir -Parent
if (-not $RelayRoot.Trim()) {
    $RelayRoot = Join-Path (Split-Path $adminRepo -Parent) "Tandem Reciprocal"
}
if (-not $Source.Trim()) {
    $Source = Join-Path $adminRepo "release\win-unpacked"
}

function Assert-UnderRoot([string]$Path, [string]$Root) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullRoot = [IO.Path]::GetFullPath($Root)
    if (-not $fullPath.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify path outside runtime root: $fullPath"
    }
    return $fullPath
}

$sourceDir = [IO.Path]::GetFullPath($Source)
if (-not (Test-Path -LiteralPath $sourceDir)) {
    if ($DryRun) {
        Write-Host "Dry run: source runtime directory would be required at $sourceDir."
    } else {
        throw "Source runtime directory is missing: $sourceDir"
    }
} else {
    $sourceDir = (Resolve-Path -LiteralPath $Source).Path
}
$sourceExe = Join-Path $sourceDir "Tandem.exe"
if (-not (Test-Path -LiteralPath $sourceExe)) {
    if ($DryRun) {
        Write-Host "Dry run: source runtime would need Tandem.exe at $sourceExe."
    } else {
        throw "Source runtime is missing Tandem.exe: $sourceExe"
    }
}
$sourceBuildInfoPath = Join-Path $sourceDir "BUILD_INFO.json"
$sourceBuildInfo = $null
if (Test-Path -LiteralPath $sourceBuildInfoPath) {
    $sourceBuildInfo = Get-Content -LiteralPath $sourceBuildInfoPath -Raw | ConvertFrom-Json
}

if (-not $SourceSha) {
    if ($sourceBuildInfo -and $sourceBuildInfo.sourceSha) {
        $SourceSha = [string]$sourceBuildInfo.sourceSha
    } else {
        $SourceSha = (& git -C $repoRoot rev-parse HEAD).Trim()
    }
}
if ($sourceBuildInfo -and $sourceBuildInfo.sourceSha -and $SourceSha -and ([string]$sourceBuildInfo.sourceSha -ne $SourceSha)) {
    throw "Source runtime SHA mismatch: BUILD_INFO has $($sourceBuildInfo.sourceSha), requested $SourceSha."
}
$sourceShortSha = if ($SourceSha.Length -ge 7) { $SourceSha.Substring(0, 7) } else { $SourceSha }

$relayRootFull = [IO.Path]::GetFullPath($RelayRoot)
$runtimesRoot = Assert-UnderRoot (Join-Path $relayRootFull "runtimes") $relayRootFull

$roles = if ($TargetRole -eq "Both") { @("a", "b") } else { @($TargetRole.ToLowerInvariant()) }
foreach ($role in $roles) {
    $targetDir = Assert-UnderRoot (Join-Path $runtimesRoot "executor-$role") $runtimesRoot
    if ($DryRun) {
        Write-Host "Dry run: would promote executor-$role runtime from $sourceDir to $targetDir at $sourceShortSha."
        continue
    }

    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null

    $running = Get-Process -Name Tandem -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and $_.Path.StartsWith($targetDir, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    }
    if ($running) { throw "Executor $role is running from $targetDir; stop it before promotion." }

    $stagingDir = Assert-UnderRoot (Join-Path $runtimesRoot ".promote-staging-executor-$role") $runtimesRoot
    Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null

    Copy-Item -Path (Join-Path $sourceDir "*") -Destination $stagingDir -Recurse -Force
    if (-not (Test-Path -LiteralPath (Join-Path $stagingDir "Tandem.exe"))) {
        throw "Staged runtime for executor $role is missing Tandem.exe."
    }

    Get-ChildItem -LiteralPath $targetDir -Force | Remove-Item -Recurse -Force
    Copy-Item -Path (Join-Path $stagingDir "*") -Destination $targetDir -Recurse -Force
    Remove-Item -LiteralPath $stagingDir -Recurse -Force

    $buildInfo = [ordered]@{
        sourceSha = $SourceSha
        sourceShortSha = $sourceShortSha
        sourceBranch = "master"
        buildRound = $BuildRound
        promotedRound = $PromotedRound
        builtAt = if ($sourceBuildInfo -and $sourceBuildInfo.builtAt) { [string]$sourceBuildInfo.builtAt } else { $null }
        sourceBuildInfo = if ($sourceBuildInfo) { $sourceBuildInfo } else { $null }
        reciprocalCapabilities = if ($sourceBuildInfo -and $sourceBuildInfo.reciprocalCapabilities) { $sourceBuildInfo.reciprocalCapabilities } else { $null }
        promotedAt = (Get-Date).ToString("o")
        artifact = "release/win-unpacked"
    }
    $buildInfoJson = $buildInfo | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText((Join-Path $targetDir "BUILD_INFO.json"), $buildInfoJson + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

    if (-not (Test-Path -LiteralPath (Join-Path $targetDir "Tandem.exe"))) {
        throw "Promoted runtime for executor $role is missing Tandem.exe."
    }
    Write-Host "Promoted executor-$role runtime to $sourceShortSha."
}
