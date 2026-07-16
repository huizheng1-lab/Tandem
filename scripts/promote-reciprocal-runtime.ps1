param(
    [string]$RelayRoot = (Join-Path (Split-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path -Parent) "Tandem Reciprocal"),
    [string]$Source = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path "release\win-unpacked"),
    [string]$SourceSha = "",
    [string]$BuildRound = "D115",
    [string]$PromotedRound = "D118"
)

$ErrorActionPreference = "Stop"

function Assert-UnderRoot([string]$Path, [string]$Root) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullRoot = [IO.Path]::GetFullPath($Root)
    if (-not $fullPath.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify path outside runtime root: $fullPath"
    }
    return $fullPath
}

$sourceDir = (Resolve-Path -LiteralPath $Source).Path
$sourceExe = Join-Path $sourceDir "Tandem.exe"
if (-not (Test-Path -LiteralPath $sourceExe)) { throw "Source runtime is missing Tandem.exe: $sourceExe" }
$sourceBuildInfoPath = Join-Path $sourceDir "BUILD_INFO.json"
$sourceBuildInfo = $null
if (Test-Path -LiteralPath $sourceBuildInfoPath) {
    $sourceBuildInfo = Get-Content -LiteralPath $sourceBuildInfoPath -Raw | ConvertFrom-Json
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $SourceSha) {
    if ($sourceBuildInfo -and $sourceBuildInfo.sourceSha) {
        $SourceSha = [string]$sourceBuildInfo.sourceSha
    } else {
        $SourceSha = (& git -C $repoRoot rev-parse HEAD).Trim()
    }
}
$sourceShortSha = if ($SourceSha.Length -ge 7) { $SourceSha.Substring(0, 7) } else { $SourceSha }

$relayRootFull = [IO.Path]::GetFullPath($RelayRoot)
$runtimesRoot = Assert-UnderRoot (Join-Path $relayRootFull "runtimes") $relayRootFull

foreach ($role in @("a", "b")) {
    $targetDir = Assert-UnderRoot (Join-Path $runtimesRoot "executor-$role") $runtimesRoot
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
        promotedAt = (Get-Date).ToString("o")
        artifact = "release/win-unpacked"
    }
    $buildInfo | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $targetDir "BUILD_INFO.json") -Encoding utf8

    if (-not (Test-Path -LiteralPath (Join-Path $targetDir "Tandem.exe"))) {
        throw "Promoted runtime for executor $role is missing Tandem.exe."
    }
    Write-Host "Promoted executor-$role runtime to $sourceShortSha."
}
