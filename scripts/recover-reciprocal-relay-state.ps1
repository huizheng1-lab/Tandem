param(
    [string]$Workspace = (Get-Location).Path,
    [Int64]$MaxStateBytes = 5MB,
    [Int64]$SampleBytes = 1048576,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$Utf8StrictNoBom = [Text.UTF8Encoding]::new($false, $true)
$Utf8LenientNoBom = [Text.UTF8Encoding]::new($false, $false)

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $output = @(& git -C $Workspace @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)" }
    return $output
}

function Get-JsonStringFromText([string]$Text, [string]$Name) {
    $pattern = '"' + [regex]::Escape($Name) + '"\s*:\s*"([^"]*)"'
    $match = [regex]::Match($Text, $pattern)
    if (-not $match.Success) { return $null }
    return $match.Groups[1].Value
}

function Read-TextSample([string]$Path, [Int64]$Offset, [Int64]$Count) {
    $buffer = [byte[]]::new([int]$Count)
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $stream.Seek($Offset, [IO.SeekOrigin]::Begin) | Out-Null
        $read = $stream.Read($buffer, 0, $buffer.Length)
        if ($read -lt $buffer.Length) { [Array]::Resize([ref]$buffer, $read) }
        return $Utf8LenientNoBom.GetString($buffer)
    } finally {
        $stream.Dispose()
    }
}

function Read-StrictJson([string]$Path, [Int64]$MaxBytes) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $item = Get-Item -LiteralPath $Path
    if ($item.Length -gt $MaxBytes) { throw "Oversized state still needs recovery: $($item.Length) bytes." }
    return ($Utf8StrictNoBom.GetString([IO.File]::ReadAllBytes($Path))) | ConvertFrom-Json
}

function Write-StrictJsonAtomic([string]$Path, [object]$Value, [Int64]$MaxBytes) {
    $json = $Value | ConvertTo-Json -Depth 12
    $bytes = $Utf8StrictNoBom.GetBytes($json + [Environment]::NewLine)
    if ($bytes.Length -gt $MaxBytes) { throw "Recovered state is too large: $($bytes.Length) bytes." }
    $tmp = "$Path.recovery-$PID.tmp"
    [IO.File]::WriteAllBytes($tmp, $bytes)
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

$root = (@(Invoke-Git rev-parse --show-toplevel))[0].Trim()
$Workspace = $root
$commonRaw = (@(Invoke-Git rev-parse --git-common-dir))[0].Trim()
$commonDir = if ([IO.Path]::IsPathRooted($commonRaw)) { $commonRaw } else { [IO.Path]::GetFullPath((Join-Path $Workspace $commonRaw)) }
$relayDir = Join-Path $commonDir "tandem-relay"
$statePath = Join-Path $relayDir "state.json"
if (-not (Test-Path -LiteralPath $statePath)) { throw "Relay state does not exist: $statePath" }

$sha = [Security.Cryptography.SHA256]::Create()
try {
    $hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($commonDir.ToLowerInvariant()))
} finally {
    $sha.Dispose()
}
$hashText = ([BitConverter]::ToString($hashBytes)).Replace("-", "")
$mutexName = "Local\TandemReciprocal-" + $hashText.Substring(0, 20)
$mutex = [Threading.Mutex]::new($false, $mutexName)
if (-not $mutex.WaitOne(10000)) { throw "Timed out waiting for the canonical reciprocal relay lock." }

