const token = document.querySelector('meta[name="control-token"]').content;
const state = { data: null, filter: "open", busy: false, revision: "", dirtyModelRoles: new Set() };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const relative = (date) => {
  if (!date) return "Never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(date).toLocaleDateString();
};

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", "X-Control-Token": token, ...(options.headers || {}) } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function hasDirtyInputs() {
  return state.dirtyModelRoles.size > 0
    || !$("#direction-form").hidden
    || Boolean($("#item-text").value.trim())
    || Boolean($("#update-comment").value.trim())
    || Boolean($("#main-update-comment").value.trim());
}

function toast(message) {
  const element = $("#toast"); element.textContent = message; element.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove("show"), 2600);
}

function setAlert(message) {
  const element = $("#alert"); element.hidden = !message; element.textContent = message || "";
}

async function refresh(silent = false, force = false) {
  try {
    if (state.revision && silent && !force && !hasDirtyInputs()) {
      const revision = await api("/api/revision");
      $("#updated").textContent = `Checked ${relative(revision.checkedAt)}`;
      if (revision.revision === state.revision) return;
    }
    if (silent && !force && hasDirtyInputs()) return;
    const [data, audit, revision] = await Promise.all([api("/api/status"), api("/api/audit"), api("/api/revision")]);
    state.revision = revision.revision;
    state.data = data; render(data, audit); setAlert("");
    if (!silent) toast("Status refreshed");
  } catch (error) { setAlert(error.message); }
}

function render(data, audit) {
  const relay = data.state;
  const supervisorDisplay = data.supervisor?.displayState || relay.phase || "Unknown";
  $("#updated").textContent = `Updated ${relative(data.now)}`;
  $("#phase").textContent = supervisorDisplay;
  $("#relay-pause").hidden = relay.phase === "paused";
  $("#relay-resume").hidden = relay.phase !== "paused";
  $("#turn").textContent = `Turn ${relay.turn ?? "--"}`;
  $("#next-role").textContent = relay.nextRole ? `Executor ${relay.nextRole}` : "--";
  const resumeCount = Number(relay.resumeCount || 0);
  const resumeThreshold = Number(relay.resumeThreshold || 3);
  const resumeSuffix = resumeCount ? ` · resumes ${resumeCount}/${resumeThreshold}` : "";
  $("#active-role").textContent = relay.activeRole ? `Active owner: ${relay.activeRole}${resumeSuffix}` : "No active owner";
  $("#stable").textContent = relay.shortStable || "Missing";
  const topology = data.runtimeTopology || {};
  const topologyHealth = topology.health || {};
  const online = topologyHealth.onlineCount ?? (Number(data.runtimes.a.running) + Number(data.runtimes.b.running));
  const expected = topologyHealth.expectedCount ?? 1;
  $("#online").textContent = `${online} / ${expected}`;
  $("#runtime-note").textContent = topologyHealth.detail || topology.label || "Checking runtime topology";
  $("#cycle-chip").textContent = relay.activeRole ? `${supervisorDisplay} · ${relay.activeRole}${resumeSuffix}` : `${supervisorDisplay} · next ${relay.nextRole || "--"}`;
  $("#gate-sha").textContent = relay.shortStable || "missing";
  $("#gate-copy").textContent = relay.candidateCommit ? `Candidate ${relay.shortCandidate} awaits ${relay.phase}` : "Passive-verified work advances";
  renderExecutor("a", data.runtimes.a, data.worktrees.b);
  renderExecutor("b", data.runtimes.b, data.worktrees.a);
  $("#general-direction").textContent = data.direction.general || "No general direction recorded.";
  const queued = data.direction.items.filter((item) => item.status === "QUEUED").sort((a, b) => a.priority.localeCompare(b.priority));
  $("#next-item").textContent = queued[0] ? `${queued[0].id} · ${queued[0].text}` : "No queued request";
  $("#wishlist-count").textContent = data.direction.items.filter((item) => !item.done).length;
  renderHealth(data.health);
  renderWishlist(data.direction.items);
  renderArtifactCapability(data.reciprocalCapabilities?.candidatePreviewArtifactLifecycle);
  renderModels(data.models);
  renderDrift(data);
  renderMainVersion(data.mainVersion, relay);
  renderReviewNote(data.candidateUpdate?.reviewNote);
  renderUpdateGate(data.candidateUpdate, data.runtimes);
  renderVersions(data);
  renderRecovery(data.recovery);
  renderActivity(data.history, audit);
}

function renderExecutor(key, runtime, target) {
  const card = $(`#executor-${key}`);
  const status = card.querySelector(".runtime-state");
  const expected = state.data?.runtimeTopology?.expectedOnline?.[key.toUpperCase()];
  status.textContent = runtime.running ? `Online · PID ${runtime.pid}` : expected === false ? "Dormant" : "Offline";
  status.classList.toggle("online", runtime.running);
  card.querySelector(".branch").textContent = target.branch;
  const drift = target.drift?.upToDate ? "" : ` · ${target.drift?.behindMaster ?? "?"} behind / ${target.drift?.aheadOfMaster ?? "?"} ahead master`;
  card.querySelector(".head").textContent = `${target.shortHead || "--"}${target.dirtyCount ? ` · ${target.dirtyCount} changes` : " · clean"}${drift}`;
  card.querySelector(".start-one").disabled = runtime.running || expected === false;
  card.querySelector(".stop-one").disabled = !runtime.running;
}

