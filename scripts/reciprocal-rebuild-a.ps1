param(
    [string]$RelayRoot = "",
    [string]$SourceSha = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $RelayRoot.Trim()) {
    $RelayRoot = Join-Path (Split-Path $repoRoot -Parent) "Tandem Reciprocal"
}
if (-not $SourceSha.Trim()) {
    $SourceSha = (& git -C $repoRoot rev-parse HEAD).Trim()
}

$stopScript = Join-Path $repoRoot "dashboard-source\reciprocal-control-panel\stop-reciprocal-tandem.ps1"
$promoteScript = Join-Path $repoRoot "scripts\promote-reciprocal-runtime.ps1"
$startScript = Join-Path $repoRoot "scripts\start-reciprocal-tandem.ps1"

& powershell -NoProfile -ExecutionPolicy Bypass -File $stopScript -Role A -RelayRoot $RelayRoot
if ($LASTEXITCODE -ne 0) { throw "Stopping Executor A failed." }

& powershell -NoProfile -ExecutionPolicy Bypass -File $promoteScript -TargetRole A -SourceSha $SourceSha -RelayRoot $RelayRoot
if ($LASTEXITCODE -ne 0) { throw "Promoting Executor A failed." }

& powershell -NoProfile -ExecutionPolicy Bypass -File $startScript -Role A -RelayRoot $RelayRoot
if ($LASTEXITCODE -ne 0) { throw "Starting Executor A failed." }
