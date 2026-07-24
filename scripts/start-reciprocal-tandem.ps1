param(
    [ValidateSet("A", "B", "Both")]
    [string]$Role = "A",
    [string]$RelayRoot = (Join-Path (Split-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path -Parent) "Tandem Reciprocal"),
    [int]$AutomationPortA = $(if ($env:TANDEM_AUTOMATION_PORT_A) { [int]$env:TANDEM_AUTOMATION_PORT_A } else { 4783 }),
    [int]$AutomationPortB = $(if ($env:TANDEM_AUTOMATION_PORT_B) { [int]$env:TANDEM_AUTOMATION_PORT_B } else { 4784 })
)

$ErrorActionPreference = "Stop"
$Utf8StrictNoBom = [Text.UTF8Encoding]::new($false, $true)
$MaxRelayStateBytes = 5MB

function Read-StrictJsonFile([string]$Path, [Int64]$MaxBytes = 0) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $item = Get-Item -LiteralPath $Path
    if ($MaxBytes -gt 0 -and $item.Length -gt $MaxBytes) {
        throw "Refusing to read oversized JSON file $Path ($($item.Length) bytes; limit $MaxBytes)."
    }
    try {
        return ($Utf8StrictNoBom.GetString([IO.File]::ReadAllBytes($Path))) | ConvertFrom-Json
    } catch {
        throw "Failed to read strict UTF-8 JSON file $Path`: $($_.Exception.Message)"
    }
}
$adminRepo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$statePath = Join-Path $adminRepo ".git\tandem-relay\state.json"

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class TandemDetachedProcess {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        int dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    private const int STARTF_USESHOWWINDOW = 0x00000001;
    private const short SW_HIDE = 0;
    private const int DETACHED_PROCESS = 0x00000008;
    private const int CREATE_NEW_PROCESS_GROUP = 0x00000200;
    private const int CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    private const int CREATE_NO_WINDOW = 0x08000000;

    public static int StartHiddenBreakaway(string exe, string commandLine, string workingDirectory) {
        var startupInfo = new STARTUPINFO();
        startupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        startupInfo.dwFlags = STARTF_USESHOWWINDOW;
        startupInfo.wShowWindow = SW_HIDE;

        PROCESS_INFORMATION processInformation;
        int flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB;
        bool ok = CreateProcessW(exe, commandLine, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, workingDirectory, ref startupInfo, out processInformation);
        if (!ok && Marshal.GetLastWin32Error() == 5) {
            flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW;
            ok = CreateProcessW(exe, commandLine, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, workingDirectory, ref startupInfo, out processInformation);
        }
        if (!ok) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        try {
            return processInformation.dwProcessId;
        } finally {
            if (processInformation.hThread != IntPtr.Zero) CloseHandle(processInformation.hThread);
            if (processInformation.hProcess != IntPtr.Zero) CloseHandle(processInformation.hProcess);
        }
    }
}
"@

function Join-WindowsCommandLine {
    param([string[]]$Parts)

    ($Parts | ForEach-Object {
        if ($_ -notmatch '[\s"]') {
            $_
        } else {
            '"' + ($_.Replace('"', '\"')) + '"'
        }
    }) -join " "
}

