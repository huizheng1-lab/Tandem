param(
    [ValidateSet("A", "B", "Both")]
    [string]$Role = "Both",
    [string]$RelayRoot = (Join-Path (Split-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path -Parent) "Tandem Reciprocal"),
    [int]$AutomationPortA = 4783,
    [int]$AutomationPortB = 4784
)

$ErrorActionPreference = "Stop"
$adminRepo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Start-Executor([string]$SelectedRole) {
    $slug = $SelectedRole.ToLowerInvariant()
    $runtimeDir = Join-Path $RelayRoot "runtimes\executor-$slug"
    $exe = Join-Path $runtimeDir "Tandem.exe"
    $stateHome = Join-Path $RelayRoot "state\executor-$slug"
    $userData = Join-Path $RelayRoot "user-data\executor-$slug"
    $targetSlug = if ($SelectedRole -eq "A") { "b" } else { "a" }
    $targetWorktree = Join-Path $RelayRoot "worktrees\copy-$targetSlug"
    $automationPort = if ($SelectedRole -eq "A") { $AutomationPortA } else { $AutomationPortB }
    $automationTokenFile = Join-Path $stateHome "automation.json"
    if (-not (Test-Path -LiteralPath $exe)) { throw "Executor $SelectedRole runtime is missing: $exe" }

    $alreadyRunning = Get-Process -Name Tandem -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and $_.Path.StartsWith($runtimeDir, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    }
    if ($alreadyRunning) {
        Write-Host "Executor $SelectedRole is already running."
        return
    }
    Remove-Item -LiteralPath $automationTokenFile -Force -ErrorAction SilentlyContinue

    $oldHome = $env:TANDEM_HOME
    $oldInstance = $env:TANDEM_INSTANCE_ID
    $oldProtectedRoots = $env:TANDEM_PROTECTED_ROOTS
    $oldCodexWritableRoots = $env:TANDEM_CODEX_WRITABLE_ROOTS
    try {
        $env:TANDEM_HOME = $stateHome
        $env:TANDEM_INSTANCE_ID = $SelectedRole
        $ownWorktree = Join-Path $RelayRoot "worktrees\copy-$slug"
        $protectedRoots = @(
            $oldProtectedRoots,
            $adminRepo,
            $ownWorktree,
            (Join-Path $RelayRoot "runtimes\executor-a"),
            (Join-Path $RelayRoot "runtimes\executor-b"),
            (Join-Path $RelayRoot "state\executor-a"),
            (Join-Path $RelayRoot "state\executor-b"),
            (Join-Path $RelayRoot "user-data\executor-a"),
            (Join-Path $RelayRoot "user-data\executor-b")
        ) | Where-Object { $_ }
        $env:TANDEM_PROTECTED_ROOTS = $protectedRoots -join [IO.Path]::PathSeparator
        $codexWritableRoots = @(
            (Join-Path $RelayRoot "control"),
            (Join-Path (Join-Path $adminRepo ".git") "tandem-relay")
        )
        $env:TANDEM_CODEX_WRITABLE_ROOTS = $codexWritableRoots -join [IO.Path]::PathSeparator
        $arguments = @(
            "--user-data-dir=`"$userData`"",
            "--hidden",
            "--automation-port=$automationPort",
            "--automation-token-file=`"$automationTokenFile`"",
            "--automation-project-dir=`"$targetWorktree`""
        )
        Start-Process -FilePath $exe -WorkingDirectory $runtimeDir -ArgumentList $arguments -WindowStyle Hidden
    } finally {
        $env:TANDEM_HOME = $oldHome
        $env:TANDEM_INSTANCE_ID = $oldInstance
        $env:TANDEM_PROTECTED_ROOTS = $oldProtectedRoots
        $env:TANDEM_CODEX_WRITABLE_ROOTS = $oldCodexWritableRoots
    }
    Write-Host "Started executor $SelectedRole hidden; automation endpoint 127.0.0.1:$automationPort targets $targetWorktree."
}

if ($Role -in @("A", "Both")) { Start-Executor "A" }
if ($Role -in @("B", "Both")) { Start-Executor "B" }
