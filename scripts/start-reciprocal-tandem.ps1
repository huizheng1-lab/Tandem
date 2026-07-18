param(
    [ValidateSet("A", "B", "Both")]
    [string]$Role = "Both",
    [string]$RelayRoot = (Join-Path (Split-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path -Parent) "Tandem Reciprocal"),
    [int]$AutomationPortA = 4783,
    [int]$AutomationPortB = 4784
)

$ErrorActionPreference = "Stop"
$adminRepo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

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
    private const int CREATE_NEW_PROCESS_GROUP = 0x00000200;
    private const int CREATE_BREAKAWAY_FROM_JOB = 0x01000000;

    public static int StartHiddenBreakaway(string exe, string commandLine, string workingDirectory) {
        var startupInfo = new STARTUPINFO();
        startupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        startupInfo.dwFlags = STARTF_USESHOWWINDOW;
        startupInfo.wShowWindow = SW_HIDE;

        PROCESS_INFORMATION processInformation;
        int flags = CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB;
        bool ok = CreateProcessW(exe, commandLine, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, workingDirectory, ref startupInfo, out processInformation);
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
        $commandLine = Join-WindowsCommandLine (@($exe) + $arguments)
        $launchedPid = [TandemDetachedProcess]::StartHiddenBreakaway($exe, $commandLine, $runtimeDir)
    } finally {
        $env:TANDEM_HOME = $oldHome
        $env:TANDEM_INSTANCE_ID = $oldInstance
        $env:TANDEM_PROTECTED_ROOTS = $oldProtectedRoots
        $env:TANDEM_CODEX_WRITABLE_ROOTS = $oldCodexWritableRoots
    }
    Write-Host "Started executor $SelectedRole hidden as breakaway PID $launchedPid; automation endpoint 127.0.0.1:$automationPort targets $targetWorktree."
}

if ($Role -in @("A", "Both")) { Start-Executor "A" }
if ($Role -in @("B", "Both")) { Start-Executor "B" }
