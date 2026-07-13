param(
    [ValidateSet("A", "B", "Both")]
    [string]$Role = "Both",
    [string]$RelayRoot = (Join-Path (Split-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path -Parent) "Tandem Reciprocal")
)

$ErrorActionPreference = "Stop"

function Start-Executor([string]$SelectedRole) {
    $slug = $SelectedRole.ToLowerInvariant()
    $runtimeDir = Join-Path $RelayRoot "runtimes\executor-$slug"
    $exe = Join-Path $runtimeDir "Tandem.exe"
    $home = Join-Path $RelayRoot "state\executor-$slug"
    $userData = Join-Path $RelayRoot "user-data\executor-$slug"
    if (-not (Test-Path -LiteralPath $exe)) { throw "Executor $SelectedRole runtime is missing: $exe" }

    $alreadyRunning = Get-Process -Name Tandem -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and $_.Path.StartsWith($runtimeDir, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    }
    if ($alreadyRunning) {
        Write-Host "Executor $SelectedRole is already running."
        return
    }

    $oldHome = $env:TANDEM_HOME
    $oldInstance = $env:TANDEM_INSTANCE_ID
    try {
        $env:TANDEM_HOME = $home
        $env:TANDEM_INSTANCE_ID = $SelectedRole
        Start-Process -FilePath $exe -WorkingDirectory $runtimeDir -ArgumentList "--user-data-dir=`"$userData`""
    } finally {
        $env:TANDEM_HOME = $oldHome
        $env:TANDEM_INSTANCE_ID = $oldInstance
    }
    Write-Host "Started executor $SelectedRole."
}

if ($Role -in @("A", "Both")) { Start-Executor "A" }
if ($Role -in @("B", "Both")) { Start-Executor "B" }