function Start-Executor([string]$SelectedRole) {
    $slug = $SelectedRole.ToLowerInvariant()
    $runtimeDir = Join-Path $RelayRoot "runtimes\executor-$slug"
    $exe = Join-Path $runtimeDir "Tandem.exe"
    $buildInfoPath = Join-Path $runtimeDir "BUILD_INFO.json"
    $stateHome = Join-Path $RelayRoot "state\executor-$slug"
    $userData = Join-Path $RelayRoot "user-data\executor-$slug"
    $targetSlug = if ($SelectedRole -eq "A") { "b" } else { "a" }
    $targetWorktree = Join-Path $RelayRoot "worktrees\copy-$targetSlug"
    $mode = if ($SelectedRole -eq "A") { "sole producer" } else { "passive build/launch target; no scheduled agentic wishlist work" }
    $automationPort = if ($SelectedRole -eq "A") { $AutomationPortA } else { $AutomationPortB }
    $automationTokenFile = Join-Path $stateHome "automation.json"
    if (-not (Test-Path -LiteralPath $exe)) { throw "Executor $SelectedRole runtime is missing: $exe" }
    if (-not (Test-Path -LiteralPath $buildInfoPath)) { throw "Executor $SelectedRole BUILD_INFO is missing: $buildInfoPath" }
    $buildInfo = Read-StrictJsonFile $buildInfoPath
    New-Item -ItemType Directory -Force -Path $stateHome, $userData | Out-Null

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
    $oldRuntimeBuildInfo = $env:TANDEM_RUNTIME_BUILD_INFO
    $oldRuntimePackageIdentity = $env:TANDEM_RUNTIME_PACKAGE_ID
    $oldProjectInstructionsRoot = $env:TANDEM_PROJECT_INSTRUCTIONS_ROOT
    try {
        $env:TANDEM_HOME = $stateHome
        $env:TANDEM_INSTANCE_ID = $SelectedRole
        $env:TANDEM_RUNTIME_BUILD_INFO = $buildInfoPath
        $env:TANDEM_RUNTIME_PACKAGE_ID = [string]$buildInfo.packageIdentity
        $env:TANDEM_PROJECT_INSTRUCTIONS_ROOT = $adminRepo
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
            (Join-Path $adminRepo ".git")
        )
        $env:TANDEM_CODEX_WRITABLE_ROOTS = $codexWritableRoots -join [IO.Path]::PathSeparator
        $arguments = @(
            "--user-data-dir=$userData",
            "--hidden",
            "--automation-port=$automationPort",
            "--automation-token-file=$automationTokenFile",
            "--automation-project-dir=$targetWorktree"
        )
        $entryOverride = [Environment]::GetEnvironmentVariable("TANDEM_EXECUTOR_${SelectedRole}_NODE_ENTRY")
        if ($entryOverride) {
            $arguments = @($entryOverride) + $arguments
        }
        $commandLine = Join-WindowsCommandLine (@($exe) + $arguments)
        $launchedPid = [TandemDetachedProcess]::StartHiddenBreakaway($exe, $commandLine, $runtimeDir)
    } finally {
        $env:TANDEM_HOME = $oldHome
        $env:TANDEM_INSTANCE_ID = $oldInstance
        $env:TANDEM_PROTECTED_ROOTS = $oldProtectedRoots
        $env:TANDEM_CODEX_WRITABLE_ROOTS = $oldCodexWritableRoots
        $env:TANDEM_RUNTIME_BUILD_INFO = $oldRuntimeBuildInfo
        $env:TANDEM_RUNTIME_PACKAGE_ID = $oldRuntimePackageIdentity
        $env:TANDEM_PROJECT_INSTRUCTIONS_ROOT = $oldProjectInstructionsRoot
    }
    Write-Host "Started executor $SelectedRole hidden as breakaway PID $launchedPid ($mode); automation endpoint 127.0.0.1:$automationPort targets $targetWorktree."
}

function Stop-ExecutorIfRunning([string]$SelectedRole, [string]$Reason) {
    $slug = $SelectedRole.ToLowerInvariant()
    $runtimeDir = Join-Path $RelayRoot "runtimes\executor-$slug"
    $running = @(Get-Process -Name Tandem -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and $_.Path.StartsWith($runtimeDir, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    })
    foreach ($process in $running) {
        Write-Host "Stopping stale executor $SelectedRole PID $($process.Id): $Reason"
        Stop-Process -Id $process.Id -Force
    }
}

function Get-RecoveryStage([object]$RelayState) {
    $journalPath = Join-Path $RelayRoot "state\runtime-recovery-flow.json"
    if (-not (Test-Path -LiteralPath $journalPath)) {
        if ($RelayState -and [string]$RelayState.phase -eq "a-upgrade-pending" -and [string]$RelayState.runtimeRecoveryStage -eq "b-runtime-verified") {
            return "b-verified"
        }
        return $null
    }
    try {
        $journal = Read-StrictJsonFile $journalPath
        if ([string]$journal.status -eq "completed" -or [string]$journal.stage -eq "b-stopped") { return $null }
        return [string]$journal.stage
    } catch {
        throw "Refusing phase-aware start because the runtime recovery journal is unreadable: $($_.Exception.Message)"
    }
}

function Get-PhaseAwareStartRoles {
    if ($Role -ne "Both") { return @($Role) }
    $phase = "unknown"
    $state = $null
    if (Test-Path -LiteralPath $statePath) {
        try {
            $state = Read-StrictJsonFile $statePath $MaxRelayStateBytes
            $phase = [string]$state.phase
        } catch {
            $phase = "unknown"
        }
    }
    $recoveryStage = Get-RecoveryStage $state
    if ($recoveryStage -in @("a-stop-started", "a-stopped", "a-promote-started", "a-promoted", "a-start-started", "a-started")) {
        Write-Host "Phase-aware start: recovery stage is $recoveryStage; starting/preserving Executor B as recovery authority."
        return @("B")
    }
    if ($phase -eq "a-upgrade-pending" -and $recoveryStage -in @("package-ready", "b-promote-started", "b-promoted", "b-start-started", "b-started", "b-verified", "approval-recorded", "a-verified", "relay-completed", "b-stop-started")) {
        Write-Host "Phase-aware start: relay is a-upgrade-pending with recovery stage $recoveryStage; preserving both endpoints for recovery reconciliation."
        return @("A", "B")
    }
    if ($phase -in @("passive-testing", "validating")) {
        Stop-ExecutorIfRunning "B" "known-good Executor A remains online while candidate checks run"
        Write-Host "Phase-aware start: relay is $phase; starting/preserving Executor A and keeping Executor B dormant."
        return @("A")
    }
    Stop-ExecutorIfRunning "B" "normal A-only reciprocal operation"
    Write-Host "Phase-aware start: relay is $phase; starting only Executor A and keeping Executor B dormant."
    return @("A")
}

foreach ($selected in (Get-PhaseAwareStartRoles)) {
    Start-Executor $selected
}
