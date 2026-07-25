param(
    [string]$Workspace = "C:\Users\huizh\Apps\HZ code",
    [string]$TaskName = "TandemHandoffDoneReviewWatch"
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $Workspace "scripts\handoff-done-review-watch.ps1"
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Missing watcher script: $scriptPath"
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Workspace $Workspace
if ($LASTEXITCODE -ne 0) { throw "Could not initialize handoff done-review watcher." }

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$argument = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Workspace `"$Workspace`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument -WorkingDirectory $Workspace
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 365)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Limited -LogonType Interactive
$description = "Zero-token detector for new Tandem D*_done.txt files; writes a review wakeup packet only on change."

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Description $description | Out-Null
Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo | Format-List TaskName, State, NextRunTime, LastTaskResult
