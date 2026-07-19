param(
    [string]$Workspace = (Get-Location).Path,
    [string]$AdminRepo = "",
    [string]$SourceSha = "",
    [string]$PreparedWinUnpacked = ""
)

$ErrorActionPreference = "Stop"

function Invoke-Native([string]$File, [string[]]$Arguments, [string]$WorkingDirectory) {
    $oldErrorAction = $ErrorActionPreference
    Push-Location -LiteralPath $WorkingDirectory
    try {
        $ErrorActionPreference = "Continue"
        $output = @(& $File @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldErrorAction
        Pop-Location
    }
    $text = ($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
    if ($exitCode -ne 0) {
        throw "$File $($Arguments -join ' ') failed with exit code $exitCode`n$text"
    }
    return $text
}

function Invoke-WithRetry([string]$Description, [scriptblock]$Operation, [int]$Attempts = 8) {
    $lastError = $null
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            & $Operation
            return
        } catch {
            $lastError = $_
            if ($attempt -eq $Attempts) { break }
            Start-Sleep -Milliseconds ([Math]::Min(2000, 250 * $attempt))
        }
    }
    throw "$Description failed after $Attempts attempts: $($lastError.Exception.Message)"
}

function Assert-UnderRoot([string]$Path, [string]$Root) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullRoot = [IO.Path]::GetFullPath($Root)
    if (-not $fullPath.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify path outside root $fullRoot`: $fullPath"
    }
    return $fullPath
}

$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
if (-not $AdminRepo.Trim()) {
    $commonRaw = (& git -C $Workspace rev-parse --git-common-dir).Trim()
    $commonDir = if ([IO.Path]::IsPathRooted($commonRaw)) { $commonRaw } else { [IO.Path]::GetFullPath((Join-Path $Workspace $commonRaw)) }
    $AdminRepo = Split-Path $commonDir -Parent
}
$AdminRepo = (Resolve-Path -LiteralPath $AdminRepo).Path

if (-not $SourceSha.Trim()) {
    $SourceSha = (& git -C $Workspace rev-parse HEAD).Trim()
}
$shortSha = if ($SourceSha.Length -ge 7) { $SourceSha.Substring(0, 7) } else { $SourceSha }
$sourceBranch = (& git -C $Workspace branch --show-current).Trim()

$releaseRoot = Assert-UnderRoot (Join-Path $AdminRepo "release") $AdminRepo
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null

$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmss")
$buildRoot = Assert-UnderRoot (Join-Path $releaseRoot ".passive-package-builds\$shortSha-$stamp-$PID") $releaseRoot
$freshWinUnpacked = $null
$usedPrepared = $false

if ($PreparedWinUnpacked.Trim()) {
    $freshWinUnpacked = (Resolve-Path -LiteralPath $PreparedWinUnpacked).Path
    $usedPrepared = $true
} else {
    Invoke-WithRetry "remove stale passive package build root" { Remove-Item -LiteralPath $buildRoot -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
    Invoke-Native "npm.cmd" @("run", "build") $Workspace | Out-Null
    Invoke-Native "npx.cmd" @("electron-vite", "build") $Workspace | Out-Null
    Invoke-Native "npx.cmd" @("electron-builder", "--dir", "-c.directories.output=$buildRoot") $Workspace | Out-Null
    $freshWinUnpacked = Join-Path $buildRoot "win-unpacked"
}

$freshExe = Join-Path $freshWinUnpacked "Tandem.exe"
if (-not (Test-Path -LiteralPath $freshExe)) {
    throw "Passive package output is missing Tandem.exe: $freshExe"
}

$stagingDir = Assert-UnderRoot (Join-Path $releaseRoot ".win-unpacked-next-$shortSha-$PID") $releaseRoot
$oldDir = Assert-UnderRoot (Join-Path $releaseRoot ".win-unpacked-old-$shortSha-$PID") $releaseRoot
$targetDir = Assert-UnderRoot (Join-Path $releaseRoot "win-unpacked") $releaseRoot

Invoke-WithRetry "remove stale runtime staging directory" { Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue }
Invoke-WithRetry "remove stale runtime backup directory" { Remove-Item -LiteralPath $oldDir -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
Get-ChildItem -LiteralPath $freshWinUnpacked -Force | Copy-Item -Destination $stagingDir -Recurse -Force

$buildInfo = [ordered]@{
    sourceSha = $SourceSha
    sourceShortSha = $shortSha
    sourceBranch = $sourceBranch
    builtAt = (Get-Date).ToUniversalTime().ToString("o")
    artifact = "release/win-unpacked"
    packagedBy = "scripts/package-passive-runtime.ps1"
    passiveWorkspace = $Workspace
}
$buildInfoJson = $buildInfo | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $stagingDir "BUILD_INFO.json"), $buildInfoJson + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

if (-not (Test-Path -LiteralPath (Join-Path $stagingDir "Tandem.exe"))) {
    throw "Staged passive runtime is missing Tandem.exe."
}

$targetMoved = $false
try {
    if (Test-Path -LiteralPath $targetDir) {
        Invoke-WithRetry "move previous canonical runtime aside" { Move-Item -LiteralPath $targetDir -Destination $oldDir -Force }
        $targetMoved = $true
    }
    Invoke-WithRetry "promote passive package to canonical runtime path" { Move-Item -LiteralPath $stagingDir -Destination $targetDir -Force }
} catch {
    if ($targetMoved -and -not (Test-Path -LiteralPath $targetDir) -and (Test-Path -LiteralPath $oldDir)) {
        Move-Item -LiteralPath $oldDir -Destination $targetDir -Force
    }
    throw
}

try {
    Invoke-WithRetry "remove old canonical runtime backup" { Remove-Item -LiteralPath $oldDir -Recurse -Force -ErrorAction SilentlyContinue } 4
} catch {
    Write-Warning $_.Exception.Message
}

if (-not $usedPrepared) {
    try {
        Invoke-WithRetry "remove passive package build root" { Remove-Item -LiteralPath $buildRoot -Recurse -Force -ErrorAction SilentlyContinue } 4
    } catch {
        Write-Warning $_.Exception.Message
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $targetDir "Tandem.exe"))) {
    throw "Canonical passive runtime is missing Tandem.exe after swap."
}
$writtenInfo = Get-Content -LiteralPath (Join-Path $targetDir "BUILD_INFO.json") -Raw | ConvertFrom-Json
if ([string]$writtenInfo.sourceSha -ne $SourceSha) {
    throw "Canonical passive runtime BUILD_INFO sourceSha mismatch: $($writtenInfo.sourceSha) != $SourceSha"
}

[pscustomobject]@{
    sourceSha = $SourceSha
    sourceShortSha = $shortSha
    sourceBranch = $sourceBranch
    targetDir = $targetDir
    exe = (Join-Path $targetDir "Tandem.exe")
    buildInfoPath = (Join-Path $targetDir "BUILD_INFO.json")
    preparedInput = if ($usedPrepared) { $freshWinUnpacked } else { $null }
} | ConvertTo-Json -Depth 5
