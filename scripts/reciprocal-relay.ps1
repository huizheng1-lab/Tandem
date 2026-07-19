param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Status", "Claim", "Validate", "PassiveTest", "PrepareAUpgrade", "CompleteAUpgrade", "Accept", "Complete", "Rollback", "CompleteRollback", "Abandon", "Pause", "Resume", "ReconcileMain", "Reset")]
    [string]$Action,

    [ValidateSet("A", "B")]
    [string]$Role,

    [string]$Summary,

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
    $defaultRelayRoot = Join-Path (Split-Path $adminRepo -Parent) "Tandem Reciprocal"
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
        $result = [ordered]@{
            outcome = $Outcome
            turn = $state.turn
            nextRole = $state.nextRole
            activeRole = $state.activeRole
            phase = $state.phase
            pausedFromPhase = $state.pausedFromPhase
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

    function Invoke-ValidationCommand([string]$Command) {
        $oldErrorAction = $ErrorActionPreference
        Push-Location -LiteralPath $Workspace
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
        $localPath = Join-Path $Workspace ".tandem\shared-control\SHARED_DIRECTION.md"
        if (Test-Path -LiteralPath (Split-Path $localPath -Parent)) {
            return $localPath
        }
        $commonRaw = (@(Invoke-Git rev-parse --git-common-dir))[0].Trim()
        $commonDir = if ([IO.Path]::IsPathRooted($commonRaw)) { $commonRaw } else { [IO.Path]::GetFullPath((Join-Path $Workspace $commonRaw)) }
        $adminRepo = Split-Path $commonDir -Parent
        $relayRoot = Join-Path (Split-Path $adminRepo -Parent) "Tandem Reciprocal"
        return (Join-Path $relayRoot "control\SHARED_DIRECTION.md")
    }

    function Get-Metadata([string]$Value) {
        $metadata = @{}
        foreach ($match in [regex]::Matches($Value, '(?:^|\s)([A-Za-z][A-Za-z0-9]*)=([^\s]+)')) {
            $metadata[$match.Groups[1].Value] = $match.Groups[2].Value
        }
        return $metadata
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
        $directionScript = Join-Path $Workspace "scripts\reciprocal-direction.ps1"
        if (-not (Test-Path -LiteralPath $directionScript)) { return $null }
        $boardPath = Get-SharedDirectionPath
        if (-not (Test-Path -LiteralPath $boardPath)) { return $null }

        $escapedCommit = [regex]::Escape($AcceptedCommit)
        $candidateLine = @(
            Get-Content -LiteralPath $boardPath |
                Where-Object { $_ -match "^- \[ \] (W\d+) \| .+ \| CANDIDATE\b" -and $_ -match "(^|\s)commit=$escapedCommit(\s|$)" }
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
                    if ($metadata.autonomy -eq "full") { return New-AutonomousContinuation $id "$($step + 1)/$total" }
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
            $state.pauseAfterTurn = $false
        } else {
            $state.phase = "idle"
            $state.pausedFromPhase = $null
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
            $state.pauseAfterTurn = $false
            Save-State
            Write-Result "PAUSED"
            exit 0
        }
        if ($state.nextRole -ne $Role) {
            Write-Result "WAIT"
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
        Write-Result $outcome
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
            $state.phase = "paused"
            $state.pausedFromPhase = "passive-testing"
            $state.activeRole = $null
            $state.lastSummary = "Passive build/test failed for candidate $($state.candidateCommit): $((@($failed | ForEach-Object { $_.command })) -join ', ')"
            Save-State
            Write-Result "PASSIVE_FAILED" ([pscustomobject]@{ passiveChecks = $checkSummary })
            exit 0
        }

        $packageScript = Join-Path $Workspace "scripts\package-passive-runtime.ps1"
        if (-not (Test-Path -LiteralPath $packageScript)) { throw "Passive package helper is missing: $packageScript" }
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
            $state.phase = "paused"
            $state.pausedFromPhase = "passive-testing"
            $state.activeRole = $null
            $state.lastSummary = "Passive package failed for candidate $($state.candidateCommit): $((@($failed | ForEach-Object { $_.command })) -join ', ')"
            Save-State
            Write-Result "PASSIVE_FAILED" ([pscustomobject]@{ passiveChecks = $checkSummary })
            exit 0
        }
        $runtimePackage = $null
        try {
            $runtimePackage = $packageCheck.output | ConvertFrom-Json
        } catch {
            $runtimePackage = [pscustomobject]@{ output = (Limit-Text $packageCheck.output 6000) }
        }

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
        $state.activeRole = $null
        $state.nextRole = "A"
        $state.phase = if ($continuation) { "idle" } else { "a-upgrade-pending" }
        $state.baseCommit = $null
        $state.startedAt = $null
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
        if ($state.phase -ne "a-upgrade-pending") { throw "CompleteAUpgrade is valid only while a-upgrade-pending. Current phase: $($state.phase)." }
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
    if ($commits.Count -ne 1) { throw "Complete requires exactly one new verified commit; found $($commits.Count)." }
    $parent = (@(Invoke-Git rev-parse "$head^"))[0].Trim()
    if ($parent -ne $state.baseCommit) { throw "The improvement commit is not a direct child of the stable base." }
    if (-not (Test-Git merge-base --is-ancestor $roleConfig.Peer HEAD)) {
        throw "Peer branch $($roleConfig.Peer) is not an ancestor of HEAD; history diverged."
    }

    $state.turn = [int]$state.turn + 1
    $state.nextRole = "A"
    $state.activeRole = $null
    $state.phase = if ($state.pauseAfterTurn) { "paused" } else { "passive-testing" }
    $state.pausedFromPhase = if ($state.pauseAfterTurn) { "passive-testing" } else { $null }
    $state.pauseAfterTurn = $false
    $state.baseCommit = $null
    $state.candidateCommit = $head
    $state.candidateKind = "improvement"
    $state.rollbackCommit = $null
    $state.startedAt = $null
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
