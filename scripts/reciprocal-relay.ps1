param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Status", "Claim", "Accept", "Complete", "Rollback", "CompleteRollback", "Abandon", "Pause", "Resume", "ReconcileMain", "Reset")]
    [string]$Action,

    [ValidateSet("A", "B")]
    [string]$Role,

    [string]$Summary,

    [string]$NewStableCommit,

    [string]$Workspace = (Get-Location).Path,

    [switch]$Force
)

$ErrorActionPreference = "Stop"

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $output = @(& git -C $Workspace @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
    }
    return $output
}

function Test-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    & git -C $Workspace @Arguments *> $null
    return $LASTEXITCODE -eq 0
}

function Get-RoleConfig([string]$SelectedRole) {
    if ($SelectedRole -eq "A") {
        return @{ Target = "codex/reciprocal-b"; Peer = "codex/reciprocal-a"; Next = "B" }
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

    function Write-Result([string]$Outcome) {
        [ordered]@{
            outcome = $Outcome
            turn = $state.turn
            nextRole = $state.nextRole
            activeRole = $state.activeRole
            phase = $state.phase
            pausedFromPhase = $state.pausedFromPhase
            pauseAfterTurn = [bool]$state.pauseAfterTurn
            baseCommit = $state.baseCommit
            stableCommit = $state.stableCommit
            candidateCommit = $state.candidateCommit
            candidateKind = $state.candidateKind
            rollbackCommit = $state.rollbackCommit
            lastCompletedCommit = $state.lastCompletedCommit
            lastSummary = $state.lastSummary
            lastRecoveryStash = $state.lastRecoveryStash
            statePath = $statePath
        } | ConvertTo-Json -Depth 5
    }

    function Assert-Clean([string]$Message) {
        $dirty = @(Invoke-Git status --porcelain --untracked-files=all)
        if ($dirty.Count -gt 0) { throw "$Message`: $($dirty -join '; ')" }
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

    function Complete-AcceptedDirectionCandidate([string]$AcceptedCommit, [string]$AcceptedKind) {
        if ($AcceptedKind -ne "improvement") { return }
        $directionScript = Join-Path $Workspace "scripts\reciprocal-direction.ps1"
        if (-not (Test-Path -LiteralPath $directionScript)) { return }
        $boardPath = Get-SharedDirectionPath
        if (-not (Test-Path -LiteralPath $boardPath)) { return }

        $escapedCommit = [regex]::Escape($AcceptedCommit)
        $candidateLine = @(
            Get-Content -LiteralPath $boardPath |
                Where-Object { $_ -match "^- \[ \] (W\d+) \| .+ \| CANDIDATE\b" -and $_ -match "(^|\s)commit=$escapedCommit(\s|$)" }
        )
        if ($candidateLine.Count -eq 0) { return }
        if ($candidateLine.Count -gt 1) { throw "Accepted commit $AcceptedCommit matches multiple shared-direction candidates." }

        $line = $candidateLine[0]
        $id = ([regex]::Match($line, "^- \[ \] (W\d+) \|")).Groups[1].Value
        $metadata = Get-Metadata $line
        if ($metadata.epic -eq "true") {
            if ($metadata.candidate -eq "PLAN") {
                if ($metadata.autonomy -eq "full") {
                    & $directionScript -Action AutoApprovePlan -Id $id -Commit $AcceptedCommit -ControlPath $boardPath | Out-Null
                    if ($LASTEXITCODE -ne 0) { throw "AutoApprovePlan failed for accepted candidate $id." }
                }
                return
            }
            if ($metadata.candidate -eq "STEP") {
                if ($metadata.step -notmatch "^(\d+)/(\d+)$") { throw "Epic candidate $id has malformed step metadata." }
                if ([int]$Matches[1] -lt [int]$Matches[2]) {
                    & $directionScript -Action AcceptStep -Id $id -Commit $AcceptedCommit -ControlPath $boardPath | Out-Null
                } else {
                    & $directionScript -Action Complete -Id $id -Commit $AcceptedCommit -ControlPath $boardPath | Out-Null
                }
                if ($LASTEXITCODE -ne 0) { throw "Accepted epic step update failed for $id." }
                return
            }
            return
        }

        & $directionScript -Action Complete -Id $id -Commit $AcceptedCommit -ControlPath $boardPath | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Complete failed for accepted candidate $id." }
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
        $state.lastCompletedCommit = $resolved
        $state.lastSummary = if ($Summary.Trim()) { $Summary.Trim() } else { "Reconciled reciprocal branches with master." }
        Save-State
        Write-Result "RECONCILED_MAIN"
        exit 0
    }

    if (-not $Role) { throw "$Action requires -Role A or -Role B." }
    $roleConfig = Get-RoleConfig $Role
    $branch = (@(Invoke-Git branch --show-current))[0].Trim()
    if ($branch -ne $roleConfig.Target) {
        throw "Role $Role must target branch $($roleConfig.Target), but this worktree is on $branch."
    }

    if ($Action -eq "Claim") {
        if ($state.phase -eq "paused") {
            Write-Result "PAUSED"
            exit 0
        }
        if ($state.activeRole) {
            Write-Result $(if ($state.activeRole -eq $Role) { "RESUME" } else { "WAIT" })
            exit 0
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

    if ($state.activeRole -ne $Role) {
        throw "Role $Role does not own the active turn. Current owner: $($state.activeRole)."
    }

    if ($Action -eq "Accept") {
        if ($state.phase -ne "validating") { throw "Accept is valid only after a VALIDATE claim." }
        Assert-Clean "Accept requires a clean worktree"
        $head = (@(Invoke-Git rev-parse HEAD))[0].Trim()
        if ($head -ne $state.candidateCommit) { throw "Validated HEAD does not match the candidate commit." }
        $acceptedKind = $state.candidateKind
        Complete-AcceptedDirectionCandidate $head $acceptedKind
        $state.stableCommit = $head
        $state.candidateCommit = $null
        $state.candidateKind = $null
        $state.rollbackCommit = $null
        $state.phase = "working"
        $state.baseCommit = $head
        $state.lastSummary = if ($Summary.Trim()) { $Summary.Trim() } else { "Candidate baseline accepted after verification." }
        Save-State
        Write-Result "ACCEPTED"
        exit 0
    }

    if ($Action -eq "Rollback") {
        if ($state.phase -ne "validating") { throw "Rollback is valid only after a VALIDATE claim." }
        if ($state.candidateKind -ne "improvement") { throw "Only an unaccepted improvement candidate can be rolled back automatically." }
        if (-not $Summary.Trim()) { throw "Rollback requires a failure summary." }
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
        $state.lastSummary = $Summary.Trim()
        Save-State
        Write-Result "ROLLBACK_CREATED"
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
        $state.nextRole = $roleConfig.Next
        $state.activeRole = $null
        Set-IdleOrPauseAfterTurn
        $state.baseCommit = $null
        $state.candidateCommit = $head
        $state.candidateKind = "rollback"
        $state.rollbackCommit = $null
        $state.startedAt = $null
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
        $state.lastSummary = $Summary.Trim()
        Save-State
        Remove-Item -LiteralPath (Join-Path $Workspace ".tandem\reciprocal-checkpoint.md") -Force -ErrorAction SilentlyContinue
        Write-Result "ABANDONED"
        exit 0
    }

    if ($state.phase -ne "working") { throw "Complete is valid only during the working phase." }
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
    $state.nextRole = $roleConfig.Next
    $state.activeRole = $null
    Set-IdleOrPauseAfterTurn
    $state.baseCommit = $null
    $state.candidateCommit = $head
    $state.candidateKind = "improvement"
    $state.rollbackCommit = $null
    $state.startedAt = $null
    $state.lastCompletedCommit = $head
    $state.lastSummary = $Summary.Trim()
    Save-State
    Remove-Item -LiteralPath (Join-Path $Workspace ".tandem\reciprocal-checkpoint.md") -Force -ErrorAction SilentlyContinue
    Write-Result "COMPLETED"
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
