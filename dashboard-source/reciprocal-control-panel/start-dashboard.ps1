param(
    [int]$Port = 4782,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$dashboardRoot = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $dashboardRoot "..\..\HZ code")).Path
$server = Join-Path $dashboardRoot "server.mjs"
$url = "http://127.0.0.1:$Port"
$controlRoot = Join-Path $dashboardRoot "..\control"
$logPath = Join-Path $controlRoot "dashboard-server.log"
$stopSignalPath = Join-Path $controlRoot "dashboard-stop-$Port.signal"
$watchdog = Join-Path $dashboardRoot "dashboard-watchdog.ps1"
$registerTask = Join-Path $dashboardRoot "register-dashboard-watchdog-task.ps1"
New-Item -ItemType Directory -Path $controlRoot -Force | Out-Null
Remove-Item -LiteralPath $stopSignalPath -Force -ErrorAction SilentlyContinue

$listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $registerTask) {
    & $registerTask -Port $Port -DashboardRoot $dashboardRoot -RepoRoot $repoRoot | Out-Host
    Start-ScheduledTask -TaskName "TandemReciprocalDashboardWatchdog-$Port"
} else {
    Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$watchdog`"",
        "-Port", $Port, "-DashboardRoot", "`"$dashboardRoot`"", "-RepoRoot", "`"$repoRoot`"",
        "-LogPath", "`"$logPath`"", "-StopSignalPath", "`"$stopSignalPath`""
    ) -WorkingDirectory $dashboardRoot -WindowStyle Hidden
}

if (-not $listener) {
    $deadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 150
        $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    } until ($listener -or (Get-Date) -gt $deadline)
    if (-not $listener) { throw "Control panel did not start on port $Port." }
}

if (-not $NoBrowser) { Start-Process $url }
Write-Output $url