function renderDrift(data) {
  const chip = $("#drift-chip");
  if (!chip) return;
  chip.classList.toggle("warn", !data.drift?.ok);
  chip.textContent = data.drift?.ok ? `Synced with master ${data.master?.shortHead || "--"}` : `${data.drift.warnings.length} stale signal${data.drift.warnings.length === 1 ? "" : "s"}`;
  chip.title = data.drift?.warnings?.join("\n") || "Branches and runtimes match master";
}

function renderHealth(items) {
  const passing = items.filter((item) => item.ok).length;
  $("#health-total").textContent = `${passing}/${items.length} passing`;
  $("#health-list").innerHTML = items.map((item) => `<div class="health-item ${item.ok ? "" : "bad"}"><span class="health-icon">${item.ok ? "✓" : "!"}</span><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.detail)}</span></div>`).join("");
}

function renderWishlist(items) {
  let filtered = items;
  if (state.filter === "open") filtered = items.filter((item) => !item.done);
  if (state.filter === "done") filtered = items.filter((item) => item.done);
  const authorityRequest = state.data?.state?.authorityRequest || null;
  $("#wishlist-list").innerHTML = filtered.length ? filtered.map((item) => {
    const inProgress = item.status === "IN_PROGRESS";
    const epic = /(?:^|\s)epic=true(?:\s|$)/.test(item.detail || "");
    const autonomous = epic && item.effectiveAutonomy === "full";
    const role = (item.detail || "").match(/(?:^|\s)role=([AB])(?:\s|$)/)?.[1] || "";
    const planCandidate = epic && item.status === "CANDIDATE" && /(?:^|\s)candidate=PLAN(?:\s|$)/.test(item.detail || "");
    const step = (item.detail || "").match(/(?:^|\s)(?:step|next)=(\d+\/\d+)/)?.[1];
    const commit = (item.detail || "").match(/(?:^|\s)commit=([^\s]+)/)?.[1];
    const planValidated = planCandidate && commit && commit === state.data?.state?.stableCommit;
    const planGate = planCandidate && !autonomous ? `<button class="button small primary approve-epic-plan" type="button" data-id="${item.id}" ${planValidated ? "" : "disabled"} title="${planValidated ? "Approve this validated epic plan" : "Awaiting passive validation"}">Approve plan</button><button class="button small quiet reject-epic-plan" type="button" data-id="${item.id}">Reject plan</button>` : "";
    const autoStatus = planCandidate && autonomous ? `<span class="auto-plan-status">${planValidated ? "Validated; automatic approval pending" : "Awaiting passive validation"}</span>` : "";
    const replan = autonomous && !item.done && !(/(?:^|\s)phase=PLAN(?:\s|$)/.test(item.detail || "") && item.status === "QUEUED") ? `<button class="button small quiet replan-epic" type="button" data-id="${item.id}">Return to planning</button>` : "";
    const canDeclareAuthority = epic && inProgress && role && /(?:^|\s)phase=STEP(?:\s|$)/.test(item.detail || "") && !authorityRequest;
    const matchingAuthority = authorityRequest?.id === item.id ? authorityRequest : null;
    const authorityControls = matchingAuthority?.status === "pending"
      ? `<div class="authority-actions"><span class="auto-plan-status">Authority ${escapeHtml(matchingAuthority.authority)}:${escapeHtml(matchingAuthority.action)} at ${escapeHtml(matchingAuthority.checkpoint)}</span><button class="button small primary approve-authority" type="button">Approve authority</button><button class="button small danger deny-authority" type="button">Deny</button></div>`
      : canDeclareAuthority
        ? `<div class="authority-actions"><button class="button small quiet declare-authority" type="button" data-id="${item.id}" data-role="${role}">Declare authority checkpoint</button></div>`
        : matchingAuthority
          ? `<div class="authority-actions"><span class="auto-plan-status">Authority ${escapeHtml(matchingAuthority.status)}</span></div>`
          : "";
    const epicActions = planGate || autoStatus || replan || authorityControls ? `<div class="epic-actions">${planGate}${autoStatus}${replan}${authorityControls}</div>` : "";
    const planHistory = epic && item.planSteps?.length ? `<ol class="epic-history">${item.planSteps.map((entry) => `<li class="${entry.done ? "done" : ""}"><span>${entry.done ? "✓" : ""}</span>${escapeHtml(entry.text)}</li>`).join("")}</ol>` : "";
    return `<article class="wish-item ${epic ? "epic-item" : ""}"><div><span class="wish-id">${item.id}</span>${epic ? '<span class="epic-badge">EPIC</span>' : ""}${autonomous ? '<span class="autonomy-badge">AUTONOMOUS</span>' : ""}</div><div class="wish-copy"><p>${escapeHtml(item.text)}</p><span class="wish-detail">${escapeHtml(item.detail || "No additional metadata")}</span>${step ? `<span class="epic-step">Step ${escapeHtml(step)}</span>` : ""}${planHistory}${epicActions}</div><div class="wish-controls"><div><span class="priority ${item.priority}">${item.priority}</span><span class="wish-status">${item.status.replaceAll("_", " ")}</span></div><button class="button small quiet remove-wish" type="button" data-id="${item.id}" ${inProgress ? "disabled" : ""} title="${inProgress ? "Cannot remove an item while an executor owns it" : `Remove ${item.id} from the board`}">Remove</button></div></article>`;
  }).join("") : '<div class="panel">No items in this view.</div>';
}

