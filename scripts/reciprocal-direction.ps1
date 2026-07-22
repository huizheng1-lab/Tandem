param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Show", "UpdateDirection", "Add", "Remove", "Retire", "Start", "NormalizeQueued", "MigrateAuthorityMetadata", "DeclareAuthority", "ApproveAuthority", "DenyAuthority", "Candidate", "DeclareArtifact", "ArtifactComplete", "ApprovePlan", "AutoApprovePlan", "RejectPlan", "AcceptStep", "Complete", "Block", "Requeue")]
    [string]$Action,

    [string]$Text,

    [ValidateSet("P0", "P1", "P2", "P3")]
    [string]$Priority = "P1",

    [string]$Id,

    [ValidateSet("A", "B")]
    [string]$Role,

    [string]$Commit,

    [ValidateSet("candidate-preview")]
    [string]$ArtifactKind,

    [string]$Evidence,

    [string]$Note,

    [switch]$Epic,

    [ValidateSet("inherit", "plan-gated", "full")]
    [string]$Autonomy = "inherit",

    [ValidateRange(0, 99)]
    [int]$Steps = 0,

    [ValidateRange(-1, 99)]
    [int]$CompletedSteps = -1,

    [string]$Plan,

    [switch]$PlanRevision,

    [ValidateSet("credentials", "authentication", "pairing", "permission", "sandbox", "destructive", "payment", "publication", "runtime")]
    [string]$AuthKind,

    [string]$AuthVerb,

    [string]$Checkpoint,

    [string]$ResumeToken,

    [string]$AuthorityProofPath,

    [string]$ControlPath
)

$ErrorActionPreference = "Stop"

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
    foreach ($name in @("explicitHumanPause", "resumeCircuitBreaker", "candidateFailure")) {
        if (-not $taxonomy.pauseReasonCodes.$name) { throw "Canonical reciprocal taxonomy is missing pauseReasonCodes.$name." }
    }
    foreach ($name in @("working", "testing", "waitingForReview", "humanPaused", "machineBlocked", "hardBlocked", "retryBackoff", "retryingPrerequisite", "planning", "unknown", "waitingNotBlocked")) {
        if (-not $taxonomy.displayStates.$name) { throw "Canonical reciprocal taxonomy is missing displayStates.$name." }
    }
    return $taxonomy
}

$taxonomy = Get-ReciprocalTaxonomy

function Assert-AuthorityProof([string]$ExpectedDecision, [string]$WishlistId, [hashtable]$Metadata) {
    if (-not $AuthorityProofPath) { throw "$ExpectedDecision requires a trusted relay authority proof." }
    if (-not (Test-Path -LiteralPath $AuthorityProofPath -PathType Leaf)) { throw "$ExpectedDecision authority proof is missing." }
    $secret = [string]$env:TANDEM_AUTHORITY_DECISION_SECRET
    if (-not $secret) { throw "$ExpectedDecision requires a trusted relay authority signing secret." }
    try {
        $proof = Get-Content -LiteralPath $AuthorityProofPath -Raw | ConvertFrom-Json
    } catch {
        throw "$ExpectedDecision authority proof is invalid JSON."
    }
    $expires = [datetime]::Parse([string]$proof.expiresAtUtc).ToUniversalTime()
    if ($expires -lt (Get-Date).ToUniversalTime()) { throw "$ExpectedDecision authority proof expired." }
    if ($proof.decision -ne $ExpectedDecision) { throw "$ExpectedDecision authority proof decision mismatch." }
    if ($proof.id -ne $WishlistId) { throw "$ExpectedDecision authority proof item mismatch." }
    foreach ($name in @("authority", "action", "checkpoint", "resume")) {
        if ([string]$proof.$name -ne [string]$Metadata[$name]) { throw "$ExpectedDecision authority proof $name mismatch." }
    }
    if (-not $proof.requestId -or -not $proof.signature) { throw "$ExpectedDecision authority proof is incomplete." }
    $binding = @(
        [string]$proof.decision,
        [string]$proof.requestId,
        [string]$proof.id,
        [string]$proof.owner,
        [string]$proof.authority,
        [string]$proof.action,
        [string]$proof.checkpoint,
        [string]$proof.resume,
        [string]$proof.expiresAtUtc
    ) -join "`n"
    $hmac = [Security.Cryptography.HMACSHA256]::new([Text.UTF8Encoding]::new($false).GetBytes($secret))
    try {
        $expected = [BitConverter]::ToString($hmac.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($binding))).Replace("-", "").ToLowerInvariant()
    } finally {
        $hmac.Dispose()
    }
    $left = [Text.UTF8Encoding]::new($false).GetBytes($expected)
    $right = [Text.UTF8Encoding]::new($false).GetBytes(([string]$proof.signature).ToLowerInvariant())
    $diff = $left.Length -bxor $right.Length
    $max = [Math]::Max($left.Length, $right.Length)
    for ($i = 0; $i -lt $max; $i++) {
        $a = if ($i -lt $left.Length) { $left[$i] } else { 0 }
        $b = if ($i -lt $right.Length) { $right[$i] } else { 0 }
        $diff = $diff -bor ($a -bxor $b)
    }
    if ($diff -ne 0) { throw "$ExpectedDecision authority proof signature mismatch." }
}

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

