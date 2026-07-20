param(
    [Parameter(Mandatory = $true)]
    [string]$ExecutablePath,

    [Parameter(Mandatory = $true)]
    [string]$StateRoot,

    [int]$TimeoutSeconds = 15,

    [string[]]$ArgumentList,

    [string]$ReadyFile
)

$ErrorActionPreference = "Stop"

function Get-ChildProcessIds([int]$ParentId) {
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentId" -ErrorAction SilentlyContinue)
    foreach ($child in $children) {
        [int]$child.ProcessId
        foreach ($grandchild in Get-ChildProcessIds ([int]$child.ProcessId)) {
            $grandchild
        }
    }
}

function Stop-LaunchedProcessTree([int]$RootPid) {
    $ids = @((Get-ChildProcessIds $RootPid) + $RootPid) | Select-Object -Unique
    [Array]::Reverse($ids)
    $stopped = @()
    foreach ($id in $ids) {
        $process = Get-Process -Id $id -ErrorAction SilentlyContinue
        if (-not $process) { continue }
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
        $stopped += $id
    }
    foreach ($id in $ids) {
        $deadline = (Get-Date).AddSeconds(5)
        do {
            $remaining = Get-Process -Id $id -ErrorAction SilentlyContinue
            if (-not $remaining) { break }
            Start-Sleep -Milliseconds 100
        } while ((Get-Date) -lt $deadline)
        $remaining = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($remaining) { throw "Smoke cleanup could not terminate process $id." }
    }
    return $stopped
}

function Write-SmokeResult([bool]$Ok, [string]$Outcome, [hashtable]$Extra) {
    $result = [ordered]@{
        ok = $Ok
        outcome = $Outcome
        executable = $ExecutablePath
        timeoutSeconds = $TimeoutSeconds
        at = (Get-Date).ToUniversalTime().ToString("o")
    }
    foreach ($key in $Extra.Keys) {
        $result[$key] = $Extra[$key]
    }
    $result | ConvertTo-Json -Depth 8
}

if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
    Write-SmokeResult $false "missing-executable" @{ error = "Executable is missing." }
    exit 2
}
if ($TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 120) {
    throw "TimeoutSeconds must be between 1 and 120."
}

$stateRootFull = [IO.Path]::GetFullPath($StateRoot)
$smokeHome = Join-Path $stateRootFull "home"
$userData = Join-Path $stateRootFull "user-data"
$project = Join-Path $stateRootFull "project"
New-Item -ItemType Directory -Force -Path $smokeHome, $userData, $project | Out-Null

$args = if ($ArgumentList -and $ArgumentList.Count -gt 0) {
    @($ArgumentList)
} else {
    @("--user-data-dir=$userData")
}

$oldHome = $env:TANDEM_HOME
$oldProject = $env:TANDEM_DESKTOP_LAST_PROJECT
try {
    $env:TANDEM_HOME = $smokeHome
    $env:TANDEM_DESKTOP_LAST_PROJECT = $project
    $process = Start-Process -FilePath $ExecutablePath -ArgumentList $args -WorkingDirectory $project -PassThru -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $ready = $false
    $readiness = "none"
    $lastIdleError = $null

    while ((Get-Date) -lt $deadline) {
        $process.Refresh()
        if ($process.HasExited) {
            $code = $process.ExitCode
            $outcome = if ($code -eq 0) { "early-exit" } else { "crash" }
            Write-SmokeResult $false $outcome @{ pid = $process.Id; exitCode = $code; readiness = $readiness }
            exit $(if ($code -eq 0) { 3 } else { 4 })
        }
        if ($ReadyFile -and (Test-Path -LiteralPath $ReadyFile)) {
            $ready = $true
            $readiness = "ready-file"
            break
        }
        try {
            if ($process.WaitForInputIdle(500)) {
                $ready = $true
                $readiness = "input-idle"
                break
            }
        } catch {
            $lastIdleError = $_.Exception.Message
            Start-Sleep -Milliseconds 250
        }
    }

    if (-not $ready) {
        $stopped = Stop-LaunchedProcessTree $process.Id
        Write-SmokeResult $false "readiness-timeout" @{ pid = $process.Id; readiness = $readiness; inputIdleError = $lastIdleError; stoppedPids = $stopped }
        exit 5
    }

    $stoppedPids = Stop-LaunchedProcessTree $process.Id
    $remaining = @($stoppedPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($remaining.Count -gt 0) {
        Write-SmokeResult $false "cleanup-failed" @{ pid = $process.Id; readiness = $readiness; remainingPids = $remaining }
        exit 6
    }

    Write-SmokeResult $true "ready" @{ pid = $process.Id; readiness = $readiness; stoppedPids = $stoppedPids; home = $smokeHome; userData = $userData; project = $project }
    exit 0
} catch {
    Write-SmokeResult $false "launch-failed" @{ error = $_.Exception.Message }
    exit 7
} finally {
    if ($null -eq $oldHome) { Remove-Item Env:\TANDEM_HOME -ErrorAction SilentlyContinue } else { $env:TANDEM_HOME = $oldHome }
    if ($null -eq $oldProject) { Remove-Item Env:\TANDEM_DESKTOP_LAST_PROJECT -ErrorAction SilentlyContinue } else { $env:TANDEM_DESKTOP_LAST_PROJECT = $oldProject }
}
