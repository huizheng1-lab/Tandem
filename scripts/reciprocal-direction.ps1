param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Show", "Add", "Remove", "Start", "Candidate", "ApprovePlan", "RejectPlan", "AcceptStep", "Complete", "Block", "Requeue")]
    [string]$Action,

    [string]$Text,

    [ValidateSet("P0", "P1", "P2", "P3")]
    [string]$Priority = "P1",

    [string]$Id,

    [ValidateSet("A", "B")]
    [string]$Role,

    [string]$Commit,

    [string]$Note,

    [switch]$Epic,

    [ValidateRange(0, 99)]
    [int]$Steps = 0,

    [string]$Plan,

    [switch]$PlanRevision,

    [string]$ControlPath
)

$ErrorActionPreference = "Stop"

function Get-GitValue([string[]]$Arguments) {
    $output = @(& git @Arguments 2>$null)
    if ($LASTEXITCODE -ne 0 -or $output.Count -eq 0) { return $null }
    return $output[0].Trim()
}

function Get-Metadata([string]$Value) {
    $metadata = @{}
    foreach ($match in [regex]::Matches($Value, '(?:^|\s)([A-Za-z][A-Za-z0-9]*)=([^\s]+)')) {
        $metadata[$match.Groups[1].Value] = $match.Groups[2].Value
    }
    return $metadata
}

function Get-CleanNote([string]$Value) {
    if ($null -eq $Value) { return "" }
    return ($Value -replace "\s+", " ").Trim().Replace("|", "/")
}

function Assert-EpicPlanPath([string]$Value, [string]$WishlistId) {
    $normalized = $Value.Replace("\", "/")
    $expected = "process/reciprocal/epics/$WishlistId-plan.md"
    if ($normalized -ne $expected) { throw "Epic $WishlistId plan must be committed at $expected." }
    return $normalized
}

if (-not $ControlPath) {
    $workspace = Get-GitValue @("rev-parse", "--show-toplevel")
    if (-not $workspace) { throw "Run this command inside the Tandem repository or pass -ControlPath." }
    $localPath = Join-Path $workspace ".tandem\shared-control\SHARED_DIRECTION.md"
    if (Test-Path -LiteralPath (Split-Path $localPath -Parent)) {
        $ControlPath = $localPath
    } else {
        $commonRaw = Get-GitValue @("rev-parse", "--git-common-dir")
        $commonDir = if ([IO.Path]::IsPathRooted($commonRaw)) { $commonRaw } else { [IO.Path]::GetFullPath((Join-Path $workspace $commonRaw)) }
        $adminRepo = Split-Path $commonDir -Parent
        $relayRoot = Join-Path (Split-Path $adminRepo -Parent) "Tandem Reciprocal"
        $ControlPath = Join-Path $relayRoot "control\SHARED_DIRECTION.md"
    }
}

$ControlPath = [IO.Path]::GetFullPath($ControlPath)
$controlDir = Split-Path $ControlPath -Parent
New-Item -ItemType Directory -Path $controlDir -Force | Out-Null

if (-not (Test-Path -LiteralPath $ControlPath)) {
    $workspace = Get-GitValue @("rev-parse", "--show-toplevel")
    $template = if ($workspace) { Join-Path $workspace "process\reciprocal\SHARED_DIRECTION_TEMPLATE.md" } else { $null }
    if (-not $template -or -not (Test-Path -LiteralPath $template)) {
        throw "Shared direction file is missing and its template could not be found."
    }
    Copy-Item -LiteralPath $template -Destination $ControlPath
}

$sha = [Security.Cryptography.SHA256]::Create()
try {
    $hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($ControlPath.ToLowerInvariant()))
} finally {
    $sha.Dispose()
}
$hashText = ([BitConverter]::ToString($hashBytes)).Replace("-", "")
$mutex = [Threading.Mutex]::new($false, "Local\TandemDirection-" + $hashText.Substring(0, 20))
if (-not $mutex.WaitOne(5000)) { throw "Timed out waiting for the shared direction lock." }

