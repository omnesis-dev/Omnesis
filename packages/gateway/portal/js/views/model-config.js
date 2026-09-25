// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The Models configuration flows, shared by the capability page and the
// Backends page:
//
//   • ModelConfigModal   — "Choose a <capability> model": a grid of backend
//                          options (Local, presets, custom HTTP backends,
//                          Anthropic, + a custom backend), each leading to the
//                          model selection (configuring the backend inline
//                          first when it isn't set up yet).
//   • AddBackendModal    — "Add a backend": the same grid in configure-only
//                          mode (no Local, no model selection at the end).
//
// Backends are global, so both flows read and write the same backend set: a
// backend you add anywhere is immediately available to every capability.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { getRecentModels } from "../api.js";
import { Modal } from "../components/modal.js";
import { ProviderIcon } from "../components/provider-icon.js";
import { filterBackendModels } from "../lib/backend-model-filter.js";
import { fuzzyMatchFields } from "../lib/fuzzy-match.js";
import {
  buildModelPickerOptions,
  buildAddBackendOptions,
  CAPABILITY_TO_CATALOG,
  isAnthropicConfigured,
  catalogProviderForBackend,
} from "../lib/backend-options.js";
import { formatBytes, fit } from "../lib/model-format.js";

const RESERVED_BACKEND_NAMES = ["local", "anthropic", "codex", "replay"];

const plural = (n, noun) => `${n} ${noun}${n !== 1 ? "s" : ""}`;

const ACTIVE_CODEX_UPDATE_STATES = new Set([
  "checking",
  "downloading",
  "verifying",
  "waiting-for-turns",
  "activating",
  "refreshing-models",
]);

const CODEX_UPDATE_PHASES = {
  checking: "Checking the runtime…",
  downloading: "Downloading the tested runtime…",
  verifying: "Verifying the new runtime…",
  "waiting-for-turns": "Waiting for active Codex work to finish…",
  activating: "Switching runtimes…",
  "refreshing-models": "Refreshing the model list…",
};

const CANCELLABLE_CODEX_UPDATE_STATES = new Set(["checking", "downloading", "verifying"]);

export function codexRuntimeUpdatePresentation(update) {
  const plan = update?.plan ?? update;
  const operation = update?.operation ?? null;
  if (operation && ACTIVE_CODEX_UPDATE_STATES.has(operation.state)) {
    return { tone: "busy", label: "Updating", action: null, active: true };
  }
  switch (plan?.state) {
    case "up-to-date":
      return { tone: "good", label: "Up to date", action: null, active: false };
    case "update-available":
      return { tone: "warn", label: "Update available", action: "update", active: false };
    case "repair-needed":
      return { tone: "bad", label: "Repair needed", action: "repair", active: false };
    case "externally-managed":
      return { tone: "neutral", label: "Managed externally", action: null, active: false };
    default:
      return { tone: "neutral", label: "Runtime status unavailable", action: null, active: false };
  }
}