function renderArtifactCapability(capability) {
  const button = $("#artifact-preview-create");
  const detail = $("#artifact-preview-state");
  if (!button || !detail) return;
  const ready = Boolean(capability?.compatible);
  const message = capability?.message || "Artifact build workflow requires Reciprocal executor upgrade.";
  button.disabled = !ready;
  button.title = ready ? "Queue an app-owned candidate preview artifact" : message;
  detail.textContent = message;
}

function renderModels(configs) {
  const cards = [configs.a, configs.b];
  const active = document.activeElement;
  if (active?.closest?.(".model-form")) return;
  if (state.dirtyModelRoles.size) return;
  $("#model-grid").innerHTML = cards.map((config) => {
    const selectedValue = (modelId) => {
      if (modelId === "claude-code/cli") return `claude-code/cli::model:${config.claudeCliModel || "default"}`;
      if (modelId === "codex/cli") return `codex/cli::effort:${config.codexCliReasoningEffort || "default"}`;
      return modelId;
    };
    const mediaBadge = (model) => {
      const values = [model.media?.images ? "img" : "", model.media?.pdf ? "pdf" : ""].filter(Boolean);
      return values.length ? ` [${values.join("+")}]` : "";
    };
    const unavailableText = (model) => {
      if (model.available) return "";
      if (model.provider === "codex-cli") return " (Codex CLI missing)";
      if (model.provider === "claude-code-cli") return " (Claude Code CLI missing)";
      return ` (${model.envKey || "configuration"} missing)`;
    };
    const option = (value, label, model, selected) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""} ${model.available ? "" : "disabled"}>${escapeHtml(label + mediaBadge(model) + unavailableText(model))}</option>`;
    const options = (selectedId) => {
      const selected = selectedValue(selectedId);
      return config.models.flatMap((model) => {
        if (model.id === "claude-code/cli") {
          const variants = [...new Set(["default", ...(config.claudeCliModelOptions || []), config.claudeCliModel].filter(Boolean))];
          return variants.map((variant) => {
            const value = `claude-code/cli::model:${variant}`;
            const label = `claude-code/cli (model ${variant === "default" ? "CLI default" : variant})`;
            return option(value, label, model, selected);
          });
        }
        if (model.id === "codex/cli") {
          return ["default", "minimal", "low", "medium", "high"].map((effort) => {
            const value = `codex/cli::effort:${effort}`;
            const modelName = config.codexCliModel || "CLI default";
            const label = `codex/cli (model ${modelName}${effort === "default" ? "" : `, reasoning ${effort}`})`;
            return option(value, label, model, selected);
          });
        }
        return [option(model.id, model.id, model, selected)];
      }).join("");
    };
    const selectedModels = [config.leader, config.worker].map((id) => config.models.find((model) => model.id === id)).filter(Boolean);
    const allReady = selectedModels.length === 2 && selectedModels.every((model) => model.available);
    return `<article class="panel model-card">
      <div class="panel-head"><div><p class="eyebrow">Tandem Copy ${config.role}</p><h2>Executor ${config.role}</h2></div><span class="status-chip">${config.running ? "Running" : "Stopped"}</span></div>
      <form class="model-form" data-role="${config.role}">
        <label>Leader model<select name="leader" ${config.running ? "disabled" : ""}>${options(config.leader)}</select></label>
        <label>Worker model<select name="worker" ${config.running ? "disabled" : ""}>${options(config.worker)}</select></label>
        <div class="model-meta"><span>${config.models.length} registered models</span><span class="${allReady ? "ready" : "missing"}">${allReady ? "Selected models ready" : "Selected model requirement missing"}</span></div>
        <div class="model-save-row"><span class="model-save-note">${config.running ? `Stop Executor ${config.role} to edit` : "Applies to the next session"}</span><button class="button primary" type="submit" ${config.running ? "disabled" : ""}>Save Copy ${config.role}</button></div>
      </form>
    </article>`;
  }).join("");
}

function renderUpdateGate(update, runtimes) {
  if (!update) return;
  const stateChip = $("#update-state");
  const reviewNote = update.reviewNote;
  const pendingReview = Boolean(update.pending || reviewNote?.visible);
  stateChip.classList.toggle("warn", pendingReview);
  stateChip.classList.toggle("bad", Boolean(update.unknownProvenance));
  stateChip.textContent = update.unknownProvenance ? "Unknown" : pendingReview ? "Review needed" : "No pending update";
  $("#update-message").textContent = update.message || "No candidate state available";
  $("#update-sha").textContent = update.expectedShortSha || update.shortSha || "--";
  $("#update-built").textContent = update.builtAt ? new Date(update.builtAt).toLocaleString() : "--";
  $("#update-ahead").textContent = update.pending ? `A +${update.aheadCounts?.A ?? "?"}, B +${update.aheadCounts?.B ?? "?"}` : update.reviewed ? `Reviewed ${update.reviewed.decision}` : "--";
  $("#update-preview").textContent = update.preview?.running ? `Running · PID ${update.preview.pid}` : "Stopped";
  $("#update-main-version").textContent = update.mainVersion || "No main-update tag";
  $("#update-runtime-versions").textContent = update.promoted?.map((item) => `${item.role}: ${item.mainVersion || "untagged"}`).join(" / ") || "--";
  $("#launch-candidate").disabled = !update.exists || update.preview?.running || Boolean(reviewNote?.ready && !reviewNote.previewReady) || Boolean(update.reviewed);
  $("#stop-candidate").disabled = !update.preview?.running;
  const canReview = Boolean(update.pending && !update.unknownProvenance && !update.reviewed);
  $$('#update-review-form button').forEach((button) => {
    button.disabled = !canReview;
    button.title = button.dataset.decision === "approve" && canReview ? "Safely pauses, stops, promotes, restarts, and resumes" : "";
  });
}

function renderReviewNote(note) {
  const banner = $("#review-note");
  if (!note?.visible) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  $("#review-note-sha").textContent = note.shortSha || "--";
  $("#review-note-summary").textContent = note.summary || "A verified build is waiting for functional review.";
  $("#review-note-message").textContent = note.message || "";
  const launch = $("#review-note-launch");
  launch.disabled = !note.previewReady;
  launch.textContent = note.previewReady ? "Launch preview" : "Preview not ready";
  launch.title = note.previewReady ? "Open the matching Launch Candidate preview build" : "Automated packaging has not produced the matching Launch Candidate build yet";
}

function renderMainVersion(version, relay) {
  if (!version) return;
  const pending = version.pendingStableCommits;
  $("#main-version").textContent = version.label;
  $("#main-stable").textContent = version.stableShortSha || "missing";
  $("#main-pending").textContent = pending == null ? "Stable is not based on the latest tag" : String(pending);
  $("#main-update-message").textContent = version.tag
    ? `${pending || 0} verified stable commit${pending === 1 ? "" : "s"} waiting for the next main update.`
    : "Master has no main-update tag yet. The first approved integration will create main-update-001.";
  const chip = $("#main-update-state");
  const blocked = Boolean(relay.activeRole || !["idle", "paused"].includes(relay.phase));
  chip.classList.toggle("warn", Boolean(pending));
  chip.classList.toggle("bad", blocked);
  chip.textContent = blocked ? "Active turn" : pending ? `${pending} pending` : "Ready";
  const submit = $("#main-update-form button[type=submit]");
  submit.disabled = blocked;
  submit.title = blocked ? "Wait for the active reciprocal turn to finish" : "";
}

function renderVersions(data) {
  const cards = [
    { title: "Copy A", subtitle: "Passive B test target", value: data.worktrees.a },
    { title: "Stable", subtitle: "Passive acceptance gate", stable: true, value: { shortHead: data.state.shortStable, branch: "refs/tandem-relay/stable", version: data.worktrees.a.version, dirtyCount: 0, subject: data.state.lastSummary || "Confirmed recovery point" } },
    { title: "Copy B", subtitle: "Produced by Executor A", value: data.worktrees.b },
    { title: "Runtime A", subtitle: "Producer runtime", runtime: true, value: data.runtimes.a },
    { title: "Runtime B", subtitle: "Passive target runtime", runtime: true, value: data.runtimes.b },
  ];
  $("#version-grid").innerHTML = cards.map(({ title, subtitle, value, stable, runtime }) => {
    if (runtime) {
      const expected = state.data?.runtimeTopology?.expectedOnline?.[value.role];
      return `<article class="version-card ${value.lagsMaster ? "lagging" : "stable"}"><p class="eyebrow">${escapeHtml(subtitle)}</p><h2>${title}</h2><dl><div><dt>Build</dt><dd><code>${escapeHtml(value.buildShortSha || "--")}</code></dd></div><div><dt>Compared to master</dt><dd>${value.lagsMaster ? "lags master" : "current"}</dd></div><div><dt>Promoted</dt><dd>${escapeHtml(value.buildInfo?.promotedRound || "--")}</dd></div><div><dt>Built at</dt><dd>${escapeHtml(value.builtAt ? relative(value.builtAt) : "missing")}</dd></div><div><dt>Runtime</dt><dd>${value.running ? `online PID ${value.pid}` : expected === false ? "dormant" : "offline"}</dd></div></dl></article>`;
    }
    const branchDrift = value.drift ? `${value.drift.behindMaster} behind / ${value.drift.aheadOfMaster} ahead master` : "n/a";
    return `<article class="version-card ${stable ? "stable" : value.drift?.upToDate ? "" : "lagging"}"><p class="eyebrow">${escapeHtml(subtitle)}</p><h2>${title}</h2><dl><div><dt>Commit</dt><dd><code>${escapeHtml(value.shortHead || "--")}</code></dd></div><div><dt>Branch/ref</dt><dd>${escapeHtml(value.branch)}</dd></div><div><dt>Vs master</dt><dd>${escapeHtml(branchDrift)}</dd></div><div><dt>Package</dt><dd>v${escapeHtml(value.version)}</dd></div><div><dt>Worktree</dt><dd>${value.dirtyCount ? `${value.dirtyCount} changes` : "clean"}</dd></div><div><dt>Latest</dt><dd>${escapeHtml(value.subject)}</dd></div></dl></article>`;
  }).join("");
  $("#version-history").innerHTML = data.history.map((item) => `<div class="history-row"><code>${item.short}</code><span>${escapeHtml(item.subject)}</span><time>${new Date(item.date).toLocaleString()}</time></div>`).join("");
}

function renderRecovery(plan) {
  $("#recovery-title").textContent = plan.title;
  $("#recovery-summary").textContent = plan.summary;
  $("#recovery-workspace").textContent = plan.workspace || "Select the active target worktree";
  $("#recovery-mark").textContent = plan.level === "safe" ? "✓" : "!";
  $("#recovery-commands").innerHTML = plan.commands.map((command, index) => `<div class="command"><span class="command-index">${String(index + 1).padStart(2, "0")}</span><code>${escapeHtml(command)}</code><button class="copy-one" data-command="${encodeURIComponent(command)}">COPY</button></div>`).join("");
}

function renderActivity(history, audit) {
  $("#git-activity").innerHTML = history.slice(0, 12).map((item) => `<div class="timeline-item"><span class="timeline-dot"></span><div><p>${escapeHtml(item.subject)}</p><small>${item.short} · ${relative(item.date)}</small></div></div>`).join("");
  $("#control-activity").innerHTML = audit.length ? audit.map((item) => `<div class="timeline-item"><span class="timeline-dot"></span><div><p>${escapeHtml(item.action)}</p><small>${relative(item.at)}${item.role ? ` · ${escapeHtml(item.role)}` : ""}</small></div></div>`).join("") : '<p class="small-print">No panel actions recorded yet.</p>';
}

async function executorAction(action, role) {
  if (state.busy) return;
  let confirmedActiveTurn = false;
  const relay = state.data?.state;
  const stopsOwner = action === "stop" && relay?.activeRole && (role === "Both" || role === relay.activeRole)
    && ["working", "validating", "rollback-verification"].includes(relay.phase);
  if (stopsOwner) {
    confirmedActiveTurn = window.confirm(`Executor ${relay.activeRole} owns an active ${relay.phase} turn. Stop it anyway? Its durable checkpoint can resume after restart.`);
    if (!confirmedActiveTurn) return;
  }
  state.busy = true; setAlert("");
  try {
    await api(`/api/executor/${action}`, { method: "POST", body: JSON.stringify({ role, confirmedActiveTurn }) });
    toast(`${role === "Both" ? "Both executors" : `Executor ${role}`} ${action === "start" ? "started" : "stopped"}`);
    setTimeout(() => refresh(true, true), 900);
  } catch (error) { setAlert(error.message); } finally { state.busy = false; }
}

$$('.nav-item').forEach((button) => button.addEventListener("click", () => {
  $$('.nav-item').forEach((item) => item.classList.remove("active")); button.classList.add("active");
  $$('.view').forEach((view) => view.classList.remove("active")); $(`#${button.dataset.view}-view`).classList.add("active");
  const titles = { overview: "Reciprocal overview", wishlist: "Wishlist control", models: "Model configuration", versions: "Version inventory", recovery: "Recovery center", activity: "Activity and evidence" };
  $("#view-title").textContent = titles[button.dataset.view];
}));

