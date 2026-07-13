param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Status", "Claim", "Complete", "Pause", "Reset")]
    [string]$Action,

    [ValidateSet("A", "B")]
    [string]$Role,

    [string]$Summary,

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

function Get-RoleConfig([string]$SelectedRole) {
    if ($SelectedRole -eq "A") {
        return @{ Target = "codex/reciprocal-b"; Peer = "codex/reciprocal-a"; Next = "B" }
    }
    return @{ Target = "codex/reciprocal-a"; Peer = "codex/reciprocal-b"; Next = "A" }
}

function New-RelayState {
    return [ordered]@{
        schemaVersion = 1
        turn = 1
        nextRole = "A"
        activeRole = $null
        phase = "idle"
        baseCommit = $null
        startedAt = $null
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
        lastCompletedCommit = $null
        lastSummary = $null
    }
}

$root = (@(Invoke-Git rev-parse --show-toplevel))[0].Trim()
$Workspace = $root
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
        [pscustomobject](New-RelayState)
    }

    function Save-State {
        $state.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
        $tempPath = "$statePath.tmp-$PID"
        $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tempPath -Encoding utf8
        Move-Item -LiteralPath $tempPath -Destination $statePath -Force
    }

    function Write-Result([string]$Outcome) {
        [ordered]@{
            outcome = $Outcome
            turn = $state.turn
            nextRole = $state.nextRole
            activeRole = $state.activeRole
            phase = $state.phase
            baseCommit = $state.baseCommit
            lastCompletedCommit = $state.lastCompletedCommit
            lastSummary = $state.lastSummary
            statePath = $statePath
        } | ConvertTo-Json -Depth 5
    }

    if ($Action -eq "Reset") {
        if (-not $Force) { throw "Reset requires -Force and is reserved for human recovery." }
        $state = [pscustomobject](New-RelayState)
        Save-State
        Remove-Item -LiteralPath (Join-Path $Workspace ".tandem\reciprocal-checkpoint.md") -Force -ErrorAction SilentlyContinue
        Write-Result "RESET"
        exit 0
    }

    if ($Action -eq "Status") {
        Write-Result "STATUS"
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
        if ($state.nextRole -ne $Role) {
            Write-Result "WAIT"
            exit 0
        }

        $dirty = @(Invoke-Git status --porcelain --untracked-files=all)
        if ($dirty.Count -gt 0) {
            throw "Cannot claim a new turn with pre-existing worktree changes: $($dirty -join '; ')"
        }

        Invoke-Git merge --ff-only $roleConfig.Peer | Out-Null
        $state.activeRole = $Role
        $state.phase = "working"
        $state.baseCommit = (@(Invoke-Git rev-parse HEAD))[0].Trim()
        $state.startedAt = (Get-Date).ToUniversalTime().ToString("o")
        Save-State
        Write-Result "CLAIMED"
        exit 0
    }

    if ($state.activeRole -ne $Role) {
        throw "Role $Role does not own the active turn. Current owner: $($state.activeRole)."
    }

    if ($Action -eq "Pause") {
        if (-not $Summary.Trim()) { throw "Pause requires a human-readable -Summary." }
        $state.phase = "paused"
        $state.lastSummary = $Summary.Trim()
        Save-State
        Write-Result "PAUSED"
        exit 0
    }

    $dirty = @(Invoke-Git status --porcelain --untracked-files=all)
    if ($dirty.Count -gt 0) {
        throw "Complete requires a clean worktree: $($dirty -join '; ')"
    }
    $head = (@(Invoke-Git rev-parse HEAD))[0].Trim()
    if ($head -eq $state.baseCommit) { throw "Complete requires one new verified commit after the claim." }
    & git -C $Workspace merge-base --is-ancestor $roleConfig.Peer HEAD 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Peer branch $($roleConfig.Peer) is not an ancestor of HEAD; history diverged." }

    $state.turn = [int]$state.turn + 1
    $state.nextRole = $roleConfig.Next
    $state.activeRole = $null
    $state.phase = "idle"
    $state.baseCommit = $null
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
