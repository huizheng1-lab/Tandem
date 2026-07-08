$taskName = "TandemHandoffMonitor"
$exists = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($exists) {
    Write-Host "Task exists; deleting and recreating"
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\huizh\Apps\HZ code\scripts\handoff-monitor.ps1"' -WorkingDirectory "C:\Users\huizh\Apps\HZ code"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 365)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Limited -LogonType Interactive
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Description "Polls for unhandled handoff files (HANDOFF_GPT5_D*.md and HANDOFF_D*.md) every 10 minutes. Exit 1 signals unhandled work exists."
Get-ScheduledTask -TaskName $taskName | Get-ScheduledTaskInfo | Format-List TaskName, State, NextRunTime
