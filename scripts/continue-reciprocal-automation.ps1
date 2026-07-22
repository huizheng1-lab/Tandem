param(
    [string]$Workspace = (Get-Location).Path,
    [string]$RelayRoot = "",
    [int]$MaxTransitions = 3
)

$ErrorActionPreference = "Stop"

function ConvertFrom-JsonOutput([string]$Text) {
    return ($Text -replace "^\uFEFF", "") | ConvertFrom-Json
}

function Invoke-JsonCommand([string]$File, [string[]]$Arguments, [string]$WorkingDirectory) {
    $output = & $File @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw (($output | Out-String).Trim())
    }
    return ConvertFrom-JsonOutput (($output | Out-String).Trim())
}

function Read-JsonFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return (Get-Content -LiteralPath $Path -Raw) | ConvertFrom-Json
}

function Get-AdminRepo([string]$Path) {
    $commonRaw = (& git -C $Path rev-parse --git-common-dir).Trim()
    $commonDir = if ([IO.Path]::IsPathRooted($commonRaw)) { $commonRaw } else { [IO.Path]::GetFullPath((Join-Path $Path $commonRaw)) }
    return (Split-Path $commonDir -Parent)
}

function Invoke-ExecutorPrompt([string]$RelayRootPath, [string]$ProjectDir, [object]$Continuation) {
    $tokenPath = Join-Path $RelayRootPath "state\executor-a\automation.json"
    $credentials = Read-JsonFile $tokenPath
    if (-not $credentials -or -not $credentials.port -or -not $credentials.token) {
        throw "Executor A automation token is not ready at $tokenPath."
    }

    $mode = if ($Continuation.mode) { [string]$Continuation.mode } else { "continue-step" }
    $prompt = if ($mode -eq "plan") {
@"
Start the approved reciprocal planning lifecycle immediately, without waiting for the scheduled tick.

First run:
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\reciprocal-relay.ps1 -Action Claim -Role A

If the claim succeeds, run the normalized planning start command:
$($Continuation.startCommand)

Create only the smallest coherent plan for wishlist $($Continuation.wishlistId) at process/reciprocal/epics/$($Continuation.wishlistId)-plan.md. Do not implement product changes for the planned item in this planning turn. The plan must split the accepted human objective into bounded vertical source steps and identify any exact sensitive authority gates only at the sensitive step. Run required verification and let Tandem's app layer commit and Complete the plan candidate when done. If Claim reports PASSIVE_TEST or A_UPGRADE_PENDING, stop and report that boundary instead of bypassing it.
"@
    } else {
@"
Continue the already-approved autonomous reciprocal epic immediately, without waiting for the scheduled tick.

First run:
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\reciprocal-relay.ps1 -Action Claim -Role A

If the claim succeeds, run the approved continuation start command:
$($Continuation.startCommand)

Implement only wishlist $($Continuation.wishlistId) step $($Continuation.nextStep), run the required verification, and let Tandem's app layer commit and Complete the candidate when the step is done. If Claim reports PASSIVE_TEST or A_UPGRADE_PENDING, stop and report that boundary instead of bypassing it.
"@
    }

    $payload = @{
        projectDir = $ProjectDir
        prompt = $prompt
    } | ConvertTo-Json -Depth 8
    return Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($credentials.port)/prompt" -Headers @{ Authorization = "Bearer $($credentials.token)" } -ContentType "application/json" -Body $payload
}

function Get-SharedDirectionPath([string]$RelayRootPath) {
    return (Join-Path $RelayRootPath "control\WISHLIST.md")
}

