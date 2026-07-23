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

function Get-PackageIntegrity([string]$RuntimeRoot, [string]$ExpectedSourceSha = "", [string]$ExpectedPackageIdentity = "") {
    $tool = Join-Path $PSScriptRoot "runtime-package-integrity.mjs"
    if (-not (Test-Path -LiteralPath $tool)) { throw "Runtime package integrity helper is missing: $tool" }
    $args = @($tool, "verify", $RuntimeRoot)
    if ($ExpectedSourceSha) { $args += @("--source-sha", $ExpectedSourceSha) }
    if ($ExpectedPackageIdentity) { $args += @("--package-identity", $ExpectedPackageIdentity) }
    return (Invoke-Native "node.exe" $args $repoRoot) | ConvertFrom-Json
}

function Write-JsonAtomic([string]$Path, [object]$Value) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Path -Parent) | Out-Null
    $tmp = "$Path.$PID.tmp"
    [IO.File]::WriteAllText($tmp, (($Value | ConvertTo-Json -Depth 12) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tmp -Destination $Path -Force
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
$sourceIntegrity = Get-PackageIntegrity $sourceDir $SourceSha
$sourcePackageIdentity = [string]$sourceIntegrity.packageIdentity
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

    $running = Get-Process -Name Tandem -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and $_.Path.StartsWith($targetDir, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    }
    if ($running) { throw "Executor $role is running from $targetDir; stop it before promotion." }

    $operationRoot = Assert-UnderRoot (Join-Path $relayRootFull "state\promotion-operations") $relayRootFull
    $operationPath = Assert-UnderRoot (Join-Path $operationRoot "executor-$role.json") $operationRoot
    $operation = $null
    if (Test-Path -LiteralPath $operationPath) {
        $operation = Get-Content -LiteralPath $operationPath -Raw | ConvertFrom-Json
        if ([string]$operation.sourceSha -ne $SourceSha -or [string]$operation.packageIdentity -ne $sourcePackageIdentity) {
            if ([string]$operation.stage -eq "target-verified") {
                $null = Get-PackageIntegrity $targetDir ([string]$operation.sourceSha) ([string]$operation.packageIdentity)
                $completedRoot = Assert-UnderRoot (Join-Path $operationRoot "completed") $operationRoot
                New-Item -ItemType Directory -Force -Path $completedRoot | Out-Null
                $operationIdForArchive = if ($operation.operationId) { [string]$operation.operationId } else { "unknown-$(Get-Date -Format yyyyMMddHHmmss)" }
                $completedPath = Assert-UnderRoot (Join-Path $completedRoot "executor-$role-$operationIdForArchive.json") $completedRoot
                Move-Item -LiteralPath $operationPath -Destination $completedPath -Force
                $operation = $null
            } else {
                throw "Existing executor-$role promotion operation targets a different package; inspect $operationPath."
            }
        }
    }

    $operationId = if ($operation -and $operation.operationId) { [string]$operation.operationId } else { "promote-$role-$sourceShortSha-$PID-$(Get-Date -Format yyyyMMddHHmmss)" }
    $stagingDir = Assert-UnderRoot (Join-Path $runtimesRoot ".promote-staging-executor-$role-$operationId") $runtimesRoot
    $backupRoot = Assert-UnderRoot (Join-Path $runtimesRoot "backups") $runtimesRoot
    $backupDir = if ($operation -and $operation.backupPath) {
        Assert-UnderRoot ([string]$operation.backupPath) $backupRoot
    } else {
        Assert-UnderRoot (Join-Path $backupRoot "executor-$role-$operationId") $backupRoot
    }
    Invoke-WithRetry "remove stale promotion staging for executor-$role" { Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null

    Get-ChildItem -LiteralPath $sourceDir -Force | Copy-Item -Destination $stagingDir -Recurse -Force
    if (-not (Test-Path -LiteralPath (Join-Path $stagingDir "Tandem.exe"))) {
        throw "Staged runtime for executor $role is missing Tandem.exe."
    }
    $null = Get-PackageIntegrity $stagingDir $SourceSha $sourcePackageIdentity

    $buildInfoPath = Join-Path $stagingDir "BUILD_INFO.json"
    $buildInfo = [ordered]@{
        sourceSha = $SourceSha
        sourceShortSha = $sourceShortSha
        sourceBranch = "master"
        buildRound = $BuildRound
        promotedRound = $PromotedRound
        builtAt = if ($sourceBuildInfo -and $sourceBuildInfo.builtAt) { [string]$sourceBuildInfo.builtAt } else { $null }
        packageIdentity = $sourcePackageIdentity
        packageManifest = $sourceIntegrity.manifest
        immutablePackagePath = if ($sourceBuildInfo -and $sourceBuildInfo.immutablePackagePath) { [string]$sourceBuildInfo.immutablePackagePath } else { $sourceDir }
        sourceBuildInfo = if ($sourceBuildInfo) { $sourceBuildInfo } else { $null }
        reciprocalCapabilities = if ($sourceBuildInfo -and $sourceBuildInfo.reciprocalCapabilities) { $sourceBuildInfo.reciprocalCapabilities } else { $sourceIntegrity.capabilities }
        promotedAt = (Get-Date).ToString("o")
        artifact = "release/win-unpacked"
    }
    [IO.File]::WriteAllText($buildInfoPath, (($buildInfo | ConvertTo-Json -Depth 12) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    $null = Get-PackageIntegrity $stagingDir $SourceSha $sourcePackageIdentity

    $operationRecord = [ordered]@{
        schemaVersion = 1
        operationId = $operationId
        role = $role
        sourceSha = $SourceSha
        packageIdentity = $sourcePackageIdentity
        sourcePath = $sourceDir
        targetPath = $targetDir
        stagingPath = $stagingDir
        backupPath = $backupDir
        stage = "staging-verified"
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    }
    Write-JsonAtomic $operationPath $operationRecord

    try {
        if ((Test-Path -LiteralPath $targetDir) -and -not (Test-Path -LiteralPath $backupDir)) {
            New-Item -ItemType Directory -Force -Path (Split-Path $backupDir -Parent) | Out-Null
            Move-Item -LiteralPath $targetDir -Destination $backupDir -Force
            $operationRecord.stage = "backup-created"
            $operationRecord.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
            Write-JsonAtomic $operationPath $operationRecord
        } elseif (Test-Path -LiteralPath $targetDir) {
            Invoke-WithRetry "remove retry target before promotion swap" { Remove-Item -LiteralPath $targetDir -Recurse -Force -ErrorAction SilentlyContinue }
        }
        Move-Item -LiteralPath $stagingDir -Destination $targetDir -Force
        $operationRecord.stage = "target-swapped"
        $operationRecord.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
        Write-JsonAtomic $operationPath $operationRecord
    } catch {
        if (-not (Test-Path -LiteralPath $targetDir) -and (Test-Path -LiteralPath $backupDir)) {
            Move-Item -LiteralPath $backupDir -Destination $targetDir -Force
        }
        throw
    }

    if (-not (Test-Path -LiteralPath (Join-Path $targetDir "Tandem.exe"))) {
        throw "Promoted runtime for executor $role is missing Tandem.exe."
    }
    $targetIntegrity = Get-PackageIntegrity $targetDir $SourceSha $sourcePackageIdentity
    $operationRecord.stage = "target-verified"
    $operationRecord.targetProof = $targetIntegrity
    $operationRecord.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    Write-JsonAtomic $operationPath $operationRecord
    Write-Host "Promoted executor-$role runtime to $sourceShortSha with package $sourcePackageIdentity; backup retained at $backupDir."
}
