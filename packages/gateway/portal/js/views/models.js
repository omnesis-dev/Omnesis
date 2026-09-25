// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Models view — the Models tab of the Settings page, a capability-card layout:
//   /portal/settings/models            → a grid of rounded cards, one per
//                                        capability. An
//                                        enabled capability shows a green tick
//                                        with its provider + model.
//   /portal/settings/models/<cap>      → a dedicated section for that
//                                        capability: the current assignment,
//                                        the catalog/HTTP/Anthropic models to
//                                        pick from, and modals to add a
//                                        backend or choose a model.
//   /portal/settings/models/backends   → manage HTTP + Anthropic backends.
//
// Capability titles, descriptions, and icon slugs come from the gateway
// (`overview.capabilities`, sourced from CAPABILITY_METADATA) — the portal
// never hardcodes that copy. Live updates come from a 1s poll while a download
// or backend probe is in flight.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  getModelsOverview,
  saveModelBehavior,
  getSystemInfo,
  installModel,
  cancelModelDownload,
  uninstallModel,
  activateModel,
  getModelCredentialsStatus,
  setModelProviderCredentials,
  assignCapability,
  addHttpBackend,
  removeHttpBackend,
  probeBackend,
  refreshAnthropicBackend,
  refreshCodexBackend,
  getCodexRuntimeUpdate,
  startCodexRuntimeUpdate,
  cancelCodexRuntimeUpdate,
  startCodexLogin,
  getCodexLogin,
  cancelCodexLogin,
  removeCodexBackend,
  rebuildIndex,
  getAdminConfig,
  patchAdminConfig,
} from "../api.js";
import { CredentialsWizard } from "./credentials-wizard.js";
import { ConfirmModal } from "../components/confirm-modal.js";
import { CapabilityIcon } from "../components/capability-icon.js";
import { useVisiblePoll } from "../lib/use-visible-poll.js";
import { ProviderIcon } from "../components/provider-icon.js";
import { navigate } from "../lib/router.js";
import { isEnabled, isConfigured, capabilityCardState } from "../lib/capability-state.js";
import { CAPABILITY_TO_CATALOG, isAnthropicConfigured, catalogProviderForBackend } from "../lib/backend-options.js";
import { ModelConfigModal, AddBackendModal, CodexConfigModal, codexRuntimeUpdatePresentation, classifyRecentApply } from "./model-config.js";
import { ModelBehaviorEditor, modelBehaviorSummary } from "./model-behavior.js";

// ── Capability grid (the tab's landing view) ──────────────────────────────

function CapabilityCard({ cap, assignment, display, behaviorSummary, onOpen }) {
  // "on" → green tick; "warn" → configured but unavailable (needs attention);
  // "off" → not configured.
  const state = capabilityCardState(assignment);
  const enabled = state === "on";
  const warn = state === "warn";

  return html`
    <button class="cap-card ${enabled ? "cap-card--on" : ""}" onClick=${onOpen}>
      <div class="cap-card-top">
        <span class="cap-card-glyph"><${CapabilityIcon} icon=${cap.icon} /></span>
        ${enabled
          ? html`<span class="cap-card-tick" title="Enabled" aria-label="Enabled">✓</span>`
          : warn
          ? html`<span class="cap-card-warn" title=${assignment.reason ?? "Configured but unavailable"} aria-label="Needs attention">!</span>`
          : null}
      </div>
      <div class="cap-card-title">
        ${cap.title}
        ${cap.experimental
          ? html`<span class="experimental-tag" title="Experimental feature">Experimental</span>`
          : null}
      </div>
      <p class="cap-card-desc">${cap.description}</p>
      <div class="cap-card-foot">
        ${enabled && display
          ? html`<span class="cap-card-model">
              <${ProviderIcon} providerId=${display.providerId} /> ${display.modelName}
              <span class="cap-card-provider">${display.providerLabel}</span>
            </span>`
          : warn
          ? html`<span class="cap-card-state warn">Needs attention</span>`
          : html`<span class="cap-card-state">Not configured</span>`}
        ${behaviorSummary ? html`<span class="cap-card-behavior">${behaviorSummary}</span>` : null}
      </div>
    </button>
  `;
}

export function CapabilityGrid({ overview, onConfigureBackends }) {
  const capabilities = overview.capabilities ?? [];
  const assignments = overview.inference.assignments;
  const displays = overview.assignmentDisplays ?? {};
  const settings = overview.modelSettings ?? {};
  const controls = overview.modelControls ?? {};

  const open = (slug) => navigate(`/portal/settings/models/${slug}`);
  const card = (cap) => html`<${CapabilityCard}
    key=${cap.role}
    cap=${cap}
    assignment=${assignments[cap.role]}
    display=${displays[cap.role]}
    behaviorSummary=${["http", "codex"].includes(assignments[cap.role]?.kind) && !["embedder", "transcriber", "ocr"].includes(cap.role)
      ? modelBehaviorSummary(settings[cap.role], controls[settings[cap.role]?.assignment]) : null}
    onOpen=${() => open(cap.role)}
  />`;

  // Preserve the served grouping order: the core pipeline first, then the
  // roles that reason over the corpus. The gateway withholds experimental
  // capabilities in non-experimental mode, so this group renders whatever is
  // actually available — no client-side experimental logic. It is not labelled
  // experimental: the interactive Agent lives here and has shipped.
  const core = capabilities.filter((cap) => cap.section !== "cognition");
  const cognition = capabilities.filter((cap) => cap.section === "cognition");

  return html`
    <div class="models-overview">
      <button class="btn-secondary models-configure-backends" onClick=${onConfigureBackends}>
        Configure backends
      </button>
      <div class="cap-grid">
        ${core.map(card)}
        ${cognition.map(card)}
      </div>
    </div>
  `;
}