function Get-IntermediateContinuationFromBoard([string]$BoardPath, [string]$StableCommit) {
    if (-not (Test-Path -LiteralPath $BoardPath)) { return $null }
    foreach ($line in (Get-Content -LiteralPath $BoardPath)) {
        $match = [regex]::Match($line, '^- \[ \] (W\d+) \| .* \| IN_PROGRESS\b')
        if (-not $match.Success) { continue }
        if ($line -notmatch '\bepic=true\b' -or $line -notmatch '\bphase=STEP\b') { continue }
        $nextMatch = [regex]::Match($line, '\bnext=(\d+/\d+)\b')
        if (-not $nextMatch.Success) { continue }
        if ($StableCommit -and $line -notmatch "\blast=$([regex]::Escape($StableCommit))(\s|$)") { continue }
        $id = $match.Groups[1].Value
        $nextStep = $nextMatch.Groups[1].Value
        return [pscustomobject]@{
            available = $true
            reason = "intermediate-epic-gate-repair"
            wishlistId = $id
            nextStep = $nextStep
            claimCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Claim -Role A"
            startCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-direction.ps1 -Action Start -Id $id -Role A"
            requiresHumanGate = $false
        }
    }
    return $null
}

function Get-HighestPriorityQueuedItem([string]$BoardPath) {
    if (-not (Test-Path -LiteralPath $BoardPath)) { return $null }
    $rank = @{ P0 = 0; P1 = 1; P2 = 2; P3 = 3 }
    $items = @()
    foreach ($line in (Get-Content -LiteralPath $BoardPath)) {
        $match = [regex]::Match($line, '^- \[ \] (W\d+) \| (P[0-3]) \| (.*?) \| QUEUED(?:\s+(.*))?$')
        if (-not $match.Success) { continue }
        $detail = [string]$match.Groups[4].Value
        if ($detail -match '(^|\s)artifact=') { continue }
        $items += [pscustomobject]@{
            id = $match.Groups[1].Value
            priority = $match.Groups[2].Value
            text = $match.Groups[3].Value
            detail = $detail
            rank = [int]$rank[$match.Groups[2].Value]
            isEpic = $detail -match '(^|\s)epic=true(\s|$)'
        }
    }
    return @($items | Sort-Object rank, id | Select-Object -First 1)
}

function Get-PlanningContinuationFromBoard([string]$BoardPath) {
    $item = Get-HighestPriorityQueuedItem $BoardPath
    if (-not $item) { return $null }
    $directionScript = Join-Path $PSScriptRoot "reciprocal-direction.ps1"
    if (-not $item.isEpic) {
        Invoke-JsonCommand "powershell" @(
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $directionScript,
            "-Action", "NormalizeQueued", "-Id", $item.id, "-ControlPath", $BoardPath
        ) (Split-Path $PSScriptRoot -Parent) | Out-Null
    }
    return [pscustomobject]@{
        available = $true
        mode = "plan"
        reason = "human-queued-auto-planning"
        wishlistId = $item.id
        nextStep = "PLAN"
        claimCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Claim -Role A"
        startCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-direction.ps1 -Action Start -Id $($item.id) -Role A"
        requiresHumanGate = $false
    }
}

function Save-RelayState([string]$Path, [object]$State) {
    $State | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path -Encoding UTF8
}

if ($MaxTransitions -lt 1) { throw "MaxTransitions must be at least 1." }

$workspaceFull = (Resolve-Path $Workspace).Path
$adminRepo = Get-AdminRepo $workspaceFull
if (-not $RelayRoot.Trim()) {
    $RelayRoot = Join-Path (Split-Path $adminRepo -Parent) "Tandem Reciprocal"
}
$relayRootFull = [IO.Path]::GetFullPath($RelayRoot)
$copyA = Join-Path $relayRootFull "worktrees\copy-a"
$copyB = Join-Path $relayRootFull "worktrees\copy-b"
$statePath = Join-Path $adminRepo ".git\tandem-relay\state.json"
$relayScript = Join-Path $PSScriptRoot "reciprocal-relay.ps1"
$leasePath = Join-Path $relayRootFull "control\continuation-supervisor.lock.json"

function Enter-Lease([string]$Path) {
    New-Item -ItemType Directory -Path (Split-Path $Path -Parent) -Force | Out-Null
    $lease = [ordered]@{ pid = $PID; startedAt = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json -Compress
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $bytes = [Text.UTF8Encoding]::new($false).GetBytes($lease)
            $stream.Write($bytes, 0, $bytes.Length)
        } finally {
            $stream.Dispose()
        }
        return $true
    } catch {
        return $false
    }
}

