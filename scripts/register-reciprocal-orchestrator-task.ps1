param(
    [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$RelayRoot = "",
    [string]$TaskName = "TandemReciprocalOrchestrator",
    [int]$RepeatMinutes = 5
)

$ErrorActionPreference = "Stop"

$Repo = (Resolve-Path -LiteralPath $Repo).Path
if ([string]::IsNullOrWhiteSpace($RelayRoot)) {
    $RelayRoot = Join-Path (Split-Path $Repo -Parent) "Tandem Reciprocal"
} else {
    $RelayRoot = (Resolve-Path -LiteralPath $RelayRoot).Path
}

$orchestrator = Join-Path $Repo "scripts\reciprocal-orchestrator.mjs"
if (-not (Test-Path -LiteralPath $orchestrator)) {
    throw "Missing reciprocal orchestrator script: $orchestrator"
}
$launcher = Join-Path $Repo "scripts\reciprocal-orchestrator-hidden.vbs"
if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Missing hidden orchestrator launcher: $launcher"
}
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
if (-not (Test-Path -LiteralPath $wscript)) {
    throw "Missing Windows Script Host launcher: $wscript"
}

if ($RepeatMinutes -lt 1) {
    throw "RepeatMinutes must be at least 1."
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$argument = "`"$launcher`" `"$node`" `"$orchestrator`" --repo `"$Repo`" --relay-root `"$RelayRoot`""
$action = New-ScheduledTaskAction -Execute $wscript -Argument $argument -WorkingDirectory $Repo
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $RepeatMinutes) -RepetitionDuration (New-TimeSpan -Days 365)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Limited -LogonType Interactive
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$description = "Runs the single Tandem reciprocal orchestrator from the admin repo every $RepeatMinutes minutes. The task never runs from reciprocal worktrees."

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logonTrigger, $repeatTrigger) -Principal $principal -Settings $settings -Description $description -Force | Out-Null
Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo | Format-List TaskName, State, NextRunTime, LastRunTime, LastTaskResult