export function CodexRuntimePanel({ overview, update, loginPending = false, switchPending = false, onUpdate, onCancel, onSwitchRole, onDismissResult }) {
  const codex = overview.inference?.codex;
  const runtime = codex?.runtime;
  const plan = update?.plan ?? update;
  const operation = update?.operation ?? null;
  const presentation = codexRuntimeUpdatePresentation(update);
  const currentVersion = plan?.currentVersion ?? runtime?.packageVersion ?? runtime?.version;
  const targetVersion = plan?.state === "externally-managed"
    ? null
    : plan?.targetVersion ?? operation?.toVersion;
  const finishedSuccessfully = operation?.state === "complete";
  const failed = operation && ["failed", "rolled-back", "canceled"].includes(operation.state);
  const newModels = operation?.newModels ?? [];
  const assigned = Object.entries(overview.inference?.assignments ?? {})
    .filter(([, value]) => value?.kind === "codex" || (typeof value === "string" && value.startsWith("codex/")))
    .map(([role, value]) => {
      const model = typeof value === "string" ? value.slice("codex/".length) : value.model;
      const cap = (overview.capabilities ?? []).find((entry) => entry.role === role);
      return { role, title: cap?.title ?? role, model };
    });

  return html`
    <section class="codex-runtime-card">
      <div class="codex-runtime-head">
        <div>
          <div class="codex-runtime-title">Codex runtime</div>
          <div class="codex-runtime-versions">
            ${currentVersion ? html`Installed ${currentVersion}` : "Installed version unknown"}
            ${targetVersion ? html`<span>Tested ${targetVersion}</span>` : null}
          </div>
        </div>
        <span class="codex-runtime-state codex-runtime-state--${presentation.tone}">${presentation.label}</span>
      </div>

      ${plan?.state === "externally-managed"
        ? html`<div class="codex-runtime-note">
            Runtime managed externally. Update it outside Omnesis, then restart the gateway.
            ${runtime?.command ? html`<code>${runtime.command}</code>` : null}
          </div>`
        : null}

      ${plan?.reason && !presentation.active ? html`<div class="codex-runtime-note">${plan.reason}</div>` : null}

      ${presentation.active
        ? html`<div class="codex-runtime-progress" role="status">
            <span class="codex-runtime-spinner" aria-hidden="true"></span>
            <div>
              <div>${CODEX_UPDATE_PHASES[operation.state] ?? "Updating Codex…"}</div>
              ${operation.state === "waiting-for-turns" && operation.activeTurns > 0
                ? html`<small>${plural(operation.activeTurns, "active turn")} remaining</small>`
                : null}
            </div>
            ${onCancel && CANCELLABLE_CODEX_UPDATE_STATES.has(operation.state)
              ? html`<button class="btn-tiny" onClick=${onCancel}>Cancel</button>`
              : null}
          </div>`
        : null}

      ${finishedSuccessfully
        ? html`<div class="codex-runtime-result codex-runtime-result--good" role="status">
            <div><strong>Codex updated to ${operation.toVersion ?? targetVersion}.</strong></div>
            ${newModels.length
              ? html`<div>New models available: ${newModels.join(", ")}</div>`
              : codex?.loggedIn
              ? html`<div>The model catalog is current; no new selectable models were added.</div>`
              : html`<div>Log in to Codex, then refresh the model list.</div>`}
            ${assigned.map((entry) => html`<div class="codex-runtime-assignment" key=${entry.role}>
              <span>${entry.title} currently uses ${entry.model}.</span>
              ${onSwitchRole && newModels.length
                ? html`<button class="btn-tiny" disabled=${switchPending} aria-label=${`Switch ${entry.title} model`} onClick=${() => onSwitchRole(entry.role)}>Switch model</button>`
                : null}
            </div>`)}
            ${onDismissResult ? html`<button class="btn-tiny" onClick=${onDismissResult}>Keep current model</button>` : null}
          </div>`
        : null}

      ${failed
        ? html`<div class="codex-runtime-result codex-runtime-result--bad" role="status">
            <strong>${operation.state === "rolled-back" ? "Update failed; the previous runtime is still active." : operation.state === "canceled" ? "Runtime update canceled." : "Runtime update failed."}</strong>
            ${operation.reason ? html`<div>${operation.reason}</div>` : null}
          </div>`
        : null}

      ${presentation.action
        ? html`<div class="codex-runtime-actions">
            <button class="btn-primary" disabled=${loginPending} onClick=${() => onUpdate?.(presentation.action)}>
              ${presentation.action === "repair" ? "Repair runtime" : "Update runtime"}
            </button>
            ${loginPending ? html`<small>Finish or cancel Codex login first.</small>` : null}
          </div>`
        : null}
    </section>
  `;
}

function isLoopbackInferenceUrl(raw) {
  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1") {
      return true;
    }
    const parts = hostname.split(".").map((p) => Number.parseInt(p, 10));
    return parts.length === 4 && parts.every((p) => Number.isInteger(p)) && parts[0] === 127;
  } catch {
    return true;
  }
}

// ── Backend option grid ─────────────────────────────────────────────────────

function BackendOptionCard({ providerId, fallbackGlyph, title, subtitle, muted, onClick }) {
  return html`
    <button class="backend-opt ${muted ? "backend-opt--muted" : ""}" onClick=${onClick}>
      <span class="backend-opt-icon">
        ${providerId ? html`<${ProviderIcon} providerId=${providerId} size=${22} />` : null}
        ${fallbackGlyph ?? null}
      </span>
      <span class="backend-opt-title">${title}</span>
      <span class="backend-opt-sub">${subtitle}</span>
    </button>
  `;
}

// A neutral "stack" glyph for the Local-model card (no provider brand).
const LOCAL_GLYPH = html`<svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="6" rx="1" /><rect x="3" y="14" width="18" height="6" rx="1" /></svg>`;
// A "plus" glyph for the add-custom card.
const ADD_GLYPH = html`<svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14" /></svg>`;