try {
    if ($Action -eq "Show") {
        Get-Content -LiteralPath $ControlPath -Raw
        exit 0
    }

    $lines = @(Get-Content -LiteralPath $ControlPath)
    $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

    if ($Action -eq "Add") {
        $cleanText = if ($null -eq $Text) { "" } else { ($Text -replace "\s+", " ").Trim().Replace("|", "/") }
        if (-not $cleanText) { throw "Add requires -Text." }
        $numbers = @($lines | ForEach-Object {
            if ($_ -match '^- \[(?: |x)\] W(\d{4}) \|' -or $_ -match '^- id=W(\d{4}) \| removed=') {
                [int]$Matches[1]
            }
        })
        $nextNumber = if ($numbers.Count) { ($numbers | Measure-Object -Maximum).Maximum + 1 } else { 1 }
        $Id = "W" + ([int]$nextNumber).ToString("D4")
        $marker = [Array]::IndexOf($lines, "<!-- wishlist-items -->")
        if ($marker -lt 0) { throw "Shared direction file is missing the wishlist marker." }
        $suffix = if ($Epic) { "QUEUED epic=true phase=PLAN revision=1 completed=0 added=$now" } else { "QUEUED added=$now" }
        $item = "- [ ] $Id | $Priority | $cleanText | $suffix"
        $before = if ($marker -ge 0) { @($lines[0..$marker]) } else { @() }
        $after = if ($marker + 1 -lt $lines.Count) { @($lines[($marker + 1)..($lines.Count - 1)]) } else { @() }
        $lines = @($before + $item + $after)
    } else {
        if (-not $Id) { throw "$Action requires -Id." }
        $pattern = '^- \[(?: |x)\] ' + [regex]::Escape($Id) + ' \|'
        $matches = @(0..($lines.Count - 1) | Where-Object { $lines[$_] -match $pattern })
        if ($matches.Count -ne 1) { throw "Expected exactly one wishlist item $Id; found $($matches.Count)." }
        $index = $matches[0]
        $originalLine = $lines[$index]
        $parts = @($originalLine -split ' \| ')
        if ($parts.Count -lt 4) { throw "Wishlist item $Id is malformed." }
        $base = @($parts[0], $parts[1], $parts[2])
        $statusAndDetail = $parts[3]
        $status = ($statusAndDetail -split '\s+')[0]
        $metadata = Get-Metadata $statusAndDetail
        $isEpic = $metadata.epic -eq "true"

        switch ($Action) {
            "Remove" {
                $cleanNote = if ($null -eq $Note) { "" } else { ($Note -replace "\s+", " ").Trim().Replace("|", "/") }
                if (-not $cleanNote) { throw "Remove requires -Note." }
                $status = if ($parts.Count -ge 4) { ($parts[3] -split '\s+')[0] } else { "" }
                if ($status -eq "IN_PROGRESS" -and $metadata.role) {
                    throw "Cannot remove $Id while it is IN_PROGRESS. Let the turn finish, requeue it, or end the turn first."
                }

                $before = if ($index -gt 0) { @($lines[0..($index - 1)]) } else { @() }
                $after = if ($index + 1 -lt $lines.Count) { @($lines[($index + 1)..($lines.Count - 1)]) } else { @() }
                $lines = @($before + $after)
                $removedHeader = [Array]::IndexOf($lines, "## Removed")
                if ($removedHeader -lt 0) {
                    $lines = @($lines + "" + "## Removed" + "")
                }
                $lines = @(
                    $lines +
                    "- id=$Id | removed=$now | note=$cleanNote" +
                    "  original: $originalLine"
                )
            }
            "Start" {
                if (-not $Role) { throw "Start requires -Role." }
                if ($base[0] -match '\[x\]') { throw "$Id is already complete." }
                if (-not $isEpic) {
                    $lines[$index] = ($base + "IN_PROGRESS role=$Role started=$now") -join " | "
                    break
                }
                $revision = if ($metadata.revision) { [int]$metadata.revision } else { 1 }
                $completed = if ($metadata.completed) { [int]$metadata.completed } else { 0 }
                if ($status -eq "QUEUED" -and $metadata.phase -eq "PLAN") {
                    $lines[$index] = ($base + "IN_PROGRESS epic=true phase=PLAN revision=$revision completed=$completed role=$Role started=$now") -join " | "
                    break
                }
                if ($status -eq "CANDIDATE" -and $metadata.candidate -eq "PLAN") {
                    throw "Epic $Id plan must be approved by a human before a step turn can start."
                }
                if ($status -notin @("PLAN_APPROVED", "IN_PROGRESS")) {
                    throw "Epic $Id cannot start a step from status $status."
                }
                if ($status -eq "IN_PROGRESS" -and $metadata.role) {
                    throw "Epic $Id is already owned by role $($metadata.role)."
                }
                $stepText = if ($metadata.next) { $metadata.next } else { "$($completed + 1)/$($metadata.steps)" }
                if ($stepText -notmatch '^(\d+)/(\d+)$') { throw "Epic $Id has malformed next-step metadata." }
                $step = [int]$Matches[1]
                $total = [int]$Matches[2]
                if ($step -le $completed -or $step -gt $total) { throw "Epic $Id next step $step/$total is inconsistent with completed=$completed." }
                $planPath = Assert-EpicPlanPath $metadata.plan $Id
                $lines[$index] = ($base + "IN_PROGRESS epic=true phase=STEP revision=$revision completed=$completed step=$step/$total plan=$planPath role=$Role started=$now") -join " | "
            }
            "Candidate" {
                if (-not $Commit) { throw "Candidate requires -Commit." }
                if (-not $isEpic) {
                    $lines[$index] = ($base + "CANDIDATE commit=$Commit updated=$now") -join " | "
                    break
                }
                if ($status -ne "IN_PROGRESS") { throw "Epic $Id must be IN_PROGRESS before creating a candidate." }
                $revision = if ($metadata.revision) { [int]$metadata.revision } else { 1 }
                $completed = if ($metadata.completed) { [int]$metadata.completed } else { 0 }
                if ($metadata.phase -eq "PLAN" -or $PlanRevision) {
                    if ($Steps -le $completed) { throw "Epic $Id plan requires more than $completed total steps." }
                    $planPath = Assert-EpicPlanPath $Plan $Id
                    if ($PlanRevision) { $revision += 1 }
                    $lines[$index] = ($base + "CANDIDATE epic=true candidate=PLAN revision=$revision completed=$completed steps=$Steps plan=$planPath commit=$Commit updated=$now") -join " | "
                    break
                }
                if ($metadata.phase -ne "STEP" -or $metadata.step -notmatch '^(\d+)/(\d+)$') {
                    throw "Epic $Id step candidate metadata is malformed."
                }
                $step = [int]$Matches[1]
                $total = [int]$Matches[2]
                $planPath = Assert-EpicPlanPath $metadata.plan $Id
                $lines[$index] = ($base + "CANDIDATE epic=true candidate=STEP revision=$revision completed=$completed step=$step/$total plan=$planPath commit=$Commit updated=$now") -join " | "
            }
            "ApprovePlan" {
                if (-not $isEpic -or $status -ne "CANDIDATE" -or $metadata.candidate -ne "PLAN") {
                    throw "ApprovePlan requires an epic PLAN candidate."
                }
                $completed = if ($metadata.completed) { [int]$metadata.completed } else { 0 }
                $total = [int]$metadata.steps
                if ($total -le $completed) { throw "Epic $Id plan has no unfinished steps." }
                $cleanNote = Get-CleanNote $Note
                $noteSuffix = if ($cleanNote) { " note=$cleanNote" } else { "" }
                $lines[$index] = ($base + "PLAN_APPROVED epic=true revision=$($metadata.revision) completed=$completed steps=$total next=$($completed + 1)/$total plan=$($metadata.plan) commit=$($metadata.commit) approved=$now$noteSuffix") -join " | "
            }
            "RejectPlan" {
                if (-not $isEpic -or $status -ne "CANDIDATE" -or $metadata.candidate -ne "PLAN") {
                    throw "RejectPlan requires an epic PLAN candidate."
                }
                $cleanNote = Get-CleanNote $Note
                if (-not $cleanNote) { throw "RejectPlan requires -Note." }
                $completed = if ($metadata.completed) { [int]$metadata.completed } else { 0 }
                $lines[$index] = ($base + "QUEUED epic=true phase=PLAN revision=$($metadata.revision) completed=$completed plan=$($metadata.plan) note=$cleanNote updated=$now") -join " | "
            }
            "AcceptStep" {
                if (-not $Commit) { throw "AcceptStep requires the accepted stable -Commit." }
                if (-not $isEpic -or $status -ne "CANDIDATE" -or $metadata.candidate -ne "STEP" -or $metadata.step -notmatch '^(\d+)/(\d+)$') {
                    throw "AcceptStep requires an epic STEP candidate."
                }
                $step = [int]$Matches[1]
                $total = [int]$Matches[2]
                if ($step -ge $total) { throw "Epic $Id final step must use Complete so the item moves CANDIDATE to DONE." }
                $lines[$index] = ($base + "IN_PROGRESS epic=true phase=STEP revision=$($metadata.revision) completed=$step step=$step/$total next=$($step + 1)/$total plan=$($metadata.plan) last=$Commit updated=$now") -join " | "
            }
            "Complete" {
                if (-not $Commit) { throw "Complete requires the accepted stable -Commit." }
                if ($isEpic) {
                    if ($status -ne "CANDIDATE" -or $metadata.candidate -ne "STEP" -or $metadata.step -notmatch '^(\d+)/(\d+)$' -or $Matches[1] -ne $Matches[2]) {
                        throw "Epic $Id can complete only after its final STEP candidate is accepted."
                    }
                }
                $base[0] = $base[0] -replace '^- \[ \]', '- [x]'
                $epicSuffix = if ($isEpic) { " epic=true steps=$($metadata.step) plan=$($metadata.plan)" } else { "" }
                $lines[$index] = ($base + "DONE stable=$Commit completed=$now$epicSuffix") -join " | "
            }
            "Block" {
                $cleanNote = if ($null -eq $Note) { "" } else { ($Note -replace "\s+", " ").Trim().Replace("|", "/") }
                if (-not $cleanNote) { throw "Block requires -Note." }
                $preserved = if ($isEpic) { ($statusAndDetail.Substring($status.Length)).Trim() + " previous=$status " } else { "" }
                $lines[$index] = ($base + "BLOCKED $($preserved)note=$cleanNote updated=$now") -join " | "
            }
            "Requeue" {
                $base[0] = $base[0] -replace '^- \[x\]', '- [ ]'
                $cleanNote = Get-CleanNote $Note
                if ($isEpic -and $metadata.candidate -eq "STEP" -and $metadata.step -match '^(\d+)/(\d+)$') {
                    $noteSuffix = if ($cleanNote) { " note=$cleanNote" } else { "" }
                    $lines[$index] = ($base + "PLAN_APPROVED epic=true revision=$($metadata.revision) completed=$($metadata.completed) steps=$($Matches[2]) next=$($Matches[1])/$($Matches[2]) plan=$($metadata.plan)$noteSuffix updated=$now") -join " | "
                    break
                }
                if ($isEpic -and $metadata.phase -eq "PLAN") {
                    $noteSuffix = if ($cleanNote) { " note=$cleanNote" } else { "" }
                    $lines[$index] = ($base + "QUEUED epic=true phase=PLAN revision=$($metadata.revision) completed=$($metadata.completed) plan=$($metadata.plan)$noteSuffix updated=$now") -join " | "
                    break
                }
                if ($isEpic -and $metadata.phase -eq "STEP" -and $metadata.step -match '^(\d+)/(\d+)$') {
                    $step = [int]$Matches[1]
                    $total = [int]$Matches[2]
                    $completed = if ($metadata.completed) { [int]$metadata.completed } else { [Math]::Max(0, $step - 1) }
                    $retry = if ($metadata.next) { $metadata.next } elseif ($metadata.role) { "$step/$total" } else { "$($completed + 1)/$total" }
                    $noteSuffix = if ($cleanNote) { " note=$cleanNote" } else { "" }
                    $lines[$index] = ($base + "PLAN_APPROVED epic=true revision=$($metadata.revision) completed=$completed steps=$total next=$retry plan=$($metadata.plan)$noteSuffix updated=$now") -join " | "
                    break
                }
                $suffix = if ($cleanNote) { "QUEUED note=$cleanNote updated=$now" } else { "QUEUED updated=$now" }
                $lines[$index] = ($base + $suffix) -join " | "
            }
        }
    }

    $tempPath = "$ControlPath.tmp-$PID"
    [IO.File]::WriteAllLines($tempPath, [string[]]$lines, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tempPath -Destination $ControlPath -Force
    [ordered]@{ action = $Action; id = $Id; path = $ControlPath } | ConvertTo-Json
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