$("#refresh").addEventListener("click", () => refresh());
$("#relay-pause").addEventListener("click", async () => {
  const reason = prompt("Pause relay reason", "human paused from dashboard");
  if (!reason?.trim()) return;
  try {
    await api("/api/relay/pause", { method: "POST", body: JSON.stringify({ reason }) });
    toast("Relay paused");
    await refresh(true, true);
  } catch (error) { setAlert(error.message); }
});
$("#relay-resume").addEventListener("click", async () => {
  const reason = prompt("Resume relay reason", "human resumed from dashboard");
  if (!reason?.trim()) return;
  try {
    await api("/api/relay/resume", { method: "POST", body: JSON.stringify({ reason }) });
    toast("Relay resumed");
    await refresh(true, true);
  } catch (error) { setAlert(error.message); }
});
$("#kickstart").addEventListener("click", async () => {
  const status = $("#kickstart-status");
  $("#kickstart").disabled = true;
  status.hidden = false;
  status.textContent = "Starting Executor A and waiting for its authenticated endpoint...";
  try {
    const response = await api("/api/executor/kickstart", { method: "POST", body: JSON.stringify({}) });
    const result = response.result;
    status.innerHTML = result.steps.map((step) => `<span class="kickstart-step ok">${escapeHtml(step.step)}: ${escapeHtml(step.detail)}</span>`).join("");
    setAlert("");
    toast("Background reciprocal turn started");
    await refresh(true, true);
  } catch (error) {
    status.innerHTML = `<span class="kickstart-step bad">Kickstart stopped: ${escapeHtml(error.message)}</span>`;
    setAlert(error.message);
  } finally {
    $("#kickstart").disabled = false;
  }
});
$("#start-all").addEventListener("click", () => executorAction("start", "Both"));
$("#stop-all").addEventListener("click", () => executorAction("stop", "Both"));
$("#quit-dashboard").addEventListener("click", async () => {
  if (!confirm("Quit the local dashboard backend and close this panel? Producer A and passive target B will keep their current state.")) return;
  try {
    await api("/api/quit", { method: "POST", body: JSON.stringify({ reason: "Quit panel button" }) });
  } catch {
    // The server may close before the response fully settles.
  }
  document.body.innerHTML = '<main class="quit-screen"><section class="panel"><p class="eyebrow">Dashboard closed</p><h1>Control panel backend stopped</h1><p>You can reopen it with the launch BAT when you need it again.</p></section></main>';
  setTimeout(() => window.close(), 250);
});
$("#recovery-stop").addEventListener("click", () => executorAction("stop", "Both"));
$$('.start-one').forEach((button) => button.addEventListener("click", () => executorAction("start", button.dataset.role)));
$$('.stop-one').forEach((button) => button.addEventListener("click", () => executorAction("stop", button.dataset.role)));
$("#item-text").addEventListener("input", (event) => { $("#char-count").textContent = `${event.target.value.length} / 1000`; });
$("#edit-direction").addEventListener("click", () => {
  const text = state.data?.direction.general || "";
  $("#direction-text").value = text;
  $("#direction-count").textContent = `${text.length} / 4000`;
  $("#general-direction").hidden = true;
  $("#direction-form").hidden = false;
  $("#direction-text").focus();
});
$("#cancel-direction").addEventListener("click", () => {
  $("#direction-form").hidden = true;
  $("#general-direction").hidden = false;
});
$("#direction-text").addEventListener("input", (event) => { $("#direction-count").textContent = `${event.target.value.length} / 4000`; });
$("#direction-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("#direction-text").value.trim();
  if (!text) return;
  const submit = event.submitter;
  submit.disabled = true;
  try {
    await api("/api/direction", { method: "POST", body: JSON.stringify({ text }) });
    $("#direction-form").hidden = true;
    $("#general-direction").hidden = false;
    toast("General direction updated");
    await refresh(true, true);
  } catch (error) { setAlert(error.message); } finally { submit.disabled = false; }
});
$("#model-grid").addEventListener("submit", async (event) => {
  const form = event.target.closest(".model-form");
  if (!form) return;
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    await api("/api/models", { method: "POST", body: JSON.stringify({ role: form.dataset.role, ...values }) });
    state.dirtyModelRoles.delete(form.dataset.role);
    toast(`Copy ${form.dataset.role} models updated`);
    await refresh(true, true);
  } catch (error) { setAlert(error.message); } finally { submit.disabled = false; }
});
$("#model-grid").addEventListener("change", (event) => {
  const form = event.target.closest(".model-form");
  if (!form) return;
  state.dirtyModelRoles.add(form.dataset.role);
  const note = form.querySelector(".model-save-note");
  if (note) note.textContent = "Unsaved changes";
});