function Get-CleanMetadataValue([string]$Value, [string]$Name) {
    $clean = Get-CleanNote $Value
    if (-not $clean -or $clean -notmatch '^[A-Za-z0-9._:-]+$') { throw "$Name requires a precise token using only letters, numbers, dot, underscore, colon, or hyphen." }
    if ($clean -match '^(all|anything|everything|broad|general|whatever|full)$') { throw "$Name must be exact, not broad." }
    return $clean
}

function Get-AutonomyDefault([string[]]$BoardLines) {
    $policy = @($BoardLines | Where-Object { $_ -match '^AutonomyDefault:\s*(plan-gated|autonomous)\s*$' })
    if ($policy.Count -ne 1) { return "plan-gated" }
    return ([regex]::Match($policy[0], '^AutonomyDefault:\s*(plan-gated|autonomous)\s*$')).Groups[1].Value
}

function Get-EffectiveAutonomy([hashtable]$Metadata, [string[]]$BoardLines, [string]$ItemText) {
    if ($Metadata.authority -or $Metadata.safety -eq "security-surface") { return "plan-gated" }
    if ($Metadata.autonomy -eq "full") { return "full" }
    if ($Metadata.autonomy -eq "plan-gated") { return "plan-gated" }
    return $(if ((Get-AutonomyDefault $BoardLines) -eq "autonomous") { "full" } else { "plan-gated" })
}