/** Render one option as a card. `mode` is "pick" (capability picker) or "configure". */
function renderOption(opt, mode, onSelect) {
  const pick = () => onSelect(opt);
  switch (opt.kind) {
    case "local":
      return html`<${BackendOptionCard} key="local" fallbackGlyph=${LOCAL_GLYPH} title="Local model" subtitle=${`${plural(opt.count, "model")} to run on this machine`} onClick=${pick} />`;
    case "preset":
      return html`<${BackendOptionCard}
        key=${`preset-${opt.id}`}
        providerId=${opt.id}
        title=${opt.preset.name}
        subtitle=${mode === "configure"
          ? opt.configured
            ? "Configured"
            : "Set up this provider"
          : opt.configured
          ? plural(opt.fitCount, "model")
          : "Needs configuration"}
        muted=${!opt.configured && mode === "pick"}
        onClick=${pick}
      />`;
    case "custom":
      return html`<${BackendOptionCard} key=${`custom-${opt.id}`} providerId=${opt.logoProviderId} fallbackGlyph=${opt.logoProviderId ? null : LOCAL_GLYPH} title=${opt.id} subtitle=${plural(opt.fitCount, "model")} onClick=${pick} />`;
    case "anthropic":
      return html`<${BackendOptionCard}
        key="anthropic"
        providerId="anthropic"
        title="Anthropic"
        subtitle=${mode === "configure"
          ? opt.configured
            ? "Configured"
            : "Set up the API key"
          : opt.configured
          ? plural(opt.count, "model")
          : "Needs configuration"}
        muted=${!opt.configured && mode === "pick"}
        onClick=${pick}
      />`;
    case "codex":
      return html`<${BackendOptionCard}
        key="codex"
        providerId="codex"
        title="Codex"
        subtitle=${mode === "configure"
          ? opt.configured
            ? plural(opt.fitCount, "model")
            : opt.loggedIn
            ? "Refresh model catalog"
            : "Login with ChatGPT"
          : opt.configured
          ? plural(opt.fitCount, "model")
          : opt.loggedIn
          ? "Refresh model catalog"
          : "Needs login"}
        muted=${!opt.configured && mode === "pick"}
        onClick=${pick}
      />`;
    case "add-custom":
      return html`<${BackendOptionCard} key="add-custom" fallbackGlyph=${ADD_GLYPH} title="Custom HTTP backend" subtitle="Any OpenAI-compatible server" onClick=${pick} />`;
    default:
      return null;
  }
}

function BackendGrid({ options, mode, onSelect }) {
  return html`<div class="backend-opt-grid">${options.map((opt) => renderOption(opt, mode, onSelect))}</div>`;
}

// ── HTTP backend form (preset-prefilled or blank) ───────────────────────────

