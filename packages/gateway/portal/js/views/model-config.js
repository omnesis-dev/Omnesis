// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The Models configuration flows, shared by the capability page and the
// Backends page:
//
//   • ModelConfigModal   — "Choose a <capability> model": a grid of backend
//                          options (Local, presets, custom HTTP backends,
//                          Codex, Claude Code, Anthropic, + a custom backend
//                          — or TypeSafe alone
//                          for the Decision model), each leading to the
//                          model selection (configuring the backend inline
//                          first when it isn't set up yet).
//   • AddBackendModal    — "Add a backend": the same grid in configure-only
//                          mode (no Local, no model selection at the end).
//
// Backends are global, so both flows read and write the same backend set: a
// backend you add anywhere is immediately available to every capability.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { getModelCredentialsStatus, getRecentModels } from "../api.js";
import { CloudInferenceConsentModal } from "../components/cloud-inference-consent.js";
import { CopyValue } from "../components/copy-button.js";
import { isLoopbackInferenceUrl } from "../lib/cloud-inference.js";
import { Modal } from "../components/modal.js";
import { ProviderIcon } from "../components/provider-icon.js";
import { CapabilityIcon } from "../components/capability-icon.js";
import { filterBackendModels } from "../lib/backend-model-filter.js";
import { fuzzyMatchFields } from "../lib/fuzzy-match.js";
import {
  buildModelPickerOptions,
  buildAddBackendOptions,
  CAPABILITY_TO_CATALOG,
  isAnthropicConfigured,
  catalogProviderForBackend,
  TYPESAFE_DEFAULT_MODEL,
  isDecisionRole,
  isClaudeCodeReady,
  httpBackendModelSummary,
} from "../lib/backend-options.js";
import { formatBytes, fit } from "../lib/model-format.js";

const RESERVED_BACKEND_NAMES = ["local", "anthropic", "codex", "claude-code", "replay", "typesafe"];

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

/** The model a role uses on a built-in CLI backend (`codex`, `claude-code`), or null. */
export function assignedCliModel(assignment, kind) {
  if (assignment?.kind === kind) return assignment.model;
  if (typeof assignment === "string" && assignment.startsWith(`${kind}/`)) return assignment.slice(kind.length + 1);
  return null;
}

