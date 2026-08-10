if (-not ('TandemRestartManager.NativeMethods' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace TandemRestartManager {
  public enum RmAppType { Unknown = 0, MainWindow = 1, OtherWindow = 2, Service = 3, Explorer = 4, Console = 5, Critical = 1000 }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct RmUniqueProcess { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct RmProcessInfo { public RmUniqueProcess Process; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName; public RmAppType ApplicationType; public uint AppStatus; public uint TSSessionId; [MarshalAs(UnmanagedType.Bool)] public bool bRestartable; }
  public static class NativeMethods {
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] public static extern int RmStartSession(out uint handle, int sessionFlags, string sessionKey);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] public static extern int RmRegisterResources(uint handle, uint nFiles, string[] files, uint nApplications, IntPtr apps, uint nServices, IntPtr services);
    [DllImport("rstrtmgr.dll")] public static extern int RmGetList(uint handle, out uint needed, ref uint found, [In, Out] RmProcessInfo[] info, ref uint rebootReasons);
    [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint handle);
  }
}
'@
}

function Test-SharingViolation([object]$ErrorRecord) {
    $message = [string]$ErrorRecord.Exception.Message
    return $message -match '(?i)(sharing violation|used by another process|cannot access the file|error\s*32|error\s*33)'
}

function Get-ExecutablePathLockHolderReport([string]$Path, [string]$RestartManagerFailure = "") {
    $target = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $targetRoot = $target
    if ((Test-Path -LiteralPath $target -PathType Leaf)) {
        $targetRoot = [IO.Path]::GetDirectoryName($target)
    }
    $prefix = if ($RestartManagerFailure) { "$RestartManagerFailure. " } else { "" }
    try {
        $holders = @(Get-CimInstance Win32_Process | Where-Object {
            if (-not $_.ExecutablePath) { return $false }
            try {
                $exe = [IO.Path]::GetFullPath([string]$_.ExecutablePath)
                return $exe.Equals($targetRoot, [StringComparison]::OrdinalIgnoreCase) -or $exe.StartsWith($targetRoot + '\', [StringComparison]::OrdinalIgnoreCase)
            } catch {
                return $false
            }
        } | ForEach-Object {
            "PID=$($_.ProcessId), Name=$($_.Name), Path=$($_.ExecutablePath)"
        })
        if ($holders.Count -gt 0) {
            return "Candidate lock holders for '$Path' ($prefix" + "executable path fallback): " + ($holders -join '; ')
        }
    } catch {
        return "No lock holder could be determined for '$Path' ($prefix" + "executable path fallback failed: $($_.Exception.Message))."
    }
    if ($RestartManagerFailure) {
        return "No lock holder could be determined for '$Path' ($RestartManagerFailure; executable path fallback found no process under '$targetRoot')."
    }
    return "No lock holder could be determined for '$Path'."
}

function Get-LockHolderReport([string]$Path) {
    $session = 0
    $key = [Guid]::NewGuid().ToString()
    $files = @($Path)
    if ($env:TANDEM_FORCE_RESTART_MANAGER_FAILURE_CODE) {
        return Get-ExecutablePathLockHolderReport $Path "Restart Manager list failed with code $env:TANDEM_FORCE_RESTART_MANAGER_FAILURE_CODE"
    }
    $start = [TandemRestartManager.NativeMethods]::RmStartSession([ref]$session, 0, $key)
    if ($start -ne 0) { return Get-ExecutablePathLockHolderReport $Path "Restart Manager start failed with code $start" }
    try {
        $registered = [TandemRestartManager.NativeMethods]::RmRegisterResources($session, [uint32]$files.Count, $files, 0, [IntPtr]::Zero, 0, [IntPtr]::Zero)
        if ($registered -ne 0) { return Get-ExecutablePathLockHolderReport $Path "Restart Manager registration failed with code $registered" }
        [uint32]$needed = 0; [uint32]$found = 0; [uint32]$reasons = 0
        $probe = [TandemRestartManager.NativeMethods]::RmGetList($session, [ref]$needed, [ref]$found, $null, [ref]$reasons)
        if ($probe -ne 234 -and $probe -ne 0) { return Get-ExecutablePathLockHolderReport $Path "Restart Manager list failed with code $probe" }
        if ($needed -eq 0) { return "No lock holder could be determined for '$Path'." }
        $info = New-Object 'TandemRestartManager.RmProcessInfo[]' ([int]$needed)
        $found = $needed
        $listed = [TandemRestartManager.NativeMethods]::RmGetList($session, [ref]$needed, [ref]$found, $info, [ref]$reasons)
        if ($listed -ne 0 -and $listed -ne 234) { return Get-ExecutablePathLockHolderReport $Path "Restart Manager list failed with code $listed" }
        $holders = @($info | Select-Object -First ([int]$found) | ForEach-Object {
            $processName = $_.strAppName
            $exePath = "unknown"
            try {
                $process = Get-Process -Id $_.Process.dwProcessId -ErrorAction Stop
                if ($process.Name) { $processName = $process.Name }
                if ($process.Path) { $exePath = $process.Path }
            } catch { }
            "PID=$($_.Process.dwProcessId), Name=$processName, Path=$exePath"
        })
        if ($holders.Count -eq 0) { return "No lock holder could be determined for '$Path'." }
        return "Candidate lock holders for '$Path': " + ($holders -join '; ')
    } finally { [void][TandemRestartManager.NativeMethods]::RmEndSession($session) }
}