async function updateAction(path, success) {
  state.busy = true;
  try {
    await api(path, { method: "POST", body: JSON.stringify({}) });
    toast(success);
    await refresh(true, true);
  } catch (error) { setAlert(error.message); } finally { state.busy = false; }
}

async function backupAction() {
  if (state.busy) return;
  state.busy = true;
  try {
    const payload = await api("/api/git/backup", { method: "POST", body: JSON.stringify({}) });
    toast(payload.result?.stable?.ok ? "Reciprocal branches and stable ref backed up" : "Branches backed up; stable ref needs attention");
    $("#approve-backup").hidden = true;
    await refresh(true, true);
  } catch (error) { setAlert(error.message); } finally { state.busy = false; }
}

function renderApprovalFlow(flow) {
  const panel = $("#approval-progress");
  if (!flow || (!flow.active && !flow.status)) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const labels = { running: "Applying approved update", waiting: "Waiting for active turn to finish", completed: "Approval completed", failed: "Approval stopped", cancelled: "Approval cancelled" };
  $("#approval-current").textContent = labels[flow.status] || flow.current || "Approval operation";
  $("#approval-detail").textContent = flow.error || (flow.status === "waiting"
    ? "The relay is draining to a safe checkpoint. Cancel the wait, or deliberately stop the active executor and resume from checkpoint after restart."
    : flow.remaining?.length ? `Remaining: ${flow.remaining.join("; ")}` : `Current step: ${flow.current || "starting"}`);
  $("#approval-cancel").hidden = flow.status !== "waiting";
  $("#approval-override").hidden = flow.status !== "waiting";
  $("#approval-steps").innerHTML = (flow.steps || []).map((step) => `<span class="approval-step">${escapeHtml(step.step)}: ${escapeHtml(step.detail)}</span>`).join("");
}