function Exit-Lease([string]$Path) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

if (-not (Enter-Lease $leasePath)) {
    [pscustomobject]@{
        ok = $true
        startedAt = (Get-Date).ToUniversalTime().ToString("o")
        endedAt = (Get-Date).ToUniversalTime().ToString("o")
        maxTransitions = $MaxTransitions
        transitionsUsed = 0
        actions = @([pscustomobject]@{ kind = "lease-held"; retryable = $true })
    } | ConvertTo-Json -Depth 8
    exit 0
}

$actions = @()
$transitionCount = 0
$startedAt = (Get-Date).ToUniversalTime().ToString("o")
try {
$state = Read-JsonFile $statePath
if (-not $state) { throw "Relay state is missing at $statePath." }

if (($state.phase -eq "passive-testing" -or $state.candidateCommit) -and $transitionCount -lt $MaxTransitions) {
    $candidate = [string]$state.candidateCommit
    $transitionCount += 1
    $passiveStart = (Get-Date).ToUniversalTime().ToString("o")
    $passive = Invoke-JsonCommand "powershell" @(
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $relayScript,
        "-Action",
        "PassiveTest",
        "-Role",
        "A",
        "-Workspace",
        $copyA,
        "-Summary",
        "D156 immediate automatic PassiveTest for candidate $candidate"
    ) $adminRepo
    $actions += [pscustomobject]@{
        kind = "passive-test"
        startedAt = $passiveStart
        endedAt = (Get-Date).ToUniversalTime().ToString("o")
        candidate = $candidate
        outcome = $passive.outcome
        phase = $passive.phase
    }

    $continuation = $passive.autonomousContinuation
    if ($passive.outcome -eq "PASSIVE_ACCEPTED" -and $continuation -and $continuation.available -and -not $continuation.requiresHumanGate) {
        if ($transitionCount -lt $MaxTransitions) {
            $transitionCount += 1
            $promptStart = (Get-Date).ToUniversalTime().ToString("o")
            try {
                $prompt = Invoke-ExecutorPrompt $relayRootFull $copyB $continuation
                $actions += [pscustomobject]@{
                    kind = "executor-prompt"
                    startedAt = $promptStart
                    endedAt = (Get-Date).ToUniversalTime().ToString("o")
                    wishlistId = $continuation.wishlistId
                    nextStep = $continuation.nextStep
                    accepted = [bool]$prompt.ok
                    projectDir = $prompt.projectDir
                }
            } catch {
                $actions += [pscustomobject]@{
                    kind = "executor-prompt-unavailable"
                    startedAt = $promptStart
                    endedAt = (Get-Date).ToUniversalTime().ToString("o")
                    wishlistId = $continuation.wishlistId
                    nextStep = $continuation.nextStep
                    error = $_.Exception.Message
                }
            }
        } else {
            $actions += [pscustomobject]@{
                kind = "chain-boundary"
                reason = "MaxTransitions reached before executor prompt."
                maxTransitions = $MaxTransitions
            }
        }
    }
}

if ($state.phase -eq "a-upgrade-pending" -and -not $state.candidateCommit -and $transitionCount -lt $MaxTransitions) {
    $boardContinuation = Get-IntermediateContinuationFromBoard (Get-SharedDirectionPath $relayRootFull) ([string]$state.stableCommit)
    if ($boardContinuation) {
        $transitionCount += 1
        $repairStart = (Get-Date).ToUniversalTime().ToString("o")
        $state.phase = "idle"
        $state.activeRole = $null
        $state.baseCommit = $null
        $state.startedAt = $null
        $state.lastSummary = "D156 released intermediate epic continuation gate for $($boardContinuation.wishlistId) $($boardContinuation.nextStep); no human A-upgrade gate applies before the final step."
        $state.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
        Save-RelayState $statePath $state
        $actions += [pscustomobject]@{
            kind = "release-intermediate-gate"
            startedAt = $repairStart
            endedAt = (Get-Date).ToUniversalTime().ToString("o")
            wishlistId = $boardContinuation.wishlistId
            nextStep = $boardContinuation.nextStep
            phase = "idle"
        }
        if ($transitionCount -lt $MaxTransitions) {
            $transitionCount += 1
            $promptStart = (Get-Date).ToUniversalTime().ToString("o")
            try {
                $prompt = Invoke-ExecutorPrompt $relayRootFull $copyB $boardContinuation
                $actions += [pscustomobject]@{
                    kind = "executor-prompt"
                    startedAt = $promptStart
                    endedAt = (Get-Date).ToUniversalTime().ToString("o")
                    wishlistId = $boardContinuation.wishlistId
                    nextStep = $boardContinuation.nextStep
                    accepted = [bool]$prompt.ok
                    projectDir = $prompt.projectDir
                }
            } catch {
                $actions += [pscustomobject]@{
                    kind = "executor-prompt-unavailable"
                    startedAt = $promptStart
                    endedAt = (Get-Date).ToUniversalTime().ToString("o")
                    wishlistId = $boardContinuation.wishlistId
                    nextStep = $boardContinuation.nextStep
                    error = $_.Exception.Message
                }
            }
        }
    }
}

$state = Read-JsonFile $statePath
if ($state.phase -eq "paused" -and $state.pausedFromPhase -eq "idle" -and -not $state.activeRole -and -not $state.candidateCommit -and $transitionCount -lt $MaxTransitions) {
    $planning = Get-PlanningContinuationFromBoard (Get-SharedDirectionPath $relayRootFull)
    if ($planning) {
        $transitionCount += 1
        $state.phase = "idle"
        $state.pausedFromPhase = $null
        $state.pauseAfterTurn = $false
        $state.lastSummary = "D175 auto-recovered paused-from-idle planning prerequisite for $($planning.wishlistId); broad human-queued work is normalized into planning, not blocked."
        $state.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
        Save-RelayState $statePath $state
        $actions += [pscustomobject]@{
            kind = "recover-paused-idle-prerequisite"
            wishlistId = $planning.wishlistId
            reason = $planning.reason
            phase = "idle"
        }
    }
}

$state = Read-JsonFile $statePath
if ($state.phase -eq "idle" -and -not $state.activeRole -and -not $state.candidateCommit -and $transitionCount -lt $MaxTransitions) {
    $idleContinuation = Get-IntermediateContinuationFromBoard (Get-SharedDirectionPath $relayRootFull) ([string]$state.stableCommit)
    if (-not $idleContinuation) {
        $idleContinuation = Get-PlanningContinuationFromBoard (Get-SharedDirectionPath $relayRootFull)
    }
    if ($idleContinuation) {
        $transitionCount += 1
        $promptStart = (Get-Date).ToUniversalTime().ToString("o")
        try {
            $prompt = Invoke-ExecutorPrompt $relayRootFull $copyB $idleContinuation
            $actions += [pscustomobject]@{
                kind = "idle-continuation-prompt"
                startedAt = $promptStart
                endedAt = (Get-Date).ToUniversalTime().ToString("o")
                wishlistId = $idleContinuation.wishlistId
                nextStep = $idleContinuation.nextStep
                accepted = [bool]$prompt.ok
                projectDir = $prompt.projectDir
            }
        } catch {
            $actions += [pscustomobject]@{
                kind = "idle-continuation-prompt-unavailable"
                startedAt = $promptStart
                endedAt = (Get-Date).ToUniversalTime().ToString("o")
                wishlistId = $idleContinuation.wishlistId
                nextStep = $idleContinuation.nextStep
                error = $_.Exception.Message
            }
        }
    }
}

$finalState = Read-JsonFile $statePath
[pscustomobject]@{
    ok = $true
    startedAt = $startedAt
    endedAt = (Get-Date).ToUniversalTime().ToString("o")
    maxTransitions = $MaxTransitions
    transitionsUsed = $transitionCount
    actions = $actions
    finalPhase = $finalState.phase
    finalActiveRole = $finalState.activeRole
    finalStableCommit = $finalState.stableCommit
    finalCandidateCommit = $finalState.candidateCommit
} | ConvertTo-Json -Depth 12
} finally {
    Exit-Lease $leasePath
}
