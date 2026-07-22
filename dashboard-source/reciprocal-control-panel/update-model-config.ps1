param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,

    [Parameter(Mandatory = $true)]
    [string]$Leader,

    [Parameter(Mandatory = $true)]
    [string]$Worker,

    [string]$CodexCliModel,
    [string]$ClaudeCliModel,

    [ValidateSet("", "minimal", "low", "medium", "high")]
    [string]$CodexEffort = "",

    [string]$EnsureCustomModelsJson = "[]"
)

$ErrorActionPreference = "Stop"
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Tandem config does not exist: $ConfigPath" }

$sha = [Security.Cryptography.SHA256]::Create()
try {
    $hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($ConfigPath.ToLowerInvariant()))
} finally {
    $sha.Dispose()
}
$hashText = ([BitConverter]::ToString($hashBytes)).Replace("-", "")
$mutex = [Threading.Mutex]::new($false, "Local\TandemModelConfig-" + $hashText.Substring(0, 20))
if (-not $mutex.WaitOne(5000)) { throw "Timed out waiting for the Tandem model config lock." }

try {
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $config.leader = $Leader
    $config.worker = $Worker

    if ($CodexCliModel) {
        $config | Add-Member -NotePropertyName codexCliModel -NotePropertyValue $CodexCliModel -Force
    } else {
        $config.PSObject.Properties.Remove("codexCliModel")
    }
    if ($ClaudeCliModel) {
        $config | Add-Member -NotePropertyName claudeCliModel -NotePropertyValue $ClaudeCliModel -Force
    } else {
        $config.PSObject.Properties.Remove("claudeCliModel")
    }
    if ($CodexEffort) {
        $config | Add-Member -NotePropertyName codexCliReasoningEffort -NotePropertyValue $CodexEffort -Force
    } else {
        $config.PSObject.Properties.Remove("codexCliReasoningEffort")
    }

    $ensureCustomModels = @($EnsureCustomModelsJson | ConvertFrom-Json)
    if ($ensureCustomModels.Count -gt 0) {
        $existingCustomModels = @()
        if ($config.PSObject.Properties.Name -contains "customModels" -and $null -ne $config.customModels) {
            $existingCustomModels = @($config.customModels)
        }
        foreach ($model in $ensureCustomModels) {
            if (-not ($existingCustomModels | Where-Object { $_.id -eq $model.id } | Select-Object -First 1)) {
                $existingCustomModels += $model
            }
        }
        $config | Add-Member -NotePropertyName customModels -NotePropertyValue $existingCustomModels -Force
    }

    $tempPath = "$ConfigPath.tmp-$PID"
    $json = $config | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText($tempPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tempPath -Destination $ConfigPath -Force
    [ordered]@{
        path = $ConfigPath
        leader = $Leader
        worker = $Worker
        codexCliModel = if ($CodexCliModel) { $CodexCliModel } else { $null }
        claudeCliModel = if ($ClaudeCliModel) { $ClaudeCliModel } else { $null }
        codexCliReasoningEffort = if ($CodexEffort) { $CodexEffort } else { $null }
    } | ConvertTo-Json
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