try {
    $stateItem = Get-Item -LiteralPath $statePath
    if ($stateItem.Length -le $MaxStateBytes) {
        $state = Read-StrictJson $statePath $MaxStateBytes
        $result = [ordered]@{
            ok = $true
            alreadyCompact = $true
            statePath = $statePath
            phase = [string]$state.phase
            pauseOrigin = [string]$state.pauseOrigin
            pauseReasonCode = [string]$state.pauseReasonCode
            candidateCommit = [string]$state.candidateCommit
            sizeBytes = $stateItem.Length
            hash = (Get-FileHash -LiteralPath $statePath -Algorithm SHA256).Hash
        }
        $result | ConvertTo-Json -Depth 8
        exit 0
    }
    if (-not $Force) {
        throw "State is oversized at $($stateItem.Length) bytes. Re-run with -Force after confirming W0027 hard-pause recovery intent."
    }

    $prefixCount = [Math]::Min($SampleBytes, $stateItem.Length)
    $tailCount = [Math]::Min($SampleBytes, $stateItem.Length)
    $prefix = Read-TextSample $statePath 0 $prefixCount
    $tailOffset = [Math]::Max([Int64]0, $stateItem.Length - $tailCount)
    $tail = Read-TextSample $statePath $tailOffset $tailCount
    $sample = $prefix + "`n" + $tail

    $phase = Get-JsonStringFromText $prefix "phase"
    $pausedFromPhase = Get-JsonStringFromText $prefix "pausedFromPhase"
    $pauseOrigin = Get-JsonStringFromText $prefix "pauseOrigin"
    $pauseReasonCode = Get-JsonStringFromText $prefix "pauseReasonCode"
    $candidateCommit = Get-JsonStringFromText $prefix "candidateCommit"
    $stableCommit = Get-JsonStringFromText $prefix "stableCommit"
    if (-not $candidateCommit) { $candidateCommit = (@(Invoke-Git rev-parse refs/tandem-relay/candidate))[0].Trim() }
    if (-not $stableCommit) { $stableCommit = (@(Invoke-Git rev-parse refs/tandem-relay/stable))[0].Trim() }
    $candidateRef = (@(Invoke-Git rev-parse refs/tandem-relay/candidate))[0].Trim()
    $stableRef = (@(Invoke-Git rev-parse refs/tandem-relay/stable))[0].Trim()

    if ($phase -ne "paused" -or $pausedFromPhase -ne "passive-testing" -or $pauseOrigin -ne "machine" -or $pauseReasonCode -ne "candidate-failure") {
        throw "Bounded prefix does not preserve the required W0027 hard-pause invariants."
    }
    if ($candidateCommit -ne $candidateRef) { throw "Candidate commit mismatch between state prefix and ref: $candidateCommit != $candidateRef" }
    if ($stableCommit -ne $stableRef) { throw "Stable commit mismatch between state prefix and ref: $stableCommit != $stableRef" }

    $oldHash = (Get-FileHash -LiteralPath $statePath -Algorithm SHA256).Hash
    $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
    $quarantinePath = Join-Path $relayDir "state.quarantine-D187-$stamp.json"
    Move-Item -LiteralPath $statePath -Destination $quarantinePath

    $failureFile = Get-JsonStringFromText $sample "file"
    if (-not $failureFile) { $failureFile = "tests/reciprocal-direction.test.ts" }
    $failureName = Get-JsonStringFromText $sample "name"
    if (-not $failureName) { $failureName = "candidate validation failure" }

    $compactState = [ordered]@{
        schemaVersion = 2
        turn = 1
        nextRole = "A"
        activeRole = $null
        phase = "paused"
        pausedFromPhase = "passive-testing"
        pauseOrigin = "machine"
        pauseReasonCode = "candidate-failure"
        pauseAfterTurn = $false
        resumeCount = 0
        resumeTurn = $null
        baseCommit = $null
        stableCommit = $stableCommit
        candidateCommit = $candidateCommit
        candidateKind = "improvement"
        rollbackCommit = $null
        startedAt = $null
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
        lastCompletedCommit = $candidateCommit
        lastSummary = "Recovered D187 compact state: W0027 remains hard-paused because the candidate failed passive validation; amplified raw Vitest output was quarantined."
        lastRecoveryStash = $null
        runtimeRecoveryStage = $null
        authorityRequest = $null
        passiveFailure = [ordered]@{
            classifier = "stable-baseline-control"
            classification = "candidate-failure"
            reproducedOnStable = $false
            candidateCommit = $candidateCommit
            stableCommit = $stableCommit
            failingTestFiles = @($failureFile)
            candidateFailureIdentities = @([ordered]@{ file = $failureFile; name = $failureName; key = "$failureFile::$failureName" })
            stableFailureIdentities = @()
            matchingFailureIdentities = @()
            skippedControls = @()
            failedCandidateCommands = @([ordered]@{
                command = "candidate passive validation"
                exitCode = 1
                output = "Recovered concise evidence only; oversized raw state quarantined at $quarantinePath with SHA256 $oldHash."
            })
            baselineChecks = @([ordered]@{
                command = "stable baseline validation"
                exitCode = 0
                passed = $true
                output = "Recovered concise evidence: stable baseline did not reproduce the candidate failure."
            })
            recovery = [ordered]@{
                round = "D187"
                quarantinedPath = $quarantinePath
                oldSizeBytes = $stateItem.Length
                oldSha256 = $oldHash
            }
        }
    }

    Write-StrictJsonAtomic $statePath ([pscustomobject]$compactState) $MaxStateBytes
    $newState = Read-StrictJson $statePath $MaxStateBytes
    if ([string]$newState.phase -ne "paused" -or [string]$newState.pauseReasonCode -ne "candidate-failure" -or [string]$newState.candidateCommit -ne $candidateCommit) {
        throw "Recovered compact state failed invariant verification."
    }
    $newItem = Get-Item -LiteralPath $statePath
    $newHash = (Get-FileHash -LiteralPath $statePath -Algorithm SHA256).Hash
    [ordered]@{
        ok = $true
        alreadyCompact = $false
        statePath = $statePath
        quarantinePath = $quarantinePath
        oldSizeBytes = $stateItem.Length
        oldSha256 = $oldHash
        newSizeBytes = $newItem.Length
        newSha256 = $newHash
        phase = [string]$newState.phase
        pausedFromPhase = [string]$newState.pausedFromPhase
        pauseOrigin = [string]$newState.pauseOrigin
        pauseReasonCode = [string]$newState.pauseReasonCode
        candidateCommit = [string]$newState.candidateCommit
        stableCommit = [string]$newState.stableCommit
    } | ConvertTo-Json -Depth 8
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