function Add-AutoApprovalAudit([string]$BoardPath, [string]$WishlistId, [string]$CandidateCommit, [string]$PlanPath) {
    $auditPath = Join-Path (Split-Path $BoardPath -Parent) "CONTROL_PANEL_AUDIT.jsonl"
    $entry = [ordered]@{
        at = (Get-Date).ToUniversalTime().ToString("o")
        action = "wishlist.planAutoApprove"
        id = $WishlistId
        commit = $CandidateCommit
        plan = $PlanPath
        reason = "plan auto-approved (item autonomy: full)"
    } | ConvertTo-Json -Compress
    [IO.File]::AppendAllText($auditPath, $entry + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

function Assert-EpicPlanPath([string]$Value, [string]$WishlistId) {
    $normalized = $Value.Replace("\", "/")
    $expected = "process/reciprocal/epics/$WishlistId-plan.md"
    if ($normalized -ne $expected) { throw "Epic $WishlistId plan must be committed at $expected." }
    return $normalized
}

$explicitControlPath = -not [string]::IsNullOrWhiteSpace($ControlPath)

function Normalize-ControlPath([string]$Value) {
    return [IO.Path]::GetFullPath($Value).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).ToLowerInvariant()
}

function Read-Utf8Lines([string]$Path) {
    return @([IO.File]::ReadAllLines($Path, [Text.UTF8Encoding]::new($false)))
}

function Read-Utf8Text([string]$Path) {
    return [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false))
}

function Get-CanonicalControlPaths([string]$Workspace) {
    $paths = @()
    if ($env:TANDEM_RECIPROCAL_ROOT) {
        $paths += (Join-Path $env:TANDEM_RECIPROCAL_ROOT "control\SHARED_DIRECTION.md")
    }
    if ($Workspace) {
        $localPath = Join-Path $Workspace ".tandem\shared-control\SHARED_DIRECTION.md"
        if (Test-Path -LiteralPath (Split-Path $localPath -Parent)) {
            $paths += [IO.Path]::GetFullPath($localPath)
        }

        $commonRaw = Get-GitValue @("rev-parse", "--git-common-dir")
        if ($commonRaw) {
            $commonDir = if ([IO.Path]::IsPathRooted($commonRaw)) { $commonRaw } else { [IO.Path]::GetFullPath((Join-Path $Workspace $commonRaw)) }
            $adminRepo = Split-Path $commonDir -Parent
            $relayRoot = Join-Path (Split-Path $adminRepo -Parent) "Tandem Reciprocal"
            $paths += (Join-Path $relayRoot "control\SHARED_DIRECTION.md")
        }
    }
    return @($paths | ForEach-Object { Normalize-ControlPath $_ } | Select-Object -Unique)
}

function Get-WishlistPath([string]$SharedDirectionPath) {
    return (Join-Path (Split-Path $SharedDirectionPath -Parent) "WISHLIST.md")
}

function Initialize-WishlistFile([string]$WishlistPath, [string]$SharedDirectionPath) {
    if (Test-Path -LiteralPath $WishlistPath) { return }
    $items = @()
    if (Test-Path -LiteralPath $SharedDirectionPath) {
        $sourceLines = Read-Utf8Lines $SharedDirectionPath
        $wishlistHeader = [Array]::IndexOf($sourceLines, "## Wishlist And Progress")
        if ($wishlistHeader -ge 0) {
            $notesHeader = [Array]::IndexOf($sourceLines, "## Human Notes")
            $removedHeader = [Array]::IndexOf($sourceLines, "## Removed")
            $wishlistEnd = if ($notesHeader -gt $wishlistHeader) { $notesHeader - 1 } elseif ($removedHeader -gt $wishlistHeader) { $removedHeader - 1 } else { $sourceLines.Count - 1 }
            $items = @($sourceLines[$wishlistHeader..$wishlistEnd])
            if ($removedHeader -gt $wishlistHeader) {
                $items += ""
                $items += $sourceLines[$removedHeader..($sourceLines.Count - 1)]
            }
        }
    }
    if ($items.Count -eq 0) {
        $items = @(
            "# Tandem Reciprocal: Wishlist And Progress",
            "",
            "Statuses are `QUEUED`, `IN_PROGRESS`, `CANDIDATE`, `PLAN_APPROVED`, `BLOCKED`, and `DONE`. Only independently accepted candidates become `DONE`.",
            "",
            "<!-- wishlist-items -->"
        )
    } elseif ($items[0] -eq "## Wishlist And Progress") {
        $items[0] = "# Tandem Reciprocal: Wishlist And Progress"
    }
    [IO.File]::WriteAllLines($WishlistPath, [string[]]$items, [Text.UTF8Encoding]::new($false))
}

function Normalize-SharedDirectionFile([string]$SharedDirectionPath) {
    if (-not (Test-Path -LiteralPath $SharedDirectionPath)) { return }
    $sourceLines = Read-Utf8Lines $SharedDirectionPath
    $wishlistHeader = [Array]::IndexOf($sourceLines, "## Wishlist And Progress")
    if ($wishlistHeader -lt 0) { return }
    $notesHeader = [Array]::IndexOf($sourceLines, "## Human Notes")
    $removedHeader = [Array]::IndexOf($sourceLines, "## Removed")
    $prefixEnd = [Math]::Max(0, $wishlistHeader - 1)
    $result = @($sourceLines[0..$prefixEnd])
    while ($result.Count -gt 0 -and [string]::IsNullOrWhiteSpace($result[-1])) {
        if ($result.Count -eq 1) { $result = @(); break }
        $result = @($result[0..($result.Count - 2)])
    }
    if ($notesHeader -gt $wishlistHeader) {
        $notesEnd = if ($removedHeader -gt $notesHeader) { $removedHeader - 1 } else { $sourceLines.Count - 1 }
        $result += ""
        $result += $sourceLines[$notesHeader..$notesEnd]
    }
    [IO.File]::WriteAllLines($SharedDirectionPath, [string[]]$result, [Text.UTF8Encoding]::new($false))
}

if (-not $ControlPath) {
    $workspace = Get-GitValue @("rev-parse", "--show-toplevel")
    if (-not $workspace) { throw "Run this command inside the Tandem repository or pass -ControlPath." }
    $localPath = Join-Path $workspace ".tandem\shared-control\SHARED_DIRECTION.md"
    if ($env:TANDEM_RECIPROCAL_ROOT) {
        $ControlPath = Join-Path $env:TANDEM_RECIPROCAL_ROOT "control\SHARED_DIRECTION.md"
    } elseif (Test-Path -LiteralPath (Split-Path $localPath -Parent)) {
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
if ([IO.Path]::GetFileName($ControlPath) -ieq "WISHLIST.md") {
    $ControlPath = Join-Path (Split-Path $ControlPath -Parent) "SHARED_DIRECTION.md"
}
$workspaceForControl = Get-GitValue @("rev-parse", "--show-toplevel")
if ($explicitControlPath -and $workspaceForControl) {
    $workspaceTandemDir = Normalize-ControlPath (Join-Path $workspaceForControl ".tandem")
    $requestedControlPath = Normalize-ControlPath $ControlPath
    $canonicalControlPaths = @(Get-CanonicalControlPaths $workspaceForControl)
    $insideWorkspaceTandem = $requestedControlPath.StartsWith($workspaceTandemDir + [IO.Path]::DirectorySeparatorChar)
    if ($insideWorkspaceTandem -and $canonicalControlPaths -notcontains $requestedControlPath) {
        throw "Explicit -ControlPath inside .tandem must point at the canonical shared board: .tandem\shared-control\SHARED_DIRECTION.md."
    }
}
$controlDir = Split-Path $ControlPath -Parent
New-Item -ItemType Directory -Path $controlDir -Force | Out-Null
$WishlistPath = Get-WishlistPath $ControlPath

if (-not (Test-Path -LiteralPath $ControlPath)) {
    $workspace = Get-GitValue @("rev-parse", "--show-toplevel")
    $template = if ($workspace) { Join-Path $workspace "process\reciprocal\SHARED_DIRECTION_TEMPLATE.md" } else { $null }
    if (-not $template -or -not (Test-Path -LiteralPath $template)) {
        $fallbackDirection = @(
            "# Tandem Reciprocal: Shared Direction",
            "",
            "This file is the durable human-owned direction for both reciprocal executors. Live wishlist/progress items are stored separately in control/WISHLIST.md.",
            "",
            "## General Direction",
            "",
            "Improve Tandem's reliability, usefulness, autonomy, cost discipline, and recovery behavior while preserving user control and backward compatibility.",
            "",
            "AutonomyDefault: plan-gated",
            "",
            "## Human Guardrails",
            "",
            "- Human wishlist items take priority over self-selected improvements.",
            "- Do not weaken tests, safety controls, rollback behavior, or audit history to make progress appear faster.",
            "",
            "## Human Notes",
            "",
            "Add broader context, product principles, or constraints here."
        )
        [IO.File]::WriteAllLines($ControlPath, [string[]]$fallbackDirection, [Text.UTF8Encoding]::new($false))
    } else {
        Copy-Item -LiteralPath $template -Destination $ControlPath
    }
}
Initialize-WishlistFile $WishlistPath $ControlPath
Normalize-SharedDirectionFile $ControlPath

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
        Read-Utf8Text $WishlistPath
        exit 0
    }

    $directionLines = Read-Utf8Lines $ControlPath
    $targetPath = if ($Action -eq "UpdateDirection") { $ControlPath } else { $WishlistPath }
    $lines = if ($Action -eq "UpdateDirection") { $directionLines } else { Read-Utf8Lines $WishlistPath }
    $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

    if ($Action -eq "UpdateDirection") {
        $cleanText = if ($null -eq $Text) { "" } else { $Text.Trim() }
        if (-not $cleanText) { throw "UpdateDirection requires -Text." }
        if ($cleanText -match '(?m)^##\s') { throw "General Direction cannot contain level-two Markdown headings." }
        $directionHeader = [Array]::IndexOf($lines, "## General Direction")
        $guardrailsHeader = [Array]::IndexOf($lines, "## Human Guardrails")
        if ($directionHeader -lt 0 -or $guardrailsHeader -le $directionHeader) {
            throw "Shared direction file has malformed General Direction or Human Guardrails sections."
        }
        $before = @($lines[0..$directionHeader])
        $directionLines = @($cleanText -split '\r?\n')
        $after = @($lines[$guardrailsHeader..($lines.Count - 1)])
        $lines = @($before + "" + $directionLines + "" + $after)
    } elseif ($Action -eq "Add") {
        $cleanText = if ($null -eq $Text) { "" } else { ($Text -replace "\s+", " ").Trim().Replace("|", "/") }
        if (-not $cleanText) { throw "Add requires -Text." }
        if ($ArtifactKind -and -not $Commit) { throw "Artifact wishlist creation requires the trusted artifact source -Commit." }
        if ($Commit -and -not $ArtifactKind) { throw "Add accepts -Commit only with -ArtifactKind." }
        if ($ArtifactKind -and $Epic) { throw "Artifact wishlist creation is only valid for non-epic items." }
        if ($ArtifactKind -and $Commit -notmatch '^[0-9a-fA-F]{7,40}$') { throw "Artifact wishlist creation requires a source commit SHA." }
        if (-not $Epic -and $Autonomy -ne "inherit") { throw "Autonomy applies only to epic wishlist items." }
        $numbers = @($lines | ForEach-Object {
            if ($_ -match '^- \[(?: |x)\] W(\d{4}) \|' -or $_ -match '^- id=W(\d{4}) \| removed=') {
                [int]$Matches[1]
            }
        })
        $nextNumber = if ($numbers.Count) { ($numbers | Measure-Object -Maximum).Maximum + 1 } else { 1 }
        $Id = "W" + ([int]$nextNumber).ToString("D4")
        $marker = [Array]::IndexOf($lines, "<!-- wishlist-items -->")
        if ($marker -lt 0) { throw "Shared direction file is missing the wishlist marker." }
        $autonomyMetadata = if ($Autonomy -ne "inherit") { " autonomy=$Autonomy" } else { "" }
        $suffix = if ($ArtifactKind) {
            "QUEUED artifact=$ArtifactKind source=$Commit declared=$now"
        } elseif ($Epic) {
            "QUEUED epic=true$autonomyMetadata phase=PLAN revision=1 completed=0 added=$now"
        } else {
            "QUEUED added=$now"
        }
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
        $effectiveAutonomy = if ($isEpic) { Get-EffectiveAutonomy $metadata $directionLines $base[2] } else { "plan-gated" }
        $autonomySuffix = if ($metadata.autonomy) { " autonomy=$($metadata.autonomy)" } else { "" }
        $safetySuffix = if ($metadata.safety) { " safety=$($metadata.safety)" } else { "" }

        switch ($Action) {
            "Retire" {
                $cleanNote = if ($null -eq $Note) { "" } else { ($Note -replace "\s+", " ").Trim().Replace("|", "/") }
                if (-not $cleanNote) { throw "Retire requires -Note." }
                if ($base[0] -match '\[x\]' -or $status -eq "DONE") { throw "$Id is already terminal and should not be retired." }
                if ($status -notin @("QUEUED", "IN_PROGRESS", "CANDIDATE", "BLOCKED")) { throw "$Id cannot be retired from status $status." }

                $before = if ($index -gt 0) { @($lines[0..($index - 1)]) } else { @() }
                $after = if ($index + 1 -lt $lines.Count) { @($lines[($index + 1)..($lines.Count - 1)]) } else { @() }
                $lines = @($before + $after)
                $retiredHeader = [Array]::IndexOf($lines, "## Retired")
                if ($retiredHeader -lt 0) {
                    $lines = @($lines + "" + "## Retired" + "")
                }
                $lines = @(
                    $lines +
                    "- id=$Id | retired=$now | note=$cleanNote" +
                    "  original: $originalLine"
                )
            }
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
                    $artifactSuffix = if ($metadata.artifact) { " artifact=$($metadata.artifact) source=$($metadata.source)" } else { "" }
                    $lines[$index] = ($base + "IN_PROGRESS$artifactSuffix role=$Role started=$now") -join " | "
                    break
                }
                $revision = if ($metadata.revision) { [int]$metadata.revision } else { 1 }
                $completed = if ($metadata.completed) { [int]$metadata.completed } else { 0 }
                if ($status -eq "QUEUED" -and $metadata.phase -eq "PLAN") {
                    $planSuffix = if ($metadata.plan) { " plan=$($metadata.plan)" } else { "" }
                    $lines[$index] = ($base + "IN_PROGRESS epic=true$autonomySuffix$safetySuffix phase=PLAN revision=$revision completed=$completed$planSuffix role=$Role started=$now") -join " | "
                    break
                }
                if ($status -eq "CANDIDATE" -and $metadata.candidate -eq "PLAN") {
                    $gate = if ($effectiveAutonomy -eq "full") { "auto-approved after independent validation" } else { "approved by a human" }
                    throw "Epic $Id plan must be $gate before a step turn can start."
                }
                if ($status -notin @("PLAN_APPROVED", "IN_PROGRESS")) {
                    throw "Epic $Id cannot start a step from status $status."
                }
                if ($metadata.authorityStatus -eq "pending") {
                    throw "Epic $Id has a pending exact authority request at checkpoint $($metadata.checkpoint)."
                }
                if ($metadata.authorityStatus -eq "denied") {
                    throw "Epic $Id authority request was denied at checkpoint $($metadata.checkpoint)."
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
                $lines[$index] = ($base + "IN_PROGRESS epic=true$autonomySuffix$safetySuffix phase=STEP revision=$revision completed=$completed step=$step/$total plan=$planPath role=$Role started=$now") -join " | "
            }
            "NormalizeQueued" {
                if ($base[0] -match '\[x\]') { throw "$Id is already complete." }
                if ($metadata.artifact) { throw "NormalizeQueued is not valid for artifact-only item $Id." }
                if ($isEpic) {
                    $planPath = if ($metadata.plan) { Assert-EpicPlanPath $metadata.plan $Id } else { "process/reciprocal/epics/$Id-plan.md" }
                    if ($status -eq "QUEUED" -and (-not $metadata.phase -or $metadata.phase -eq "PLAN")) {
                        $revision = if ($metadata.revision) { [int]$metadata.revision } else { 1 }
                        $completed = if ($metadata.completed) { [int]$metadata.completed } else { 0 }
                        $lines[$index] = ($base + "QUEUED epic=true$autonomySuffix$safetySuffix phase=PLAN revision=$revision completed=$completed plan=$planPath normalized=$now") -join " | "
                        break
                    }
                    throw "NormalizeQueued is valid only for queued plan items; $Id is $status."
                }
                if ($status -ne "QUEUED") { throw "NormalizeQueued requires a QUEUED item; $Id is $status." }
                $autonomy = "full"
                $planPath = "process/reciprocal/epics/$Id-plan.md"
                $lines[$index] = ($base + "QUEUED epic=true autonomy=$autonomy phase=PLAN revision=1 completed=0 plan=$planPath normalized=$now") -join " | "
            }
            "MigrateAuthorityMetadata" {
                if ($base[0] -match '\[x\]') { throw "$Id is already complete." }
                if (-not $isEpic) { throw "MigrateAuthorityMetadata requires an epic item." }
                if ($metadata.authority) { throw "MigrateAuthorityMetadata refuses to remove explicit authority metadata from $Id." }
                $planPath = if ($metadata.plan) { Assert-EpicPlanPath $metadata.plan $Id } else { "process/reciprocal/epics/$Id-plan.md" }
                $revision = if ($metadata.revision) { [int]$metadata.revision } else { 1 }
                $completed = if ($metadata.completed) { [int]$metadata.completed } else { 0 }
                $roleSuffix = if ($metadata.role) { " role=$($metadata.role)" } else { "" }
                $startedSuffix = if ($metadata.started) { " started=$($metadata.started)" } else { "" }
                $normalizedSuffix = if ($metadata.normalized) { " normalized=$($metadata.normalized)" } else { "" }
                $candidateSuffix = if ($metadata.commit) { " commit=$($metadata.commit)" } else { "" }
                $updatedSuffix = " migrated=$now"
                if ($status -eq "QUEUED" -and $metadata.phase -eq "PLAN") {
                    $lines[$index] = ($base + "QUEUED epic=true autonomy=full phase=PLAN revision=$revision completed=$completed plan=$planPath$normalizedSuffix$updatedSuffix") -join " | "
                    break
                }
                if ($status -eq "IN_PROGRESS" -and $metadata.phase -eq "PLAN") {
                    $lines[$index] = ($base + "IN_PROGRESS epic=true autonomy=full phase=PLAN revision=$revision completed=$completed plan=$planPath$roleSuffix$startedSuffix$updatedSuffix") -join " | "
                    break
                }
                if ($status -eq "CANDIDATE" -and $metadata.candidate -eq "PLAN") {
                    $stepsSuffix = if ($metadata.steps) { " steps=$($metadata.steps)" } else { "" }
                    $lines[$index] = ($base + "CANDIDATE epic=true autonomy=full candidate=PLAN revision=$revision completed=$completed$stepsSuffix plan=$planPath$candidateSuffix$updatedSuffix") -join " | "
                    break
                }
                if ($status -eq "PLAN_APPROVED") {
                    $stepsSuffix = if ($metadata.steps) { " steps=$($metadata.steps)" } else { "" }
                    $nextSuffix = if ($metadata.next) { " next=$($metadata.next)" } else { "" }
                    $approvalSuffix = if ($metadata.approval) { " approval=$($metadata.approval)" } else { "" }
                    $lines[$index] = ($base + "PLAN_APPROVED epic=true autonomy=full revision=$revision completed=$completed$stepsSuffix$nextSuffix plan=$planPath$candidateSuffix$approvalSuffix$updatedSuffix") -join " | "
                    break
                }
                if ($status -eq "IN_PROGRESS" -and $metadata.phase -eq "STEP") {
                    $stepSuffix = if ($metadata.step) { " step=$($metadata.step)" } else { "" }
                    $nextSuffix = if ($metadata.next) { " next=$($metadata.next)" } else { "" }
                    $lastSuffix = if ($metadata.last) { " last=$($metadata.last)" } else { "" }
                    $lines[$index] = ($base + "IN_PROGRESS epic=true autonomy=full phase=STEP revision=$revision completed=$completed$stepSuffix$nextSuffix plan=$planPath$lastSuffix$roleSuffix$startedSuffix$updatedSuffix") -join " | "
                    break
                }
                if ($status -eq "CANDIDATE" -and $metadata.candidate -eq "STEP") {
                    $stepSuffix = if ($metadata.step) { " step=$($metadata.step)" } else { "" }
                    $lines[$index] = ($base + "CANDIDATE epic=true autonomy=full candidate=STEP revision=$revision completed=$completed$stepSuffix plan=$planPath$candidateSuffix$updatedSuffix") -join " | "
                    break
                }
                throw "MigrateAuthorityMetadata does not support $Id in status $status with current metadata."
            }
            "DeclareAuthority" {
                if (-not $isEpic -or $status -ne "IN_PROGRESS" -or $metadata.phase -ne "STEP") {
                    throw "DeclareAuthority requires the exact current IN_PROGRESS epic STEP."
                }
                if (-not $metadata.role) { throw "DeclareAuthority requires an owned current step." }
                if ($metadata.authorityStatus -eq "pending") { throw "$Id already has a pending authority request." }
                if (-not $AuthKind -and $Text -match '^(.+?)__(.+?)__(.+?)__(.+?)$') {
                    $AuthKind = $Matches[1]
                    $AuthVerb = $Matches[2]
                    $Checkpoint = $Matches[3]
                    $ResumeToken = $Matches[4]
                }
                $kind = Get-CleanMetadataValue $AuthKind "authority kind"
                $authorityAction = Get-CleanMetadataValue $(if ($AuthVerb) { $AuthVerb } else { $Note }) "authority action"
                $checkpoint = Get-CleanMetadataValue $(if ($Checkpoint) { $Checkpoint } else { $Evidence }) "checkpoint"
                $resume = Get-CleanMetadataValue $(if ($ResumeToken) { $ResumeToken } else { $Commit }) "resume action"
                if ($kind -notin @("credentials", "authentication", "pairing", "permission", "sandbox", "destructive", "payment", "publication", "runtime")) { throw "authority kind '$kind' is not supported." }
                $lines[$index] = "$originalLine authority=$kind action=$authorityAction checkpoint=$checkpoint resume=$resume authorityStatus=pending authorityDeclared=$now"
            }
            "ApproveAuthority" {
                if (-not $isEpic -or $metadata.authorityStatus -ne "pending") {
                    throw "ApproveAuthority requires a pending exact authority request."
                }
                if ($AuthKind -and $AuthKind -ne $metadata.authority) { throw "ApproveAuthority kind mismatch for $Id." }
                Assert-AuthorityProof "approve" $Id $metadata
                $existing = $statusAndDetail -replace '\s+authorityStatus=pending\b', ' authorityStatus=approved'
                $lines[$index] = ($base + "$existing authorityApproved=$now") -join " | "
            }
            "DenyAuthority" {
                if (-not $isEpic -or $metadata.authorityStatus -ne "pending") {
                    throw "DenyAuthority requires a pending exact authority request."
                }
                Assert-AuthorityProof "deny" $Id $metadata
                $cleanNote = Get-CleanNote $Note
                if (-not $cleanNote) { throw "DenyAuthority requires -Note." }
                $preserved = ($statusAndDetail.Substring($status.Length)).Trim()
                $preserved = $preserved -replace '\s+authorityStatus=pending\b', ' authorityStatus=denied'
                $lines[$index] = ($base + "BLOCKED $preserved previous=$status authorityDenied=$now note=$cleanNote") -join " | "
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
                    if ($CompletedSteps -ge 0) {
                        if ($CompletedSteps -lt $completed) { throw "Epic $Id plan cannot reduce completed steps from $completed to $CompletedSteps." }
                        $completed = $CompletedSteps
                    }
                    if ($Steps -le $completed) { throw "Epic $Id plan requires more than $completed total steps." }
                    $planPath = Assert-EpicPlanPath $Plan $Id
                    if ($PlanRevision) { $revision += 1 }
                    $lines[$index] = ($base + "CANDIDATE epic=true$autonomySuffix$safetySuffix candidate=PLAN revision=$revision completed=$completed steps=$Steps plan=$planPath commit=$Commit updated=$now") -join " | "
                    break
                }
                if ($metadata.phase -ne "STEP" -or $metadata.step -notmatch '^(\d+)/(\d+)$') {
                    throw "Epic $Id step candidate metadata is malformed."
                }
                $step = [int]$Matches[1]
                $total = [int]$Matches[2]
                $planPath = Assert-EpicPlanPath $metadata.plan $Id
                $authoritySuffix = ""
                if ($metadata.authorityStatus -eq "approved") {
                    $authoritySuffix = " authority=$($metadata.authority) action=$($metadata.action) checkpoint=$($metadata.checkpoint) resume=$($metadata.resume) authorityStatus=consumed authorityConsumed=$now"
                }
                $lines[$index] = ($base + "CANDIDATE epic=true$autonomySuffix$safetySuffix candidate=STEP revision=$revision completed=$completed step=$step/$total plan=$planPath commit=$Commit$authoritySuffix updated=$now") -join " | "
            }
            "DeclareArtifact" {
                if ($env:TANDEM_ALLOW_MANUAL_DECLARE_ARTIFACT -ne "1") { throw "DeclareArtifact is reserved for trusted control-plane compatibility only; create artifact items with Add -ArtifactKind -Commit." }
                if (-not $Commit) { throw "DeclareArtifact requires the trusted artifact source -Commit." }
                if (-not $ArtifactKind) { throw "DeclareArtifact requires -ArtifactKind." }
                if ($isEpic) { throw "DeclareArtifact is only valid for non-epic wishlist items." }
                if ($status -ne "QUEUED") { throw "$Id must be QUEUED before declaring artifact mode." }
                if ($Commit -notmatch '^[0-9a-fA-F]{7,40}$') { throw "DeclareArtifact requires a source commit SHA." }
                $lines[$index] = ($base + "QUEUED artifact=$ArtifactKind source=$Commit declared=$now") -join " | "
            }
            "ArtifactComplete" {
                if (-not $Commit) { throw "ArtifactComplete requires -Commit." }
                if (-not $Role) { throw "ArtifactComplete requires -Role." }
                if (-not $ArtifactKind) { throw "ArtifactComplete requires -ArtifactKind." }
                if (-not $Evidence -or $Evidence -notmatch '^[A-Za-z0-9._:-]{6,128}$') { throw "ArtifactComplete requires machine-checkable -Evidence metadata." }
                if ($isEpic) { throw "ArtifactComplete is only valid for non-epic wishlist items." }
                if ($status -notin @("QUEUED", "IN_PROGRESS")) { throw "$Id cannot complete an artifact from status $status." }
                if (-not $metadata.artifact -or $metadata.artifact -ne $ArtifactKind) { throw "$Id is not declared for artifact $ArtifactKind." }
                if (-not $metadata.source -or $metadata.source -ne $Commit) { throw "$Id is not declared for source $Commit." }
                if ($status -eq "IN_PROGRESS" -and $metadata.role -and $metadata.role -ne $Role) {
                    throw "$Id is owned by role $($metadata.role), not $Role."
                }
                $base[0] = $base[0] -replace '^- \[ \]', '- [x]'
                $lines[$index] = ($base + "DONE artifact=$ArtifactKind source=$Commit evidence=$Evidence role=$Role completed=$now") -join " | "
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
                $lines[$index] = ($base + "PLAN_APPROVED epic=true$autonomySuffix$safetySuffix revision=$($metadata.revision) completed=$completed steps=$total next=$($completed + 1)/$total plan=$($metadata.plan) commit=$($metadata.commit) approved=$now$noteSuffix") -join " | "
            }
            "AutoApprovePlan" {
                if (-not $isEpic -or $status -ne "CANDIDATE" -or $metadata.candidate -ne "PLAN") {
                    throw "AutoApprovePlan requires an epic PLAN candidate."
                }
                if ($effectiveAutonomy -ne "full") { throw "Epic $Id is plan-gated and cannot be auto-approved." }
                if (-not $Commit -or -not $metadata.commit) { throw "AutoApprovePlan requires the independently accepted plan -Commit." }
                $stableRef = Get-GitValue @("rev-parse", "refs/tandem-relay/stable")
                $acceptedRef = Get-GitValue @("rev-parse", "$Commit^{commit}")
                $candidateRef = Get-GitValue @("rev-parse", "$($metadata.commit)^{commit}")
                if (-not $stableRef -or -not $acceptedRef -or -not $candidateRef -or $acceptedRef -ne $stableRef -or $candidateRef -ne $stableRef) {
                    throw "Epic $Id plan commit is not the independently accepted relay stable commit."
                }
                $completed = if ($metadata.completed) { [int]$metadata.completed } else { 0 }
                $total = [int]$metadata.steps
                if ($total -le $completed) { throw "Epic $Id plan has no unfinished steps." }
                $lines[$index] = ($base + "PLAN_APPROVED epic=true$autonomySuffix$safetySuffix revision=$($metadata.revision) completed=$completed steps=$total next=$($completed + 1)/$total plan=$($metadata.plan) commit=$stableRef approved=$now approval=auto") -join " | "
                Add-AutoApprovalAudit $ControlPath $Id $stableRef $metadata.plan
            }
            "RejectPlan" {
                if (-not $isEpic -or $status -ne "CANDIDATE" -or $metadata.candidate -ne "PLAN") {
                    throw "RejectPlan requires an epic PLAN candidate."
                }
                $cleanNote = Get-CleanNote $Note
                if (-not $cleanNote) { throw "RejectPlan requires -Note." }
                $completed = if ($metadata.completed) { [int]$metadata.completed } else { 0 }
                $lines[$index] = ($base + "QUEUED epic=true$autonomySuffix$safetySuffix phase=PLAN revision=$($metadata.revision) completed=$completed plan=$($metadata.plan) note=$cleanNote updated=$now") -join " | "
            }
            "AcceptStep" {
                if (-not $Commit) { throw "AcceptStep requires the accepted stable -Commit." }
                if (-not $isEpic -or $status -ne "CANDIDATE" -or $metadata.candidate -ne "STEP" -or $metadata.step -notmatch '^(\d+)/(\d+)$') {
                    throw "AcceptStep requires an epic STEP candidate."
                }
                $step = [int]$Matches[1]
                $total = [int]$Matches[2]
                if ($step -ge $total) { throw "Epic $Id final step must use Complete so the item moves CANDIDATE to DONE." }
                $lines[$index] = ($base + "IN_PROGRESS epic=true$autonomySuffix$safetySuffix phase=STEP revision=$($metadata.revision) completed=$step step=$step/$total next=$($step + 1)/$total plan=$($metadata.plan) last=$Commit updated=$now") -join " | "
            }
            "Complete" {
                if (-not $Commit) { throw "Complete requires the accepted stable -Commit." }
                if ($isEpic) {
                    if ($status -ne "CANDIDATE" -or $metadata.candidate -ne "STEP" -or $metadata.step -notmatch '^(\d+)/(\d+)$' -or $Matches[1] -ne $Matches[2]) {
                        throw "Epic $Id can complete only after its final STEP candidate is accepted."
                    }
                }
                $base[0] = $base[0] -replace '^- \[ \]', '- [x]'
                $epicSuffix = if ($isEpic) { " epic=true$autonomySuffix$safetySuffix steps=$($metadata.step) plan=$($metadata.plan)" } else { "" }
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
                if ($isEpic -and $effectiveAutonomy -eq "full" -and $cleanNote -and ($metadata.phase -eq "STEP" -or $metadata.candidate -in @("STEP", "PLAN"))) {
                    $completed = if ($metadata.completed) { [int]$metadata.completed } else { 0 }
                    $revision = $(if ($metadata.revision) { [int]$metadata.revision + 1 } else { 2 })
                    $lines[$index] = ($base + "QUEUED epic=true$autonomySuffix$safetySuffix phase=PLAN revision=$revision completed=$completed plan=$($metadata.plan) note=$cleanNote updated=$now") -join " | "
                    break
                }
                if ($isEpic -and $metadata.candidate -eq "STEP" -and $metadata.step -match '^(\d+)/(\d+)$') {
                    $noteSuffix = if ($cleanNote) { " note=$cleanNote" } else { "" }
                    $lines[$index] = ($base + "PLAN_APPROVED epic=true$autonomySuffix$safetySuffix revision=$($metadata.revision) completed=$($metadata.completed) steps=$($Matches[2]) next=$($Matches[1])/$($Matches[2]) plan=$($metadata.plan)$noteSuffix updated=$now") -join " | "
                    break
                }
                if ($isEpic -and $metadata.phase -eq "PLAN") {
                    $noteSuffix = if ($cleanNote) { " note=$cleanNote" } else { "" }
                    $lines[$index] = ($base + "QUEUED epic=true$autonomySuffix$safetySuffix phase=PLAN revision=$($metadata.revision) completed=$($metadata.completed) plan=$($metadata.plan)$noteSuffix updated=$now") -join " | "
                    break
                }
                if ($isEpic -and $metadata.phase -eq "STEP" -and $metadata.step -match '^(\d+)/(\d+)$') {
                    $step = [int]$Matches[1]
                    $total = [int]$Matches[2]
                    $completed = if ($metadata.completed) { [int]$metadata.completed } else { [Math]::Max(0, $step - 1) }
                    $retry = if ($metadata.next) { $metadata.next } elseif ($metadata.role) { "$step/$total" } else { "$($completed + 1)/$total" }
                    $noteSuffix = if ($cleanNote) { " note=$cleanNote" } else { "" }
                    $lines[$index] = ($base + "PLAN_APPROVED epic=true$autonomySuffix$safetySuffix revision=$($metadata.revision) completed=$completed steps=$total next=$retry plan=$($metadata.plan)$noteSuffix updated=$now") -join " | "
                    break
                }
                $suffix = if ($cleanNote) { "QUEUED note=$cleanNote updated=$now" } else { "QUEUED updated=$now" }
                $lines[$index] = ($base + $suffix) -join " | "
            }
        }
    }

    $tempPath = "$targetPath.tmp-$PID"
    [IO.File]::WriteAllLines($tempPath, [string[]]$lines, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tempPath -Destination $targetPath -Force
    [ordered]@{ action = $Action; id = $Id; path = $targetPath; directionPath = $ControlPath; wishlistPath = $WishlistPath } | ConvertTo-Json
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
