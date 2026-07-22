param(
    [ValidateSet("A", "B", "Both")]
    [string]$Role = "Both",
    [string]$RelayRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"

function Stop-Executor([string]$SelectedRole) {
    $slug = $SelectedRole.ToLowerInvariant()
    $runtimeDir = [IO.Path]::GetFullPath((Join-Path $RelayRoot "runtimes\executor-$slug"))
    $automationTokenFile = Join-Path $RelayRoot "state\executor-$slug\automation.json"
    $processes = Get-Process -Name Tandem -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and $_.Path.StartsWith($runtimeDir, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    }
    if (-not $processes) {
        Remove-Item -LiteralPath $automationTokenFile -Force -ErrorAction SilentlyContinue
        Write-Host "Executor $SelectedRole is not running."
        return
    }
    $processes | Stop-Process
    Remove-Item -LiteralPath $automationTokenFile -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped executor $SelectedRole. Durable relay state and checkpoints were preserved."
}

if ($Role -in @("A", "Both")) { Stop-Executor "A" }
if ($Role -in @("B", "Both")) { Stop-Executor "B" }
