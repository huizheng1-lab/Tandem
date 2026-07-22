param(
    [int]$Port = 4782,
    [Parameter(Mandatory = $true)][string]$DashboardRoot,
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Parameter(Mandatory = $true)][string]$StopSignalPath
)

$ErrorActionPreference = "Stop"
$server = Join-Path $DashboardRoot "server.mjs"
$pidPath = Join-Path (Split-Path $LogPath -Parent) "dashboard-watchdog-$Port.pid"
$mutex = [Threading.Mutex]::new($false, "Local\TandemDashboardWatchdog-$Port")
if (-not $mutex.WaitOne(0)) { exit 0 }

function Rotate-Log {
    try {
        if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -ge 2MB) {
            $rotated = "$LogPath.1"
            Remove-Item -LiteralPath $rotated -Force -ErrorAction SilentlyContinue
            Move-Item -LiteralPath $LogPath -Destination $rotated -Force
        }
    } catch {}
}

function Write-WatchdogLog([string]$Message) {
    Rotate-Log
    $line = "{0} pid={1} port={2} watchdog {3}{4}" -f (Get-Date).ToUniversalTime().ToString("o"), $PID, $Port, $Message, [Environment]::NewLine
    [IO.File]::AppendAllText($LogPath, $line, [Text.UTF8Encoding]::new($false))
}

function Test-Listening {
    return $null -ne (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Start-Server {
    Rotate-Log
    $node = (Get-Command node -ErrorAction Stop).Source
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $node
    $info.Arguments = "`"$server`" --port=$Port"
    $info.WorkingDirectory = $DashboardRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables["TANDEM_SOURCE_REPO"] = $RepoRoot

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    [void]$process.Start()
    Write-WatchdogLog "server launched serverPid=$($process.Id)"

    $stdout = Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -MessageData @{ Log = $LogPath; Port = $Port; Stream = "stdout" } -Action {
        if ($EventArgs.Data) {
            $data = $EventArgs.Data -replace '\r?\n', '\n'
            $line = "{0} port={1} server-{2} {3}{4}" -f (Get-Date).ToUniversalTime().ToString("o"), $Event.MessageData.Port, $Event.MessageData.Stream, $data, [Environment]::NewLine
            [IO.File]::AppendAllText($Event.MessageData.Log, $line, [Text.UTF8Encoding]::new($false))
        }
    }
    $stderr = Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived -MessageData @{ Log = $LogPath; Port = $Port; Stream = "stderr" } -Action {
        if ($EventArgs.Data) {
            $data = $EventArgs.Data -replace '\r?\n', '\n'
            $line = "{0} port={1} server-{2} {3}{4}" -f (Get-Date).ToUniversalTime().ToString("o"), $Event.MessageData.Port, $Event.MessageData.Stream, $data, [Environment]::NewLine
            [IO.File]::AppendAllText($Event.MessageData.Log, $line, [Text.UTF8Encoding]::new($false))
        }
    }
    $process.BeginOutputReadLine()
    $process.BeginErrorReadLine()

    try {
        while (-not $process.HasExited) {
            if (Test-Path -LiteralPath $StopSignalPath) {
                $deadline = (Get-Date).AddSeconds(3)
                while (-not $process.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
                if (-not $process.HasExited) {
                    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                    Write-WatchdogLog "server forced to stop after shutdown signal serverPid=$($process.Id)"
                }
                break
            }
            Start-Sleep -Milliseconds 250
        }
        $process.WaitForExit()
        Write-WatchdogLog "server exited serverPid=$($process.Id) exitCode=$($process.ExitCode)"
    } finally {
        foreach ($subscription in @($stdout, $stderr)) {
            Unregister-Event -SourceIdentifier $subscription.Name -ErrorAction SilentlyContinue
            Remove-Job -Id $subscription.Id -Force -ErrorAction SilentlyContinue
        }
        $process.Dispose()
    }
}

try {
    [IO.File]::WriteAllText($pidPath, "$PID`n", [Text.UTF8Encoding]::new($false))
    Write-WatchdogLog "started"
    while (-not (Test-Path -LiteralPath $StopSignalPath)) {
        if (Test-Listening) {
            Start-Sleep -Seconds 1
            continue
        }
        Write-WatchdogLog "listener unavailable; restart in 2 seconds"
        Start-Sleep -Seconds 2
        if (Test-Path -LiteralPath $StopSignalPath) { break }
        try { Start-Server } catch { Write-WatchdogLog "launch failure $($_.Exception.Message)" }
    }
    Write-WatchdogLog "stopped by shutdown signal"
} finally {
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