// ── Backends detail ────────────────────────────────────────────────────────

function backendStatusColor(status) {
  if (status === "ok") return "var(--success)";
  if (status === "probing" || status === "reachable") return "var(--warning)";
  return "var(--danger)";
}

function backendStatusLabel(status) {
  if (status === "ok") return "Connected";
  if (status === "probing") return "Probing…";
  if (status === "reachable") return "No model list";
  return "Unreachable";
}

function codexRuntimeLabel(codex) {
  const runtime = codex?.runtime;
  if (!runtime) return null;
  const source =
    runtime.source === "managed"
      ? `managed ${runtime.packageVersion ? `@openai/codex ${runtime.packageVersion}` : "@openai/codex"}`
      : "override";
  const version = runtime.version ? `CLI ${runtime.version}` : "CLI unknown";
  return `${source}, ${version}${codex.discovery ? `, ${codex.discovery}` : ""}`;
}

function BackendsDetail({ overview, anthropicRefreshBusy, codexRefreshBusy, codexRuntimeUpdate, codexLoginPending, onAddBackend, onConfigureAnthropic, onConfigureCodex, onRefreshAnthropic, onRefreshCodex, onUpdateCodexRuntime, onRemoveBackend, onRemoveCodex, onTestBackend, testStates }) {
  const inference = overview.inference;
  const httpBackends = Object.entries(inference.backends).filter(([, s]) => s.type === "http");
  const hasAnthropic = !!inference.backends.anthropic;
  const anthropic = inference.backends.anthropic;
  const anthropicConfigured = isAnthropicConfigured(inference.backends);
  const anthropicBusy = anthropicRefreshBusy || anthropic?.status === "probing";
  const codex = inference.codex?.configured === true ? inference.codex : null;
  const runtimeUpdate = codexRuntimeUpdatePresentation(codexRuntimeUpdate);
  const runtimePlan = codexRuntimeUpdate?.plan;
  const codexBusy = !!codex && (codexRefreshBusy || codex.status === "probing" || runtimeUpdate.active);
  const codexRefreshLabel = codexBusy
    ? runtimeUpdate.active ? "Runtime updating…" : "Checking…"
    : codex?.loggedIn
    ? "Refresh model list"
    : "Check status";
  const codexCheckedAt = codex?.refreshedAt
    ? `last checked ${new Date(codex.refreshedAt).toLocaleTimeString()}`
    : null;
  const codexRuntime = codexRuntimeLabel(codex);

  const testBtn = (key) => {
    const state = testStates[key] || "idle";
    if (state === "testing") return html`<button class="btn-tiny" disabled>Testing…</button>`;
    if (state === "ok") return html`<button class="btn-tiny" disabled style="color: var(--success); border-color: var(--success)">Connected ✓</button>`;
    if (state === "reachable") return html`<button class="btn-tiny" disabled style="color: var(--warning); border-color: var(--warning)" title="Host reachable, but couldn't list models — assign a model id manually">Reachable ⚠</button>`;
    if (state === "fail") return html`<button class="btn-tiny" disabled style="color: var(--danger); border-color: var(--danger)">Failed ✗</button>`;
    return html`<button class="btn-tiny" onClick=${() => onTestBackend(key)}>Test</button>`;
  };

  return html`
    <div class="backends-detail">
      <div class="detail-section">
        <div class="detail-section-head">
          <h2>External backends</h2>
          <button class="btn-primary" onClick=${onAddBackend}>+ Add backend</button>
        </div>
        <p class="detail-sub">Cloud and self-hosted inference servers. Bundled local models are installed from each capability's own section.</p>

        ${httpBackends.length === 0 && !hasAnthropic && !codex
          ? html`<p class="detail-empty">No external backends yet. Add an HTTP server or the Anthropic API to use cloud or self-hosted models.</p>`
          : null}

        ${httpBackends.map(([key, status]) => {
          return html`<div class="backend-item" key=${key}>
            <div class="backend-item-main">
              <div class="backend-item-title"><${ProviderIcon} providerId=${catalogProviderForBackend(overview, key) ?? (overview.presets?.some((preset) => preset.id === key) ? key : null)} /> HTTP · ${key}</div>
              <div class="backend-item-meta">
                <code>${status.url ?? "—"}</code>
                <span style="color: ${backendStatusColor(status.status)}">${backendStatusLabel(status.status)}</span>
                ${status.status === "reachable" ? html`<span title=${status.reason ?? ""}>reachable — assign a model id manually${status.reason ? html` (${status.reason})` : null}</span>` : null}
                ${status.hasApiKey ? html`<span class="backend-pill">Key set</span>` : null}
                ${status.models && status.models.length > 0 ? html`<span>${status.models.length} model${status.models.length !== 1 ? "s" : ""}</span>` : null}
              </div>
            </div>
            <div class="backend-item-actions">
              ${testBtn(key)}
              <button class="btn-tiny danger" onClick=${() => onRemoveBackend(key)}>Remove</button>
            </div>
          </div>`;
        })}

        ${hasAnthropic
          ? html`<div class="backend-item">
              <div class="backend-item-main">
                <div class="backend-item-title"><${ProviderIcon} providerId="anthropic" /> Anthropic API</div>
                <div class="backend-item-meta">
                  <span>API key ${anthropicConfigured ? "configured" : "not configured"}</span>
                  ${anthropic.credentialSource === "environment"
                    ? html`<span class="backend-pill">Environment key</span>`
                    : null}
                  <span style="color: ${backendStatusColor(anthropic.status)}">${backendStatusLabel(anthropic.status)}</span>
                  ${anthropic.models && anthropic.models.length > 0 ? html`<span>${anthropic.models.length} model${anthropic.models.length !== 1 ? "s" : ""}</span>` : null}
                  ${anthropic.reason ? html`<span title=${anthropic.reason}>${anthropic.reason}</span>` : null}
                </div>
              </div>
              <div class="backend-item-actions">
                <button class="btn-tiny" onClick=${onRefreshAnthropic} disabled=${anthropicBusy}>${anthropicBusy ? "Refreshing…" : "Refresh model list"}</button>
                ${anthropic.credentialSource === "environment"
                  ? html`<button
                      class="btn-tiny"
                      disabled
                      title="The active key comes from OMNESIS_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY. Change the environment and restart the gateway to replace it."
                    >
                      Environment key
                    </button>`
                  : html`<button class="btn-tiny" onClick=${onConfigureAnthropic}>${anthropicConfigured ? "Manage key" : "Configure key"}</button>`}
              </div>
            </div>`
          : null}

        ${codex
          ? html`<div class="backend-item">
              <div class="backend-item-main">
                <div class="backend-item-title"><${ProviderIcon} providerId="codex" /> Codex</div>
                <div class="backend-item-meta">
                  <span style="color: ${backendStatusColor(codex.status)}">${backendStatusLabel(codex.status)}</span>
                  <span>${codex.loggedIn ? "ChatGPT login active" : "Not logged in"}</span>
                  ${codexRuntime ? html`<span>${codexRuntime}</span>` : null}
                  ${codexRuntimeUpdate ? html`<span class="codex-runtime-state codex-runtime-state--${runtimeUpdate.tone}">${runtimeUpdate.label}</span>` : null}
                  ${runtimePlan?.targetVersion && runtimePlan.state !== "externally-managed"
                    ? html`<span>Tested ${runtimePlan.targetVersion}</span>`
                    : null}
                  ${codexCheckedAt ? html`<span>${codexCheckedAt}</span>` : null}
                  ${codex.models && codex.models.length > 0 ? html`<span>${codex.models.length} model${codex.models.length !== 1 ? "s" : ""}</span>` : null}
                  ${codex.reason ? html`<span title=${codex.reason}>${codex.reason}</span>` : null}
                </div>
              </div>
              <div class="backend-item-actions">
                ${runtimeUpdate.action
                  ? html`<button class="btn-tiny" disabled=${codexLoginPending} title=${codexLoginPending ? "Finish or cancel Codex login first" : null} onClick=${() => onUpdateCodexRuntime(runtimeUpdate.action)}>
                      ${runtimeUpdate.action === "repair" ? "Repair runtime" : "Update runtime"}
                    </button>`
                  : null}
                <button class="btn-tiny" onClick=${onRefreshCodex} disabled=${codexBusy}>${codexRefreshLabel}</button>
                <button class="btn-tiny" onClick=${onConfigureCodex} disabled=${codexBusy}>${codex.loggedIn ? "Manage" : "Login"}</button>
                <button class="btn-tiny danger" onClick=${onRemoveCodex} disabled=${codexBusy}>Remove</button>
              </div>
            </div>`
          : null}
      </div>
    </div>
  `;
}

