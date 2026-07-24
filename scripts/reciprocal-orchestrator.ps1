param(
    [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$RelayRoot = "",
    [switch]$Status
)

$ErrorActionPreference = "Stop"

if (-not $RelayRoot.Trim()) {
    $RelayRoot = Join-Path (Split-Path (Resolve-Path $Repo).Path -Parent) "Tandem Reciprocal"
}

$argsList = @((Join-Path $PSScriptRoot "reciprocal-orchestrator.mjs"), "--repo", $Repo, "--relay-root", $RelayRoot)
if ($Status) { $argsList += "--status" }
& node @argsList
exit $LASTEXITCODE
