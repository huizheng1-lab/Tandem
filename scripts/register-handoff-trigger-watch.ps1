param(
    [string]$Workspace = "C:\Users\huizh\Apps\HZ code",
    [string]$TaskName = "TandemHandoffTriggerWatch"
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $Workspace "scripts\handoff-trigger-watch.ps1"
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Missing watcher script: $scriptPath"
}

$exists = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($exists) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$argument = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Workspace `"$Workspace`" -Once"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument -WorkingDirectory $Workspace
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 365)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Limited -LogonType Interactive
$description = "Zero-token Tandem handoff detector. Writes .tandem\handoff-watch\wakeup.json only when the next contiguous D handoff is ready."

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Description $description | Out-Null
Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo | Format-List TaskName, State, NextRunTime, LastTaskResult
