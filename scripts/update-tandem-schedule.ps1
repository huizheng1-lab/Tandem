param(
    [Parameter(Mandatory = $true)]
    [string]$SchedulePath,

    [Parameter(Mandatory = $true)]
    [string]$Id,

    [string]$Cron,

    [string]$Prompt
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $SchedulePath)) {
    throw "Schedule file does not exist: $SchedulePath"
}

$raw = Get-Content -LiteralPath $SchedulePath -Raw
$parsed = if ($raw.Trim()) { $raw | ConvertFrom-Json } else { @() }
if ($parsed -isnot [array]) {
    throw "Schedule file must be a JSON array: $SchedulePath"
}

$schedules = @($parsed)
$schedule = $schedules | Where-Object { $_.id -eq $Id } | Select-Object -First 1
if (-not $schedule) {
    throw "Schedule id $Id was not found in $SchedulePath"
}

if ($PSBoundParameters.ContainsKey("Cron")) {
    $schedule.cron = $Cron
}
if ($PSBoundParameters.ContainsKey("Prompt")) {
    $schedule.prompt = $Prompt
}

$json = ConvertTo-Json -InputObject ([object[]]$schedules) -Depth 8
$resolvedPath = (Resolve-Path -LiteralPath $SchedulePath).ProviderPath
[IO.File]::WriteAllText($resolvedPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
