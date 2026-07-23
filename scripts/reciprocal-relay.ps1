param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Status", "Claim", "Validate", "PassiveTest", "PrepareAUpgrade", "CompleteAUpgrade", "Accept", "Complete", "CompleteArtifact", "Rollback", "CompleteRollback", "Abandon", "Pause", "Resume", "ReconcileMain", "DeclareAuthority", "ApproveAuthority", "DenyAuthority", "Reset")]
    [string]$Action,

    [ValidateSet("A", "B")]
    [string]$Role,

    [string]$Summary,

    [string]$Id,

    [ValidateSet("credentials", "authentication", "pairing", "permission", "sandbox", "destructive", "payment", "publication", "runtime")]
    [string]$AuthKind,

    [string]$AuthVerb,

    [string]$Checkpoint,

    [string]$ResumeToken,

    [string]$NewStableCommit,

    [string]$Workspace = (Get-Location).Path,

    [string[]]$ValidationChecks,

    [string]$TandemHome,

    [string]$ReviewVerdictJson,

    [string]$ValidationTracePath,

    [switch]$DryRun,

    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ResumePauseThreshold = 3
$CandidatePreviewArtifactCapability = 1

function Get-ReciprocalTaxonomy {
    $path = $env:TANDEM_RECIPROCAL_TAXONOMY
    if (-not $path) {
        $path = Join-Path (Split-Path $PSScriptRoot -Parent) "process\reciprocal\gate-taxonomy.json"
    }
    if (-not (Test-Path -LiteralPath $path)) { throw "Canonical reciprocal taxonomy is missing at $path." }
    $taxonomy = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    foreach ($name in @("autoRecoverablePrerequisite", "hardBlocked", "hardHumanGate", "waitingNotBlocked")) {
        if (-not $taxonomy.categories.$name) { throw "Canonical reciprocal taxonomy is missing categories.$name." }
    }
    foreach ($name in @("human", "machine", "unknown")) {
        if (-not $taxonomy.pauseOrigins.$name) { throw "Canonical reciprocal taxonomy is missing pauseOrigins.$name." }
    }
    foreach ($name in @("explicitHumanPause", "resumeCircuitBreaker", "candidateFailure", "environmentFailure")) {
        if (-not $taxonomy.pauseReasonCodes.$name) { throw "Canonical reciprocal taxonomy is missing pauseReasonCodes.$name." }
    }
    foreach ($name in @("working", "testing", "waitingForReview", "humanPaused", "machineBlocked", "hardBlocked", "retryBackoff", "retryingPrerequisite", "planning", "unknown", "waitingNotBlocked")) {
        if (-not $taxonomy.displayStates.$name) { throw "Canonical reciprocal taxonomy is missing displayStates.$name." }
    }
    return $taxonomy
}

$taxonomy = Get-ReciprocalTaxonomy

function Get-ReciprocalCapabilities {
    if ($env:TANDEM_DISABLE_CANDIDATE_PREVIEW_ARTIFACT_CAPABILITY -eq "1") {
        return [ordered]@{}
    }
    return [ordered]@{
        candidatePreviewArtifactLifecycle = $CandidatePreviewArtifactCapability
    }
}

function Test-CandidatePreviewArtifactCapability {
    $capabilities = Get-ReciprocalCapabilities
    $version = 0
    if ($capabilities -and $capabilities["candidatePreviewArtifactLifecycle"]) {
        $version = [int]$capabilities["candidatePreviewArtifactLifecycle"]
    }
    return $version -ge $CandidatePreviewArtifactCapability
}

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $oldErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = @(& git -C $Workspace @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldErrorAction
    }
    if ($exitCode -ne 0) {
        throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
    }
    return $output
}

function Test-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $oldErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & git -C $Workspace @Arguments *> $null
        return $LASTEXITCODE -eq 0
    } finally {
        $ErrorActionPreference = $oldErrorAction
    }
}

function Get-RoleConfig([string]$SelectedRole) {
    if ($SelectedRole -eq "A") {
        return @{ Target = "codex/reciprocal-b"; Peer = "codex/reciprocal-a"; Next = "A" }
    }
    return @{ Target = "codex/reciprocal-a"; Peer = "codex/reciprocal-b"; Next = "A" }
}

function New-RelayState([string]$StableCommit) {
    return [ordered]@{
        schemaVersion = 2
        turn = 1
        nextRole = "A"
        activeRole = $null
        phase = "idle"
        pausedFromPhase = $null
        pauseOrigin = $null
        pauseReasonCode = $null
        pauseAfterTurn = $false
        resumeCount = 0
        resumeTurn = $null
        baseCommit = $null
        stableCommit = $StableCommit
        candidateCommit = $null
        candidateKind = $null
        rollbackCommit = $null
        startedAt = $null
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
        lastCompletedCommit = $null
        lastSummary = $null
        lastRecoveryStash = $null
        runtimeRecoveryStage = $null
        authorityRequest = $null
        passiveFailure = $null
    }
}

$root = (@(Invoke-Git rev-parse --show-toplevel))[0].Trim()
$Workspace = $root
$currentHead = (@(Invoke-Git rev-parse HEAD))[0].Trim()
$commonRaw = (@(Invoke-Git rev-parse --git-common-dir))[0].Trim()
$commonDir = if ([IO.Path]::IsPathRooted($commonRaw)) { $commonRaw } else { [IO.Path]::GetFullPath((Join-Path $Workspace $commonRaw)) }
    $relayDir = Join-Path $commonDir "tandem-relay"
    $statePath = Join-Path $relayDir "state.json"
    $adminRepo = Split-Path $commonDir -Parent
    $defaultRelayRoot = if ($env:TANDEM_RECIPROCAL_ROOT) { $env:TANDEM_RECIPROCAL_ROOT } else { Join-Path (Split-Path $adminRepo -Parent) "Tandem Reciprocal" }
New-Item -ItemType Directory -Path $relayDir -Force | Out-Null

$sha = [Security.Cryptography.SHA256]::Create()
try {
    $hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($commonDir.ToLowerInvariant()))
} finally {
    $sha.Dispose()
}
$hashText = ([BitConverter]::ToString($hashBytes)).Replace("-", "")
$mutexName = "Local\TandemReciprocal-" + $hashText.Substring(0, 20)
$mutex = [Threading.Mutex]::new($false, $mutexName)
if (-not $mutex.WaitOne(5000)) { throw "Timed out waiting for the reciprocal relay lock." }