async function pollApprovalFlow() {
  clearInterval(state.approvalPoll);
  const update = async () => {
    try {
      const payload = await api("/api/update/approve/status");
      renderApprovalFlow(payload.flow);
      if (!payload.flow.active) clearInterval(state.approvalPoll);
    } catch (error) {
      clearInterval(state.approvalPoll);
      setAlert(error.message);
    }
  };
  await update();
  state.approvalPoll = setInterval(update, 700);
}

$("#launch-candidate").addEventListener("click", () => updateAction("/api/update/launch-candidate", "Candidate preview launched"));
$("#review-note-launch").addEventListener("click", () => updateAction("/api/update/launch-candidate", "Candidate preview launched"));
$("#review-note-dismiss").addEventListener("click", async () => {
  const comment = window.prompt("Record this accepted SHA as reviewed", "Reviewed the functional change; no runtime promotion requested.");
  if (comment === null) return;
  try {
    await api("/api/update/dismiss-review", { method: "POST", body: JSON.stringify({ comment }) });
    toast("Review decision recorded");
    await refresh(true, true);
  } catch (error) { setAlert(error.message); }
});
$("#stop-candidate").addEventListener("click", () => updateAction("/api/update/stop-candidate", "Candidate preview stopped"));
$("#backup-github").addEventListener("click", backupAction);
$("#approve-backup").addEventListener("click", backupAction);
$("#approval-cancel").addEventListener("click", async () => {
  try {
    await api("/api/update/approve/cancel", { method: "POST", body: JSON.stringify({}) });
    toast("Approval wait cancellation requested");
  } catch (error) { setAlert(error.message); }
});
$("#approval-override").addEventListener("click", async () => {
  if (!window.confirm("Stop the active executor now? The turn will rely on its durable checkpoint to resume after the hidden restart.")) return;
  try {
    await api("/api/update/approve/override", { method: "POST", body: JSON.stringify({ confirmed: true }) });
    toast("Checkpoint stop authorized");
  } catch (error) { setAlert(error.message); }
});
$("#update-review-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const decision = event.submitter?.dataset?.decision;
  const comment = $("#update-comment").value.trim();
  const path = decision === "approve" ? "/api/update/approve" : "/api/update/reject";
  event.submitter.disabled = true;
  try {
    if (decision === "approve") {
      renderApprovalFlow({ active: true, status: "running", current: "boundary-check", steps: [] });
      setTimeout(() => pollApprovalFlow(), 150);
    }
    const payload = await api(path, { method: "POST", body: JSON.stringify({ comment }) });
    $("#update-comment").value = "";
    if (payload.offerBackup) $("#approve-backup").hidden = false;
    if (payload.result) renderApprovalFlow(payload.result);
    toast(decision === "approve"
      ? "Candidate promoted; hidden executors restarted"
      : `Candidate rejected; ${payload.wishlistId || "follow-up"} queued for the next :07/:37 run`);
    await refresh(true, true);
  } catch (error) {
    setAlert(error.message);
    if (decision === "approve") {
      const status = await api("/api/update/approve/status").catch(() => null);
      if (status) renderApprovalFlow(status.flow);
    }
  } finally { event.submitter.disabled = false; }
});
$("#main-update-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const comment = $("#main-update-comment").value.trim();
  if (!comment) return;
  const confirmed = window.confirm("Update master from the verified stable ref, create and push an annotated tag, then re-synchronize both reciprocal branches?");
  if (!confirmed) return;
  const submit = event.submitter;
  submit.disabled = true;
  state.busy = true;
  try {
    const payload = await api("/api/main/update", { method: "POST", body: JSON.stringify({ comment, confirmed: true }) });
    $("#main-update-comment").value = "";
    toast(`Master updated as ${payload.result.tag}`);
    await refresh(true, true);
  } catch (error) { setAlert(error.message); } finally { submit.disabled = false; state.busy = false; }
});
$("#wishlist-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("#item-text").value.trim(); if (!text) return;
  const submit = event.submitter; submit.disabled = true;
  try {
    await api("/api/wishlist", { method: "POST", body: JSON.stringify({ text, priority: $("#item-priority").value, epic: $("#item-epic").checked, autonomy: $("#item-autonomous").checked ? "full" : "inherit" }) });
    $("#item-text").value = ""; $("#item-epic").checked = false; $("#item-autonomous").checked = false; $("#item-autonomous").disabled = true; $("#char-count").textContent = "0 / 1000"; toast("Wishlist item added"); await refresh(true, true);
  } catch (error) { setAlert(error.message); } finally { submit.disabled = false; }
});
$("#artifact-preview-create").addEventListener("click", async (event) => {
  const submit = event.currentTarget;
  submit.disabled = true;
  try {
    const payload = await api("/api/wishlist/artifact", { method: "POST", body: JSON.stringify({ kind: "candidate-preview" }) });
    toast(`${payload.result.id} queued for candidate preview review`);
    await refresh(true, true);
  } catch (error) { setAlert(error.message); } finally { submit.disabled = false; }
});
$("#item-epic").addEventListener("change", (event) => {
  $("#item-autonomous").disabled = !event.target.checked;
  if (!event.target.checked) $("#item-autonomous").checked = false;
});
$("#wishlist-list").addEventListener("click", async (event) => {
  const button = event.target.closest(".remove-wish");
  if (!button || button.disabled) return;
  const id = button.dataset.id;
  const note = window.prompt(`Why are you removing ${id}? This reason will be kept in removal history.`);
  if (!note?.trim()) return;
  if (!window.confirm(`Remove ${id} from the active wishlist? Its full original line and your reason will remain under Removed.`)) return;
  button.disabled = true;
  try {
    await api("/api/wishlist/remove", { method: "POST", body: JSON.stringify({ id, note: note.trim() }) });
    toast(`${id} removed; history preserved`);
    await refresh(true, true);
  } catch (error) { setAlert(error.message); } finally { button.disabled = false; }
});
$("#wishlist-list").addEventListener("click", async (event) => {
  const button = event.target.closest(".replan-epic");
  if (!button) return;
  const id = button.dataset.id;
  const note = window.prompt(`Why should ${id} return to planning? Pause the relay first if an executor is active.`);
  if (!note?.trim() || !window.confirm(`Reject ${id}'s current autonomous plan and return it to a plan-only turn?`)) return;
  button.disabled = true;
  try {
    await api("/api/wishlist/requeue", { method: "POST", body: JSON.stringify({ id, note: note.trim() }) });
    toast(`${id} returned to planning`);
    await refresh(true, true);
  } catch (error) { setAlert(error.message); } finally { button.disabled = false; }
});
$("#wishlist-list").addEventListener("click", async (event) => {
  const approve = event.target.closest(".approve-epic-plan");
  const reject = event.target.closest(".reject-epic-plan");
  if (!approve && !reject) return;
  const button = approve || reject;
  if (button.disabled) return;
  const id = button.dataset.id;
  const note = window.prompt(approve ? `Optional approval comment for ${id}` : `Why should ${id}'s plan be revised?`);
  if (note === null || (reject && !note.trim())) return;
  const decision = approve ? "approve" : "reject";
  if (!window.confirm(`${decision === "approve" ? "Approve" : "Reject"} the validated plan for ${id}?`)) return;
  button.disabled = true;
  try {
    await api(`/api/wishlist/${decision}-plan`, { method: "POST", body: JSON.stringify({ id, note: note.trim() }) });
    toast(`${id} plan ${decision === "approve" ? "approved" : "returned for revision"}`);
    await refresh(true, true);
  } catch (error) { setAlert(error.message); } finally { button.disabled = false; }
});
$("#wishlist-list").addEventListener("click", async (event) => {
  const declareButton = event.target.closest(".declare-authority");
  const approveButton = event.target.closest(".approve-authority");
  const denyButton = event.target.closest(".deny-authority");
  const button = declareButton || approveButton || denyButton;
  if (!button) return;
  button.disabled = true;
  try {
    if (declareButton) {
      const id = declareButton.dataset.id;
      const role = declareButton.dataset.role;
      const kind = window.prompt(`Authority kind for ${id} (permission, sandbox, credentials, runtime, etc.)`);
      if (!kind) return;
      const action = window.prompt("Exact authority action token");
      if (!action) return;
      const checkpoint = window.prompt("Exact checkpoint token");
      if (!checkpoint) return;
      const resume = window.prompt("Exact resume token");
      if (!resume) return;
      if (!window.confirm(`Pause ${id} at ${checkpoint} for human authority ${kind}:${action}?`)) return;
      await api("/api/authority/declare", { method: "POST", body: JSON.stringify({ id, role, kind: kind.trim(), action: action.trim(), checkpoint: checkpoint.trim(), resume: resume.trim() }) });
      toast(`${id} authority checkpoint declared`);
    } else if (approveButton) {
      if (!window.confirm("Approve this exact authority checkpoint and resume its owner once?")) return;
      await api("/api/authority/approve", { method: "POST", body: JSON.stringify({ confirmed: true }) });
      toast("Authority approved");
    } else {
      const note = window.prompt("Why is this authority denied?");
      if (!note?.trim()) return;
      if (!window.confirm("Deny this authority request and keep the checkpoint stopped?")) return;
      await api("/api/authority/deny", { method: "POST", body: JSON.stringify({ note: note.trim() }) });
      toast("Authority denied");
    }
    await refresh(true, true);
  } catch (error) { setAlert(error.message); } finally { button.disabled = false; }
});
$$('#wishlist-filter button').forEach((button) => button.addEventListener("click", () => {
  $$('#wishlist-filter button').forEach((item) => item.classList.remove("active")); button.classList.add("active"); state.filter = button.dataset.filter; renderWishlist(state.data.direction.items);
}));
document.addEventListener("click", async (event) => {
  const button = event.target.closest(".copy-one"); if (!button) return;
  await navigator.clipboard.writeText(decodeURIComponent(button.dataset.command)); toast("Command copied");
});
$("#copy-runbook").addEventListener("click", async () => {
  const plan = state.data.recovery; await navigator.clipboard.writeText(`cd \"${plan.workspace}\"\n${plan.commands.join("\n")}`); toast("Runbook copied");
});

refresh(true);
setInterval(() => refresh(true), 15_000);