// ── Capability detail ──────────────────────────────────────────────────────

/** The served descriptor for a capability role, or undefined if not advertised. */
function capabilityFor(overview, role) {
  return (overview.capabilities ?? []).find((c) => c.role === role);
}

function CapabilityDetail({ role, overview, onOpenPicker, onAddBackend, onDisable, onSaveBehavior }) {
  const cap = capabilityFor(overview, role);
  const assignment = overview.inference.assignments[role];
  const display = overview.assignmentDisplays?.[role];
  const enabled = isEnabled(assignment);
  const configured = isConfigured(assignment);
  const settings = overview.modelSettings?.[role];
  const model = overview.modelControls?.[settings?.assignment];
  const behaviorEditor = ["http", "codex"].includes(assignment.kind) && settings?.assignment && !["embedder", "transcriber", "ocr"].includes(role)
    ? html`<${ModelBehaviorEditor} key=${`${role}:${settings.assignment}`} settings=${settings} model=${model} onSave=${onSaveBehavior} />`
    : null;

  return html`
    <div class="cap-detail">
      <div class="cap-detail-hero">
        <span class="cap-detail-glyph"><${CapabilityIcon} icon=${cap?.icon} size=${28} /></span>
        <div>
          <h2>${cap?.title ?? role}</h2>
          <p class="cap-detail-desc">${cap?.description}</p>
        </div>
      </div>

      <div class="cap-detail-status">
        ${enabled && display
          ? html`<div class="cap-detail-active">
              <div class="cap-detail-active-head">
                <span class="cap-detail-tick">✓</span>
                <div>
                  <div class="cap-detail-active-model"><${ProviderIcon} providerId=${display.providerId} /> ${display.modelName}</div>
                  <div class="cap-detail-active-provider">${display.providerLabel}</div>
                </div>
              </div>
              ${behaviorEditor}
            </div>`
          : configured
          ? html`<div class="cap-detail-warn">
              <strong>Configured, but unavailable.</strong>
              ${assignment.reason ? html` ${assignment.reason}` : " The model or backend isn't reachable right now."}
            </div>`
          : html`<div class="cap-detail-off">Not configured. Choose a model to enable ${cap?.title ?? role}.</div>`}
      </div>

      <div class="cap-detail-actions">
        <button class="btn-primary" onClick=${onOpenPicker}>Choose model</button>
        <button class="btn-secondary" onClick=${onAddBackend}>Add backend</button>
        ${configured ? html`<button class="btn-secondary" onClick=${onDisable}>Disable</button>` : null}
      </div>

      ${enabled && display ? null : behaviorEditor}

      ${role === "embedder"
        ? html`<div class="cap-detail-hint">Switching the embedder rebuilds the vector index gracefully — search stays live on the current model and switches automatically when the new index is ready. A hard cutover (offered when switching) stops the old model immediately, leaving keyword-only search until the rebuild finishes.</div>`
        : null}
      ${role === "transcriber"
        ? html`<div class="cap-detail-hint">Voice notes are transcribed as sources sync. Already-ingested voice notes are <strong>not</strong> re-transcribed automatically; resync a source to reprocess it.</div>`
        : null}
      ${role === "ocr"
        ? html`<div class="cap-detail-hint">Images and scanned PDFs are OCR'd as sources sync. Already-ingested attachments are <strong>not</strong> re-OCR'd automatically; resync a source to reprocess them.</div>`
        : null}
      ${role === "entailment-verifier"
        ? html`<${EntailmentPromptStyle} />`
        : null}
    </div>
  `;
}

