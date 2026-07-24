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
$directionTemplate = Join-Path $SourceRepo "process\reciprocal\SHARED_DIRECTION_TEMPLATE.md"
$wishlistTemplate = Join-Path $SourceRepo "process\reciprocal\WISHLIST_TEMPLATE.md"
$reciprocalMaxStepsPerAgentTurn = 250

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
    $json = ConvertTo-Json -InputObject $Value -Depth 10
    [IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

function Initialize-ExecutorState([string]$Role, [string]$TargetWorktree) {
    $stateHome = Join-Path $RelayRoot "state\executor-$($Role.ToLowerInvariant())"
    $userData = Join-Path $RelayRoot "user-data\executor-$($Role.ToLowerInvariant())"
    New-Item -ItemType Directory -Path $stateHome, $userData -Force | Out-Null

    $targetConfig = Join-Path $stateHome "config.json"
    $sourceConfig = Join-Path $SourceRepo ".tandem\config.json"
    if ((-not (Test-Path -LiteralPath $targetConfig)) -and (Test-Path -LiteralPath $sourceConfig)) {
        $config = Get-Content -LiteralPath $sourceConfig -Raw | ConvertFrom-Json
        if ($config.PSObject.Properties.Name -contains "permissionMode") {
            $config.permissionMode = "yolo"
        } else {
            $config | Add-Member -NotePropertyName permissionMode -NotePropertyValue "yolo"
        }
        if ($config.PSObject.Properties.Name -contains "maxStepsPerAgentTurn") {
            $config.maxStepsPerAgentTurn = $reciprocalMaxStepsPerAgentTurn
        } else {
            $config | Add-Member -NotePropertyName maxStepsPerAgentTurn -NotePropertyValue $reciprocalMaxStepsPerAgentTurn
        }
        Write-Json $config $targetConfig
    }
    if ($CopyEnv -and (Test-Path -LiteralPath (Join-Path $SourceRepo ".env"))) {
        Copy-Item -LiteralPath (Join-Path $SourceRepo ".env") -Destination (Join-Path $stateHome ".env") -Force
    }
    Write-Json ([ordered]@{ lastProjectDir = $TargetWorktree }) (Join-Path $stateHome "desktop-state.json")
}

function Initialize-Schedule([string]$TargetWorktree, [string]$Role, [string]$Cron) {
    $orchestratorScript = Join-Path $SourceRepo "scripts\reciprocal-orchestrator.ps1"
    $prompt = "Run the D196 single reciprocal orchestrator tick from the admin repo: powershell -NoProfile -ExecutionPolicy Bypass -File `"$orchestratorScript`" -Repo `"$SourceRepo`" -RelayRoot `"$RelayRoot`". Do not run legacy relay Claim/PassiveTest/Complete actions."
    $schedule = @([ordered]@{
        id = "relay-$($Role.ToLowerInvariant())"
        cron = $Cron
        prompt = $prompt
        createdAt = (Get-Date).ToUniversalTime().ToString("o")
        lastRunAt = (Get-Date).ToUniversalTime().ToString("o")
    })
    Write-Json $schedule (Join-Path $TargetWorktree ".tandem\schedules.json")
}

function Initialize-SharedDirection([string[]]$Worktrees) {
    $controlDir = Join-Path $RelayRoot "control"
    $directionPath = Join-Path $controlDir "SHARED_DIRECTION.md"
    $wishlistPath = Join-Path $controlDir "WISHLIST.md"
    New-Item -ItemType Directory -Path $controlDir -Force | Out-Null
    if (-not (Test-Path -LiteralPath $directionPath)) {
        Copy-Item -LiteralPath $directionTemplate -Destination $directionPath
    }
    if (-not (Test-Path -LiteralPath $wishlistPath)) {
        Copy-Item -LiteralPath $wishlistTemplate -Destination $wishlistPath
    }
    foreach ($worktree in $Worktrees) {
        $linkPath = Join-Path $worktree ".tandem\shared-control"
        New-Item -ItemType Directory -Path (Split-Path $linkPath -Parent) -Force | Out-Null
        if (Test-Path -LiteralPath $linkPath) {
            $item = Get-Item -LiteralPath $linkPath -Force
            $targets = @($item.Target)
            if ($item.LinkType -ne "Junction" -or $targets -notcontains $controlDir) {
                throw "Shared-control path exists but is not the expected junction: $linkPath"
            }
        } else {
            New-Item -ItemType Junction -Path $linkPath -Target $controlDir | Out-Null
        }
    }
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

# Executor A remains the sole producer, but cron now invokes the admin-repo
# orchestrator instead of prompting either executor directly.
Copy-Item -LiteralPath $templateA -Destination (Join-Path $worktreeB "TANDEM.md") -Force
Copy-Item -LiteralPath $templateB -Destination (Join-Path $worktreeA "TANDEM.md") -Force
Initialize-SharedDirection @($worktreeA, $worktreeB)
Initialize-ExecutorState "A" $worktreeB
Initialize-ExecutorState "B" $worktreeA
Initialize-Schedule $worktreeB "A" "7 * * * *"
Write-Json @() (Join-Path $worktreeA ".tandem\schedules.json")

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
    Invoke-Checked powershell @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $SourceRepo "scripts\reciprocal-orchestrator.ps1"), "-Repo", $SourceRepo, "-RelayRoot", $RelayRoot, "-Status")
}

[ordered]@{
    relayRoot = $RelayRoot
    executorA = [ordered]@{ runtime = (Join-Path $RelayRoot "runtimes\executor-a\Tandem.exe"); target = $worktreeB; branch = $branchB; cron = "7 * * * *"; role = "orchestrator-invoked-producer" }
    executorB = [ordered]@{ runtime = (Join-Path $RelayRoot "runtimes\executor-b\Tandem.exe"); target = $worktreeA; branch = $branchA; cron = $null; role = "mechanical-swap-runtime-only" }
    sharedDirection = (Join-Path $RelayRoot "control\SHARED_DIRECTION.md")
    wishlist = (Join-Path $RelayRoot "control\WISHLIST.md")
    nextRole = "A"
} | ConvertTo-Json -Depth 5
