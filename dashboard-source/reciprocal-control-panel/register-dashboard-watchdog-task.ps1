param(
    [int]$Port = 4782,
    [string]$DashboardRoot = $PSScriptRoot,
    [string]$RepoRoot = "",
    [string]$TaskName = "",
    [int]$RepeatMinutes = 5
)

$ErrorActionPreference = "Stop"

$DashboardRoot = (Resolve-Path -LiteralPath $DashboardRoot).Path
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $DashboardRoot "..\..\HZ code")).Path
} else {
    $RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
}
if ([string]::IsNullOrWhiteSpace($TaskName)) {
    $TaskName = "TandemReciprocalDashboardWatchdog-$Port"
}

$controlRoot = Join-Path $DashboardRoot "..\control"
$logPath = Join-Path $controlRoot "dashboard-server.log"
$stopSignalPath = Join-Path $controlRoot "dashboard-stop-$Port.signal"
$watchdog = Join-Path $DashboardRoot "dashboard-watchdog.ps1"
New-Item -ItemType Directory -Path $controlRoot -Force | Out-Null

if (-not (Test-Path -LiteralPath $watchdog)) {
    throw "Missing dashboard watchdog script: $watchdog"
}

$argument = "-NoProfile -ExecutionPolicy Bypass -File `"$watchdog`" -Port $Port -DashboardRoot `"$DashboardRoot`" -RepoRoot `"$RepoRoot`" -LogPath `"$logPath`" -StopSignalPath `"$stopSignalPath`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument -WorkingDirectory $DashboardRoot
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $RepeatMinutes) -RepetitionDuration (New-TimeSpan -Days 365)
$triggers = @($logonTrigger, $repeatTrigger)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Limited -LogonType Interactive
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$description = "Keeps the Tandem reciprocal dashboard watchdog alive. If dashboard-stop-$Port.signal exists, the watchdog exits without restarting the panel."

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description $description -Force | Out-Null
Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo | Format-List TaskName, State, NextRunTime, LastTaskResult