// Prompt-style setting for the entailment verifier — the one knob the config
// tab's "managed on the Models tab" ownership note points here. `judge` is
// the generic three-label prompt any chat model answers; `minicheck` is the
// Document/Claim Yes-No convention MiniCheck-family checkers were trained on.
function EntailmentPromptStyle() {
  const [style, setStyle] = useState(null); // null = loading
  const [error, setError] = useState(null);
  useEffect(() => {
    getAdminConfig()
      .then((cfg) => setStyle(cfg?.inference?.entailment?.promptStyle ?? "judge"))
      .catch(() => setStyle("judge"));
  }, []);
  async function pick(next) {
    const prev = style;
    setStyle(next);
    setError(null);
    const res = await patchAdminConfig({ inference: { entailment: { promptStyle: next } } });
    if (!res.ok) {
      setStyle(prev);
      setError(res.body?.error ?? "Failed to save the prompt style.");
    }
  }
  return html`
    <div class="cap-detail-hint">
      <strong>Prompt style.</strong> How the verifier is asked for its verdict:
      <label class="cap-prompt-style-opt">
        <input type="radio" name="entailment-prompt-style" checked=${style === "judge"} disabled=${style === null} onChange=${() => pick("judge")} />
        Generic judge — any chat-capable model
      </label>
      <label class="cap-prompt-style-opt">
        <input type="radio" name="entailment-prompt-style" checked=${style === "minicheck"} disabled=${style === null} onChange=${() => pick("minicheck")} />
        MiniCheck convention — for MiniCheck-family fact checkers
      </label>
      ${error ? html`<div class="cap-detail-warn">${error}</div>` : null}
    </div>
  `;
}

// ── Main view ──────────────────────────────────────────────────────────────

/**
 * Resolve the `/portal/settings/models/<section>` path segment to what the tab
 * shows: no segment is the capability grid, "backends" is the backend list,
 * and anything else names a capability and opens its detail.
 *
 * `validRoles` are the roles the gateway actually advertises, so a capability
 * it doesn't serve — an experimental role on a stock install, a role from a
 * newer version — isn't routable and falls back to the grid rather than
 * rendering an empty detail.
 */
export function resolveModelsSection(section, validRoles) {
  if (section == null) return { view: "grid", role: null };
  if (section === "backends") return { view: "backends", role: null };
  if (validRoles.includes(section)) return { view: "capability", role: section };
  return { view: "grid", role: null };
}