/** Every role currently assigned to a built-in CLI backend, with its title and model. */
export function cliBackendAssignments(overview, kind) {
  return Object.entries(overview.inference?.assignments ?? {}).flatMap(([role, value]) => {
    const model = assignedCliModel(value, kind);
    if (model == null) return [];
    const cap = (overview.capabilities ?? []).find((entry) => entry.role === role);
    return [{ role, title: cap?.title ?? role, model }];
  });
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
  const assigned = cliBackendAssignments(overview, "codex");

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
// TypeSafe has no served provider logo; its card wears the Decision model's
// own capability glyph.
const TYPESAFE_GLYPH = html`<${CapabilityIcon} icon="scale" size=${22} />`;
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
        providerId=${opt.providerId ?? opt.id}
        title=${opt.preset.name}
        subtitle=${mode === "configure"
          ? opt.configured
            ? "Configured"
            : "Set up this provider"
          : opt.configured
          ? httpBackendModelSummary(opt)
          : "Needs configuration"}
        muted=${!opt.configured && mode === "pick"}
        onClick=${pick}
      />`;
    case "custom":
      return html`<${BackendOptionCard} key=${`custom-${opt.id}`} providerId=${opt.logoProviderId} fallbackGlyph=${opt.logoProviderId ? null : LOCAL_GLYPH} title=${opt.id} subtitle=${httpBackendModelSummary(opt)} onClick=${pick} />`;
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
    case "claude-code":
      return html`<${BackendOptionCard}
        key="claude-code"
        providerId="claude-code"
        title="Claude Code"
        subtitle=${opt.configured
          ? plural(opt.fitCount, "model")
          : !opt.installed
          ? "Use your Claude subscription"
          : !opt.loggedIn
          ? "Sign in on the gateway host"
          : "Refresh model catalog"}
        muted=${!opt.configured && mode === "pick"}
        onClick=${pick}
      />`;
    case "typesafe":
      return html`<${BackendOptionCard} key="typesafe" fallbackGlyph=${TYPESAFE_GLYPH} title="TypeSafe" subtitle="Judges whether an email is worth recording" onClick=${pick} />`;
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
  const [showConsent, setShowConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const nameValid = name.trim() && !RESERVED_BACKEND_NAMES.includes(name.trim()) && !name.includes("/");
  const needsRemoteApproval =
    url.trim() && !allowRemoteInference && !isLoopbackInferenceUrl(url.trim());
  const canAdd = nameValid && url.trim() && !busy;

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!canAdd || showConsent) return;
    if (needsRemoteApproval) { setShowConsent(true); return; }
    await addBackend(false);
  };

  const addBackend = async (enableRemote) => {
    setShowConsent(false);
    setBusy(true);
    setErr(null);
    const res = await submit(
      name.trim(),
      url.trim(),
      apiKey.trim() || undefined,
      apiPathPrefix || undefined,
      enableRemote,
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
      ${needsRemoteApproval ? html`<p class="field-note">Adding this remote backend requires permission for cloud inference. You will be asked to confirm before it is saved. The API key is sent to this backend.</p>` : null}
      <${CloudInferenceConsentModal}
        open=${showConsent}
        providerLabel=${url.trim()}
        onConfirm=${() => addBackend(true)}
        onCancel=${() => setShowConsent(false)}
      />
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
  const noModelList = role !== "speech-to-speech" && status?.status === "reachable";
  // A model the backend has already refused for this role (the gateway asked
  // it to transcribe and it answered it cannot) is shown with that answer
  // instead of a Use button, so the user does not try it again.
  const refusal = (m) =>
    (status?.verdicts ?? []).find((v) => v.role === role && v.model === m && !v.supported && !v.inconclusive);
  const backendRefusesRole = curated.suggested.length > 0 && curated.suggested.every((m) => refusal(m));

  return html`
    <div class="picker-pane">
      <div class="picker-pane-head">
        <button type="button" class="btn-back" onClick=${onBack}>← Back</button>
        <div class="picker-pane-title"><${ProviderIcon} providerId=${catalogProviderForBackend(overview, backendKey) ?? (overview.presets?.some((preset) => preset.id === backendKey) ? backendKey : null)} /> ${backendKey}</div>
      </div>
      <input class="picker-search" type="text" placeholder="Search models…" value=${query} onInput=${(e) => setQuery(e.target.value)} autofocus />
      <div class="picker-scroll">
        ${role === "transcriber"
          ? html`<div class="picker-note">A transcriber backend must serve the OpenAI audio transcription API (whisper-server, speaches, vLLM, llama-server, Ollama with a speech model, OpenAI) and the model must be a speech model: a chat or embedding model cannot transcribe. The backend is checked before it is assigned.</div>`
          : null}
        ${backendRefusesRole ? html`<div class="picker-note picker-note--warn">This backend cannot serve ${role}: ${refusal(curated.suggested[0]).detail}</div>` : null}
        ${probing && curated.suggested.length === 0 ? html`<div class="picker-note">Probing the backend for its model list…</div>` : null}
        ${noModelList ? html`<div class="picker-note">This backend didn't return a model list${status?.reason ? html` (${status.reason})` : null} — type the exact model id below.</div>` : null}
        ${curated.suggested.map(
          (m) => {
            const refused = refusal(m);
            return refused
              ? html`<div class="picker-row picker-row--muted" key=${m}>
                  <div class="picker-row-info"><div class="picker-row-name">${m}</div><div class="picker-row-meta"><span>cannot serve ${role}: ${refused.detail}</span></div></div>
                  <button class="btn-tiny" disabled title=${refused.detail}>Cannot use</button>
                </div>`
              : html`<div class="picker-row" key=${m}>
                  <div class="picker-row-info"><div class="picker-row-name">${m}</div></div>
                  <button class="btn-tiny" onClick=${() => onPick(backendKey, m)}>Use</button>
                </div>`;
          },
        )}
        ${curated.suggestedTruncated
          ? html`<div class="picker-note">Showing ${curated.suggested.length} of ${curated.suggestedCount} matching models — refine the search to narrow.</div>`
          : null}
        ${!probing && curated.suggested.length === 0
          ? html`<div class="picker-note">${q ? "No matching models." : role === "speech-to-speech" ? "No supported speech models are available." : "No suggested models for this capability — search, reveal other models, or type an id below."}</div>`
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

        ${role === "speech-to-speech" ? null : html`<div class="picker-custom">
          <input class="picker-custom-input" type="text" placeholder=${`Or type a model id served by ${backendKey}…`} value=${custom} onInput=${(e) => setCustom(e.target.value)} onKeyDown=${(e) => { if (e.key === "Enter" && custom.trim()) onPick(backendKey, custom.trim()); }} />
          <button class="btn-tiny" disabled=${!custom.trim()} onClick=${() => onPick(backendKey, custom.trim())}>Use</button>
        </div>`}
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

// ── Built-in CLI backend pieces (Codex, Claude Code) ────────────────────────

/** "Choose a <backend> model for <role>" banner over a role-scoped model list. */
function CliModelTarget({ backendLabel, roleTitle, currentModel }) {
  return html`<div class="cli-model-target">
    <strong>Choose a ${backendLabel} model for ${roleTitle}</strong>
    <span>Only ${roleTitle} will change.${currentModel ? ` Current model: ${currentModel}.` : ""}</span>
  </div>`;
}

/**
 * Searchable model rows for a CLI backend. With `onPick` each row offers
 * "Use for <role>"; without it the list is informational.
 */
function CliModelRows({ backendLabel, models, currentModel, roleTitle, busy, switchingModel, onPick }) {
  const [query, setQuery] = useState("");
  const filtered = models.filter((m) => fuzzyMatchFields([m.id, m.name, m.description, m.resolvedModel], query));
  return html`
    <input class="picker-search" type="text" placeholder=${`Search ${backendLabel} models…`} value=${query} onInput=${(e) => setQuery(e.target.value)} autofocus />
    ${filtered.map(
      (model) => html`<div class="picker-row" key=${model.id}>
        <div class="picker-row-info">
          <div class="picker-row-name">${model.name ?? model.id}</div>
          <div class="picker-row-meta">
            <span>${model.id}</span>
            ${model.resolvedModel && model.resolvedModel !== model.id ? html`<span>currently ${model.resolvedModel}</span>` : null}
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
    ${filtered.length === 0 ? html`<div class="picker-note">No matching ${backendLabel} models.</div>` : null}
  `;
}

/** A CLI backend's model details, falling back to bare ids, scoped to a role when given. */
function cliModelsForRole(status, role) {
  const details = status?.modelDetails?.length
    ? status.modelDetails
    : (status?.models ?? []).map((id) => ({ id, name: id }));
  return role ? details.filter((m) => status?.modelRoles?.[m.id]?.includes(role)) : details;
}

function roleTitleFor(overview, role) {
  return role ? (overview.capabilities ?? []).find((entry) => entry.role === role)?.title ?? role : null;
}

// ── Codex model list + device login ─────────────────────────────────────────

function CodexModelList({ overview, role, loginFlow, refreshing, runtimeUpdate, switchingModel, onStartLogin, onCancelLogin, onRefresh, onRuntimeUpdate, onCancelRuntimeUpdate, onDismissRuntimeResult, onSwitchRole, onRemove, onPick, onBack }) {
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
  const roleDetails = cliModelsForRole(codex, role);
  const roleTitle = roleTitleFor(overview, role);
  const currentModel = role ? assignedCliModel(overview.inference?.assignments?.[role], "codex") : null;
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
      ${roleTitle ? html`<${CliModelTarget} backendLabel="Codex" roleTitle=${roleTitle} currentModel=${currentModel} />` : null}
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
                  ${loginFlow.userCode
                    ? html`<${CopyValue} text=${loginFlow.userCode} title="Copy login code"><strong>${loginFlow.userCode}</strong><//>`
                    : html`<strong>Code pending…</strong>`}
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
          ? html`<${CliModelRows}
              backendLabel="Codex"
              models=${roleDetails}
              currentModel=${currentModel}
              roleTitle=${roleTitle}
              busy=${busy}
              switchingModel=${switchingModel}
              onPick=${onPick}
            />`
          : null}
      </div>
    </div>
  `;
}

// ── Claude Code model list ──────────────────────────────────────────────────

const CLAUDE_CODE_INSTALL_URL = "https://claude.com/claude-code";
const CLAUDE_CODE_LOGIN_COMMAND = "claude auth login";

/** A readable label for how Claude Code is signed in, e.g. "Claude Max". */
export function claudeCodeAccountLabel(account) {
  const plan = account?.subscriptionType?.trim();
  if (plan) return `Claude ${plan.charAt(0).toUpperCase()}${plan.slice(1)}`;
  if (account?.authMethod === "oauth_token") return "long-lived token";
  return null;
}

/**
 * Which Claude Code pane to show: `ready` (signed in with a catalog),
 * `checking` (a first refresh is in flight), `not-installed`, `signed-out`,
 * or `unavailable` (signed in, but the catalog could not be read).
 */
export function claudeCodeState(claudeCode) {
  if (isClaudeCodeReady(claudeCode)) return "ready";
  if (claudeCode?.status === "probing") return "checking";
  if (claudeCode?.installed !== true) return "not-installed";
  if (claudeCode?.runtime?.supported === false) return "outdated";
  if (claudeCode?.loggedIn !== true) return "signed-out";
  return "unavailable";
}

function ClaudeCodeSetup({ state, claudeCode, busy, onRefresh }) {
  const reason =
    state === "unavailable" || state === "not-installed" ? (claudeCode?.reason ?? claudeCode?.runtime?.reason) : null;
  return html`<div class="claude-code-setup" role="status">
    ${state === "checking" ? html`<strong>Checking Claude Code on the gateway host…</strong>` : null}
    ${state === "not-installed"
      ? html`<strong>Claude Code is not installed on the gateway host</strong>
          <ol>
            <li>Install Claude Code on the machine that runs the gateway: <a href=${CLAUDE_CODE_INSTALL_URL} target="_blank" rel="noreferrer">claude.com/claude-code</a>.</li>
            <li>Sign in there with <${CopyValue} text=${CLAUDE_CODE_LOGIN_COMMAND} title="Copy sign-in command" />.</li>
            <li>Come back and check again.</li>
          </ol>`
      : null}
    ${state === "outdated"
      ? html`<strong>Claude Code ${claudeCode?.runtime?.version ?? ""} is too old for Omnesis</strong>
          <p>On the gateway host, run <${CopyValue} text="claude update" title="Copy update command" />, then check again.</p>`
      : null}
    ${state === "signed-out"
      ? html`<strong>Claude Code is not signed in</strong>
          <p>On the gateway host, run <${CopyValue} text=${CLAUDE_CODE_LOGIN_COMMAND} title="Copy sign-in command" /> and complete the sign-in, then check again.</p>`
      : null}
    ${state === "unavailable" ? html`<strong>Claude Code is signed in but unavailable</strong>` : null}
    ${reason ? html`<p class="claude-code-setup-note">${reason}</p>` : null}
    <p class="claude-code-setup-note">Omnesis runs your installed Claude Code under its own sign-in. It never sees, stores or relays your Claude credentials.</p>
    <div class="claude-code-setup-actions">
      <button class="btn-tiny" onClick=${onRefresh} disabled=${busy}>${busy ? "Checking…" : "Check again"}</button>
    </div>
  </div>`;
}

function ClaudeCodeModelList({ overview, role, refreshing, switchingModel, onRefresh, onPick, onBack }) {
  const [lastCheckedAt, setLastCheckedAt] = useState(null);
  const claudeCode = overview.inference?.claudeCode;
  const state = claudeCodeState(claudeCode);
  const busy = refreshing || claudeCode?.status === "probing" || switchingModel != null;
  const models = cliModelsForRole(claudeCode, role);
  const roleTitle = roleTitleFor(overview, role);
  const currentModel = role ? assignedCliModel(overview.inference?.assignments?.[role], "claude-code") : null;
  const account = claudeCodeAccountLabel(claudeCode?.account);
  const checkedLabel = lastCheckedAt
    ? "updated just now"
    : claudeCode?.refreshedAt
    ? `last checked ${new Date(claudeCode.refreshedAt).toLocaleTimeString()}`
    : null;
  const check = async () => {
    const ok = await onRefresh?.();
    if (ok !== false) setLastCheckedAt(new Date());
  };

  return html`
    <div class="picker-pane">
      <div class="picker-pane-head">
        ${onBack ? html`<button type="button" class="btn-back" onClick=${onBack}>← Back</button>` : null}
        <div class="picker-pane-title"><${ProviderIcon} providerId="claude-code" /> Claude Code</div>
      </div>
      ${roleTitle && state === "ready" ? html`<${CliModelTarget} backendLabel="Claude Code" roleTitle=${roleTitle} currentModel=${currentModel} />` : null}
      <div class="picker-scroll">
        ${state === "ready"
          ? html`<div class="picker-row">
                <div class="picker-row-info">
                  <div class="picker-row-name">Claude Code is connected</div>
                  <div class="picker-row-meta">
                    <span>${account ? `Signed in with ${account}` : "Signed in"}</span>
                    ${claudeCode.runtime?.version ? html`<span>CLI ${claudeCode.runtime.version}</span>` : null}
                    <span>${plural(models.length, "model")} available</span>
                    ${checkedLabel ? html`<span>${checkedLabel}</span>` : null}
                  </div>
                </div>
                <span class="picker-row-actions">
                  <button class="btn-tiny" onClick=${check} disabled=${busy}>${busy ? "Checking…" : "Refresh model list"}</button>
                </span>
              </div>
              <${CliModelRows}
                backendLabel="Claude Code"
                models=${models}
                currentModel=${currentModel}
                roleTitle=${roleTitle}
                busy=${busy}
                switchingModel=${switchingModel}
                onPick=${onPick}
              />`
          : html`<${ClaudeCodeSetup} state=${state} claudeCode=${claudeCode} busy=${busy} onRefresh=${check} />`}
      </div>
    </div>
  `;
}

// ── TypeSafe (decision models) ──────────────────────────────────────────────

/**
 * Whether the gateway holds a TypeSafe key: the stored credential, or — when
 * the capability is already on TypeSafe — the resolved assignment, which also
 * sees a key supplied through the environment.
 */
export function typesafeKeyConfigured(credentialEntry, assignment) {
  return (
    credentialEntry?.configured === true ||
    credentialEntry?.environment === true ||
    (assignment?.kind === "typesafe" && assignment.hasApiKey === true)
  );
}

/** The model id the TypeSafe pane starts from: the current one, else the default. */
export function typesafeInitialModel(assignment) {
  return assignment?.kind === "typesafe" && assignment.model ? assignment.model : TYPESAFE_DEFAULT_MODEL;
}

function TypeSafeModelPane({ role, overview, onPick, onConfigureKey, onBack }) {
  const assignment = overview.inference?.assignments?.[role];
  const [model, setModel] = useState(() => typesafeInitialModel(assignment));
  const [credential, setCredential] = useState(undefined); // undefined = loading
  useEffect(() => {
    let cancelled = false;
    getModelCredentialsStatus()
      .then((status) => {
        if (!cancelled) setCredential((status?.items ?? []).find((e) => e.fileKey === "typesafe") ?? null);
      })
      .catch(() => {
        if (!cancelled) setCredential(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const keyConfigured = typesafeKeyConfigured(credential, assignment);
  const trimmed = model.trim();
  const current = assignment?.kind === "typesafe" ? assignment.model : null;
  const use = () => {
    if (trimmed) onPick(trimmed);
  };
  return html`
    <div class="picker-pane">
      <div class="picker-pane-head">
        <button type="button" class="btn-back" onClick=${onBack}>← Back</button>
        <div class="picker-pane-title">${TYPESAFE_GLYPH} TypeSafe</div>
      </div>
      <div class="picker-scroll">
        <div class="picker-row">
          <div class="picker-row-info">
            <div class="picker-row-name">API key</div>
            <div class="picker-row-meta">
              <span>${credential === undefined
                ? "Checking…"
                : keyConfigured
                ? "Configured"
                : "Not configured — you'll be asked for it when you use a model"}</span>
            </div>
          </div>
          ${credential
            ? html`<button class="btn-tiny" onClick=${() => onConfigureKey(credential)}>${keyConfigured ? "Replace key" : "Configure key"}</button>`
            : null}
        </div>
        <label class="field">
          <span class="field-label">Model</span>
          <span class="picker-custom">
            <input
              class="picker-custom-input"
              type="text"
              aria-label="TypeSafe model id"
              value=${model}
              onInput=${(e) => setModel(e.target.value)}
              onKeyDown=${(e) => { if (e.key === "Enter") use(); }}
            />
            <button class="btn-tiny" disabled=${!trimmed || credential === undefined} onClick=${use}>
              ${current === trimmed ? "Current" : "Use"}
            </button>
          </span>
        </label>
        <div class="picker-note">
          Cloud · each scored document's subject, sender and opening text are sent to TypeSafe.
          ${overview.inference?.allowRemoteInference === true ? null : " You'll be asked to allow cloud inference first."}
        </div>
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

export function ModelConfigModal({ role, capTitle, overview, sys, codexLoginFlow, codexRefreshing, codexRuntimeUpdate, claudeCodeRefreshing, onClose, onAddHttp, onPickHttp, onPickLocal, onPickAnthropic, onPickCodex, onPickClaudeCode, onRefreshClaudeCode, onPickTypeSafe, onConfigureTypeSafeKey, onPickRecent, onStartCodexLogin, onCancelCodexLogin, onRefreshCodex, onCodexRuntimeUpdate, onCancelCodexRuntimeUpdate, onDismissCodexRuntimeResult, onInstall, onUninstall, onCancelDownload }) {
  // step.name: "grid" | "http" | "select" | "local" | "anthropic" | "codex" | "claude-code" | "typesafe"
  // A decision role has one backend, so its picker opens on it directly.
  const [step, setStep] = useState(() => (isDecisionRole(role) ? { name: "typesafe" } : { name: "grid" }));
  const toGrid = () => setStep({ name: "grid" });

  const onSelect = (opt) => {
    if (opt.kind === "local") setStep({ name: "local" });
    else if (opt.kind === "anthropic") setStep({ name: "anthropic" });
    else if (opt.kind === "codex") setStep({ name: "codex" });
    else if (opt.kind === "claude-code") setStep({ name: "claude-code" });
    else if (opt.kind === "typesafe") setStep({ name: "typesafe" });
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
  } else if (step.name === "typesafe") {
    body = html`<${TypeSafeModelPane} role=${role} overview=${overview} onPick=${onPickTypeSafe} onConfigureKey=${onConfigureTypeSafeKey} onBack=${toGrid} />`;
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
  } else if (step.name === "claude-code") {
    body = html`<${ClaudeCodeModelList}
      overview=${overview}
      role=${role}
      refreshing=${claudeCodeRefreshing}
      onRefresh=${onRefreshClaudeCode}
      onPick=${onPickClaudeCode}
      onBack=${toGrid}
    />`;
  }

  const size = ["select", "codex", "claude-code"].includes(step.name) ? "lg" : "md";
  return html`<${Modal} open onClose=${onClose} title=${/\bmodel$/i.test(capTitle) ? `Choose a ${capTitle}` : `Choose a ${capTitle} model`} size=${size}>${body}<//>`;
}

// ── Backend management modals ───────────────────────────────────────────────

function CliSwitchResult({ result }) {
  return html`<div class="cli-switch-result" role="status">
    <strong>${result.title} now uses ${result.model}.</strong>
    <div>No other capability was changed.</div>
  </div>`;
}

/**
 * Switch one role's model on a CLI backend from its management modal: tracks
 * the role being switched, the model being saved, and the last success.
 */
function useCliModelSwitch(overview, onSwitchModel) {
  const [switchRole, setSwitchRole] = useState(null);
  const [switchingModel, setSwitchingModel] = useState(null);
  const [switchResult, setSwitchResult] = useState(null);
  const switchTitle = roleTitleFor(overview, switchRole);
  const beginSwitch = (role) => {
    setSwitchResult(null);
    setSwitchRole(role);
  };
  const pick = switchRole && onSwitchModel
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
    : null;
  return { switchRole, switchTitle, switchingModel, switchResult, beginSwitch, cancelSwitch: () => setSwitchRole(null), pick };
}

export function ClaudeCodeConfigModal({ overview, refreshing, onClose, onRefresh, onSwitchModel }) {
  const { switchRole, switchTitle, switchingModel, switchResult, beginSwitch, cancelSwitch, pick } = useCliModelSwitch(overview, onSwitchModel);
  const assigned = cliBackendAssignments(overview, "claude-code");
  const ready = isClaudeCodeReady(overview.inference?.claudeCode);
  return html`
    <${Modal} open onClose=${onClose} title=${switchTitle ? `Choose a Claude Code model for ${switchTitle}` : "Claude Code"} size="lg">
      ${switchResult ? html`<${CliSwitchResult} result=${switchResult} />` : null}
      ${!switchRole && ready && assigned.length > 0
        ? html`<div class="claude-code-assignments">
            ${assigned.map((entry) => html`<div class="picker-row" key=${entry.role}>
              <div class="picker-row-info">
                <div class="picker-row-name">${entry.title}</div>
                <div class="picker-row-meta"><span>uses ${entry.model}</span></div>
              </div>
              ${onSwitchModel
                ? html`<button class="btn-tiny" aria-label=${`Switch ${entry.title} model`} onClick=${() => beginSwitch(entry.role)}>Switch model</button>`
                : null}
            </div>`)}
          </div>`
        : null}
      <${ClaudeCodeModelList}
        overview=${overview}
        role=${switchRole}
        refreshing=${refreshing}
        switchingModel=${switchingModel}
        onRefresh=${onRefresh}
        onPick=${pick}
        onBack=${switchRole ? cancelSwitch : null}
      />
    <//>
  `;
}

export function CodexConfigModal({ overview, loginFlow, refreshing, runtimeUpdate, onClose, onStartLogin, onCancelLogin, onRefresh, onRuntimeUpdate, onCancelRuntimeUpdate, onDismissRuntimeResult, onSwitchModel, onRemove }) {
  const { switchRole, switchTitle, switchingModel, switchResult, beginSwitch, pick } = useCliModelSwitch(overview, onSwitchModel);
  return html`
    <${Modal} open onClose=${onClose} title=${switchTitle ? `Choose a Codex model for ${switchTitle}` : "Codex"} size="lg">
      ${switchResult ? html`<${CliSwitchResult} result=${switchResult} />` : null}
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
        onPick=${pick}
        onRemove=${onRemove}
        onBack=${null}
      />
    <//>
  `;
}

export function AddBackendModal({ overview, onClose, onAddHttp, onConfigureAnthropic, onConfigureCodex, onConfigureClaudeCode }) {
  const [step, setStep] = useState({ name: "grid" });

  const onSelect = (opt) => {
    if (opt.kind === "anthropic") {
      onConfigureAnthropic();
      onClose();
    } else if (opt.kind === "codex") {
      onConfigureCodex();
      onClose();
    } else if (opt.kind === "claude-code") {
      onConfigureClaudeCode();
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
