param(
    [string]$SourceRepo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$RelayRoot = (Join-Path (Split-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path -Parent) "Tandem Reciprocal"),
    [switch]$SkipInstall,
    [switch]$SkipRuntimeCopy,
    [switch]$CopyEnv,
    [switch]$ResetRelay
)

$ErrorActionPreference = "Stop"
$branchA = "codex/reciprocal-a"
$branchB = "codex/reciprocal-b"
$worktreeA = Join-Path $RelayRoot "worktrees\copy-a"
$worktreeB = Join-Path $RelayRoot "worktrees\copy-b"
$runtimeSource = Join-Path $SourceRepo "release\win-unpacked"
$templateA = Join-Path $SourceRepo "process\reciprocal\TANDEM_EXECUTOR_A.md"
$templateB = Join-Path $SourceRepo "process\reciprocal\TANDEM_EXECUTOR_B.md"

function Invoke-Checked {
    param([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory = $SourceRepo)
    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$FilePath $($Arguments -join ' ') failed with exit code $LASTEXITCODE." }
    } finally {
        Pop-Location
    }
}

function Ensure-Worktree([string]$Path, [string]$Branch) {
    if (Test-Path -LiteralPath (Join-Path $Path ".git")) { return }
    New-Item -ItemType Directory -Path (Split-Path $Path -Parent) -Force | Out-Null
    & git -C $SourceRepo show-ref --verify --quiet "refs/heads/$Branch"
    if ($LASTEXITCODE -eq 0) {
        Invoke-Checked git @("-C", $SourceRepo, "worktree", "add", $Path, $Branch)
    } else {
        Invoke-Checked git @("-C", $SourceRepo, "worktree", "add", "-b", $Branch, $Path, "HEAD")
    }
}

function Write-Json([object]$Value, [string]$Path) {
    New-Item -ItemType Directory -Path (Split-Path $Path -Parent) -Force | Out-Null
    ConvertTo-Json -InputObject $Value -Depth 10 | Set-Content -LiteralPath $Path -Encoding utf8
}

function Initialize-ExecutorState([string]$Role, [string]$TargetWorktree) {
    $home = Join-Path $RelayRoot "state\executor-$($Role.ToLowerInvariant())"
    $userData = Join-Path $RelayRoot "user-data\executor-$($Role.ToLowerInvariant())"
    New-Item -ItemType Directory -Path $home, $userData -Force | Out-Null

    $sourceConfig = Join-Path $SourceRepo ".tandem\config.json"
    if (Test-Path -LiteralPath $sourceConfig) {
        $config = Get-Content -LiteralPath $sourceConfig -Raw | ConvertFrom-Json
        if ($config.PSObject.Properties.Name -contains "permissionMode") {
            $config.permissionMode = "yolo"
        } else {
            $config | Add-Member -NotePropertyName permissionMode -NotePropertyValue "yolo"
        }
        Write-Json $config (Join-Path $home "config.json")
    }
    if ($CopyEnv -and (Test-Path -LiteralPath (Join-Path $SourceRepo ".env"))) {
        Copy-Item -LiteralPath (Join-Path $SourceRepo ".env") -Destination (Join-Path $home ".env") -Force
    }
    Write-Json ([ordered]@{ lastProjectDir = $TargetWorktree }) (Join-Path $home "desktop-state.json")
}

function Initialize-Schedule([string]$TargetWorktree, [string]$Role, [string]$Cron) {
    $prompt = "Follow the injected TANDEM.md and execute exactly one reciprocal improvement invocation. Begin with the Claim command."
    $schedule = @([ordered]@{
        id = "relay-$($Role.ToLowerInvariant())"
        cron = $Cron
        prompt = $prompt
        createdAt = (Get-Date).ToUniversalTime().ToString("o")
        lastRunAt = (Get-Date).ToUniversalTime().ToString("o")
    })
    Write-Json $schedule (Join-Path $TargetWorktree ".tandem\schedules.json")
}

New-Item -ItemType Directory -Path $RelayRoot -Force | Out-Null
Ensure-Worktree $worktreeA $branchA
Ensure-Worktree $worktreeB $branchB

$commonDirRaw = (& git -C $SourceRepo rev-parse --git-common-dir).Trim()
$commonDir = if ([IO.Path]::IsPathRooted($commonDirRaw)) { $commonDirRaw } else { [IO.Path]::GetFullPath((Join-Path $SourceRepo $commonDirRaw)) }
$excludePath = Join-Path $commonDir "info\exclude"
New-Item -ItemType Directory -Path (Split-Path $excludePath -Parent) -Force | Out-Null
$exclude = if (Test-Path -LiteralPath $excludePath) { Get-Content -LiteralPath $excludePath } else { @() }
if ($exclude -notcontains "/TANDEM.md") { Add-Content -LiteralPath $excludePath -Value "/TANDEM.md" }

# Executor A edits B, so B receives A's local project instructions; vice versa for executor B.
Copy-Item -LiteralPath $templateA -Destination (Join-Path $worktreeB "TANDEM.md") -Force
Copy-Item -LiteralPath $templateB -Destination (Join-Path $worktreeA "TANDEM.md") -Force
Initialize-ExecutorState "A" $worktreeB
Initialize-ExecutorState "B" $worktreeA
Initialize-Schedule $worktreeB "A" "7 * * * *"
Initialize-Schedule $worktreeA "B" "37 * * * *"

if (-not $SkipInstall) {
    Invoke-Checked npm @("ci") $worktreeA
    Invoke-Checked npm @("ci") $worktreeB
}

if (-not $SkipRuntimeCopy) {
    if (-not (Test-Path -LiteralPath (Join-Path $runtimeSource "Tandem.exe"))) {
        throw "Packaged runtime not found at $runtimeSource. Run npm run dist:app first."
    }
    foreach ($role in @("a", "b")) {
        $destination = Join-Path $RelayRoot "runtimes\executor-$role"
        New-Item -ItemType Directory -Path $destination -Force | Out-Null
        Copy-Item -Path (Join-Path $runtimeSource "*") -Destination $destination -Recurse -Force
    }
}

$relayStatePath = Join-Path $commonDir "tandem-relay\state.json"
if ($ResetRelay -or -not (Test-Path -LiteralPath $relayStatePath)) {
    Invoke-Checked powershell @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $SourceRepo "scripts\reciprocal-relay.ps1"), "-Action", "Reset", "-Workspace", $SourceRepo, "-Force")
}

[ordered]@{
    relayRoot = $RelayRoot
    executorA = [ordered]@{ runtime = (Join-Path $RelayRoot "runtimes\executor-a\Tandem.exe"); target = $worktreeB; branch = $branchB; cron = "7 * * * *" }
    executorB = [ordered]@{ runtime = (Join-Path $RelayRoot "runtimes\executor-b\Tandem.exe"); target = $worktreeA; branch = $branchA; cron = "37 * * * *" }
    nextRole = "A"
} | ConvertTo-Json -Depth 5