export function ModelsView({ section }) {
  const [overview, setOverview] = useState(null);
  const [sys, setSys] = useState(null);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);
  const [credsWizard, setCredsWizard] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [showAddBackend, setShowAddBackend] = useState(false);
  const [showCodexConfig, setShowCodexConfig] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [testStates, setTestStates] = useState({});
  const [codexLoginFlow, setCodexLoginFlow] = useState(null);
  const [codexRefreshBusy, setCodexRefreshBusy] = useState(false);
  const [codexRuntimeUpdate, setCodexRuntimeUpdate] = useState(null);
  const [codexRuntimeError, setCodexRuntimeError] = useState(null);
  const [dismissedCodexOperation, setDismissedCodexOperation] = useState(null);
  const [anthropicRefreshBusy, setAnthropicRefreshBusy] = useState(false);
  const refreshSequence = useRef(0);

  const validRoles = (overview?.capabilities ?? []).map((c) => c.role);
  const { view, role } = resolveModelsSection(section ?? null, validRoles);
  const visibleCodexRuntimeUpdate =
    codexRuntimeUpdate?.operation?.id === dismissedCodexOperation
      ? { ...codexRuntimeUpdate, operation: null }
      : codexRuntimeUpdate;

  const refresh = async () => {
    const sequence = ++refreshSequence.current;
    try {
      const [o, s] = await Promise.all([
        getModelsOverview(),
        getSystemInfo(),
      ]);
      if (sequence !== refreshSequence.current) return;
      setOverview(o);
      setSys(s);
      setError(null);
    } catch (e) {
      if (sequence !== refreshSequence.current) return;
      setError(e?.message ?? String(e));
    }
  };

  const refreshCodexRuntimePlan = async () => {
    try {
      setCodexRuntimeUpdate(await getCodexRuntimeUpdate());
      setCodexRuntimeError(null);
    } catch (e) {
      setCodexRuntimeError(e?.message ?? String(e));
    }
  };

  useEffect(() => {
    refresh();
    refreshCodexRuntimePlan();
  }, []);

  // Probe HTTP backends once after first load so their status is fresh.
  const [probed, setProbed] = useState(false);
  useEffect(() => {
    if (probed || !overview) return;
    setProbed(true);
    const httpKeys = Object.entries(overview.inference.backends)
      .filter(([, s]) => s.type === "http")
      .map(([k]) => k);
    if (httpKeys.length === 0) return;
    Promise.allSettled(httpKeys.map((k) => probeBackend(k))).then(() => refresh());
  }, [overview, probed]);

  const hasActiveDownload = (overview?.activeDownloads?.length ?? 0) > 0;
  useVisiblePoll(refresh, 1000, { enabled: hasActiveDownload });
  const hasProbingBackend = Object.values(overview?.inference?.backends ?? {}).some((b) => b.status === "probing");
  useVisiblePoll(refresh, 1000, { enabled: hasProbingBackend });
  const hasProbingCodex = overview?.inference?.codex?.status === "probing";
  useVisiblePoll(refresh, 1000, { enabled: hasProbingCodex });
  const codexUpdateActive = codexRuntimeUpdatePresentation(codexRuntimeUpdate).active;
  useVisiblePoll(async () => {
    try {
      const next = await getCodexRuntimeUpdate();
      setCodexRuntimeUpdate(next);
      setCodexRuntimeError(null);
      if (next.operation && !codexRuntimeUpdatePresentation(next).active) await refresh();
    } catch (e) {
      setCodexRuntimeError(e?.message ?? String(e));
      flashErr(e?.message ?? String(e));
    }
  }, 1000, { enabled: codexUpdateActive });
  useVisiblePoll(async () => {
    try {
      const data = await getCodexLogin();
      setCodexLoginFlow(data.flow ?? null);
      if (data.flow?.status === "complete") await refresh();
    } catch {
      // A transient poll failure should not close the login modal.
    }
  }, 2000, { enabled: codexLoginFlow?.status === "pending" });

  const flashOk = (msg) => { setFlash({ kind: "success", message: msg }); setTimeout(() => setFlash(null), 3000); };
  const flashErr = (msg) => setFlash({ kind: "error", message: msg });

  // ── Backend management ──────────────────────────────────────────────────

  const onAddHttp = async (name, url, apiKey, apiPathPrefix, allowRemoteInference = false) => {
    try {
      const res = await addHttpBackend(name, url, apiKey, apiPathPrefix, allowRemoteInference);
      if (!res.ok) {
        const msg = res.body?.errors?.[0]?.message ?? res.body?.error ?? "Failed to add backend.";
        flashErr(msg);
        await refresh();
        return { ok: false, error: msg };
      }
      flashOk(
        allowRemoteInference
          ? `Added HTTP backend "${name}" and enabled remote inference.`
          : `Added HTTP backend "${name}".`,
      );
      await refresh();
      // Probe immediately so its models populate the picker.
      probeBackend(name).then(() => refresh()).catch(() => {});
      return { ok: true };
    } catch (e) {
      const msg = e?.message ?? String(e);
      flashErr(msg);
      return { ok: false, error: msg };
    }
  };

  const onConfigureAnthropic = async () => {
    try {
      const status = await getModelCredentialsStatus();
      const credEntry = (status.items || []).find((e) => e.fileKey === "anthropic");
      if (credEntry) setCredsWizard({ entry: credEntry });
    } catch (e) {
      flashErr(e?.message ?? String(e));
    }
  };

  const onRefreshCodex = async () => {
    if (codexRefreshBusy) return false;
    setCodexRefreshBusy(true);
    try {
      await refreshCodexBackend();
      await refresh();
      return true;
    } catch (e) {
      flashErr(e?.message ?? String(e));
      return false;
    } finally {
      setCodexRefreshBusy(false);
    }
  };

  const onRefreshAnthropic = async () => {
    if (anthropicRefreshBusy) return false;
    setAnthropicRefreshBusy(true);
    try {
      const status = await refreshAnthropicBackend();
      await refresh();
      if (status.status === "ok") {
        flashOk("Refreshed the Anthropic model list.");
        return true;
      }
      flashErr(status.reason ?? "Anthropic model discovery failed.");
      return false;
    } catch (e) {
      flashErr(e?.message ?? String(e));
      await refresh();
      return false;
    } finally {
      setAnthropicRefreshBusy(false);
    }
  };

  const onUpdateCodexRuntime = (action) => {
    const plan = codexRuntimeUpdate?.plan;
    const verb = action === "repair" ? "Repair" : "Update";
    const from = plan?.currentVersion ?? "the current installation";
    const to = plan?.targetVersion ?? "the tested runtime";
    setConfirmState({
      title: `${verb} Codex runtime?`,
      body: html`<div class="codex-update-confirm">
        <p><strong>${from} → ${to}</strong>, the Codex runtime tested with this Omnesis version.</p>
        <p>Your ChatGPT login and model assignments are preserved. New Codex work pauses briefly while active turns finish and the gateway switches runtimes. The gateway stays online throughout.</p>
        <p>Omnesis verifies the replacement before activation. If activation itself fails, it restores the previous runtime.</p>
      </div>`,
      confirmLabel: `${verb} runtime`,
      onConfirm: async () => {
        try {
          setDismissedCodexOperation(null);
          setCodexRuntimeUpdate(await startCodexRuntimeUpdate());
          setCodexRuntimeError(null);
          setShowCodexConfig(true);
        } catch (e) {
          flashErr(e?.message ?? String(e));
        }
      },
    });
  };

  const onCancelCodexRuntimeUpdate = async () => {
    try {
      setCodexRuntimeUpdate(await cancelCodexRuntimeUpdate());
    } catch (e) {
      flashErr(e?.message ?? String(e));
    }
  };

  const onStartCodexLogin = async () => {
    try {
      const flow = await startCodexLogin();
      setCodexLoginFlow(flow);
      if (flow.status === "complete") await onRefreshCodex();
    } catch (e) {
      flashErr(e?.message ?? String(e));
    }
  };

  const onCancelCodexLogin = async () => {
    try {
      const res = await cancelCodexLogin();
      setCodexLoginFlow(res.flow ?? null);
      await refresh();
    } catch (e) {
      flashErr(e?.message ?? String(e));
    }
  };

  const onRemoveCodex = () => {
    setConfirmState({
      title: "Remove Codex backend?",
      body: "This logs Omnesis out of the dedicated Codex home for this gateway and disables any capability currently assigned to Codex. You can add it again by logging in.",
      confirmLabel: "Remove",
      destructive: true,
      onConfirm: async () => {
        try {
          await removeCodexBackend();
          setCodexLoginFlow(null);
          flashOk("Removed Codex backend.");
          await refresh();
        } catch (e) {
          flashErr(e?.message ?? String(e));
        }
      },
    });
  };

  const onTestBackend = async (key) => {
    setTestStates((s) => ({ ...s, [key]: "testing" }));
    try {
      const result = await probeBackend(key);
      // Mirror the three probe outcomes: ok (listed models), reachable (host up
      // but model list unavailable), fail (unreachable / bad credentials).
      const state = result.status === "ok" ? "ok" : result.status === "reachable" ? "reachable" : "fail";
      setTestStates((s) => ({ ...s, [key]: state }));
      await refresh();
    } catch {
      setTestStates((s) => ({ ...s, [key]: "fail" }));
    }
    setTimeout(() => setTestStates((s) => ({ ...s, [key]: "idle" })), 3000);
  };

  const onRemoveBackend = (key) => {
    setConfirmState({
      title: `Remove backend "${key}"?`,
      body: "Any capability using this backend will become unavailable.",
      confirmLabel: "Remove",
      destructive: true,
      onConfirm: async () => {
        try {
          const res = await removeHttpBackend(key);
          if (!res.ok) flashErr(res.body?.errors?.[0]?.message ?? res.body?.error ?? "Failed to remove backend.");
          else flashOk(`Removed backend "${key}".`);
          await refresh();
        } catch (e) {
          flashErr(e?.message ?? String(e));
        }
      },
    });
  };

  // ── Local model lifecycle ───────────────────────────────────────────────

  const onInstall = async (entry) => {
    try {
      await installModel(entry.id);
      await refresh();
    } catch (e) {
      flashErr(e?.message ?? String(e));
    }
  };

  const onCancelDownload = async (id) => {
    try { await cancelModelDownload(id); await refresh(); } catch (e) { flashErr(e?.message ?? String(e)); }
  };

  const onUninstall = (entry) => {
    setConfirmState({
      title: `Remove ${entry.id}?`,
      body: "The model file is deleted from disk. You can re-install it any time from the catalog.",
      confirmLabel: "Remove",
      destructive: true,
      onConfirm: async () => {
        try { await uninstallModel(entry.id); flashOk(`Removed ${entry.id}`); await refresh(); } catch (e) { flashErr(e?.message ?? String(e)); }
      },
    });
  };

  // ── Activation / assignment ─────────────────────────────────────────────

  const performActivation = async (entry, catalogRole) => {
    if (
      entry.kind === "anthropic-api" &&
      !isAnthropicConfigured(overview.inference.backends)
    ) {
      try {
        const status = await getModelCredentialsStatus();
        const credEntry = (status.items || []).find((e) => e.fileKey === "anthropic");
        if (credEntry && !credEntry.configured) {
          setCredsWizard({
            entry: credEntry,
            pendingActivation: { entry, catalogRole, capability: role },
          });
          return;
        }
      } catch {
        // fall through
      }
    }
    try {
      const res = await activateModel(entry.id, catalogRole, role);
      flashOk(res.willReindex ? `Activated ${entry.name} — reindex started.` : `Activated ${entry.name}.`);
      await refresh();
    } catch (e) {
      flashErr(e?.message ?? String(e));
    }
  };

  const assignHttp = async (backendKey, model) => {
    const assignmentValue = `${backendKey}/${model}`;
    // mode: "graceful" (default, zero-downtime) | "hard" (immediate cutover).
    const doAssign = async (mode = "graceful") => {
      try {
        const res = await assignCapability(role, assignmentValue);
        if (!res.ok) {
          flashErr(res.body?.errors?.[0]?.message ?? res.body?.error ?? "Failed to update config.");
          return;
        }
        if (role === "embedder" && mode === "hard") {
          // The config change above kicked off a graceful swap; the hard
          // cutover request supersedes it (gateway newest-wins) — stop the old
          // model now, keyword-only search until the rebuild completes (#1011).
          await rebuildIndex("hard");
          flashOk(`Switching ${role} to ${model} — hard cutover; keyword-only search until ready.`);
        } else if (role === "embedder") {
          flashOk(`Switching ${role} to ${model} — search stays live, switches automatically when ready.`);
        } else {
          flashOk(`Switched ${role} to ${model} on "${backendKey}".`);
        }
        await refresh();
      } catch (e) {
        flashErr(e?.message ?? String(e));
      }
    };
    if (role === "embedder") {
      setConfirmState({
        title: `Switch embedding model to ${model}?`,
        body: "Graceful (recommended): search stays live on the current model and switches automatically when the new index is ready — no downtime. Hard cutover stops the current model immediately and drops to keyword-only search until the rebuild finishes.",
        confirmLabel: "Switch (graceful)",
        onConfirm: () => doAssign("graceful"),
        secondaryLabel: "Hard cutover",
        secondaryDestructive: true,
        onSecondary: () => doAssign("hard"),
      });
      return;
    }
    await doAssign();
  };

  const pickLocal = (entry, catalogRole = CAPABILITY_TO_CATALOG[role]) => {
    setShowPicker(false);
    if (catalogRole === "embed") {
      // Graceful swaps now cover a local target too (epic #1011, mechanism 1):
      // the new local model builds in an off-main-thread build worker while the
      // active index keeps serving, then flips. Offer the same graceful-vs-hard
      // choice as an HTTP target — graceful (default), hard cutover as the opt-out.
      const doAssign = async (mode = "graceful") => {
        await performActivation(entry, catalogRole);
        if (mode === "hard") {
          try {
            await rebuildIndex("hard");
            flashOk(`Switching ${role} to ${entry.name} — hard cutover; keyword-only search until ready.`);
          } catch (e) {
            flashErr(e?.message ?? String(e));
          }
        }
      };
      setConfirmState({
        title: `Switch embedding model to ${entry.name}?`,
        body: "Graceful (recommended): search stays live on the current model and switches automatically when the new index is ready — no downtime. Hard cutover stops the current model immediately and drops to keyword-only search until the rebuild finishes.",
        confirmLabel: "Switch (graceful)",
        onConfirm: () => doAssign("graceful"),
        secondaryLabel: "Hard cutover",
        secondaryDestructive: true,
        onSecondary: () => doAssign("hard"),
      });
      return;
    }
    if (catalogRole === "transcribe") {
      setConfirmState({
        title: `Use ${entry.name} for transcription?`,
        body: "Voice notes are transcribed locally as sources sync. Already-ingested voice notes are NOT re-transcribed automatically — resync a source to reprocess it.",
        confirmLabel: "Use",
        onConfirm: () => performActivation(entry, catalogRole),
      });
      return;
    }
    void performActivation(entry, catalogRole);
  };

  const pickAnthropic = (entry) => {
    setShowPicker(false);
    void performActivation(entry, CAPABILITY_TO_CATALOG[role]);
  };

  const pickHttp = (backendKey, model) => {
    setShowPicker(false);
    void assignHttp(backendKey, model);
  };

  const assignCodexModel = async (targetRole, model) => {
    const targetTitle = capabilityFor(overview, targetRole)?.title ?? targetRole;
    try {
      const res = await assignCapability(targetRole, `codex/${model}`);
      if (!res.ok) {
        flashErr(res.body?.errors?.[0]?.message ?? res.body?.error ?? "Failed to update config.");
        return false;
      }
      flashOk(`${targetTitle} now uses ${model} on Codex.`);
      await refresh();
      return true;
    } catch (e) {
      flashErr(e?.message ?? String(e));
      return false;
    }
  };

  const pickCodex = async (model) => {
    setShowPicker(false);
    return assignCodexModel(role, model);
  };

  // Apply one "Recently used" entry: catalog models go through the same
  // local-use path (including the embedder cutover choice and the Anthropic
  // key wizard) with the server-provided catalog role — which covers chat
  // roles the portal's own catalog map doesn't list. Anything else assigns
  // the raw value, splitting backend/model for the HTTP confirm flow and
  // assigning bare values (native OCR runtimes, replay) directly. The
  // branching decision is `classifyRecentApply` (unit-tested in
  // model-config.js); this only wires it to the view's actions.
  const pickRecent = (entry) => {
    const decision = classifyRecentApply(entry, overview.catalog);
    if (decision.kind === "error") {
      setShowPicker(false);
      flashErr(decision.message);
      return;
    }
    if (decision.kind === "activate") {
      pickLocal(decision.entry, decision.catalogRole);
      return;
    }
    setShowPicker(false);
    if (decision.kind === "assignRaw") {
      assignCapability(role, decision.value)
        .then(async (res) => {
          if (!res.ok) {
            flashErr(res.body?.errors?.[0]?.message ?? res.body?.error ?? "Failed to update config.");
          } else {
            flashOk(`Switched ${role} to ${decision.value}.`);
          }
          await refresh();
        })
        .catch((e) => flashErr(e?.message ?? String(e)));
      return;
    }
    void assignHttp(decision.backendKey, decision.model);
  };

  const onDisable = () => {
    setConfirmState({
      title: `Disable ${role}?`,
      body: "This capability will be turned off until you choose a model again.",
      confirmLabel: "Disable",
      destructive: true,
      onConfirm: async () => {
        try {
          const res = await assignCapability(role, null);
          if (!res.ok) flashErr(res.body?.errors?.[0]?.message ?? res.body?.error ?? "Failed to update config.");
          else flashOk(`Disabled ${role}.`);
          await refresh();
        } catch (e) {
          flashErr(e?.message ?? String(e));
        }
      },
    });
  };

  const onSaveBehavior = async (assignment, values, expectedValues) => {
    try {
      await saveModelBehavior(role, assignment, values, expectedValues);
      await refresh();
      flashOk("Model settings saved.");
    } catch (error) {
      if (error?.status === 409) await refresh();
      throw error;
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────

  if (error && !overview) {
    return html`<div class="config-view"><div class="config-banner error">Failed to load models: ${error}</div></div>`;
  }
  if (!overview) {
    return html`<div class="config-view"><p class="config-empty">Loading models…</p></div>`;
  }

  return html`
    <div class="config-view models-view">
      ${view !== "grid"
        ? html`<header class="config-header">
            <div>
                <button class="models-back" onClick=${() => navigate("/portal/settings/models")}>← Models</button>
                ${
                  // A capability's detail opens with its own titled hero card,
                  // so only the backend list needs a heading of its own.
                  view === "backends"
                    ? html`<h2 class="models-section-title">Backends</h2>`
                    : null
                }
            </div>
          </header>`
        : null}

      ${flash ? html`<div class=${`config-banner ${flash.kind}`}>${flash.message}</div>` : null}
      ${codexRuntimeError
        ? html`<div class="config-banner error" role="alert">
            Codex runtime status unavailable: ${codexRuntimeError}
            <button class="btn-tiny" onClick=${refreshCodexRuntimePlan}>Retry</button>
          </div>`
        : null}

      ${view === "grid"
        ? html`<${CapabilityGrid}
            overview=${overview}
            onConfigureBackends=${() => navigate("/portal/settings/models/backends")}
          />`
        : null}

      ${view === "backends"
        ? html`<${BackendsDetail}
            overview=${overview}
            anthropicRefreshBusy=${anthropicRefreshBusy}
            codexRefreshBusy=${codexRefreshBusy}
            codexRuntimeUpdate=${visibleCodexRuntimeUpdate}
            codexLoginPending=${codexLoginFlow?.status === "pending"}
            testStates=${testStates}
            onAddBackend=${() => setShowAddBackend(true)}
            onConfigureAnthropic=${onConfigureAnthropic}
            onConfigureCodex=${() => setShowCodexConfig(true)}
            onRefreshAnthropic=${onRefreshAnthropic}
            onRefreshCodex=${onRefreshCodex}
            onUpdateCodexRuntime=${onUpdateCodexRuntime}
            onRemoveBackend=${onRemoveBackend}
            onRemoveCodex=${onRemoveCodex}
            onTestBackend=${onTestBackend}
          />`
        : null}

      ${view === "capability"
        ? html`<${CapabilityDetail}
            role=${role}
            overview=${overview}
            onOpenPicker=${() => setShowPicker(true)}
            onAddBackend=${() => setShowAddBackend(true)}
            onDisable=${onDisable}
            onSaveBehavior=${onSaveBehavior}
          />`
        : null}

      ${showAddBackend
        ? html`<${AddBackendModal}
            overview=${overview}
            onClose=${() => setShowAddBackend(false)}
            onAddHttp=${onAddHttp}
            onConfigureAnthropic=${onConfigureAnthropic}
            onConfigureCodex=${() => setShowCodexConfig(true)}
          />`
        : null}

      ${showCodexConfig
        ? html`<${CodexConfigModal}
            overview=${overview}
            loginFlow=${codexLoginFlow}
            refreshing=${codexRefreshBusy}
            runtimeUpdate=${visibleCodexRuntimeUpdate}
            onClose=${() => setShowCodexConfig(false)}
            onStartLogin=${onStartCodexLogin}
            onCancelLogin=${onCancelCodexLogin}
            onRefresh=${onRefreshCodex}
            onRuntimeUpdate=${onUpdateCodexRuntime}
            onCancelRuntimeUpdate=${onCancelCodexRuntimeUpdate}
            onDismissRuntimeResult=${() => setDismissedCodexOperation(codexRuntimeUpdate?.operation?.id ?? null)}
            onSwitchModel=${assignCodexModel}
            onRemove=${onRemoveCodex}
          />`
        : null}

      ${showPicker && role
        ? html`<${ModelConfigModal}
            role=${role}
            capTitle=${capabilityFor(overview, role)?.title ?? role}
            overview=${overview}
            sys=${sys}
            codexLoginFlow=${codexLoginFlow}
            codexRefreshing=${codexRefreshBusy}
            codexRuntimeUpdate=${visibleCodexRuntimeUpdate}
            onClose=${() => setShowPicker(false)}
            onAddHttp=${onAddHttp}
            onPickLocal=${pickLocal}
            onPickAnthropic=${pickAnthropic}
            onPickHttp=${pickHttp}
            onPickCodex=${pickCodex}
            onPickRecent=${pickRecent}
            onStartCodexLogin=${onStartCodexLogin}
            onCancelCodexLogin=${onCancelCodexLogin}
            onRefreshCodex=${onRefreshCodex}
            onCodexRuntimeUpdate=${onUpdateCodexRuntime}
            onCancelCodexRuntimeUpdate=${onCancelCodexRuntimeUpdate}
            onDismissCodexRuntimeResult=${() => setDismissedCodexOperation(codexRuntimeUpdate?.operation?.id ?? null)}
            onInstall=${onInstall}
            onUninstall=${onUninstall}
            onCancelDownload=${onCancelDownload}
          />`
        : null}

      ${credsWizard
        ? html`<${CredentialsWizard}
            entry=${credsWizard.entry}
            saveCredentials=${setModelProviderCredentials}
            onClose=${async (updated) => {
              const pending = credsWizard;
              setCredsWizard(null);
              if (updated && pending?.pendingActivation) {
                const { entry, catalogRole, capability } = pending.pendingActivation;
                try {
                  const res = await activateModel(entry.id, catalogRole, capability);
                  flashOk(res.willReindex ? `Activated ${entry.name} — reindex started.` : `Activated ${entry.name}.`);
                  await refresh();
                } catch (e) {
                  flashErr(e?.message ?? String(e));
                }
              } else if (updated) {
                await refresh();
              }
            }}
          />`
        : null}

      <${ConfirmModal}
        open=${!!confirmState}
        title=${confirmState?.title}
        body=${confirmState?.body}
        confirmLabel=${confirmState?.confirmLabel}
        destructive=${!!confirmState?.destructive}
        secondaryLabel=${confirmState?.secondaryLabel ?? null}
        secondaryDestructive=${!!confirmState?.secondaryDestructive}
        onCancel=${() => setConfirmState(null)}
        onConfirm=${async () => {
          const fn = confirmState?.onConfirm;
          setConfirmState(null);
          if (fn) await fn();
        }}
        onSecondary=${async () => {
          const fn = confirmState?.onSecondary;
          setConfirmState(null);
          if (fn) await fn();
        }}
      />
    </div>
  `;
}