function HttpBackendForm({ preset, submit, onSuccess, onBack, allowRemoteInference }) {
  const [name, setName] = useState(preset?.id ?? "");
  const [url, setUrl] = useState(preset?.defaultUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [apiPathPrefix] = useState(preset?.apiPathPrefix ?? "");
  const [remoteApproved, setRemoteApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const nameValid = name.trim() && !RESERVED_BACKEND_NAMES.includes(name.trim()) && !name.includes("/");
  const needsRemoteApproval =
    url.trim() && !allowRemoteInference && !isLoopbackInferenceUrl(url.trim());
  const canAdd = nameValid && url.trim() && !busy && (!needsRemoteApproval || remoteApproved);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!canAdd) return;
    setBusy(true);
    setErr(null);
    const res = await submit(
      name.trim(),
      url.trim(),
      apiKey.trim() || undefined,
      apiPathPrefix || undefined,
      needsRemoteApproval && remoteApproved,
    );
    if (res && res.ok === false) {
      setErr(res.error ?? "Failed to add backend.");
      setBusy(false);
      return;
    }
    onSuccess(name.trim());
  };

  return html`
    <form class="backend-form" onSubmit=${onSubmit}>
      ${preset
        ? html`<p class="field-note"><${ProviderIcon} providerId=${preset.id} /> Configuring <strong>${preset.name}</strong>. Add your API key below; the URL is pre-filled.</p>`
        : html`<p class="field-note">Point Omnesis at any OpenAI-compatible server you run or pay for.</p>`}
      <label class="field">
        <span class="field-label">Name</span>
        <input class="field-input" type="text" placeholder="e.g. vllm" value=${name} onInput=${(e) => setName(e.target.value)} disabled=${!!preset} />
        ${name.trim() && !nameValid ? html`<span class="field-error">Name can't be a reserved word or contain "/".</span>` : null}
      </label>
      <label class="field">
        <span class="field-label">Base URL</span>
        <input class="field-input" type="text" placeholder="https://api.example.com" value=${url} onInput=${(e) => setUrl(e.target.value)} />
      </label>
      <label class="field">
        <span class="field-label">API key <span class="field-opt">(optional)</span></span>
        <input class="field-input" type="password" placeholder="Leave blank for a keyless local server" value=${apiKey} onInput=${(e) => setApiKey(e.target.value)} />
      </label>
      ${apiPathPrefix ? html`<p class="field-note">API path prefix: <code>${apiPathPrefix}</code></p>` : null}
      ${needsRemoteApproval
        ? html`<label class="field-check backend-remote-warning">
            <input type="checkbox" checked=${remoteApproved} onChange=${(e) => setRemoteApproved(e.currentTarget.checked)} />
            <span>
              Allow remote HTTP inference. Omnesis may send document chunks, search queries, agent prompts/tool context, OCR images, and this API key to this backend. Metadata, link-local, multicast, and unspecified addresses stay blocked.
            </span>
          </label>`
        : null}
      ${err ? html`<div class="modal-error">${err}</div>` : null}
      <div class="modal-actions">
        <button type="button" class="btn-secondary" onClick=${onBack}>Back</button>
        <button type="submit" class="btn-primary" disabled=${!canAdd}>${busy ? "Adding…" : "Add backend"}</button>
      </div>
    </form>
  `;
}

// ── Per-backend model selection (bounds the 300-models list) ────────────────

function BackendModelSelect({ backendKey, role, overview, onPick, onBack }) {
  const status = overview.inference.backends[backendKey];
  const [query, setQuery] = useState("");
  const [showOthers, setShowOthers] = useState(false);
  const [custom, setCustom] = useState("");
  const q = query.trim().toLowerCase();

  const curated = filterBackendModels(status?.modelRoles ?? {}, role, { query, includeOthers: showOthers });
  const probing = status?.status === "probing";
  // The backend answered but didn't return a model list (e.g. its /v1/models
  // endpoint 500s). There's nothing to suggest beyond preset hints — point the
  // user at the free-text box so they can name the model directly.
  const noModelList = status?.status === "reachable";

  return html`
    <div class="picker-pane">
      <div class="picker-pane-head">
        <button type="button" class="btn-back" onClick=${onBack}>← Back</button>
        <div class="picker-pane-title"><${ProviderIcon} providerId=${catalogProviderForBackend(overview, backendKey) ?? (overview.presets?.some((preset) => preset.id === backendKey) ? backendKey : null)} /> ${backendKey}</div>
      </div>
      <input class="picker-search" type="text" placeholder="Search models…" value=${query} onInput=${(e) => setQuery(e.target.value)} autofocus />
      <div class="picker-scroll">
        ${probing && curated.suggested.length === 0 ? html`<div class="picker-note">Probing the backend for its model list…</div>` : null}
        ${noModelList ? html`<div class="picker-note">This backend didn't return a model list${status?.reason ? html` (${status.reason})` : null} — type the exact model id below.</div>` : null}
        ${curated.suggested.map(
          (m) => html`<div class="picker-row" key=${m}>
            <div class="picker-row-info"><div class="picker-row-name">${m}</div></div>
            <button class="btn-tiny" onClick=${() => onPick(backendKey, m)}>Use</button>
          </div>`,
        )}
        ${curated.suggestedTruncated
          ? html`<div class="picker-note">Showing ${curated.suggested.length} of ${curated.suggestedCount} matching models — refine the search to narrow.</div>`
          : null}
        ${!probing && curated.suggested.length === 0
          ? html`<div class="picker-note">${q ? "No matching models." : "No suggested models for this capability — search, reveal other models, or type an id below."}</div>`
          : null}

        ${curated.others.length > 0
          ? html`<div class="picker-others">
              ${curated.others.map(
                (m) => html`<div class="picker-row picker-row--muted" key=${`other/${m}`}>
                  <div class="picker-row-info"><div class="picker-row-name">${m}</div><div class="picker-row-meta"><span>not typically used for ${role}</span></div></div>
                  <button class="btn-tiny" onClick=${() => onPick(backendKey, m)}>Use anyway</button>
                </div>`,
              )}
            </div>`
          : null}
        ${curated.othersTruncated
          ? html`<div class="picker-note">Showing ${curated.others.length} of ${curated.othersCount} other models — refine the search to narrow.</div>`
          : null}
        ${!q && !showOthers && curated.totalCandidates > curated.suggestedCount
          ? html`<button class="picker-link" onClick=${() => setShowOthers(true)}>Show ${curated.totalCandidates - curated.suggestedCount} other model${curated.totalCandidates - curated.suggestedCount !== 1 ? "s" : ""}</button>`
          : null}

        <div class="picker-custom">
          <input class="picker-custom-input" type="text" placeholder=${`Or type a model id served by ${backendKey}…`} value=${custom} onInput=${(e) => setCustom(e.target.value)} onKeyDown=${(e) => { if (e.key === "Enter" && custom.trim()) onPick(backendKey, custom.trim()); }} />
          <button class="btn-tiny" disabled=${!custom.trim()} onClick=${() => onPick(backendKey, custom.trim())}>Use</button>
        </div>
      </div>
    </div>
  `;
}

// ── Local model list (install + use) ────────────────────────────────────────

function LocalModelList({ role, overview, sys, onInstall, onUse, onUninstall, onCancelDownload, onBack }) {
  // Bundled-catalog GGUFs fit for this capability's role. When sideloading /
  // HF-browse lands (#21), an installed model absent from the catalog has no
  // role and would not appear here — it'll need its own home to stay listable.
  const entries = overview.catalog.filter((e) => e.kind === "gguf" && (e.roles ?? []).includes(CAPABILITY_TO_CATALOG[role]));
  return html`
    <div class="picker-pane">
      <div class="picker-pane-head">
        <button type="button" class="btn-back" onClick=${onBack}>← Back</button>
        <div class="picker-pane-title">${LOCAL_GLYPH} Local models</div>
      </div>
      <div class="picker-scroll">
        ${entries.map((entry) => {
          const installed = overview.installed.some((m) => m.id === entry.id);
          const downloading = (overview.activeDownloads ?? []).find((d) => d.modelId === entry.id);
          const fits_ = fit(entry, sys);
          return html`<div class="picker-row" key=${entry.id}>
            <div class="picker-row-info">
              <div class="picker-row-name">${entry.name}</div>
              <div class="picker-row-meta">
                <span>${formatBytes(entry.sizeBytes)}${entry.minRamGb ? ` · ${entry.minRamGb} GB RAM` : ""}</span>
                ${entry.recommended ? html`<span class="picker-tag good">Recommended</span>` : null}
                ${fits_.badges.some((b) => b.kind === "warn") ? html`<span class="picker-tag warn" title=${fits_.badges.filter((b) => b.kind === "warn").map((b) => b.text).join("\n")}>⚠ fit</span>` : null}
              </div>
            </div>
            ${downloading
              ? html`<span class="picker-row-state">${Math.min(100, Math.floor((downloading.progress.downloadedBytes / (downloading.progress.totalBytes || 1)) * 100))}% <button class="btn-tiny danger" onClick=${() => onCancelDownload(entry.id)}>Cancel</button></span>`
              : installed
              ? html`<span class="picker-row-actions"><button class="btn-tiny" onClick=${() => onUse(entry)}>Use</button><button class="btn-tiny danger" onClick=${() => onUninstall(entry)}>Remove</button></span>`
              : html`<button class="btn-tiny" onClick=${() => onInstall(entry)}>Install</button>`}
          </div>`;
        })}
        ${entries.length === 0 ? html`<div class="picker-note">No bundled local models for this capability.</div>` : null}
      </div>
    </div>
  `;
}

// ── Anthropic model list ────────────────────────────────────────────────────

function AnthropicModelList({ role, overview, onPick, onBack }) {
  const entries = overview.catalog.filter((e) => e.kind === "anthropic-api" && (e.roles ?? []).includes(CAPABILITY_TO_CATALOG[role]));
  const configured = isAnthropicConfigured(overview.inference.backends);
  return html`
    <div class="picker-pane">
      <div class="picker-pane-head">
        <button type="button" class="btn-back" onClick=${onBack}>← Back</button>
        <div class="picker-pane-title"><${ProviderIcon} providerId="anthropic" /> Anthropic</div>
      </div>
      <div class="picker-scroll">
        ${configured ? null : html`<div class="picker-note">Pick a model — you'll be asked for your Anthropic API key next.</div>`}
        ${entries.map(
          (entry) => html`<div class="picker-row" key=${entry.id}>
            <div class="picker-row-info">
              <div class="picker-row-name">${entry.name}</div>
              <div class="picker-row-meta"><span>Cloud · sends inference content to Anthropic</span></div>
            </div>
            <button class="btn-tiny" onClick=${() => onPick(entry)}>Use</button>
          </div>`,
        )}
        ${entries.length === 0 ? html`<div class="picker-note">No Anthropic models for this capability.</div>` : null}
      </div>
    </div>
  `;
}

// ── Codex model list + device login ─────────────────────────────────────────

function CodexModelList({ overview, role, loginFlow, refreshing, runtimeUpdate, switchingModel, onStartLogin, onCancelLogin, onRefresh, onRuntimeUpdate, onCancelRuntimeUpdate, onDismissRuntimeResult, onSwitchRole, onRemove, onPick, onBack }) {
  const [query, setQuery] = useState("");
  const [lastCheckedAt, setLastCheckedAt] = useState(null);
  const codex = overview.inference?.codex;
  const configured = codex?.status === "ok" && codex?.loggedIn === true;
  const probing = codex?.status === "probing";
  const pendingLogin = loginFlow?.status === "pending";
  const runtimeUpdating = codexRuntimeUpdatePresentation(runtimeUpdate).active;
  const busy = refreshing || probing || runtimeUpdating || switchingModel != null;
  const checkedLabel = lastCheckedAt
    ? "updated just now"
    : codex?.refreshedAt
    ? `last checked ${new Date(codex.refreshedAt).toLocaleTimeString()}`
    : null;
  const details = codex?.modelDetails?.length
    ? codex.modelDetails
    : (codex?.models ?? []).map((id) => ({ id, name: id }));
  const roleDetails = role
    ? details.filter((m) => codex?.modelRoles?.[m.id]?.includes(role))
    : details;
  const roleTitle = role
    ? (overview.capabilities ?? []).find((entry) => entry.role === role)?.title ?? role
    : null;
  const assignment = role ? overview.inference?.assignments?.[role] : null;
  const currentModel = assignment?.kind === "codex"
    ? assignment.model
    : typeof assignment === "string" && assignment.startsWith("codex/")
    ? assignment.slice("codex/".length)
    : null;
  const filtered = roleDetails.filter((m) => fuzzyMatchFields([m.id, m.name, m.description], query));
  const checkCodex = async () => {
    const ok = await onRefresh?.();
    if (ok !== false) setLastCheckedAt(new Date());
  };

  return html`
    <div class="picker-pane">
      <div class="picker-pane-head">
        ${onBack ? html`<button type="button" class="btn-back" onClick=${onBack}>← Back</button>` : null}
        <div class="picker-pane-title"><${ProviderIcon} providerId="codex" /> Codex</div>
      </div>
      ${runtimeUpdate
        ? html`<${CodexRuntimePanel}
            overview=${overview}
            update=${runtimeUpdate}
            loginPending=${loginFlow?.status === "pending"}
            onUpdate=${onRuntimeUpdate}
            onCancel=${onCancelRuntimeUpdate}
            onDismissResult=${onDismissRuntimeResult}
            onSwitchRole=${onSwitchRole}
            switchPending=${switchingModel != null}
          />`
        : null}
      ${roleTitle
        ? html`<div class="codex-model-target">
            <strong>Choose a Codex model for ${roleTitle}</strong>
            <span>Only ${roleTitle} will change.${currentModel ? ` Current model: ${currentModel}.` : ""}</span>
          </div>`
        : null}
      <div class="picker-scroll">
        ${configured
          ? html`<div class="picker-row">
              <div class="picker-row-info">
                <div class="picker-row-name">Codex is connected</div>
                <div class="picker-row-meta">
                  <span>${plural(roleDetails.length, "model")} available</span>
                  ${checkedLabel ? html`<span>${checkedLabel}</span>` : null}
                </div>
              </div>
              <span class="picker-row-actions">
                <button class="btn-tiny" onClick=${checkCodex} disabled=${busy}>${busy ? "Checking…" : "Refresh model list"}</button>
                ${onRemove ? html`<button class="btn-tiny danger" onClick=${onRemove} disabled=${busy}>Remove</button>` : null}
              </span>
            </div>`
          : null}

        ${!configured && !pendingLogin
          ? html`<div class="picker-row">
              <div class="picker-row-info">
                <div class="picker-row-name">Codex needs OpenAI login</div>
                <div class="picker-row-meta">
                  <span>Login with ChatGPT to use subscription-backed Codex.</span>
                  ${busy ? html`<span>checking status…</span>` : checkedLabel ? html`<span>${checkedLabel}</span>` : null}
                  ${codex?.reason ? html`<span>${codex.reason}</span>` : null}
                </div>
              </div>
              <span class="picker-row-actions">
                <button class="btn-tiny" onClick=${checkCodex} disabled=${busy}>${busy ? "Checking…" : "Check status"}</button>
                <button class="btn-tiny" onClick=${onStartLogin} disabled=${busy}>Login</button>
              </span>
            </div>`
          : null}

        ${pendingLogin
          ? html`<div class="picker-row">
              <div class="picker-row-info">
                <div class="picker-row-name">Complete OpenAI login</div>
                <div class="picker-row-meta">
                  <span>Open this link to log in to OpenAI, then paste this one-time code.</span>
                  ${loginFlow.verificationUri
                    ? html`<a href=${loginFlow.verificationUri} target="_blank" rel="noreferrer">${loginFlow.verificationUri}</a>`
                    : html`<span>Waiting for Codex to return the login link…</span>`}
                  <span><strong>${loginFlow.userCode ?? "Code pending…"}</strong></span>
                  ${loginFlow.expiresAt ? html`<span>expires ${new Date(loginFlow.expiresAt).toLocaleTimeString()}</span>` : null}
                </div>
              </div>
              <span class="picker-row-actions">
                <button class="btn-tiny" onClick=${checkCodex} disabled=${busy}>${busy ? "Checking…" : "Check login"}</button>
                <button class="btn-tiny danger" onClick=${onCancelLogin}>Cancel</button>
              </span>
            </div>`
          : null}

        ${configured
          ? html`
              <input class="picker-search" type="text" placeholder="Search Codex models…" value=${query} onInput=${(e) => setQuery(e.target.value)} autofocus />
              ${filtered.map(
                (model) => html`<div class="picker-row" key=${model.id}>
                  <div class="picker-row-info">
                    <div class="picker-row-name">${model.name ?? model.id}</div>
                    <div class="picker-row-meta">
                      <span>${model.id}</span>
                      ${model.recommended ? html`<span class="picker-tag good">Recommended</span>` : null}
                      ${model.description ? html`<span>${model.description}</span>` : null}
                    </div>
                  </div>
                  ${onPick
                    ? model.id === currentModel
                      ? html`<span class="picker-row-state">Current for ${roleTitle}</span>`
                      : html`<button class="btn-tiny" disabled=${busy} onClick=${() => onPick(model.id)}>${switchingModel === model.id ? "Switching…" : `Use for ${roleTitle}`}</button>`
                    : null}
                </div>`,
              )}
              ${filtered.length === 0 ? html`<div class="picker-note">No matching Codex models.</div>` : null}
            `
          : null}
      </div>
    </div>
  `;
}

/**
 * Decide how one "Recently used" entry applies — the pure decision behind
 * `pickRecent` in `models.js`, unit-tested here so every "Use" click path is
 * pinned: catalog models resolve to their entry + server catalog role,
 * `backend/model` values split for the HTTP flow, bare values (native OCR
 * runtimes, replay) assign directly, and anything unusable becomes an error
 * message for the flash banner.
 */
export function classifyRecentApply(entry, catalog = []) {
  const apply = entry?.apply;
  if (apply?.type === "activate") {
    const catalogEntry = (catalog ?? []).find((e) => e.id === apply.catalogId);
    if (!catalogEntry) {
      return { kind: "error", message: `Model ${apply.catalogId} is no longer in the catalog.` };
    }
    return { kind: "activate", entry: catalogEntry, catalogRole: apply.catalogRole };
  }
  const value = apply?.type === "assign" ? apply.value : entry?.assignment;
  if (typeof value !== "string" || value.length === 0) {
    return { kind: "error", message: "That recent model is no longer available." };
  }
  const slash = value.indexOf("/");
  if (slash === -1) return { kind: "assignRaw", value };
  return { kind: "assignHttp", backendKey: value.slice(0, slash), model: value.slice(slash + 1) };
}

/**
 * Whether an entry may render a "Use" button at all — mirrors the native
 * clients' skip of incomplete apply payloads, so a malformed entry never
 * offers a button that can only end in an error flash.
 */
export function isUsableRecentEntry(entry) {
  const apply = entry?.apply;
  if (apply?.type === "activate") {
    return typeof apply.catalogId === "string" && apply.catalogId.length > 0;
  }
  if (apply?.type === "assign") {
    return typeof apply.value === "string" && apply.value.length > 0;
  }
  return false;
}

// ── Recently used models ──────────────────────────────────────────────────

/**
 * Flat "Recently used" list above the backend grid: the models recently used
 * for this capability or a similar one, each as a plain row (provider logo +
 * model name + Use button — deliberately not cards). Hidden entirely while
 * loading and when the gateway reports no entries.
 */
function RecentModels({ role, onPick }) {
  const [entries, setEntries] = useState(null); // null = loading
  useEffect(() => {
    let cancelled = false;
    getRecentModels(role)
      .then((res) => {
        if (!cancelled) setEntries(res?.entries ?? []);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [role]);
  const usable = (entries ?? []).filter(isUsableRecentEntry);
  if (usable.length === 0) return null;
  return html`
    <div class="recent-models">
      <h3 class="recent-models-title">Recently used</h3>
      <div class="recent-models-list">
        ${usable.map(
          (entry) => html`<div class="picker-row" key=${entry.assignment}>
            <div class="picker-row-info">
              <div class="picker-row-name">
                <${ProviderIcon} providerId=${entry.providerId} />
                <span>${entry.modelName}</span>
                <span class="picker-row-meta"><span>${entry.providerLabel}</span></span>
              </div>
            </div>
            <button class="btn-tiny" onClick=${() => onPick(entry)}>Use</button>
          </div>`,
        )}
      </div>
    </div>
  `;
}

// ── Choose-model flow ───────────────────────────────────────────────────────

export function ModelConfigModal({ role, capTitle, overview, sys, codexLoginFlow, codexRefreshing, codexRuntimeUpdate, onClose, onAddHttp, onPickHttp, onPickLocal, onPickAnthropic, onPickCodex, onPickRecent, onStartCodexLogin, onCancelCodexLogin, onRefreshCodex, onCodexRuntimeUpdate, onCancelCodexRuntimeUpdate, onDismissCodexRuntimeResult, onInstall, onUninstall, onCancelDownload }) {
  // step.name: "grid" | "http" | "select" | "local" | "anthropic" | "codex"
  const [step, setStep] = useState({ name: "grid" });
  const toGrid = () => setStep({ name: "grid" });

  const onSelect = (opt) => {
    if (opt.kind === "local") setStep({ name: "local" });
    else if (opt.kind === "anthropic") setStep({ name: "anthropic" });
    else if (opt.kind === "codex") setStep({ name: "codex" });
    else if (opt.kind === "add-custom") setStep({ name: "http", preset: null });
    else if (opt.kind === "custom") setStep({ name: "select", backendKey: opt.id });
    else if (opt.kind === "preset") setStep(opt.configured ? { name: "select", backendKey: opt.id } : { name: "http", preset: opt.preset });
  };

  let body;
  if (step.name === "grid") {
    body = html`
      <${RecentModels} role=${role} onPick=${onPickRecent} />
      <${BackendGrid} options=${buildModelPickerOptions(overview, role)} mode="pick" onSelect=${onSelect} />

    `;
  } else if (step.name === "http") {
    body = html`<${HttpBackendForm} preset=${step.preset} submit=${onAddHttp} onSuccess=${(key) => setStep({ name: "select", backendKey: key })} onBack=${toGrid} allowRemoteInference=${overview.inference?.allowRemoteInference === true} />`;
  } else if (step.name === "select") {
    body = html`<${BackendModelSelect} backendKey=${step.backendKey} role=${role} overview=${overview} onPick=${onPickHttp} onBack=${toGrid} />`;
  } else if (step.name === "local") {
    body = html`<${LocalModelList} role=${role} overview=${overview} sys=${sys} onInstall=${onInstall} onUse=${onPickLocal} onUninstall=${onUninstall} onCancelDownload=${onCancelDownload} onBack=${toGrid} />`;
  } else if (step.name === "anthropic") {
    body = html`<${AnthropicModelList} role=${role} overview=${overview} onPick=${onPickAnthropic} onBack=${toGrid} />`;
  } else if (step.name === "codex") {
    body = html`<${CodexModelList}
      overview=${overview}
      role=${role}
      loginFlow=${codexLoginFlow}
      refreshing=${codexRefreshing}
      runtimeUpdate=${codexRuntimeUpdate}
      onStartLogin=${onStartCodexLogin}
      onCancelLogin=${onCancelCodexLogin}
      onRefresh=${onRefreshCodex}
      onRuntimeUpdate=${onCodexRuntimeUpdate}
      onCancelRuntimeUpdate=${onCancelCodexRuntimeUpdate}
      onDismissRuntimeResult=${onDismissCodexRuntimeResult}
      onPick=${onPickCodex}
      onBack=${toGrid}
    />`;
  }

  const size = step.name === "select" || step.name === "codex" ? "lg" : "md";
  return html`<${Modal} open onClose=${onClose} title=${`Choose a ${capTitle} model`} size=${size}>${body}<//>`;
}