try {
    $state = if (Test-Path -LiteralPath $statePath) {
        Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    } else {
        [pscustomobject](New-RelayState $currentHead)
    }

    if ($state.schemaVersion -ne 2) {
        if ($state.activeRole -or $state.phase -ne "idle") {
            throw "Relay state predates rollback support and has active work. Inspect it, then run a human Reset only after recovery."
        }
        $state = [pscustomobject](New-RelayState $currentHead)
    }
    if (-not $state.PSObject.Properties["pauseAfterTurn"]) {
        $state | Add-Member -NotePropertyName pauseAfterTurn -NotePropertyValue $false
    }
    if (-not $state.PSObject.Properties["resumeCount"]) {
        $state | Add-Member -NotePropertyName resumeCount -NotePropertyValue 0
    }
    if (-not $state.PSObject.Properties["resumeTurn"]) {
        $state | Add-Member -NotePropertyName resumeTurn -NotePropertyValue $null
    }
    if (-not $state.PSObject.Properties["pauseOrigin"]) {
        $state | Add-Member -NotePropertyName pauseOrigin -NotePropertyValue $null
    }
    if (-not $state.PSObject.Properties["pauseReasonCode"]) {
        $state | Add-Member -NotePropertyName pauseReasonCode -NotePropertyValue $null
    }
    if ($state.phase -eq "paused" -and -not $state.pauseOrigin) {
        if ($state.lastSummary -match '^Auto-paused turn \d+: executor [AB] received \d+ consecutive RESUME claims without completing\.') {
            $state.pauseOrigin = [string]$taxonomy.pauseOrigins.machine
            $state.pauseReasonCode = [string]$taxonomy.pauseReasonCodes.resumeCircuitBreaker
        } elseif ($state.lastSummary) {
            $state.pauseOrigin = [string]$taxonomy.pauseOrigins.unknown
        }
    }
    if (-not $state.PSObject.Properties["authorityRequest"]) {
        $state | Add-Member -NotePropertyName authorityRequest -NotePropertyValue $null
    }
    if (-not $state.PSObject.Properties["runtimeRecoveryStage"]) {
        $state | Add-Member -NotePropertyName runtimeRecoveryStage -NotePropertyValue $null
    }
    if (-not $state.PSObject.Properties["passiveFailure"]) {
        $state | Add-Member -NotePropertyName passiveFailure -NotePropertyValue $null
    }

    $runtimeRecoveryJournalPath = Join-Path $defaultRelayRoot "state\runtime-recovery-flow.json"
    $durableRecoveryStages = @(
        "package-ready",
        "b-promote-started",
        "b-promoted",
        "b-start-started",
        "b-started",
        "b-verified",
        "approval-recorded",
        "a-stop-started",
        "a-stopped",
        "a-promote-started",
        "a-promoted",
        "a-start-started",
        "a-started",
        "a-verified",
        "relay-completed",
        "b-stop-started",
        "b-stopped"
    )

    function Save-RuntimeRecoveryJournal {
        param(
            [string]$Stage,
            [string]$SourceSha,
            [string]$PackageIdentity,
            [string]$ImmutablePackagePath = "",
            [object]$Proof = $null,
            [string]$Status = "running"
        )
        if (-not $SourceSha) { throw "Runtime recovery journal requires source SHA." }
        if (-not $PackageIdentity) { throw "Runtime recovery journal requires package identity." }
        if (-not $ImmutablePackagePath) { throw "Runtime recovery journal requires immutable package path." }
        $stageIndex = [Array]::IndexOf($durableRecoveryStages, $Stage)
        if ($stageIndex -lt 0) { throw "Unknown runtime recovery stage: $Stage" }
        $existing = $null
        if (Test-Path -LiteralPath $runtimeRecoveryJournalPath) {
            try {
                $existing = Get-Content -LiteralPath $runtimeRecoveryJournalPath -Raw | ConvertFrom-Json
            } catch {
                throw "Runtime recovery journal is unreadable: $($_.Exception.Message)"
            }
            if ([string]$existing.sourceSha -ne $SourceSha) { throw "Runtime recovery journal source mismatch: $($existing.sourceSha) != $SourceSha" }
            if ([string]$existing.packageIdentity -ne $PackageIdentity) { throw "Runtime recovery journal package mismatch: $($existing.packageIdentity) != $PackageIdentity" }
            if ($existing.immutablePackagePath -and ([IO.Path]::GetFullPath([string]$existing.immutablePackagePath) -ine [IO.Path]::GetFullPath($ImmutablePackagePath))) {
                throw "Runtime recovery journal immutable package path mismatch: $($existing.immutablePackagePath) != $ImmutablePackagePath"
            }
            $existingIndex = [Array]::IndexOf($durableRecoveryStages, [string]$existing.stage)
            if ($existingIndex -gt $stageIndex) { throw "Runtime recovery journal refuses stage regression: $($existing.stage) -> $Stage" }
            if ($stageIndex -gt ($existingIndex + 1)) { throw "Runtime recovery journal refuses stage skip: $($existing.stage) -> $Stage" }
        } elseif ($Stage -ne "package-ready") {
            throw "Runtime recovery journal must start at package-ready, not $Stage"
        }
        $existingProof = if ($existing -and $existing.proof) { $existing.proof } else { [pscustomobject]@{} }
        $proofObject = [ordered]@{}
        foreach ($property in @($existingProof.PSObject.Properties)) { $proofObject[$property.Name] = $property.Value }
        if ($Proof) {
            foreach ($property in @($Proof.PSObject.Properties)) { $proofObject[$property.Name] = $property.Value }
        }
        $journal = [ordered]@{
            schemaVersion = 1
            id = if ($existing -and $existing.id) { [string]$existing.id } else { "relay-recovery-$((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss'))-$PID" }
            status = $Status
            stage = $Stage
            durableStages = $durableRecoveryStages
            sourceSha = $SourceSha
            candidateShortSha = if ($SourceSha.Length -ge 7) { $SourceSha.Substring(0, 7) } else { $SourceSha }
            packageIdentity = $PackageIdentity
            immutablePackagePath = $ImmutablePackagePath
            approvalReviewKey = $SourceSha
            expected = [ordered]@{
                worktrees = [ordered]@{
                    A = (Join-Path $defaultRelayRoot "worktrees\copy-b")
                    B = (Join-Path $defaultRelayRoot "worktrees\copy-a")
                }
                endpoints = [ordered]@{
                    A = (Join-Path $defaultRelayRoot "state\executor-a\automation.json")
                    B = (Join-Path $defaultRelayRoot "state\executor-b\automation.json")
                }
            }
            previousStableA = if ($existing -and $existing.previousStableA) { $existing.previousStableA } else { $state.stableCommit }
            interruptedPhase = if ($existing -and $existing.interruptedPhase) { $existing.interruptedPhase } else { "a-upgrade-pending" }
            interruptedRole = if ($existing) { $existing.interruptedRole } else { $null }
            flags = [ordered]@{
                pausedByFlow = $false
                relayResumed = $false
                recoveryAuthorityReady = $stageIndex -ge ([Array]::IndexOf($durableRecoveryStages, "b-verified"))
                executorsStopped = $stageIndex -ge ([Array]::IndexOf($durableRecoveryStages, "a-stopped"))
                promoted = $stageIndex -ge ([Array]::IndexOf($durableRecoveryStages, "a-promoted"))
                executorsRestarted = $stageIndex -ge ([Array]::IndexOf($durableRecoveryStages, "a-started"))
            }
            steps = if ($existing -and $existing.steps) { $existing.steps } else { @() }
            proof = $proofObject
            updatedAt = (Get-Date).ToUniversalTime().ToString("o")
            completedAt = if ($Status -eq "completed") { (Get-Date).ToUniversalTime().ToString("o") } else { $null }
            error = $null
        }
        $json = $journal | ConvertTo-Json -Depth 20
        New-Item -ItemType Directory -Force -Path (Split-Path $runtimeRecoveryJournalPath -Parent) | Out-Null
        $temp = "$runtimeRecoveryJournalPath.$PID.tmp"
        [IO.File]::WriteAllText($temp, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temp -Destination $runtimeRecoveryJournalPath -Force
    }

    function Get-RuntimePackageIntegrity {
        param(
            [string]$RuntimeRoot,
            [string]$ExpectedSourceSha,
            [string]$ExpectedPackageIdentity
        )
        $integrityScript = Join-Path $Workspace "scripts\runtime-package-integrity.mjs"
        if (-not (Test-Path -LiteralPath $integrityScript)) {
            $integrityScript = Join-Path $PSScriptRoot "runtime-package-integrity.mjs"
        }
        if (-not (Test-Path -LiteralPath $integrityScript)) { throw "Runtime package integrity helper is missing: $integrityScript" }
        $output = @(& node.exe $integrityScript verify $RuntimeRoot --source-sha $ExpectedSourceSha --package-identity $ExpectedPackageIdentity 2>&1)
        $exitCode = $LASTEXITCODE
        $text = ($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
        if ($exitCode -ne 0) { throw "Runtime package verification failed for ${RuntimeRoot}: $text" }
        return $text | ConvertFrom-Json
    }

    function Update-RelayRefs {
        function Get-RelayRef([string]$RefName) {
            $oldErrorAction = $ErrorActionPreference
            try {
                $ErrorActionPreference = "Continue"
                & git -C $Workspace rev-parse --verify $RefName *> $null
                $exists = $LASTEXITCODE -eq 0
            } finally {
                $ErrorActionPreference = $oldErrorAction
            }
            if (-not $exists) { return $null }
            return (@(Invoke-Git rev-parse --verify $RefName))[0].Trim()
        }

        if ($state.stableCommit) {
            $stableRef = "refs/tandem-relay/stable"
            if ((Get-RelayRef $stableRef) -ne $state.stableCommit) {
                Invoke-Git update-ref $stableRef $state.stableCommit | Out-Null
            }
        }
        $candidateRef = "refs/tandem-relay/candidate"
        $currentCandidate = Get-RelayRef $candidateRef
        if ($state.candidateCommit) {
            if ($currentCandidate -ne $state.candidateCommit) {
                Invoke-Git update-ref $candidateRef $state.candidateCommit | Out-Null
            }
        } elseif ($currentCandidate) {
            $deleteCandidate = @("update-ref", "-d", $candidateRef)
            Invoke-Git @deleteCandidate | Out-Null
        }
        $rollbackRef = "refs/tandem-relay/rollback"
        $currentRollback = Get-RelayRef $rollbackRef
        if ($state.rollbackCommit) {
            if ($currentRollback -ne $state.rollbackCommit) {
                Invoke-Git update-ref $rollbackRef $state.rollbackCommit | Out-Null
            }
        } elseif ($currentRollback) {
            $deleteRollback = @("update-ref", "-d", $rollbackRef)
            Invoke-Git @deleteRollback | Out-Null
        }
    }

    function Save-State {
        $state.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
        $tempPath = "$statePath.tmp-$PID"
        $json = $state | ConvertTo-Json -Depth 5
        [IO.File]::WriteAllText($tempPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $tempPath -Destination $statePath -Force
        Update-RelayRefs
    }

    function Write-Result([string]$Outcome, [object]$Extra) {
        $authority = $null
        if ($state.authorityRequest) {
            $authority = [ordered]@{}
            foreach ($property in $state.authorityRequest.PSObject.Properties) {
                if ($property.Name -notin @("decisionProof", "decisionSecret", "signature")) { $authority[$property.Name] = $property.Value }
            }
        }
        $result = [ordered]@{
            outcome = $Outcome
            turn = $state.turn
            nextRole = $state.nextRole
            activeRole = $state.activeRole
            phase = $state.phase
            pausedFromPhase = $state.pausedFromPhase
            pauseOrigin = $state.pauseOrigin
            pauseReasonCode = $state.pauseReasonCode
            pauseAfterTurn = [bool]$state.pauseAfterTurn
            resumeCount = [int]$state.resumeCount
            resumeThreshold = $ResumePauseThreshold
            resumeTurn = $state.resumeTurn
            baseCommit = $state.baseCommit
            stableCommit = $state.stableCommit
            candidateCommit = $state.candidateCommit
            candidateKind = $state.candidateKind
            rollbackCommit = $state.rollbackCommit
            lastCompletedCommit = $state.lastCompletedCommit
            lastSummary = $state.lastSummary
            lastRecoveryStash = $state.lastRecoveryStash
            passiveFailure = $state.passiveFailure
            authorityRequest = $authority
            capabilities = Get-ReciprocalCapabilities
            statePath = $statePath
        }
        if ($Extra) {
            foreach ($property in $Extra.PSObject.Properties) {
                $result[$property.Name] = $property.Value
            }
        }
        $result | ConvertTo-Json -Depth 12
    }

    function Assert-Clean([string]$Message) {
        $dirty = @(Invoke-Git status --porcelain --untracked-files=all)
        if ($dirty.Count -gt 0) { throw "$Message`: $($dirty -join '; ')" }
    }

    function Test-ReciprocalCheckpoint {
        return Test-Path -LiteralPath (Join-Path $Workspace ".tandem\reciprocal-checkpoint.md")
    }

    function Test-GenuineResumeState {
        return [bool]($state.candidateCommit -or $state.rollbackCommit -or (Test-ReciprocalCheckpoint))
    }

    function Limit-Text([string]$Value, [int]$Limit = 6000) {
        if (-not $Value) { return "" }
        if ($Value.Length -le $Limit) { return $Value }
        return $Value.Substring(0, $Limit) + "`n...[truncated $($Value.Length - $Limit) chars]"
    }

    function Write-ValidationTrace([string]$Message) {
        if (-not $ValidationTracePath.Trim()) { return }
        $line = "$(Get-Date -Format o) $Message"
        [IO.File]::AppendAllText($ValidationTracePath, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    }

    function Invoke-ValidationCommandInWorkspace([string]$Command, [string]$CommandWorkspace) {
        $oldErrorAction = $ErrorActionPreference
        Push-Location -LiteralPath $CommandWorkspace
        try {
            $ErrorActionPreference = "Continue"
            $output = @(& cmd.exe /d /s /c $Command 2>&1)
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $oldErrorAction
            Pop-Location
        }
        $text = ($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
        return [pscustomobject]@{
            command = $Command
            exitCode = $exitCode
            passed = ($exitCode -eq 0)
            output = $text
        }
    }

    function Invoke-ValidationCommand([string]$Command) {
        return Invoke-ValidationCommandInWorkspace $Command $Workspace
    }

    function Get-FailingTestFilesFromOutput([string]$Output) {
        if (-not $Output) { return @() }
        $matches = [regex]::Matches($Output, 'tests[\\/][^\s:"''<>|]+?\.(?:test|spec)\.[cm]?[tj]sx?')
        $seen = @{}
        $files = @()
        foreach ($match in $matches) {
            $candidate = $match.Value.Replace('/', '\')
            if ($seen.ContainsKey($candidate.ToLowerInvariant())) { continue }
            $seen[$candidate.ToLowerInvariant()] = $true
            $files += $candidate
        }
        return $files
    }

    function Join-CmdQuotedArgs([string[]]$Values) {
        return (($Values | ForEach-Object { '"' + ($_.Replace('"', '\"')) + '"' }) -join " ")
    }

    function Get-StableBaselineCommand([object]$FailedCheck, [string[]]$FailingTestFiles) {
        $command = [string]$FailedCheck.command
        if ($FailingTestFiles.Count -eq 0) { return $command }
        $quotedFiles = Join-CmdQuotedArgs $FailingTestFiles
        if ($command -match '^\s*npm(\.cmd)?\s+test(\s|$)') {
            return "npm test -- $quotedFiles"
        }
        if ($command -match '^\s*npx(\.cmd)?\s+vitest\s+run(\s|$)') {
            return "npx vitest run $quotedFiles"
        }
        if ($command -match '(^|\s)vitest\s+run(\s|$)') {
            return "npx vitest run $quotedFiles"
        }
        return $command
    }

    function Invoke-StableBaselineControl([object[]]$FailedChecks) {
        $baselineRoot = Join-Path ([IO.Path]::GetTempPath()) ("tandem-stable-baseline-" + [guid]::NewGuid().ToString("N"))
        $failingFiles = @()
        $baselineChecks = @()
        $classification = [string]$taxonomy.pauseReasonCodes.candidateFailure
        try {
            Invoke-Git worktree add --detach $baselineRoot $state.stableCommit | Out-Null
            $sourceNodeModules = Join-Path $Workspace "node_modules"
            $baselineNodeModules = Join-Path $baselineRoot "node_modules"
            if ((Test-Path -LiteralPath $sourceNodeModules) -and -not (Test-Path -LiteralPath $baselineNodeModules)) {
                New-Item -ItemType Junction -Path $baselineNodeModules -Target $sourceNodeModules | Out-Null
            }
            foreach ($failed in $FailedChecks) {
                $files = @(Get-FailingTestFilesFromOutput ([string]$failed.output))
                foreach ($file in $files) {
                    if ($failingFiles -notcontains $file) { $failingFiles += $file }
                }
                $baselineCommand = Get-StableBaselineCommand $failed $files
                $baselineChecks += Invoke-ValidationCommandInWorkspace $baselineCommand $baselineRoot
            }
            $reproduced = @($baselineChecks | Where-Object { -not $_.passed }).Count -gt 0
            if ($reproduced) { $classification = [string]$taxonomy.pauseReasonCodes.environmentFailure }
            return [pscustomobject]@{
                classifier = "stable-baseline-control"
                classification = $classification
                reproducedOnStable = $reproduced
                candidateCommit = [string]$state.candidateCommit
                stableCommit = [string]$state.stableCommit
                failingTestFiles = @($failingFiles)
                failedCandidateCommands = @($FailedChecks | ForEach-Object {
                    [ordered]@{
                        command = [string]$_.command
                        exitCode = [int]$_.exitCode
                        output = (Limit-Text ([string]$_.output) 3000)
                    }
                })
                baselineChecks = @($baselineChecks | ForEach-Object {
                    [ordered]@{
                        command = [string]$_.command
                        exitCode = [int]$_.exitCode
                        passed = [bool]$_.passed
                        output = (Limit-Text ([string]$_.output) 3000)
                    }
                })
            }
        } finally {
            if (Test-Path -LiteralPath $baselineRoot) {
                try {
                    Invoke-Git worktree remove --force $baselineRoot | Out-Null
                } catch {
                    Remove-Item -LiteralPath $baselineRoot -Recurse -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }

    function Pause-PassiveFailure([object[]]$FailedChecks, [object[]]$CheckSummary, [string]$SummaryPrefix) {
        $baseline = Invoke-StableBaselineControl $FailedChecks
        $state.phase = "paused"
        $state.pausedFromPhase = "passive-testing"
        $state.pauseOrigin = [string]$taxonomy.pauseOrigins.machine
        $state.pauseReasonCode = [string]$baseline.classification
        $state.activeRole = $null
        $state.passiveFailure = $baseline
        $failedNames = ((@($FailedChecks | ForEach-Object { $_.command })) -join ', ')
        if ($baseline.classification -eq [string]$taxonomy.pauseReasonCodes.environmentFailure) {
            $state.lastSummary = "$SummaryPrefix for candidate $($state.candidateCommit), but the same failure reproduced on stable $($state.stableCommit): $failedNames"
        } else {
            $state.lastSummary = "$SummaryPrefix for candidate $($state.candidateCommit): $failedNames"
        }
        Save-State
        Write-Result "PASSIVE_FAILED" ([pscustomobject]@{ passiveChecks = $CheckSummary; stableBaseline = $baseline })
    }

    function Invoke-PowerShellFileCommand([string[]]$Arguments, [string]$DisplayCommand) {
        function Join-WindowsCommandLine([string[]]$Parts) {
            ($Parts | ForEach-Object {
                if ($_ -notmatch '[\s"]') {
                    $_
                } else {
                    '"' + ($_.Replace('"', '\"')) + '"'
                }
            }) -join " "
        }

        $stdoutPath = Join-Path ([IO.Path]::GetTempPath()) ("tandem-relay-command-" + [guid]::NewGuid().ToString("N") + ".out")
        $stderrPath = Join-Path ([IO.Path]::GetTempPath()) ("tandem-relay-command-" + [guid]::NewGuid().ToString("N") + ".err")
        Push-Location -LiteralPath $Workspace
        try {
            $process = Start-Process -FilePath "powershell" -ArgumentList (Join-WindowsCommandLine $Arguments) -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
            $outputParts = @()
            if (Test-Path -LiteralPath $stdoutPath) { $outputParts += (Get-Content -LiteralPath $stdoutPath -Raw) }
            if (Test-Path -LiteralPath $stderrPath) { $outputParts += (Get-Content -LiteralPath $stderrPath -Raw) }
            $text = ($outputParts | Where-Object { $_ }) -join [Environment]::NewLine
            return [pscustomobject]@{
                command = $DisplayCommand
                exitCode = [int]$process.ExitCode
                passed = ($process.ExitCode -eq 0)
                output = $text
            }
        } finally {
            Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
            Pop-Location
        }
    }

    function Start-PowerShellFileCommand([string[]]$Arguments, [string]$DisplayCommand) {
        function Join-WindowsCommandLine([string[]]$Parts) {
            ($Parts | ForEach-Object {
                if ($_ -notmatch '[\s"]') {
                    $_
                } else {
                    '"' + ($_.Replace('"', '\"')) + '"'
                }
            }) -join " "
        }

        Push-Location -LiteralPath $Workspace
        try {
            $process = Start-Process -FilePath "powershell" -ArgumentList (Join-WindowsCommandLine $Arguments) -PassThru -WindowStyle Hidden
            return [pscustomobject]@{
                command = $DisplayCommand
                exitCode = 0
                passed = $true
                output = "Started helper PID $($process.Id); readiness is verified by the executor automation token and /status attestation."
            }
        } finally {
            Pop-Location
        }
    }

    function ConvertTo-FlatStringList([object]$Value) {
        $items = @()
        if ($null -eq $Value) { return $items }
        foreach ($item in @($Value)) {
            if ($null -eq $item) { continue }
            if ($item -is [string]) {
                $items += $item
                continue
            }
            if ($item -is [System.Collections.IEnumerable] -and -not ($item -is [string])) {
                $items += @(ConvertTo-FlatStringList $item)
                continue
            }
            $items += [string]$item
        }
        return $items
    }

    function ConvertTo-FlatObjectList([object]$Value) {
        $items = @()
        if ($null -eq $Value) { return $items }
        foreach ($item in @($Value)) {
            if ($null -eq $item) { continue }
            if ($item -is [System.Array]) {
                $items += @(ConvertTo-FlatObjectList $item)
                continue
            }
            $items += ,$item
        }
        return $items
    }

    function ConvertTo-ValidationCostSummary([object]$Cost) {
        if ($null -eq $Cost) { return $null }
        $leader = $Cost.leader
        $worker = $Cost.worker
        return [ordered]@{
            leader = if ($null -eq $leader) { $null } else {
                [ordered]@{
                    role = [string]$leader.role
                    inputTokens = [int]$leader.inputTokens
                    outputTokens = [int]$leader.outputTokens
                    dollars = [double]$leader.dollars
                }
            }
            worker = if ($null -eq $worker) { $null } else {
                [ordered]@{
                    role = [string]$worker.role
                    inputTokens = [int]$worker.inputTokens
                    outputTokens = [int]$worker.outputTokens
                    dollars = [double]$worker.dollars
                }
            }
        }
    }

    function ConvertTo-ValidationReportSummary([object]$Report) {
        if ($null -eq $Report) { return $null }
        return [ordered]@{
            status = [string]$Report.status
            summary = [string]$Report.summary
            taskResults = @(ConvertTo-FlatObjectList $Report.taskResults | ForEach-Object {
                [ordered]@{
                    id = [string]$_.id
                    status = [string]$_.status
                    notes = [string]$_.notes
                }
            })
            filesChanged = @(ConvertTo-FlatStringList $Report.filesChanged)
            verificationResults = @(ConvertTo-FlatObjectList $Report.verificationResults | ForEach-Object {
                [ordered]@{
                    command = [string]$_.command
                    exitCode = [int]$_.exitCode
                    passed = [bool]$_.passed
                    output = [string]$_.output
                }
            })
            deviationsFromPlan = @(ConvertTo-FlatStringList $Report.deviationsFromPlan)
        }
    }

    function ConvertTo-ValidationPlanSummary([object]$Plan) {
        if ($null -eq $Plan) { return $null }
        return [ordered]@{
            title = [string]$Plan.title
            objective = [string]$Plan.objective
            constraints = @(ConvertTo-FlatStringList $Plan.constraints)
            tasks = @(ConvertTo-FlatObjectList $Plan.tasks | ForEach-Object {
                [ordered]@{
                    id = [string]$_.id
                    description = [string]$_.description
                    files = @(ConvertTo-FlatStringList $_.files)
                }
            })
            acceptanceCriteria = @(ConvertTo-FlatStringList $Plan.acceptanceCriteria)
            verification = @(ConvertTo-FlatStringList $Plan.verification)
        }
    }

    function ConvertTo-ValidationReviewSummary([object]$Review) {
        if ($null -eq $Review) { return $null }
        $verdict = $Review.verdict
        $scores = $verdict.scores
        return [ordered]@{
            source = [string]$Review.source
            totalDollars = [double]$Review.totalDollars
            cost = ConvertTo-ValidationCostSummary $Review.cost
            verdict = [ordered]@{
                verdict = [string]$verdict.verdict
                scores = if ($null -eq $scores) { $null } else {
                    [ordered]@{
                        correctness = [int]$scores.correctness
                        planAdherence = [int]$scores.planAdherence
                        codeQuality = [int]$scores.codeQuality
                    }
                }
                feedback = @(ConvertTo-FlatStringList $verdict.feedback)
                userSummary = [string]$verdict.userSummary
            }
        }
    }

    function Save-ValidationArtifact([object]$Artifact) {
        $validationDir = Join-Path $relayDir "validations"
        New-Item -ItemType Directory -Path $validationDir -Force | Out-Null
        $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
        $path = Join-Path $validationDir "$stamp-role-$Role-turn-$($state.turn).json"
        $plainArtifact = [ordered]@{
            candidateCommit = [string]$Artifact["candidateCommit"]
            stableCommit = [string]$Artifact["stableCommit"]
            candidateKind = [string]$Artifact["candidateKind"]
            role = [string]$Artifact["role"]
            dryRun = [bool]$Artifact["dryRun"]
            commandStartedAt = [string]$Artifact["commandStartedAt"]
            changedFiles = @(ConvertTo-FlatStringList $Artifact["changedFiles"])
            diffStat = [string]$Artifact["diffStat"]
            planText = [string]$Artifact["planText"]
            mechanicalChecks = @(ConvertTo-FlatObjectList $Artifact["mechanicalChecks"] | ForEach-Object {
                [ordered]@{
                    command = [string]$_.command
                    exitCode = [int]$_.exitCode
                    passed = [bool]$_.passed
                    output = [string]$_.output
                }
            })
            report = ConvertTo-ValidationReportSummary $Artifact["report"]
            plan = ConvertTo-ValidationPlanSummary $Artifact["plan"]
            review = ConvertTo-ValidationReviewSummary $Artifact["review"]
            reviewError = [string]$Artifact["reviewError"]
            outcome = [string]$Artifact["outcome"]
        }
        $json = $plainArtifact | ConvertTo-Json -Depth 12
        [IO.File]::WriteAllText($path, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        return $path
    }

    function Invoke-LeaderOnlyReview([object]$Payload) {
        if ($ReviewVerdictJson.Trim()) {
            return [pscustomobject]@{
                verdict = ($ReviewVerdictJson | ConvertFrom-Json)
                cost = $null
                totalDollars = 0
                source = "inline-json"
            }
        }

        $payloadPath = Join-Path $relayDir "validation-review-$PID.json"
        Write-ValidationTrace "review-payload-write-start"
        $payloadJson = $payload | ConvertTo-Json -Depth 12
        [IO.File]::WriteAllText($payloadPath, $payloadJson + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Write-ValidationTrace "review-payload-write-done"
        $scriptRoot = Split-Path -Parent $PSCommandPath
        $sourceRoot = Split-Path -Parent $scriptRoot
        $reviewScript = Join-Path $scriptRoot "reciprocal-validate-review.ts"
        if (-not (Test-Path -LiteralPath $reviewScript)) {
            throw "Missing reciprocal validation review helper: $reviewScript"
        }

        $oldTandemHome = $env:TANDEM_HOME
        try {
            if ($TandemHome.Trim()) { $env:TANDEM_HOME = $TandemHome }
            $oldErrorAction = $ErrorActionPreference
            try {
                $ErrorActionPreference = "Continue"
                $output = @(& npm --prefix $sourceRoot exec -- tsx $reviewScript --input $payloadPath 2>&1)
                $exitCode = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $oldErrorAction
            }
            $stdout = ($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
            $stderr = ""
        } finally {
            if ($null -eq $oldTandemHome) { Remove-Item Env:\TANDEM_HOME -ErrorAction SilentlyContinue } else { $env:TANDEM_HOME = $oldTandemHome }
            Remove-Item -LiteralPath $payloadPath -Force -ErrorAction SilentlyContinue
        }
        if ($exitCode -ne 0) { throw "Leader-only validation review failed: $stdout$([Environment]::NewLine)$stderr" }
        try {
            $jsonLine = @($stdout -split "\r?\n" | Where-Object { $_.Trim() })[-1]
            return ($jsonLine | ConvertFrom-Json)
        } catch {
            throw "Leader-only validation review returned non-JSON output: $stdout$([Environment]::NewLine)$stderr"
        }
    }

    function Get-SharedDirectionPath {
        $localPath = Join-Path $Workspace ".tandem\shared-control\WISHLIST.md"
        if (Test-Path -LiteralPath (Split-Path $localPath -Parent)) {
            return $localPath
        }
        if ($env:TANDEM_RECIPROCAL_ROOT) {
            return (Join-Path $env:TANDEM_RECIPROCAL_ROOT "control\WISHLIST.md")
        }
        $commonRaw = (@(Invoke-Git rev-parse --git-common-dir))[0].Trim()
        $commonDir = if ([IO.Path]::IsPathRooted($commonRaw)) { $commonRaw } else { [IO.Path]::GetFullPath((Join-Path $Workspace $commonRaw)) }
        $adminRepo = Split-Path $commonDir -Parent
        $relayRoot = Join-Path (Split-Path $adminRepo -Parent) "Tandem Reciprocal"
        return (Join-Path $relayRoot "control\WISHLIST.md")
    }

    function New-CleanAuthorityValue([string]$Value, [string]$Name) {
        $clean = if ($null -eq $Value) { "" } else { $Value.Trim() }
        if ($clean -notmatch '^[A-Za-z0-9._:-]{2,128}$') { throw "Authority $Name must be exact machine-readable metadata." }
        return $clean
    }

    function Get-Sha256Hex([string]$Value) {
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            return [BitConverter]::ToString($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Value))).Replace("-", "").ToLowerInvariant()
        } finally {
            $sha.Dispose()
        }
    }

    function Get-AuthorityBinding([object]$Request, [string]$Decision, [string]$ExpiresAtUtc) {
        return @(
            $Decision,
            [string]$Request.requestId,
            [string]$Request.id,
            [string]$Request.owner,
            [string]$Request.authority,
            [string]$Request.action,
            [string]$Request.checkpoint,
            [string]$Request.resume,
            $ExpiresAtUtc
        ) -join "`n"
    }

    function Get-HmacHex([string]$Secret, [string]$Value) {
        $hmac = [Security.Cryptography.HMACSHA256]::new([Text.UTF8Encoding]::new($false).GetBytes($Secret))
        try {
            return [BitConverter]::ToString($hmac.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Value))).Replace("-", "").ToLowerInvariant()
        } finally {
            $hmac.Dispose()
        }
    }

    function Assert-FixedEqual([string]$Expected, [string]$Actual, [string]$Message) {
        $left = [Text.UTF8Encoding]::new($false).GetBytes($Expected.ToLowerInvariant())
        $right = [Text.UTF8Encoding]::new($false).GetBytes($Actual.ToLowerInvariant())
        $diff = $left.Length -bxor $right.Length
        $max = [Math]::Max($left.Length, $right.Length)
        for ($i = 0; $i -lt $max; $i++) {
            $a = if ($i -lt $left.Length) { $left[$i] } else { 0 }
            $b = if ($i -lt $right.Length) { $right[$i] } else { 0 }
            $diff = $diff -bor ($a -bxor $b)
        }
        if ($diff -ne 0) {
            throw $Message
        }
    }

    function Assert-DashboardAuthorityDecision([object]$Request, [string]$Decision) {
        $secret = [string]$env:TANDEM_AUTHORITY_DECISION_SECRET
        $packetJson = [string]$env:TANDEM_AUTHORITY_DECISION_PACKET
        if (-not $secret -or -not $packetJson) { throw "$Decision authority requires an authenticated dashboard decision packet." }
        try {
            $packet = $packetJson | ConvertFrom-Json
        } catch {
            throw "$Decision authority decision packet is invalid JSON."
        }
        if ([string]$packet.decision -ne $Decision) { throw "$Decision authority decision mismatch." }
        foreach ($name in @("requestId", "id", "owner", "authority", "action", "checkpoint", "resume")) {
            if ([string]$packet.$name -ne [string]$Request.$name) { throw "$Decision authority decision $name mismatch." }
        }
        $expires = [datetime]::Parse([string]$packet.expiresAtUtc).ToUniversalTime()
        if ($expires -lt (Get-Date).ToUniversalTime()) { throw "$Decision authority decision packet expired." }
        $binding = Get-AuthorityBinding $Request $Decision ([string]$packet.expiresAtUtc)
        Assert-FixedEqual (Get-HmacHex $secret $binding) ([string]$packet.signature) "$Decision authority decision signature mismatch."
        return $packet
    }

    function New-AuthorityProofFile([object]$Request, [string]$Decision, [object]$Packet) {
        $proofPath = Join-Path $relayDir "authority-proof-$($Request.requestId)-$Decision.json"
        $payload = [ordered]@{
            requestId = $Request.requestId
            decision = $Decision
            id = $Request.id
            owner = $Request.owner
            authority = $Request.authority
            action = $Request.action
            checkpoint = $Request.checkpoint
            resume = $Request.resume
            expiresAtUtc = [string]$Packet.expiresAtUtc
            signature = [string]$Packet.signature
        }
        $payload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $proofPath -Encoding UTF8
        return $proofPath
    }

    function Invoke-DirectionAuthorityDecision([object]$Request, [string]$Decision, [object]$Packet, [string]$NoteText = "") {
        $directionScript = Join-Path $Workspace "scripts\reciprocal-direction.ps1"
        $boardPath = Get-SharedDirectionPath
        $proofPath = New-AuthorityProofFile $Request $Decision $Packet
        try {
            $directionAction = if ($Decision -eq "approve") { "ApproveAuthority" } else { "DenyAuthority" }
            $directionArgs = @(
                "-Action", $directionAction,
                "-Id", $Request.id,
                "-AuthKind", $Request.authority,
                "-AuthorityProofPath", $proofPath,
                "-ControlPath", $boardPath
            )
            if ($Decision -eq "deny") { $directionArgs += @("-Note", $NoteText) }
            $powershellArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $directionScript) + $directionArgs
            $output = @(& powershell @powershellArgs 2>&1)
            if ($LASTEXITCODE -ne 0 -or -not $?) { throw "Direction authority $Decision failed: $($output -join ' ')" }
            return ($output -join [Environment]::NewLine)
        } finally {
            Remove-Item -LiteralPath $proofPath -Force -ErrorAction SilentlyContinue
        }
    }

    function Get-Metadata([string]$Value) {
        $metadata = @{}
        foreach ($match in [regex]::Matches($Value, '(?:^|\s)([A-Za-z][A-Za-z0-9]*)=([^\s]+)')) {
            $metadata[$match.Groups[1].Value] = $match.Groups[2].Value
        }
        return $metadata
    }

    function Read-Utf8Lines([string]$Path) {
        return @([IO.File]::ReadAllLines($Path, [Text.UTF8Encoding]::new($false)))
    }

    function Assert-WishlistToolingCompatible {
        $directionScript = Join-Path $Workspace "scripts\reciprocal-direction.ps1"
        if (-not (Test-Path -LiteralPath $directionScript)) {
            throw "Cannot claim: reciprocal-direction.ps1 is missing from this executor worktree."
        }
        $scriptText = [IO.File]::ReadAllText($directionScript, [Text.UTF8Encoding]::new($false))
        if ($scriptText -notmatch "Get-WishlistPath" -or $scriptText -notmatch "WISHLIST\.md") {
            throw "Cannot claim: executor worktree has stale pre-D167 wishlist tooling. Reconcile reciprocal infrastructure before starting work."
        }

        $showOutput = @(& $directionScript -Action Show 2>&1)
        if (-not $?) {
            throw "Cannot claim: D167 wishlist tooling check failed: $($showOutput -join ' ')"
        }
        $shownBoard = $showOutput -join [Environment]::NewLine
        if ($shownBoard -notmatch "<!-- wishlist-items -->") {
            throw "Cannot claim: executor direction script did not return the WISHLIST.md work-state board."
        }
    }

    function New-AutonomousContinuation([string]$Id, [string]$NextStep) {
        $nextStep = $NextStep.Trim()
        if ($nextStep -notmatch "^\d+/\d+$") { return $null }
        return [pscustomobject]@{
            available = $true
            reason = "autonomous-epic-next-step"
            wishlistId = $Id
            nextStep = $nextStep
            claimCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Claim -Role $Role"
            startCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-direction.ps1 -Action Start -Id $Id -Role $Role"
        }
    }

    function Complete-AcceptedDirectionCandidate([string]$AcceptedCommit, [string]$AcceptedKind) {
        if ($AcceptedKind -ne "improvement") { return $null }
        # Relay and direction are one control-plane protocol. When an admin relay
        # intentionally operates on a worktree, do not mix it with that worktree's
        # potentially older direction implementation during the acceptance commit.
        $directionScript = Join-Path $PSScriptRoot "reciprocal-direction.ps1"
        if (-not (Test-Path -LiteralPath $directionScript)) {
            $directionScript = Join-Path $Workspace "scripts\reciprocal-direction.ps1"
        }
        if (-not (Test-Path -LiteralPath $directionScript)) { return $null }
        $boardPath = Get-SharedDirectionPath
        if (-not (Test-Path -LiteralPath $boardPath)) { return $null }

        $candidateLine = @(
            Read-Utf8Lines $boardPath |
                Where-Object {
                    if ($_ -notmatch "^- \[ \] (W\d+) \| .+ \| CANDIDATE\b") { return $false }
                    $candidateMetadata = Get-Metadata $_
                    if (-not $candidateMetadata.commit) { return $false }
                    $candidateSha = ([string]$candidateMetadata.commit).ToLowerInvariant()
                    $acceptedSha = $AcceptedCommit.ToLowerInvariant()
                    return $candidateSha -eq $acceptedSha -or $candidateSha.StartsWith($acceptedSha) -or $acceptedSha.StartsWith($candidateSha)
                }
        )
        if ($candidateLine.Count -eq 0) { return $null }
        if ($candidateLine.Count -gt 1) { throw "Accepted commit $AcceptedCommit matches multiple shared-direction candidates." }

        $line = $candidateLine[0]
        $id = ([regex]::Match($line, "^- \[ \] (W\d+) \|")).Groups[1].Value
        $metadata = Get-Metadata $line
        if ($metadata.epic -eq "true") {
            if ($metadata.candidate -eq "PLAN") {
                if ($metadata.autonomy -eq "full") {
                    $completed = if ($metadata.completed) { [int]$metadata.completed } else { 0 }
                    $total = [int]$metadata.steps
                    & $directionScript -Action AutoApprovePlan -Id $id -Commit $AcceptedCommit -ControlPath $boardPath | Out-Null
                    return New-AutonomousContinuation $id "$($completed + 1)/$total"
                }
                return $null
            }
            if ($metadata.candidate -eq "STEP") {
                if ($metadata.step -notmatch "^(\d+)/(\d+)$") { throw "Epic candidate $id has malformed step metadata." }
                $step = [int]$Matches[1]
                $total = [int]$Matches[2]
                if ($step -lt $total) {
                    & $directionScript -Action AcceptStep -Id $id -Commit $AcceptedCommit -ControlPath $boardPath | Out-Null
                    return New-AutonomousContinuation $id "$($step + 1)/$total"
                } else {
                    & $directionScript -Action Complete -Id $id -Commit $AcceptedCommit -ControlPath $boardPath | Out-Null
                }
                return $null
            }
            return $null
        }

        & $directionScript -Action Complete -Id $id -Commit $AcceptedCommit -ControlPath $boardPath | Out-Null
        return $null
    }

    function Approve-Candidate([string]$AcceptSummary, [object]$Extra) {
        if ($state.phase -ne "validating") { throw "Accept is valid only after a VALIDATE claim." }
        Assert-Clean "Accept requires a clean worktree"
        $head = (@(Invoke-Git rev-parse HEAD))[0].Trim()
        if ($head -ne $state.candidateCommit) { throw "Validated HEAD does not match the candidate commit." }
        $acceptedKind = $state.candidateKind
        $previousStableCommit = $state.stableCommit
        $state.stableCommit = $head
        Update-RelayRefs
        $continuation = $null
        try {
            $continuation = Complete-AcceptedDirectionCandidate $head $acceptedKind
        } catch {
            $state.stableCommit = $previousStableCommit
            Update-RelayRefs
            throw
        }
        $state.stableCommit = $head
        $state.candidateCommit = $null
        $state.candidateKind = $null
        $state.rollbackCommit = $null
        $state.phase = "working"
        $state.baseCommit = $head
        Reset-ResumeCounter
        $state.lastSummary = if ($AcceptSummary.Trim()) { $AcceptSummary.Trim() } else { "Candidate baseline accepted after verification." }
        Save-State
        $resultExtra = if ($Extra) { $Extra } else { [pscustomobject]@{} }
        if ($continuation) {
            $continuation | Add-Member -NotePropertyName role -NotePropertyValue $Role -Force
            $continuation | Add-Member -NotePropertyName requiresHumanGate -NotePropertyValue $false -Force
            $continuation | Add-Member -NotePropertyName maxExtraLifecycleActions -NotePropertyValue 1 -Force
            $resultExtra | Add-Member -NotePropertyName autonomousContinuation -NotePropertyValue $continuation -Force
        } else {
            $resultExtra | Add-Member -NotePropertyName autonomousContinuation -NotePropertyValue $null -Force
        }
        Write-Result "ACCEPTED" $resultExtra
    }

    function Reject-Candidate([string]$FailureSummary, [object]$Extra) {
        if ($state.phase -ne "validating") { throw "Rollback is valid only after a VALIDATE claim." }
        if ($state.candidateKind -ne "improvement") { throw "Only an unaccepted improvement candidate can be rolled back automatically." }
        if (-not $FailureSummary.Trim()) { throw "Rollback requires a failure summary." }
        Assert-Clean "Rollback requires a clean worktree"
        $head = (@(Invoke-Git rev-parse HEAD))[0].Trim()
        if ($head -ne $state.candidateCommit) { throw "Rollback candidate is not HEAD." }
        $parent = (@(Invoke-Git rev-parse "$head^"))[0].Trim()
        if ($parent -ne $state.stableCommit) { throw "Candidate is not a direct child of the stable commit; automatic rollback stopped." }
        try {
            Invoke-Git revert --no-edit $head | Out-Null
        } catch {
            & git -C $Workspace revert --abort *> $null
            throw
        }
        $state.rollbackCommit = (@(Invoke-Git rev-parse HEAD))[0].Trim()
        $state.phase = "rollback-verification"
        Reset-ResumeCounter
        $state.lastSummary = $FailureSummary.Trim()
        Save-State
        Write-Result "ROLLBACK_CREATED" $Extra
    }

    function Invoke-CandidateValidation([bool]$DryRunMode) {
        if (-not $state.candidateCommit) { throw "Validate requires a pending candidate commit." }
        Assert-Clean "Validate requires a clean worktree"
        $head = (@(Invoke-Git rev-parse HEAD))[0].Trim()
        if ($head -ne $state.candidateCommit) { throw "Validate requires HEAD to match candidate commit $($state.candidateCommit), but HEAD is $head." }
        if (-not $state.stableCommit) { throw "Validate requires a stable commit." }
        Write-ValidationTrace "start head=$head candidate=$($state.candidateCommit)"

        $checks = if ($ValidationChecks -and $ValidationChecks.Count -gt 0) {
            $ValidationChecks
        } else {
            @(
                "npm run typecheck",
                "npm test",
                "git diff --check refs/tandem-relay/stable refs/tandem-relay/candidate --"
            )
        }
        $mechanical = @()
        foreach ($check in $checks) {
            Write-ValidationTrace "check-start $check"
            $mechanical += Invoke-ValidationCommand $check
            Write-ValidationTrace "check-done $check"
        }
        $failed = @($mechanical | Where-Object { -not $_.passed })
        $changedFiles = @(Invoke-Git diff --name-only $state.stableCommit $state.candidateCommit --)
        $simpleChangedFiles = @($changedFiles | ForEach-Object { [string]$_ })
        $simpleChecks = @($checks | ForEach-Object { [string]$_ })
        $diff = (@(Invoke-Git diff --no-ext-diff $state.stableCommit $state.candidateCommit --) -join [Environment]::NewLine)
        $diffStat = (@(Invoke-Git diff --stat $state.stableCommit $state.candidateCommit --) -join [Environment]::NewLine)
        $commitSubject = (@(Invoke-Git log -1 --format=%s $state.candidateCommit))[0].Trim()

        $planFile = @($changedFiles | Where-Object { $_ -match '^process[\\/]reciprocal[\\/]epics[\\/].+-plan\.md$' } | Select-Object -First 1)
        $planText = ""
        if ($planFile.Count -gt 0) {
            $planPath = Join-Path $Workspace $planFile[0]
            if (Test-Path -LiteralPath $planPath) { $planText = Get-Content -LiteralPath $planPath -Raw }
        }

        $verificationResults = @($mechanical | ForEach-Object {
            [ordered]@{
                command = $_.command
                exitCode = [int]$_.exitCode
                passed = [bool]$_.passed
                output = (Limit-Text $_.output 6000)
            }
        })
        $deviationsFromPlan = if ($failed.Count -eq 0) { [string[]]@("None.") } else { [string[]]@("Mechanical validation failed before leader-only review.") }
        $report = [ordered]@{
            status = if ($failed.Count -eq 0) { "complete" } else { "blocked" }
            summary = if ($failed.Count -eq 0) { "Mechanical validation checks passed for reciprocal candidate $($state.candidateCommit)." } else { "Mechanical validation checks failed for reciprocal candidate $($state.candidateCommit)." }
            taskResults = ,@(
                [ordered]@{
                    id = "mechanical-checks"
                    status = if ($failed.Count -eq 0) { "done" } else { "partial" }
                    notes = if ($failed.Count -eq 0) { "All mechanical validation commands passed." } else { "Failed: $((@($failed | ForEach-Object { $_.command })) -join ', ')" }
                },
                [ordered]@{
                    id = "candidate-diff-review"
                    status = "done"
                    notes = "Candidate diff and changed files captured for leader-only review."
                }
            )
            filesChanged = ,$simpleChangedFiles
            verificationResults = ,$verificationResults
            deviationsFromPlan = ,$deviationsFromPlan
        }
        $plan = [ordered]@{
            title = "Reciprocal validation for candidate $($state.candidateCommit.Substring(0, 7))"
            objective = "Validate the reciprocal candidate before advancing the stable relay baseline. Candidate subject: $commitSubject"
            constraints = ,@(
                "Producer turn output is unchanged; validate only the committed candidate.",
                "Run mechanical checks directly in the validating worktree.",
                "Use one leader-only review of the plan/report/diff after mechanical checks pass.",
                "Accept approved candidates through the relay; reject failed candidates through rollback."
            )
            tasks = ,@(
                [ordered]@{
                    id = "mechanical-checks"
                    description = "Run npm run typecheck, npm test, and candidate diff whitespace checks in the validating worktree."
                    files = ,[string[]]@()
                },
                [ordered]@{
                    id = "candidate-diff-review"
                    description = "Review the candidate's epic plan or implementation diff and decide whether it should advance."
                    files = ,$simpleChangedFiles
                }
            )
            acceptanceCriteria = ,@(
                "All mechanical checks pass.",
                "The diff matches the shared reciprocal direction and keeps the relay safety boundaries.",
                "The leader-only ReviewVerdict is approve before relay Accept."
            )
            verification = ,$simpleChecks
        }

        $artifact = [ordered]@{
            candidateCommit = $state.candidateCommit
            stableCommit = $state.stableCommit
            candidateKind = $state.candidateKind
            role = $Role
            dryRun = $DryRunMode
            commandStartedAt = (Get-Date).ToUniversalTime().ToString("o")
            changedFiles = $simpleChangedFiles
            diffStat = $diffStat
            planText = $planText
            mechanicalChecks = $verificationResults
            report = $report
            plan = $plan
            review = $null
            outcome = $null
        }

        if ($failed.Count -gt 0) {
            Write-ValidationTrace "mechanical-failed"
            $artifact["outcome"] = "mechanical-failed"
            $artifactPath = Save-ValidationArtifact $artifact
            $summaryText = "Mechanical validation failed for candidate $($state.candidateCommit): $((@($failed | ForEach-Object { $_.command })) -join ', ')"
            $extra = [pscustomobject]@{ validationArtifactPath = $artifactPath; validationOutcome = $artifact["outcome"] }
            if ($DryRunMode) {
                Write-Result "VALIDATION_FAILED_DRY_RUN" $extra
                exit 0
            }
            Reject-Candidate $summaryText $extra
            exit 0
        }

        Write-ValidationTrace "review-start"
        $payload = [ordered]@{
            cwd = $Workspace
            round = [int]$state.turn
            tandemHome = $TandemHome
            plan = $plan
            report = $report
            diff = $diff
        }
        try {
            $review = Invoke-LeaderOnlyReview $payload
            Write-ValidationTrace "review-done"
        } catch {
            Write-ValidationTrace "review-error $($_.Exception.Message)"
            $artifact["reviewError"] = $_.Exception.Message
            $artifact["outcome"] = "review-failed"
            $artifactPath = Save-ValidationArtifact $artifact
            $extra = [pscustomobject]@{
                validationArtifactPath = $artifactPath
                validationOutcome = $artifact["outcome"]
                reviewVerdict = $null
                validationCost = $null
                validationTotalDollars = $null
            }
            if ($DryRunMode) {
                Write-Result "VALIDATION_REVIEW_FAILED_DRY_RUN" $extra
                exit 0
            }
            Reject-Candidate "leader-only validation failed: $($_.Exception.Message)" $extra
            exit 0
        }
        $artifact["review"] = $review
        $verdict = [string]$review.verdict.verdict
        $artifact["outcome"] = "review-$verdict"
        Write-ValidationTrace "artifact-save-start"
        $artifactPath = Save-ValidationArtifact $artifact
        Write-ValidationTrace "artifact-save-done $artifactPath"
        $extra = [pscustomobject]@{
            validationArtifactPath = $artifactPath
            validationOutcome = $artifact["outcome"]
            reviewVerdict = $verdict
            validationCost = $review.cost
            validationTotalDollars = $review.totalDollars
        }

        if ($DryRunMode) {
            Write-Result "VALIDATION_$($verdict.ToUpperInvariant())_DRY_RUN" $extra
            exit 0
        }
        if ($verdict -eq "approve") {
            Approve-Candidate "candidate baseline verified by mechanical checks and leader-only review" $extra
            exit 0
        }
        Reject-Candidate "leader-only validation requested revision: $($review.verdict.userSummary)" $extra
        exit 0
    }

    function Set-IdleOrPauseAfterTurn {
        if ($state.pauseAfterTurn) {
            $state.phase = "paused"
            $state.pausedFromPhase = "idle"
            $state.pauseOrigin = [string]$taxonomy.pauseOrigins.human
            $state.pauseReasonCode = [string]$taxonomy.pauseReasonCodes.explicitHumanPause
            $state.pauseAfterTurn = $false
        } else {
            $state.phase = "idle"
            $state.pausedFromPhase = $null
            $state.pauseOrigin = $null
            $state.pauseReasonCode = $null
        }
    }

    function Reset-ResumeCounter {
        $state.resumeCount = 0
        $state.resumeTurn = $null
    }

    function Increment-ResumeCounter {
        if ($state.resumeTurn -ne $state.turn) {
            $state.resumeTurn = $state.turn
            $state.resumeCount = 0
        }
        $state.resumeCount = [int]$state.resumeCount + 1
        return [int]$state.resumeCount
    }

    function Pause-ResumeLoop([string]$SelectedRole) {
        $previousPhase = $state.phase
        $state.phase = "paused"
        $state.pausedFromPhase = $previousPhase
        $state.pauseOrigin = [string]$taxonomy.pauseOrigins.machine
        $state.pauseReasonCode = [string]$taxonomy.pauseReasonCodes.resumeCircuitBreaker
        $state.pauseAfterTurn = $false
        $state.lastSummary = "Auto-paused turn $($state.turn): executor $SelectedRole received $($state.resumeCount) consecutive RESUME claims without completing. Human attention is required before resuming."
        Save-State
        Write-Result "PAUSED"
        exit 0
    }

    if ($Action -eq "Reset") {
        if (-not $Force) { throw "Reset requires -Force and is reserved for human recovery." }
        $state = [pscustomobject](New-RelayState $currentHead)
        Save-State
        Remove-Item -LiteralPath (Join-Path $Workspace ".tandem\reciprocal-checkpoint.md") -Force -ErrorAction SilentlyContinue
        Write-Result "RESET"
        exit 0
    }

    if ($Action -eq "Status") {
        Save-State
        Write-Result "STATUS"
        exit 0
    }

    function Get-PendingAppFinalization([string]$SelectedRole) {
        $relayRoot = if ($env:TANDEM_RECIPROCAL_ROOT) { $env:TANDEM_RECIPROCAL_ROOT } else { $defaultRelayRoot }
        $path = Join-Path $relayRoot "state\finalization-$($SelectedRole.ToLowerInvariant()).json"
        if (-not (Test-Path -LiteralPath $path)) { return $null }
        try {
            $pending = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        } catch {
            throw "Pending app-layer finalization is unreadable at $path."
        }
        if ($pending.schemaVersion -ne 1 -or $pending.role -ne $SelectedRole -or -not $pending.wishlistId) {
            throw "Pending app-layer finalization is invalid at $path."
        }
        return [pscustomobject]@{
            path = $path
            wishlistId = [string]$pending.wishlistId
            stage = [string]$pending.stage
            commit = if ($pending.commit) { [string]$pending.commit } else { $null }
            files = @($pending.files | ForEach-Object { ([string]$_).Replace('\', '/').Trim() } | Where-Object { $_ })
        }
    }

    function Assert-PendingAppFinalizationRange([string]$SelectedRole, [string]$BaseCommit, [string]$HeadCommit, [int]$CommitCount) {
        $pending = Get-PendingAppFinalization $SelectedRole
        if (-not $pending -or $pending.commit -ne $HeadCommit -or $pending.stage -notin @("committed", "board-recorded")) {
            throw "Complete requires exactly one new verified commit; found $CommitCount."
        }
        $merges = @(Invoke-Git rev-list --merges "$BaseCommit..$HeadCommit")
        $subjects = @(Invoke-Git log --format=%s "$BaseCommit..$HeadCommit")
        $changed = @(Invoke-Git diff --name-only $BaseCommit $HeadCommit -- | ForEach-Object { ([string]$_).Replace('\', '/').Trim() } | Where-Object { $_ })
        $touched = @(Invoke-Git log --format= --name-only "$BaseCommit..$HeadCommit" -- | ForEach-Object { ([string]$_).Replace('\', '/').Trim() } | Where-Object { $_ })
        $reported = @($pending.files | Sort-Object -Unique)
        $net = @($changed | Sort-Object -Unique)
        $unexpected = @($touched | Where-Object { $_ -notin $reported } | Sort-Object -Unique)
        $missing = @($reported | Where-Object { $_ -notin $net })
        $extra = @($net | Where-Object { $_ -notin $reported })
        if ($merges.Count -gt 0 -or $subjects.Count -ne $CommitCount -or @($subjects | Where-Object { -not ([string]$_).StartsWith("relay:") }).Count -gt 0 -or $unexpected.Count -gt 0 -or $missing.Count -gt 0 -or $extra.Count -gt 0) {
            throw "Complete refuses the pending multi-commit finalization because its history is not linear app-layer work limited exactly to the reported files."
        }
    }

    if ($Action -eq "DeclareAuthority") {
        if (-not $Role) { throw "DeclareAuthority requires -Role." }
        if (-not $Id -or $Id -notmatch '^W\d{4}$') { throw "DeclareAuthority requires a wishlist item -Id." }
        if (-not $AuthKind) { throw "DeclareAuthority requires -AuthKind." }
        if ($state.authorityRequest -and $state.authorityRequest.status -eq "pending") { throw "Relay already has a pending authority request for $($state.authorityRequest.id)." }
        if ($state.activeRole -ne $Role -or $state.phase -ne "working") { throw "DeclareAuthority requires the active working owner. phase=$($state.phase) owner=$($state.activeRole)" }
        $verb = New-CleanAuthorityValue $AuthVerb "action"
        $checkpointValue = New-CleanAuthorityValue $Checkpoint "checkpoint"
        $resumeValue = New-CleanAuthorityValue $ResumeToken "resume"
        $directionScript = Join-Path $Workspace "scripts\reciprocal-direction.ps1"
        $boardPath = Get-SharedDirectionPath
        $declareText = "$AuthKind`__$verb`__$checkpointValue`__$resumeValue"
        $output = @(& $directionScript -Action DeclareAuthority -Id $Id -Text $declareText -ControlPath $boardPath 2>&1)
        if ($LASTEXITCODE -ne 0 -or -not $?) { throw "Direction authority declaration failed: $($output -join ' ')" }
        $requestId = [guid]::NewGuid().ToString("n")
        $requestDigest = Get-Sha256Hex (@($requestId, $Id, $Role, $AuthKind, $verb, $checkpointValue, $resumeValue) -join "`n")
        $state.authorityRequest = [pscustomobject]@{
            requestId = $requestId
            requestDigest = $requestDigest
            id = $Id
            owner = $Role
            authority = $AuthKind
            action = $verb
            checkpoint = $checkpointValue
            resume = $resumeValue
            status = "pending"
            declaredAtUtc = (Get-Date).ToUniversalTime().ToString("o")
            approvedAtUtc = $null
            deniedAtUtc = $null
            consumedAtUtc = $null
        }
        $state.phase = "paused"
        $state.pausedFromPhase = "working"
        $state.pauseOrigin = [string]$taxonomy.pauseOrigins.human
        $state.pauseReasonCode = [string]$taxonomy.pauseReasonCodes.explicitHumanPause
        $state.lastSummary = "Authority checkpoint $checkpointValue for $Id requires explicit human decision before $resumeValue."
        Save-State
        Write-Result "AUTHORITY_DECLARED"
        exit 0
    }

    if ($Action -eq "ApproveAuthority") {
        $request = $state.authorityRequest
        if (-not $request) { throw "No relay authority request is pending." }
        if ($request.status -in @("approved", "consumed")) {
            Write-Result "AUTHORITY_APPROVED_NOOP"
            exit 0
        }
        if ($request.status -ne "pending") { throw "Authority request is not pending; status=$($request.status)." }
        $packet = Assert-DashboardAuthorityDecision $request "approve"
        Invoke-DirectionAuthorityDecision $request "approve" $packet | Out-Null
        $request.status = "approved"
        $request.approvedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        if ($state.phase -eq "paused" -and $state.pausedFromPhase -eq "working" -and $state.activeRole -eq $request.owner) {
            $state.phase = "working"
            $state.pausedFromPhase = $null
            $state.pauseOrigin = $null
            $state.pauseReasonCode = $null
            Reset-ResumeCounter
        }
        $state.lastSummary = "Authority checkpoint $($request.checkpoint) for $($request.id) approved; resume $($request.resume) for owner $($request.owner)."
        Save-State
        Write-Result "AUTHORITY_APPROVED"
        exit 0
    }

    if ($Action -eq "DenyAuthority") {
        $request = $state.authorityRequest
        if (-not $request) { throw "No relay authority request is pending." }
        if ($request.status -eq "denied") {
            Write-Result "AUTHORITY_DENIED_NOOP"
            exit 0
        }
        if ($request.status -ne "pending") { throw "Authority request is not pending; status=$($request.status)." }
        $packet = Assert-DashboardAuthorityDecision $request "deny"
        $noteText = if ($Summary.Trim()) { $Summary.Trim() } else { "authority denied" }
        Invoke-DirectionAuthorityDecision $request "deny" $packet $noteText | Out-Null
        $request.status = "denied"
        $request.deniedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        $state.phase = "paused"
        $state.pausedFromPhase = "working"
        $state.pauseOrigin = [string]$taxonomy.pauseOrigins.human
        $state.pauseReasonCode = [string]$taxonomy.pauseReasonCodes.explicitHumanPause
        $state.lastSummary = "Authority checkpoint $($request.checkpoint) for $($request.id) denied: $noteText"
        Save-State
        Write-Result "AUTHORITY_DENIED"
        exit 0
    }

    if ($Action -eq "Pause") {
        if (-not $Summary.Trim()) { throw "Pause requires a human-readable -Summary." }
        if ($state.phase -eq "paused") { throw "Relay is already paused." }
        if ($state.activeRole -and $state.phase -in @("working", "validating", "rollback-verification")) {
            if ($state.phase -eq "working" -and -not $state.candidateCommit -and -not $state.rollbackCommit) {
                $head = (@(Invoke-Git rev-parse HEAD))[0].Trim()
                $dirty = @(Invoke-Git status --porcelain --untracked-files=all)
                if ($head -eq $state.baseCommit -and $dirty.Count -eq 0) {
                    $state.nextRole = $state.activeRole
                    $state.activeRole = $null
                    $state.phase = "paused"
                    $state.pausedFromPhase = "idle"
                    $state.pauseOrigin = [string]$taxonomy.pauseOrigins.human
                    $state.pauseReasonCode = [string]$taxonomy.pauseReasonCodes.explicitHumanPause
                    $state.pauseAfterTurn = $false
                    $state.baseCommit = $null
                    $state.startedAt = $null
                    $state.lastSummary = $Summary.Trim()
                    Save-State
                    Remove-Item -LiteralPath (Join-Path $Workspace ".tandem\reciprocal-checkpoint.md") -Force -ErrorAction SilentlyContinue
                    Write-Result "PAUSED"
                    exit 0
                }
            }
            $state.pauseAfterTurn = $true
            $state.lastSummary = $Summary.Trim()
            Save-State
            Write-Result "PAUSE_REQUESTED"
            exit 0
        }
        $state.pausedFromPhase = $state.phase
        $state.phase = "paused"
        $state.pauseOrigin = [string]$taxonomy.pauseOrigins.human
        $state.pauseReasonCode = [string]$taxonomy.pauseReasonCodes.explicitHumanPause
        $state.lastSummary = $Summary.Trim()
        Save-State
        Write-Result "PAUSED"
        exit 0
    }

    if ($Action -eq "Resume") {
        if (-not $Summary.Trim()) { throw "Resume requires a human-readable -Summary." }
        if ($state.pauseAfterTurn) {
            $state.pauseAfterTurn = $false
            Reset-ResumeCounter
            $state.lastSummary = $Summary.Trim()
            Save-State
            Write-Result "PAUSE_CANCELLED"
            exit 0
        }
        if ($state.phase -ne "paused") { throw "Resume is valid only when the relay phase is paused. Current phase: $($state.phase)." }
        $restorePhase = if ($state.pausedFromPhase) { [string]$state.pausedFromPhase } else { "idle" }
        if ($restorePhase -eq "paused") { throw "Cannot resume from malformed pausedFromPhase=paused." }
        $state.phase = $restorePhase
        $state.pausedFromPhase = $null
        $state.pauseOrigin = $null
        $state.pauseReasonCode = $null
        Reset-ResumeCounter
        $state.lastSummary = $Summary.Trim()
        Save-State
        Write-Result "RESUMED"
        exit 0
    }

    if ($Action -eq "ReconcileMain") {
        if ($state.phase -ne "paused" -or $state.activeRole) {
            throw "ReconcileMain requires a paused relay with no active owner."
        }
        if ($state.candidateCommit -or $state.rollbackCommit) {
            throw "ReconcileMain refuses while a candidate or rollback is pending."
        }
        if (-not $NewStableCommit.Trim()) { throw "ReconcileMain requires -NewStableCommit." }
        $resolved = (@(Invoke-Git rev-parse "$NewStableCommit^{commit}"))[0].Trim()
        foreach ($branchName in @("codex/reciprocal-a", "codex/reciprocal-b")) {
            $branchHead = (@(Invoke-Git rev-parse $branchName))[0].Trim()
            if ($branchHead -ne $resolved) {
                throw "$branchName is at $branchHead instead of reconciled commit $resolved."
            }
        }
        $state.stableCommit = $resolved
        $state.baseCommit = $null
        $state.candidateCommit = $null
        $state.candidateKind = $null
        $state.rollbackCommit = $null
        Reset-ResumeCounter
        $state.lastCompletedCommit = $resolved
        $state.lastSummary = if ($Summary.Trim()) { $Summary.Trim() } else { "Reconciled reciprocal branches with master." }
        Save-State
        Write-Result "RECONCILED_MAIN"
        exit 0
    }

    if (-not $Role) { throw "$Action requires -Role A or -Role B." }
    $roleConfig = Get-RoleConfig $Role
    if ($Action -eq "Claim") {
        if ($Role -eq "B") {
            Write-Result "WAIT" ([pscustomobject]@{ passiveOnly = $true; reason = "executor-b-no-agentic-turns" })
            exit 0
        }
        if ($state.phase -eq "passive-testing" -or $state.candidateCommit) {
            Write-Result "PASSIVE_TEST" ([pscustomobject]@{
                passiveTestCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action PassiveTest -Role A"
            })
            exit 0
        }
        if ($state.phase -eq "a-upgrade-pending") {
            Write-Result "A_UPGRADE_PENDING" ([pscustomobject]@{
                prepareCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action PrepareAUpgrade -Role A -DryRun"
                completeCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action CompleteAUpgrade -Role A -Force -Summary '<human confirmed A rebuild>'"
            })
            exit 0
        }
    }

    function Get-NextArtifactItem {
        if ($Role -ne "A") { return $null }
        $boardPath = Get-SharedDirectionPath
        if (-not (Test-Path -LiteralPath $boardPath)) { return $null }
        $line = @(
            Read-Utf8Lines $boardPath |
                Where-Object { $_ -match "^- \[ \] (W\d{4}) \| (P[0-3]) \| (.*?) \| QUEUED\b" -and $_ -match "(^|\s)artifact=candidate-preview(\s|$)" -and $_ -match "(^|\s)source=([0-9a-fA-F]{7,40})(\s|$)" } |
                Select-Object -First 1
        )
        if ($line.Count -eq 0) { return $null }
        $id = ([regex]::Match($line[0], "^- \[ \] (W\d{4}) \|")).Groups[1].Value
        $metadata = Get-Metadata $line[0]
        return [pscustomobject]@{
            kind = "candidate-preview"
            wishlistId = $id
            sourceSha = $metadata.source
        }
    }

    function New-ArtifactCapabilityBlocked([object]$ArtifactItem) {
        return [pscustomobject]@{
            kind = $ArtifactItem.kind
            wishlistId = $ArtifactItem.wishlistId
            sourceSha = $ArtifactItem.sourceSha
            requiredCapability = [ordered]@{
                candidatePreviewArtifactLifecycle = $CandidatePreviewArtifactCapability
            }
            capabilities = Get-ReciprocalCapabilities
            reason = "Artifact build workflow requires Reciprocal executor upgrade."
        }
    }

    function Get-NextArtifactInstruction {
        $artifactItem = Get-NextArtifactItem
        if (-not $artifactItem -or -not (Test-CandidatePreviewArtifactCapability)) { return $null }
        return [pscustomobject]@{
            kind = $artifactItem.kind
            wishlistId = $artifactItem.wishlistId
            sourceSha = $artifactItem.sourceSha
            startCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-direction.ps1 -Action Start -Id $($artifactItem.wishlistId) -Role A"
            completionReportShape = [ordered]@{
                status = "complete"
                filesChanged = @()
                reciprocalArtifact = [ordered]@{
                    kind = $artifactItem.kind
                    wishlistId = $artifactItem.wishlistId
                    sourceSha = $artifactItem.sourceSha
                }
            }
            instruction = "Build or verify the trusted candidate preview artifact without source edits. Submit a CompletionReport with filesChanged=[] and reciprocalArtifact exactly matching this kind, wishlistId, and sourceSha; the app layer will validate BUILD_INFO, run GUI smoke, close the relay, and mark the board terminal."
        }
    }
    $branch = (@(Invoke-Git branch --show-current))[0].Trim()
    $expectedBranch = if ($Action -in @("PassiveTest", "PrepareAUpgrade", "CompleteAUpgrade")) { "codex/reciprocal-a" } else { $roleConfig.Target }
    if ($branch -ne $expectedBranch) {
        if ($Action -in @("PassiveTest", "PrepareAUpgrade", "CompleteAUpgrade")) {
            throw "$Action must run from passive branch $expectedBranch, but this worktree is on $branch."
        }
        throw "Role $Role must target branch $($roleConfig.Target), but this worktree is on $branch."
    }

    if ($Action -eq "Claim") {
        if ($state.phase -eq "paused") {
            Write-Result "PAUSED"
            exit 0
        }
        if ($state.activeRole) {
            if ($state.activeRole -eq $Role) {
                $pendingFinalization = Get-PendingAppFinalization $Role
                if ($pendingFinalization) {
                    Reset-ResumeCounter
                    Save-State
                    Write-Result "RESUME" ([pscustomobject]@{
                        reason = "app-layer-finalization-pending"
                        finalizationPending = $true
                        wishlistId = $pendingFinalization.wishlistId
                        finalizationStage = $pendingFinalization.stage
                        finalizationCommit = $pendingFinalization.commit
                        instruction = "Do not start another agent turn. Tandem's app layer must replay the durable candidate finalization before another Claim."
                    })
                    exit 0
                }
                if (Test-GenuineResumeState) {
                    $count = Increment-ResumeCounter
                    if ($count -ge $ResumePauseThreshold) {
                        Pause-ResumeLoop $Role
                    }
                    Save-State
                    Write-Result "RESUME"
                    exit 0
                }
                $state.activeRole = $null
                $state.nextRole = $Role
                $state.startedAt = $null
            } else {
                Write-Result "WAIT"
                exit 0
            }
        }
        if ($state.pauseAfterTurn) {
            $state.phase = "paused"
            $state.pausedFromPhase = "idle"
            $state.pauseOrigin = [string]$taxonomy.pauseOrigins.human
            $state.pauseReasonCode = [string]$taxonomy.pauseReasonCodes.explicitHumanPause
            $state.pauseAfterTurn = $false
            Save-State
            Write-Result "PAUSED"
            exit 0
        }
        if ($state.nextRole -ne $Role) {
            Write-Result "WAIT"
            exit 0
        }
        Assert-WishlistToolingCompatible

        $artifactItem = Get-NextArtifactItem
        if ($artifactItem -and -not (Test-CandidatePreviewArtifactCapability)) {
            Write-Result "CAPABILITY_BLOCKED" ([pscustomobject]@{
                artifactBlocked = New-ArtifactCapabilityBlocked $artifactItem
            })
            exit 0
        }

        Assert-Clean "Cannot claim a new turn with pre-existing worktree changes"
        Invoke-Git merge --ff-only $roleConfig.Peer | Out-Null
        $head = (@(Invoke-Git rev-parse HEAD))[0].Trim()
        $state.activeRole = $Role
        $state.baseCommit = $head
        $state.startedAt = (Get-Date).ToUniversalTime().ToString("o")
        Reset-ResumeCounter
        $outcome = "CLAIMED"
        if ($state.candidateCommit) {
            if ($head -ne $state.candidateCommit) {
                throw "Candidate $($state.candidateCommit) is not the synchronized target HEAD $head."
            }
            $state.phase = "validating"
            $outcome = "VALIDATE"
        } else {
            if ($head -ne $state.stableCommit) {
                throw "Target HEAD $head differs from stable commit $($state.stableCommit) without a candidate."
            }
            $state.phase = "working"
        }
        Save-State
        $extra = [pscustomobject]@{}
        if ($outcome -eq "CLAIMED" -and $state.phase -eq "working") {
            $artifactInstruction = Get-NextArtifactInstruction
            if ($artifactInstruction) {
                $extra | Add-Member -NotePropertyName artifactWork -NotePropertyValue $artifactInstruction
            }
        }
        Write-Result $outcome $extra
        exit 0
    }

    if ($Action -eq "PassiveTest") {
        if ($Role -ne "A") { throw "PassiveTest is driven by Executor A and must use -Role A." }
        if ($state.phase -ne "passive-testing") { throw "PassiveTest is valid only during passive-testing. Current phase: $($state.phase)." }
        if (-not $state.candidateCommit) { throw "PassiveTest requires a pending candidate commit." }
        Assert-Clean "PassiveTest requires a clean passive worktree"
        Invoke-Git merge --ff-only $state.candidateCommit | Out-Null
        $head = (@(Invoke-Git rev-parse HEAD))[0].Trim()
        if ($head -ne $state.candidateCommit) { throw "PassiveTest did not land candidate commit $($state.candidateCommit)." }

        $checks = if ($ValidationChecks -and $ValidationChecks.Count -gt 0) {
            $ValidationChecks
        } else {
            @(
                "npm run typecheck",
                "npm test",
                "npm run build",
                "git diff --check refs/tandem-relay/stable refs/tandem-relay/candidate --"
            )
        }
        $mechanical = @()
        foreach ($check in $checks) {
            $mechanical += Invoke-ValidationCommand $check
        }
        $failed = @($mechanical | Where-Object { -not $_.passed })
        $checkSummary = @($mechanical | ForEach-Object {
            [ordered]@{
                command = $_.command
                exitCode = [int]$_.exitCode
                passed = [bool]$_.passed
                output = (Limit-Text $_.output 6000)
            }
        })
        if ($failed.Count -gt 0) {
            Pause-PassiveFailure $failed $checkSummary "Passive build/test failed"
            exit 0
        }

        $packageScript = Join-Path $Workspace "scripts\package-passive-runtime.ps1"
        if (-not (Test-Path -LiteralPath $packageScript)) {
            $packageScript = Join-Path $PSScriptRoot "package-passive-runtime.ps1"
        }
        if (-not (Test-Path -LiteralPath $packageScript)) { throw "Passive package helper is missing: $packageScript" }
        $state.runtimeRecoveryStage = "passive-package-started"
        Save-State
        $packageCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$packageScript`" -Workspace `"$Workspace`" -AdminRepo `"$adminRepo`" -SourceSha $head"
        $preparedPackage = [Environment]::GetEnvironmentVariable("TANDEM_PASSIVE_PACKAGE_PREPARED_WIN_UNPACKED")
        if ($preparedPackage) {
            $packageCommand += " -PreparedWinUnpacked `"$preparedPackage`""
        }
        $packageCheck = Invoke-ValidationCommand $packageCommand
        $mechanical += $packageCheck
        $failed = @($mechanical | Where-Object { -not $_.passed })
        $checkSummary = @($mechanical | ForEach-Object {
            [ordered]@{
                command = $_.command
                exitCode = [int]$_.exitCode
                passed = [bool]$_.passed
                output = (Limit-Text $_.output 6000)
            }
        })
        if ($failed.Count -gt 0) {
            Pause-PassiveFailure $failed $checkSummary "Passive package failed"
            exit 0
        }
        $runtimePackage = $null
        try {
            $runtimePackage = $packageCheck.output | ConvertFrom-Json
        } catch {
            $runtimePackage = [pscustomobject]@{ output = (Limit-Text $packageCheck.output 6000) }
        }
        $state.runtimeRecoveryStage = "passive-package-ready"
        Save-State
        $packageIdentity = if ($runtimePackage -and $runtimePackage.packageIdentity) { [string]$runtimePackage.packageIdentity } else { $null }
        if (-not $packageIdentity) {
            $packageBuildInfoPath = if ($runtimePackage -and $runtimePackage.buildInfoPath) { [string]$runtimePackage.buildInfoPath } else { Join-Path $adminRepo "release\win-unpacked\BUILD_INFO.json" }
            if (-not (Test-Path -LiteralPath $packageBuildInfoPath)) { throw "Passive package BUILD_INFO is missing package identity: $packageBuildInfoPath" }
            $packageBuildInfo = Get-Content -LiteralPath $packageBuildInfoPath -Raw | ConvertFrom-Json
            $packageIdentity = [string]$packageBuildInfo.packageIdentity
        }
        if (-not $packageIdentity) { throw "Passive package did not produce a cryptographic package identity." }
        $immutablePackagePath = if ($runtimePackage -and $runtimePackage.immutablePackagePath) { [string]$runtimePackage.immutablePackagePath } else { Join-Path $adminRepo "release\runtime-packages\$packageIdentity\win-unpacked" }
        if (-not (Test-Path -LiteralPath $immutablePackagePath)) { throw "Immutable passive runtime package is missing: $immutablePackagePath" }
        Save-RuntimeRecoveryJournal -Stage "package-ready" -SourceSha $head -PackageIdentity $packageIdentity -ImmutablePackagePath $immutablePackagePath -Proof ([pscustomobject]@{ package = $runtimePackage })

        $promotionScript = Join-Path $Workspace "scripts\promote-reciprocal-runtime.ps1"
        if (-not (Test-Path -LiteralPath $promotionScript)) {
            $promotionScript = Join-Path $PSScriptRoot "promote-reciprocal-runtime.ps1"
        }
        if (-not (Test-Path -LiteralPath $promotionScript)) { throw "Passive recovery promotion helper is missing: $promotionScript" }
        $state.runtimeRecoveryStage = "b-runtime-promote-started"
        Save-State
        Save-RuntimeRecoveryJournal -Stage "b-promote-started" -SourceSha $head -PackageIdentity $packageIdentity -ImmutablePackagePath $immutablePackagePath
        $bSourceDir = $immutablePackagePath
        $promoteBCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$promotionScript`" -RelayRoot `"$defaultRelayRoot`" -Source `"$bSourceDir`" -SourceSha $head -TargetRole B -BuildRound D184 -PromotedRound D184"
        $promoteBCheck = Invoke-ValidationCommand $promoteBCommand
        $mechanical += $promoteBCheck
        $failed = @($mechanical | Where-Object { -not $_.passed })
        $checkSummary = @($mechanical | ForEach-Object {
            [ordered]@{
                command = $_.command
                exitCode = [int]$_.exitCode
                passed = [bool]$_.passed
                output = (Limit-Text $_.output 6000)
            }
        })
        if ($failed.Count -gt 0) {
            Pause-PassiveFailure $failed $checkSummary "Executor B recovery runtime promotion failed"
            exit 0
        }
        $bBuildInfoPath = Join-Path $defaultRelayRoot "runtimes\executor-b\BUILD_INFO.json"
        if (-not (Test-Path -LiteralPath $bBuildInfoPath)) { throw "Executor B recovery runtime BUILD_INFO is missing: $bBuildInfoPath" }
        $bBuildInfo = Get-Content -LiteralPath $bBuildInfoPath -Raw | ConvertFrom-Json
        if ([string]$bBuildInfo.sourceSha -ne $head) { throw "Executor B recovery runtime BUILD_INFO sourceSha mismatch: $($bBuildInfo.sourceSha) != $head" }
        if ([string]$bBuildInfo.packageIdentity -ne $packageIdentity) { throw "Executor B recovery runtime package identity mismatch: $($bBuildInfo.packageIdentity) != $packageIdentity" }
        if (-not $bBuildInfo.reciprocalCapabilities -or [int]$bBuildInfo.reciprocalCapabilities.candidatePreviewArtifactLifecycle -lt 1) {
            throw "Executor B recovery runtime does not advertise candidatePreviewArtifactLifecycle v1."
        }
        $bPackageProof = Get-RuntimePackageIntegrity (Join-Path $defaultRelayRoot "runtimes\executor-b") $head $packageIdentity
        $state.runtimeRecoveryStage = "b-runtime-promoted"
        Save-State
        Save-RuntimeRecoveryJournal -Stage "b-promoted" -SourceSha $head -PackageIdentity $packageIdentity -ImmutablePackagePath $immutablePackagePath -Proof ([pscustomobject]@{ bBuildInfo = $bBuildInfo })

        $startScript = Join-Path $Workspace "scripts\start-reciprocal-tandem.ps1"
        if (-not (Test-Path -LiteralPath $startScript)) {
            $startScript = Join-Path $PSScriptRoot "start-reciprocal-tandem.ps1"
        }
        if (-not (Test-Path -LiteralPath $startScript)) { throw "Passive recovery start helper is missing: $startScript" }
        $state.runtimeRecoveryStage = "b-runtime-start-started"
        Save-State
        Save-RuntimeRecoveryJournal -Stage "b-start-started" -SourceSha $head -PackageIdentity $packageIdentity -ImmutablePackagePath $immutablePackagePath
        $startBCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -Role B -RelayRoot `"$defaultRelayRoot`""
        $startBCheck = Start-PowerShellFileCommand @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $startScript, "-Role", "B", "-RelayRoot", $defaultRelayRoot) $startBCommand
        $mechanical += $startBCheck
        $failed = @($mechanical | Where-Object { -not $_.passed })
        $checkSummary = @($mechanical | ForEach-Object {
            [ordered]@{
                command = $_.command
                exitCode = [int]$_.exitCode
                passed = [bool]$_.passed
                output = (Limit-Text $_.output 6000)
            }
        })
        if ($failed.Count -gt 0) {
            Pause-PassiveFailure $failed $checkSummary "Executor B recovery launch failed"
            exit 0
        }
        $state.runtimeRecoveryStage = "b-runtime-started"
        Save-State
        Save-RuntimeRecoveryJournal -Stage "b-started" -SourceSha $head -PackageIdentity $packageIdentity -ImmutablePackagePath $immutablePackagePath -Proof ([pscustomobject]@{ startBOutput = $startBCheck.output })

        $bAutomationPath = Join-Path $defaultRelayRoot "state\executor-b\automation.json"
        $tokenDeadline = (Get-Date).AddSeconds(15)
        while (-not (Test-Path -LiteralPath $bAutomationPath) -and (Get-Date) -lt $tokenDeadline) {
            Start-Sleep -Milliseconds 200
        }
        if (-not (Test-Path -LiteralPath $bAutomationPath)) { throw "Executor B automation token is missing after recovery start: $bAutomationPath" }
        $bAutomation = Get-Content -LiteralPath $bAutomationPath -Raw | ConvertFrom-Json
        if (-not $bAutomation.port -or -not $bAutomation.token -or -not $bAutomation.pid) { throw "Executor B automation token is incomplete after recovery start." }
        $bStatus = $null
        $deadline = (Get-Date).AddSeconds(30)
        do {
            try {
                $headers = @{ Authorization = "Bearer $($bAutomation.token)" }
                $bStatus = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$($bAutomation.port)/status" -Headers $headers -TimeoutSec 3
                break
            } catch {
                Start-Sleep -Milliseconds 300
            }
        } while ((Get-Date) -lt $deadline)
        if (-not $bStatus) { throw "Executor B recovery endpoint did not become ready before approval gate." }
        if (-not $bStatus.pid -or [int]$bStatus.pid -ne [int]$bAutomation.pid) {
            throw "Executor B recovery endpoint PID mismatch: endpoint=$($bStatus.pid), token=$($bAutomation.pid)"
        }
        if (-not $bStatus.port -or [int]$bStatus.port -ne [int]$bAutomation.port) {
            throw "Executor B recovery endpoint port mismatch: endpoint=$($bStatus.port), token=$($bAutomation.port)"
        }
        if (-not $bStatus.tokenFile -or ([IO.Path]::GetFullPath([string]$bStatus.tokenFile) -ine [IO.Path]::GetFullPath($bAutomationPath))) {
            throw "Executor B recovery endpoint token file mismatch: $($bStatus.tokenFile) != $bAutomationPath"
        }
        if ([string]$bStatus.instanceId -ne "B") {
            throw "Executor B recovery endpoint instance mismatch: $($bStatus.instanceId)"
        }
        $expectedBTarget = (Join-Path $defaultRelayRoot "worktrees\copy-a")
        $actualBTarget = if ($bStatus.allowedProjectDir) { [string]$bStatus.allowedProjectDir } else { [string]$bStatus.projectDir }
        if (([IO.Path]::GetFullPath($actualBTarget)).TrimEnd('\') -ine ([IO.Path]::GetFullPath($expectedBTarget)).TrimEnd('\')) {
            throw "Executor B recovery endpoint target mismatch: $actualBTarget != $expectedBTarget"
        }
        if ([string]$bStatus.sourceSha -ne $head) { throw "Executor B recovery endpoint source mismatch: $($bStatus.sourceSha) != $head" }
        if ([string]$bStatus.packageIdentity -ne $packageIdentity) { throw "Executor B recovery endpoint package mismatch: $($bStatus.packageIdentity) != $packageIdentity" }
        if (-not $bStatus.capabilities -or [int]$bStatus.capabilities.candidatePreviewArtifactLifecycle -lt 1) {
            throw "Executor B recovery endpoint does not advertise candidatePreviewArtifactLifecycle v1."
        }
        $bRuntimeExe = Join-Path $defaultRelayRoot "runtimes\executor-b\Tandem.exe"
        $bProcess = Get-Process -Id ([int]$bAutomation.pid) -ErrorAction SilentlyContinue
        if (-not $bProcess) { throw "Executor B recovery PID $($bAutomation.pid) is not running." }
        if (-not $bProcess.Path -or ([IO.Path]::GetFullPath($bProcess.Path) -ine [IO.Path]::GetFullPath($bRuntimeExe))) {
            throw "Executor B recovery PID path mismatch: $($bProcess.Path) != $bRuntimeExe"
        }
        $state.runtimeRecoveryStage = "b-runtime-verified"
        Save-State
        Save-RuntimeRecoveryJournal -Stage "b-verified" -SourceSha $head -PackageIdentity $packageIdentity -ImmutablePackagePath $immutablePackagePath -Proof ([pscustomobject]@{
            bEndpoint = $bStatus
            bAutomation = $bAutomation
            bProcess = [ordered]@{ pid = [int]$bAutomation.pid; path = $bProcess.Path }
            bPackageProof = $bPackageProof
        })

        $acceptedKind = $state.candidateKind
        $previousStableCommit = $state.stableCommit
        $state.stableCommit = $head
        Update-RelayRefs
        $continuation = $null
        try {
            $continuation = Complete-AcceptedDirectionCandidate $head $acceptedKind
        } catch {
            $state.stableCommit = $previousStableCommit
            Update-RelayRefs
            throw
        }
        if ($continuation) {
            Save-RuntimeRecoveryJournal -Stage "b-verified" -SourceSha $head -PackageIdentity $packageIdentity -ImmutablePackagePath $immutablePackagePath -Proof ([pscustomobject]@{
                bStopStartedAfterAutonomousContinuation = $true
                bPid = [int]$bAutomation.pid
            })
            Stop-Process -Id ([int]$bAutomation.pid) -Force -ErrorAction SilentlyContinue
            Save-RuntimeRecoveryJournal -Stage "b-verified" -SourceSha $head -PackageIdentity $packageIdentity -ImmutablePackagePath $immutablePackagePath -Proof ([pscustomobject]@{
                bStoppedAfterAutonomousContinuation = $true
                bPid = [int]$bAutomation.pid
            })
        }
        $state.stableCommit = $head
        $state.candidateCommit = $null
        $state.candidateKind = $null
        $state.rollbackCommit = $null
        $state.activeRole = $null
        $state.nextRole = "A"
        $state.phase = if ($continuation) { "idle" } else { "a-upgrade-pending" }
        $state.baseCommit = $null
        $state.startedAt = $null
        $state.runtimeRecoveryStage = if ($continuation) { $null } else { "b-runtime-verified" }
        Reset-ResumeCounter
        $state.lastCompletedCommit = $head
        $state.lastSummary = if ($Summary.Trim()) {
            $Summary.Trim()
        } elseif ($continuation) {
            "Passive copy built and verified intermediate candidate $head; continuing autonomous epic work."
        } else {
            "Passive copy built and verified candidate $head; A runtime upgrade is human-gated."
        }
        Save-State
        $extra = [pscustomobject]@{
            passiveChecks = $checkSummary
            runtimePackage = $runtimePackage
            recoveryRuntime = [pscustomobject]@{
                role = "B"
                sourceSha = $head
                buildInfoPath = $bBuildInfoPath
                stage = $state.runtimeRecoveryStage
            }
        }
        if ($continuation) {
            $continuation | Add-Member -NotePropertyName role -NotePropertyValue "A" -Force
            $continuation | Add-Member -NotePropertyName requiresHumanGate -NotePropertyValue $false -Force
            $continuation | Add-Member -NotePropertyName maxExtraLifecycleActions -NotePropertyValue 0 -Force
            $extra | Add-Member -NotePropertyName autonomousContinuation -NotePropertyValue $continuation -Force
        } else {
            $extra | Add-Member -NotePropertyName aUpgradeCommand -NotePropertyValue "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/promote-reciprocal-runtime.ps1 -TargetRole A -SourceSha $head -RelayRoot `"$defaultRelayRoot`"" -Force
            $extra | Add-Member -NotePropertyName autonomousContinuation -NotePropertyValue $null -Force
        }
        Write-Result "PASSIVE_ACCEPTED" $extra
        exit 0
    }

    if ($Action -eq "PrepareAUpgrade") {
        if ($Role -ne "A") { throw "PrepareAUpgrade is driven by Executor A and must use -Role A." }
        if ($state.phase -ne "a-upgrade-pending") { throw "PrepareAUpgrade is valid only while a-upgrade-pending. Current phase: $($state.phase)." }
        $promotionScript = Join-Path $Workspace "scripts\promote-reciprocal-runtime.ps1"
        if (-not (Test-Path -LiteralPath $promotionScript)) { throw "Missing promotion helper: $promotionScript" }
        Write-Result "A_UPGRADE_READY" ([pscustomobject]@{
            sourceSha = $state.stableCommit
            promotionCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/promote-reciprocal-runtime.ps1 -TargetRole A -SourceSha $($state.stableCommit) -RelayRoot `"$defaultRelayRoot`""
            humanGate = "Confirm passive runtime health manually, then promote Executor A from this same packaged build and run CompleteAUpgrade."
        })
        exit 0
    }

    if ($Action -eq "CompleteAUpgrade") {
        if ($Role -ne "A") { throw "CompleteAUpgrade is driven by Executor A and must use -Role A." }
        if (-not $Force) { throw "CompleteAUpgrade requires -Force after human confirmation." }
        if (-not $Summary.Trim()) { throw "CompleteAUpgrade requires a human-readable confirmation summary." }
        $fromPausedAUpgrade = $state.phase -eq "paused" -and $state.pausedFromPhase -eq "a-upgrade-pending" -and -not $state.activeRole
        if ($state.phase -ne "a-upgrade-pending" -and -not $fromPausedAUpgrade) { throw "CompleteAUpgrade is valid only while a-upgrade-pending or paused from a-upgrade-pending with no active owner. Current phase: $($state.phase)." }
        $state.nextRole = "A"
        $state.activeRole = $null
        Set-IdleOrPauseAfterTurn
        Reset-ResumeCounter
        $state.lastSummary = $Summary.Trim()
        Save-State
        Write-Result "A_UPGRADE_COMPLETED"
        exit 0
    }

    if ($Action -eq "Validate" -and $DryRun) {
        if ($state.phase -ne "paused" -or $state.activeRole) {
            throw "Validate -DryRun requires a paused relay with no active owner. Current phase: $($state.phase), owner: $($state.activeRole)."
        }
        Invoke-CandidateValidation $true
    }

    if ($state.activeRole -ne $Role) {
        throw "Role $Role does not own the active turn. Current owner: $($state.activeRole)."
    }

    if ($Action -eq "CompleteArtifact") {
        if ($Role -ne "A") { throw "Only Executor A can complete reciprocal artifact work." }
        if (-not $Summary.Trim()) { throw "CompleteArtifact requires a verification summary." }
        if ($state.candidateCommit -or $state.rollbackCommit) {
            throw "CompleteArtifact refuses while a source candidate or rollback is pending."
        }
        $fromWorkingPause = $state.phase -eq "paused" -and $state.pausedFromPhase -eq "working"
        if ($state.phase -ne "working" -and -not $fromWorkingPause) {
            throw "CompleteArtifact is valid only during working or paused-from-working. Current phase: $($state.phase)."
        }
        Assert-Clean "CompleteArtifact requires a clean worktree"
        $head = (@(Invoke-Git rev-parse HEAD))[0].Trim()
        if ($state.baseCommit -ne $state.stableCommit) { throw "Artifact working base no longer matches the stable commit." }
        if ($head -ne $state.baseCommit) { throw "Artifact turn HEAD changed from base $($state.baseCommit) to $head." }
        $commits = @(Invoke-Git rev-list "$($state.baseCommit)..$head")
        if ($commits.Count -ne 0) { throw "CompleteArtifact requires no source commits; found $($commits.Count)." }

        $state.turn = [int]$state.turn + 1
        $state.nextRole = "A"
        $state.activeRole = $null
        Set-IdleOrPauseAfterTurn
        $state.baseCommit = $null
        $state.candidateCommit = $null
        $state.candidateKind = $null
        $state.rollbackCommit = $null
        $state.startedAt = $null
        Reset-ResumeCounter
        $state.lastCompletedCommit = $head
        $state.lastSummary = $Summary.Trim()
        Save-State
        Remove-Item -LiteralPath (Join-Path $Workspace ".tandem\reciprocal-checkpoint.md") -Force -ErrorAction SilentlyContinue
        Write-Result "ARTIFACT_COMPLETED"
        exit 0
    }

    if ($Action -eq "Validate") {
        if ($state.phase -ne "validating") { throw "Validate is valid only after a VALIDATE claim unless -DryRun is used while paused." }
        Invoke-CandidateValidation $false
    }

    if ($Action -eq "Accept") {
        Approve-Candidate $Summary $null
        exit 0
    }

    if ($Action -eq "Rollback") {
        Reject-Candidate $Summary $null
        exit 0
    }

    if ($Action -eq "CompleteRollback") {
        if ($state.phase -ne "rollback-verification") { throw "CompleteRollback requires a pending rollback verification." }
        if (-not $Summary.Trim()) { throw "CompleteRollback requires a verification summary." }
        Assert-Clean "CompleteRollback requires a clean worktree"
        $head = (@(Invoke-Git rev-parse HEAD))[0].Trim()
        if ($head -ne $state.rollbackCommit) { throw "Rollback verification HEAD changed unexpectedly." }
        if (-not (Test-Git diff --quiet $state.stableCommit HEAD --)) {
            throw "Rollback tree does not match the last stable commit."
        }
        $state.turn = [int]$state.turn + 1
        $state.nextRole = "A"
        $state.activeRole = $null
        Set-IdleOrPauseAfterTurn
        $state.baseCommit = $null
        $state.candidateCommit = $head
        $state.candidateKind = "rollback"
        $state.rollbackCommit = $null
        $state.startedAt = $null
        Reset-ResumeCounter
        $state.lastCompletedCommit = $head
        $state.lastSummary = $Summary.Trim()
        Save-State
        Remove-Item -LiteralPath (Join-Path $Workspace ".tandem\reciprocal-checkpoint.md") -Force -ErrorAction SilentlyContinue
        Write-Result "ROLLBACK_COMPLETED"
        exit 0
    }

    if ($Action -eq "Abandon") {
        if ($state.phase -ne "working") { throw "Abandon is valid only for an in-progress improvement." }
        if (-not $Summary.Trim()) { throw "Abandon requires a recovery summary." }
        $head = (@(Invoke-Git rev-parse HEAD))[0].Trim()
        if ($head -ne $state.baseCommit) {
            throw "The turn already contains a commit. Resume and verify it, or ask a human to review it; Abandon only preserves uncommitted work."
        }
        $dirty = @(Invoke-Git status --porcelain --untracked-files=all)
        if ($dirty.Count -gt 0) {
            $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
            $stashMessage = "tandem-relay abandoned role $Role turn $($state.turn) $stamp"
            Invoke-Git stash push --include-untracked -m $stashMessage | Out-Null
            Assert-Clean "Recovery stash did not clean the worktree"
            $state.lastRecoveryStash = (@(Invoke-Git stash list --format="%gd %s"))[0].Trim()
        }
        $state.nextRole = $Role
        $state.activeRole = $null
        Set-IdleOrPauseAfterTurn
        $state.baseCommit = $null
        $state.startedAt = $null
        Reset-ResumeCounter
        $state.lastSummary = $Summary.Trim()
        Save-State
        Remove-Item -LiteralPath (Join-Path $Workspace ".tandem\reciprocal-checkpoint.md") -Force -ErrorAction SilentlyContinue
        Write-Result "ABANDONED"
        exit 0
    }

    if ($state.phase -ne "working") { throw "Complete is valid only during the working phase." }
    if ($Role -ne "A") { throw "Only Executor A can complete reciprocal producer work." }
    if (-not $Summary.Trim()) { throw "Complete requires a verification summary." }
    Assert-Clean "Complete requires a clean worktree"
    $head = (@(Invoke-Git rev-parse HEAD))[0].Trim()
    if ($state.baseCommit -ne $state.stableCommit) { throw "Working base no longer matches the stable commit." }
    $commits = @(Invoke-Git rev-list "$($state.baseCommit)..$head")
    if ($commits.Count -ne 1) {
        Assert-PendingAppFinalizationRange $Role $state.baseCommit $head $commits.Count
    } else {
        $parent = (@(Invoke-Git rev-parse "$head^"))[0].Trim()
        if ($parent -ne $state.baseCommit) { throw "The improvement commit is not a direct child of the stable base." }
    }
    if (-not (Test-Git merge-base --is-ancestor $roleConfig.Peer HEAD)) {
        throw "Peer branch $($roleConfig.Peer) is not an ancestor of HEAD; history diverged."
    }

    $state.turn = [int]$state.turn + 1
    $state.nextRole = "A"
    $state.activeRole = $null
    $state.phase = if ($state.pauseAfterTurn) { "paused" } else { "passive-testing" }
    $state.pausedFromPhase = if ($state.pauseAfterTurn) { "passive-testing" } else { $null }
    $state.pauseOrigin = if ($state.pauseAfterTurn) { [string]$taxonomy.pauseOrigins.human } else { $null }
    $state.pauseReasonCode = if ($state.pauseAfterTurn) { [string]$taxonomy.pauseReasonCodes.explicitHumanPause } else { $null }
    $state.pauseAfterTurn = $false
    $state.baseCommit = $null
    $state.candidateCommit = $head
    $state.candidateKind = "improvement"
    $state.rollbackCommit = $null
    $state.startedAt = $null
    if ($state.authorityRequest -and $state.authorityRequest.status -eq "approved" -and $state.authorityRequest.owner -eq $Role) {
        $state.authorityRequest.status = "consumed"
        $state.authorityRequest.consumedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    }
    Reset-ResumeCounter
    $state.lastCompletedCommit = $head
    $state.lastSummary = $Summary.Trim()
    Save-State
    Remove-Item -LiteralPath (Join-Path $Workspace ".tandem\reciprocal-checkpoint.md") -Force -ErrorAction SilentlyContinue
    Write-Result "COMPLETED"
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