// ── Add-backend flow (configure only) ───────────────────────────────────────

export function CodexConfigModal({ overview, loginFlow, refreshing, runtimeUpdate, onClose, onStartLogin, onCancelLogin, onRefresh, onRuntimeUpdate, onCancelRuntimeUpdate, onDismissRuntimeResult, onSwitchModel, onRemove }) {
  const [switchRole, setSwitchRole] = useState(null);
  const [switchingModel, setSwitchingModel] = useState(null);
  const [switchResult, setSwitchResult] = useState(null);
  const switchTitle = switchRole
    ? (overview.capabilities ?? []).find((entry) => entry.role === switchRole)?.title ?? switchRole
    : null;
  const beginSwitch = (role) => {
    setSwitchResult(null);
    setSwitchRole(role);
  };
  return html`
    <${Modal} open onClose=${onClose} title=${switchTitle ? `Choose a Codex model for ${switchTitle}` : "Codex"} size="lg">
      ${switchResult
        ? html`<div class="codex-runtime-result codex-runtime-result--good" role="status">
            <strong>${switchResult.title} now uses ${switchResult.model}.</strong>
            <div>No other capability was changed.</div>
          </div>`
        : null}
      <${CodexModelList}
        overview=${overview}
        loginFlow=${loginFlow}
        refreshing=${refreshing}
        runtimeUpdate=${runtimeUpdate}
        onStartLogin=${onStartLogin}
        onCancelLogin=${onCancelLogin}
        onRefresh=${onRefresh}
        onRuntimeUpdate=${onRuntimeUpdate}
        onCancelRuntimeUpdate=${onCancelRuntimeUpdate}
        onDismissRuntimeResult=${onDismissRuntimeResult}
        onSwitchRole=${beginSwitch}
        role=${switchRole}
        switchingModel=${switchingModel}
        onPick=${switchRole && onSwitchModel
          ? async (model) => {
              const targetRole = switchRole;
              const targetTitle = switchTitle;
              setSwitchingModel(model);
              let ok;
              try {
                ok = await onSwitchModel(targetRole, model);
              } finally {
                setSwitchingModel(null);
              }
              if (ok !== false) {
                setSwitchResult({ title: targetTitle, model });
                setSwitchRole(null);
              }
            }
          : null}
        onRemove=${onRemove}
        onBack=${null}
      />
    <//>
  `;
}

export function AddBackendModal({ overview, onClose, onAddHttp, onConfigureAnthropic, onConfigureCodex }) {
  const [step, setStep] = useState({ name: "grid" });

  const onSelect = (opt) => {
    if (opt.kind === "anthropic") {
      onConfigureAnthropic();
      onClose();
    } else if (opt.kind === "codex") {
      onConfigureCodex();
      onClose();
    } else if (opt.kind === "add-custom") {
      setStep({ name: "http", preset: null });
    } else if (opt.kind === "preset") {
      setStep({ name: "http", preset: opt.preset });
    }
  };

  const body =
    step.name === "grid"
      ? html`<${BackendGrid} options=${buildAddBackendOptions(overview)} mode="configure" onSelect=${onSelect} />`
      : html`<${HttpBackendForm} preset=${step.preset} submit=${onAddHttp} onSuccess=${() => onClose()} onBack=${() => setStep({ name: "grid" })} allowRemoteInference=${overview.inference?.allowRemoteInference === true} />`;

  return html`
    <${Modal} open onClose=${onClose} title="Add a backend" subtitle=${step.name === "grid" ? "Pick a provider or point Omnesis at any OpenAI-compatible server." : null} size="md">
      ${body}
    <//>
  `;
}
