// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The Decision model's setup, beside the generic Models flows:
//
//   • DecisionProviderGrid     — the provider picker: your decision backends,
//                                then servers on this machine, then hosted
//                                APIs (TypeSafe first).
//   • DecisionBackendForm      — one provider's form: name, URL, key, model;
//                                Save is one config write, then a test
//                                decision whose answer shows inline.
//   • DecisionCheckLine        — the result of that test decision.
//   • DecisionCalibrationPanel — maps a decision backend's scores onto Jev's
//                                scale, so the decision thresholds keep
//                                their meaning.
//   • DecisionBackendsSection  — the configured decision backends on the
//                                Backends page, with edit and remove.
//   • DecisionBackendModal     — edit one decision backend's URL or key.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  probeDecisionBackend,
  probeDecisionEndpoint,
  getDecisionCalibration,
  startDecisionCalibration,
  cancelDecisionCalibration,
} from "../api.js";
import { Modal } from "../components/modal.js";
import { BackendOptionCard, Monogram, ProviderLogo, LOCAL_GLYPH, TYPESAFE_GLYPH, ADD_GLYPH } from "../components/backend-option-card.js";
import { CloudInferenceConsentModal } from "../components/cloud-inference-consent.js";
import { remoteAssignmentConsent } from "../lib/cloud-inference.js";
import { useVisiblePoll } from "../lib/use-visible-poll.js";
import {
  assignedCalibration,
  assignedDecisionBackend,
  calibrationFraction,
  calibrationPanelState,
  calibrationProgressText,
  calibrationSummary,
  canProbeDecisionBackend,
  CUSTOM_DECISION_PROVIDER,
  decisionBackendNameError,
  decisionBackends,
  decisionBackendWhere,
  decisionLogoId,
  decisionModelHint,
  decisionModelOptions,
  decisionProviderGroups,
  decisionUrlPlaceholders,
  decisionVerifyText,
  defaultDecisionBackendName,
  fillDecisionUrl,
  presetForBackend,
} from "../lib/decision-backends.js";

/** How long typing in a new server's URL or key pauses before its models are listed. */
const ENDPOINT_PROBE_DEBOUNCE_MS = 600;

const plural = (n, noun) => `${n} ${noun}${n !== 1 ? "s" : ""}`;

/** A preset note with `code` spans, e.g. "Pull a model with `ollaya pull <model>` first." */
function NoteText({ text }) {
  const parts = String(text ?? "").split("`");
  return html`${parts.map((part, i) => (i % 2 ? html`<code key=${i}>${part}</code>` : part))}`;
}

/** A provider's logo, its initial when the gateway has none, or the server glyph. */
function ProviderMark({ provider, name }) {
  const logo = decisionLogoId(provider);
  return logo
    ? html`<${ProviderLogo} providerId=${logo} fallback=${html`<${Monogram} name=${provider.name ?? name} />`} size=${22} />`
    : LOCAL_GLYPH;
}

function fallbackFor(provider) {
  if (provider?.custom) return ADD_GLYPH;
  if (provider?.builtIn === "typesafe") return TYPESAFE_GLYPH;
  return html`<${Monogram} name=${provider?.name} />`;
}

// ── Provider picker ─────────────────────────────────────────────────────────

/** One short line under a provider: what it offers, never where it runs (the group says that). */
function providerSubtitle(provider) {
  if (provider.custom) return "Your own URL";
  if (provider.builtIn === "typesafe") return "Reference model";
  const count = provider.models?.length ?? 0;
  return count > 0 ? plural(count, "model") : provider.kind === "local" ? "Local server" : "Hosted API";
}

/**
 * The Decision model's provider picker. `chatGrid`, when given, is the
 * experimental chat-model grid shown under its own heading.
 */
export function DecisionProviderGrid({ overview, chatGrid, onSelectExisting, onSelectProvider }) {
  const { existing, local, cloud } = decisionProviderGroups(overview);
  return html`
    <div class="decision-provider-picker">
      ${existing.length
        ? html`<section class="decision-provider-group">
            <h3 class="decision-provider-heading">Your decision backends</h3>
            <div class="backend-opt-grid">
              ${existing.map(({ key, backend, preset }) => html`<${BackendOptionCard}
                key=${`existing-${key}`}
                compact
                providerId=${decisionLogoId(preset)}
                fallbackGlyph=${preset ? fallbackFor(preset) : LOCAL_GLYPH}
                title=${key}
                subtitle=${[preset?.name, decisionBackendWhere(backend)].filter(Boolean).join(" · ")}
                onClick=${() => onSelectExisting(key)}
              />`)}
            </div>
          </section>`
        : null}
      <section class="decision-provider-group">
        <h3 class="decision-provider-heading">On this machine</h3>
        <div class="backend-opt-grid">
          ${local.map((provider) => html`<${BackendOptionCard}
            key=${`local-${provider.id}`}
            compact
            providerId=${decisionLogoId(provider)}
            fallbackGlyph=${fallbackFor(provider)}
            title=${provider.name}
            subtitle=${providerSubtitle(provider)}
            onClick=${() => onSelectProvider(provider)}
          />`)}
        </div>
      </section>
      ${cloud.length
        ? html`<section class="decision-provider-group">
            <h3 class="decision-provider-heading">Cloud</h3>
            <div class="backend-opt-grid">
              ${cloud.map((provider) => html`<${BackendOptionCard}
                key=${`cloud-${provider.id}`}
                compact
                providerId=${decisionLogoId(provider)}
                fallbackGlyph=${fallbackFor(provider)}
                title=${provider.name}
                subtitle=${providerSubtitle(provider)}
                onClick=${() => onSelectProvider(provider)}
              />`)}
            </div>
          </section>`
        : null}
      ${chatGrid
        ? html`<section class="decision-provider-group">
            <h3 class="decision-provider-heading">Chat models <span class="experimental-tag">Experimental</span></h3>
            ${chatGrid}
          </section>`
        : null}
    </div>
  `;
}

// ── Test decision result ────────────────────────────────────────────────────

/** `check`: `{state: "checking"|"ok"|"fail", result?}` for one assignment. */
export function DecisionCheckLine({ check, model }) {
  if (!check) return null;
  if (check.state === "checking") {
    return html`<div class="decision-check decision-check--busy" role="status">
      <span class="decision-check-spinner" aria-hidden="true"></span>
      Checking that ${model ?? "the model"} answers…
    </div>`;
  }
  const ok = check.state === "ok";
  return html`<div class=${`decision-check decision-check--${ok ? "ok" : "fail"}`} role="status">
    <span class="decision-check-icon" aria-hidden="true">${ok ? "✓" : "!"}</span>
    <span>${decisionVerifyText(check.result, model)}</span>
  </div>`;
}

// ── Provider form ───────────────────────────────────────────────────────────

function ModelSuggestions({ options, value, onPick }) {
  if (!options.length) return null;
  return html`<div class="decision-model-list" role="listbox" aria-label="Suggested models">
    ${options.map((option) => {
      const hint = decisionModelHint(option);
      const selected = option.id === value;
      return html`<button
        type="button"
        role="option"
        key=${option.id}
        class=${`decision-model-opt${selected ? " is-selected" : ""}`}
        aria-selected=${selected}
        onClick=${() => onPick(option.id)}
      >
        <span class="decision-model-id">${option.id}</span>
        ${option.installed ? html`<span class="picker-tag good">On server</span>` : null}
        ${hint ? html`<span class="decision-model-hint">${hint}</span>` : null}
      </button>`;
    })}
  </div>`;
}

/**
 * Set up one decision provider, or change a configured decision backend.
 *
 * `mode` "assign" also picks the model and makes it the Decision model;
 * "manage" edits only the backend (URL, key). `provider` is a decision
 * preset or "Other server"; `existingKey` names a configured backend instead.
 * `onSave(fields)` resolves to `{ok, error?}`; the form asks the
 * cloud-inference question itself before calling it.
 */
export function DecisionBackendForm({ overview, provider: givenProvider, existingKey, mode = "assign", checks = {}, onVerify, onSave, onBack, onDone }) {
  const existing = existingKey ? decisionBackends(overview)[existingKey] : null;
  const provider = givenProvider ?? (existing ? presetForBackend(overview, existing) ?? CUSTOM_DECISION_PROVIDER : CUSTOM_DECISION_PROVIDER);
  const assignedHere = assignedDecisionBackend(overview);
  const [savedKey, setSavedKey] = useState(existingKey ?? null);
  const key0 = savedKey ?? existingKey;
  const [name, setName] = useState(() => existingKey ?? defaultDecisionBackendName(provider, overview));
  const [params, setParams] = useState({});
  const [paramsTouched, setParamsTouched] = useState(false);
  const [url, setUrl] = useState(() => existing?.url ?? (provider.urlParams?.length ? "" : provider.url ?? ""));
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(() => (assignedHere && assignedHere.key === existingKey ? assignedHere.model : ""));
  const [phase, setPhase] = useState("edit"); // edit | saving | saved
  const [error, setError] = useState(null);
  const [consent, setConsent] = useState(null);
  const [probe, setProbe] = useState(null); // null | {state: "busy"} | result
  const probeSeq = useRef(0);

  const backend = key0 ? decisionBackends(overview)[key0] : null;
  const isEdit = !!key0;
  // A configured backend shows its stored URL; a new one with placeholders
  // asks for each value instead.
  const usesParams = !isEdit && (provider.urlParams?.length ?? 0) > 0;
  const showUrl = isEdit || provider.custom || provider.kind === "local";
  const filled = usesParams ? fillDecisionUrl(provider, params) : { url: url.trim() };
  const nameError = isEdit ? null : decisionBackendNameError(name, overview);
  const keyField = provider.keyRequired || provider.kind === "local" || provider.custom;
  const keyMissing = provider.keyRequired && !apiKey.trim() && !backend?.hasApiKey;
  const trimmedModel = model.trim();
  const needsModel = mode === "assign";
  const urlError = !filled.url
    ? null
    : (() => {
        try {
          new URL(filled.url);
          return decisionUrlPlaceholders(filled.url).length ? "The URL still has a {placeholder}." : null;
        } catch {
          return "Enter a full URL, e.g. http://127.0.0.1:11435/v1/systemone.";
        }
      })();
  const canSave =
    phase !== "saving" && !nameError && !!filled.url && !urlError && !keyMissing && (!needsModel || !!trimmedModel);
  const assignment = key0 && trimmedModel ? `${key0}/${trimmedModel}` : null;
  const check = assignment ? checks[assignment] : null;
  // Verify asks the saved backend; with edits pending it would answer for
  // the old settings, so it waits for Save.
  const urlChanged = !!backend && filled.url && filled.url !== backend.url;
  const canVerify = needsModel && !!backend && !!trimmedModel && !apiKey.trim() && !urlChanged && check?.state !== "checking";

  // Lists the server's models: a saved backend by its key (with its stored
  // key), a new one by the URL and key typed so far.
  const runProbe = async (ask) => {
    const seq = ++probeSeq.current;
    setProbe({ state: "busy" });
    try {
      const result = await ask();
      if (seq === probeSeq.current) setProbe(result);
    } catch (e) {
      if (seq !== probeSeq.current) return;
      // A gateway without the unsaved-server probe: suggest the preset's models only.
      if (e?.status === 404) setProbe(null);
      else setProbe({ ok: false, models: [], listed: false, reason: e?.serverMessage ?? e?.message ?? String(e) });
    }
  };
  useEffect(() => {
    if (existingKey && needsModel && canProbeDecisionBackend(provider)) void runProbe(() => probeDecisionBackend(existingKey));
    return () => { probeSeq.current += 1; };
  }, []);
  // A new local or custom server is asked once typing pauses.
  const endpointKey =
    !isEdit && needsModel && canProbeDecisionBackend(provider) && filled.url && !urlError
      ? JSON.stringify([filled.url, apiKey.trim()])
      : null;
  useEffect(() => {
    if (!endpointKey) {
      if (!isEdit) { probeSeq.current += 1; setProbe(null); }
      return undefined;
    }
    const timer = setTimeout(() => {
      void runProbe(() => probeDecisionEndpoint({
        url: filled.url,
        auth: provider.auth,
        apiKey: apiKey.trim() || undefined,
        protocol: provider.protocol,
        preset: provider.custom ? undefined : provider.id,
      }));
    }, ENDPOINT_PROBE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [endpointKey]);

  const edit = (setter) => (e) => {
    setter(e.target.value);
    if (phase === "saved") setPhase("edit");
    setError(null);
  };
  const pickModel = (id) => {
    setModel(id);
    if (phase === "saved") setPhase("edit");
  };

  const save = async (enableRemote) => {
    setConsent(null);
    setPhase("saving");
    setError(null);
    const key = isEdit ? key0 : name.trim();
    const res = await onSave({
      key,
      provider,
      url: filled.url,
      apiKey,
      model: needsModel ? trimmedModel : undefined,
      enableRemote,
    });
    if (!res.ok) { setPhase("edit"); setError(res.error ?? "Could not save the decision backend."); return; }
    setApiKey("");
    setSavedKey(key);
    setPhase("saved");
    if (mode === "manage") { onDone?.(); return; }
    if (canProbeDecisionBackend(provider)) void runProbe(() => probeDecisionBackend(key));
  };

  const onSubmit = (e) => {
    e?.preventDefault?.();
    if (phase === "saved") { onDone?.(); return; }
    if (!canSave) {
      if (filled.error) setError(filled.error);
      return;
    }
    // Saving a backend sends nothing anywhere; only a backend the Decision
    // model uses (or is about to use) needs cloud inference allowed.
    const servesDecision = needsModel || (assignedHere && assignedHere.key === key0);
    const ask = servesDecision
      ? remoteAssignmentConsent(overview, key0 ?? name.trim(), needsModel ? trimmedModel : assignedHere.model, {
          url: filled.url,
          providerLabel: provider.custom ? filled.url : provider.name,
        })
      : null;
    if (ask) { setConsent(ask); return; }
    void save(false);
  };

  const options = decisionModelOptions(provider, probe?.ok ? probe.models : []);

  return html`
    <form class="backend-form decision-form" onSubmit=${onSubmit}>
      <div class="picker-pane-head">
        ${onBack ? html`<button type="button" class="btn-back" onClick=${onBack}>← Back</button>` : null}
        <div class="picker-pane-title">
          <${ProviderMark} provider=${provider} />
          ${provider.custom && isEdit ? key0 : provider.name}
          ${isEdit && !provider.custom && key0 !== provider.id ? html`<span class="decision-form-sub">${key0}</span>` : null}
        </div>
      </div>
      ${provider.note || provider.docsUrl
        ? html`<p class="field-note">
            ${provider.note ? html`<${NoteText} text=${provider.note} />` : null}
            ${provider.docsUrl ? html` <a href=${provider.docsUrl} target="_blank" rel="noreferrer">Docs</a>` : null}
          </p>`
        : null}

      ${usesParams
        ? provider.urlParams.map((param) => html`<label class="field" key=${param.key}>
            <span class="field-label">${param.label}</span>
            <input
              class="field-input"
              type="text"
              placeholder=${param.placeholder}
              value=${params[param.key] ?? ""}
              aria-label=${param.label}
              onInput=${(e) => { setParams((p) => ({ ...p, [param.key]: e.target.value })); setParamsTouched(true); setError(null); if (phase === "saved") setPhase("edit"); }}
            />
          </label>`)
        : null}
      ${usesParams && paramsTouched && filled.error ? html`<span class="field-error">${filled.error}</span>` : null}
      ${showUrl
        ? html`<label class="field">
            <span class="field-label">URL</span>
            <input class="field-input field-input--mono" type="text" placeholder="http://127.0.0.1:8080/v1/systemone" value=${url} onInput=${edit(setUrl)} aria-label="URL" />
            ${url.trim() && urlError ? html`<span class="field-error">${urlError}</span>` : null}
          </label>`
        : null}

      ${keyField
        ? html`<label class="field">
            <span class="field-label decision-field-label">
              <span>API key ${provider.keyRequired ? null : html`<span class="field-opt">(optional)</span>`}</span>
              ${provider.keyUrl ? html`<a href=${provider.keyUrl} target="_blank" rel="noreferrer">Get a key</a>` : null}
            </span>
            <input
              class="field-input"
              type="password"
              autocomplete="off"
              aria-label="API key"
              placeholder=${backend?.hasApiKey ? "Saved · leave blank to keep it" : provider.keyRequired ? "Paste your key" : "Only if the server asks for one"}
              value=${apiKey}
              onInput=${edit(setApiKey)}
            />
            ${backend?.apiKeySecretError ? html`<span class="field-error">${backend.apiKeySecretError}</span>` : null}
          </label>`
        : null}

      ${needsModel
        ? html`<div class="field decision-model-field">
            <label class="field">
              <span class="field-label">Model</span>
              <input
                class="field-input field-input--mono"
                type="text"
                placeholder=${options.length ? "Pick one below, or type a model id" : "Model id"}
                value=${model}
                onInput=${edit(setModel)}
              />
            </label>
            ${probe?.state === "busy" ? html`<span class="field-note">Checking which models the server has…</span>` : null}
            ${probe && probe.state !== "busy" && !probe.ok && probe.reason && check?.state !== "fail" ? html`<span class="field-note decision-note-warn">Could not list the server's models: ${probe.reason}</span>` : null}
            <${ModelSuggestions} options=${options} value=${trimmedModel} onPick=${pickModel} />
          </div>`
        : null}

      ${isEdit
        ? null
        : html`<label class="field">
            <span class="field-label">Backend name</span>
            <input class="field-input" type="text" value=${name} onInput=${edit(setName)} aria-label="Backend name" />
            ${nameError && name.trim() ? html`<span class="field-error">${nameError}</span>` : null}
          </label>`}

      <${DecisionCheckLine} check=${check} model=${trimmedModel} />
      ${error ? html`<div class="modal-error" role="alert">${error}</div>` : null}
      <${CloudInferenceConsentModal}
        open=${!!consent}
        modelName=${consent?.modelName}
        providerLabel=${consent?.providerLabel}
        onConfirm=${() => save(true)}
        onCancel=${() => setConsent(null)}
      />
      <div class="modal-actions">
        ${needsModel && backend
          ? html`<button type="button" class="btn-secondary" disabled=${!canVerify} title=${canVerify ? null : "Save your changes first"} onClick=${() => onVerify?.(key0, trimmedModel)}>Verify</button>`
          : null}
        <button type="submit" class="btn-primary" disabled=${phase === "saved" ? false : !canSave}>
          ${phase === "saving" ? "Saving…" : phase === "saved" ? "Done" : needsModel ? "Save and use" : "Save"}
        </button>
      </div>
    </form>
  `;
}

/** The Backends page's editor for one decision backend's URL and key. */
export function DecisionBackendModal({ overview, backendKey, onSave, onClose }) {
  return html`<${Modal} open onClose=${onClose} title="Decision backend" size="md">
    <${DecisionBackendForm} overview=${overview} existingKey=${backendKey} mode="manage" onSave=${onSave} onDone=${onClose} />
  <//>`;
}

// ── Calibration ─────────────────────────────────────────────────────────────

const CALIBRATION_POLL_MS = 2000;
/** While nothing runs, the panel still looks now and then for a run started elsewhere (the CLI). */
const CALIBRATION_IDLE_POLL_MS = 10_000;

/**
 * Calibration of the assigned decision backend's model onto Jev's scale.
 * Reads the job status on mount and keeps polling while the card is open —
 * every 2 s during a run, now and then otherwise, so a run started from the
 * CLI shows too — and calls `onChanged` when a run ends so the overview
 * reloads with the stored calibration.
 */
export function DecisionCalibrationPanel({ overview, onChanged }) {
  const assigned = assignedDecisionBackend(overview);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const wasRunning = useRef(false);

  const read = async () => {
    try {
      const next = await getDecisionCalibration();
      setStatus(next);
      if (wasRunning.current && next?.state !== "running") {
        wasRunning.current = false;
        await onChanged?.();
      }
      if (next?.state === "running") wasRunning.current = true;
    } catch {
      // Keep the last status; the next poll tries again.
    }
  };
  useEffect(() => { void read(); }, []);
  useVisiblePoll(read, status?.state === "running" ? CALIBRATION_POLL_MS : CALIBRATION_IDLE_POLL_MS);

  if (!assigned) return null;
  const state = calibrationPanelState(status, assigned);
  const stored = assignedCalibration(assigned, status);
  const lastRunFailed = status?.state === "failed" && status.assignment === `${assigned.key}/${assigned.model}`;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await startDecisionCalibration();
      wasRunning.current = true;
      setStatus(next);
    } catch (e) {
      if (e?.status === 409) {
        wasRunning.current = true;
        await read();
      } else setError(e?.serverMessage ?? e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    try {
      setStatus(await cancelDecisionCalibration());
      await read();
    } catch (e) {
      setError(e?.serverMessage ?? e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const cost = "Sends about 300 invented emails, no personal data, to the model: a few cents on a hosted provider, several minutes on a local CPU server.";

  return html`
    <div class=${`decision-calibration decision-calibration--${state}`}>
      ${state === "running"
        ? html`<div class="decision-calibration-row">
            <div class="decision-calibration-main">
              <div class="decision-calibration-title">Calibrating against Jev…</div>
              <div
                class="decision-calibration-bar"
                role="progressbar"
                aria-label="Calibration progress"
                aria-valuemin="0"
                aria-valuemax=${status?.total > 0 ? status.total : undefined}
                aria-valuenow=${status?.total > 0 ? status.done ?? 0 : undefined}
              >
                <span style=${`width:${Math.round(calibrationFraction(status) * 100)}%`}></span>
              </div>
              <div class="decision-calibration-meta">${calibrationProgressText(status)}</div>
            </div>
            <button type="button" class="btn-tiny" disabled=${busy} onClick=${cancel}>Cancel</button>
          </div>`
        : state === "other-running"
        ? html`<div class="decision-calibration-row">
            <div class="decision-calibration-main">
              <div class="decision-calibration-text">A calibration of ${status.assignment} is running: ${calibrationProgressText(status)}.</div>
              <div class="decision-calibration-meta">This model can be calibrated once it ends.</div>
            </div>
            <button type="button" class="btn-tiny" disabled=${busy} onClick=${cancel}>Cancel it</button>
          </div>`
        : state === "calibrated"
        ? html`<div class="decision-calibration-row">
            <div class="decision-calibration-main">
              ${lastRunFailed ? html`<div class="decision-calibration-warn">Recalibration failed; the earlier calibration still applies. ${status.error ?? ""}</div>` : null}
              <div class="decision-calibration-text">${calibrationSummary(stored)}</div>
            </div>
            <button type="button" class="btn-tiny" disabled=${busy} onClick=${start}>Recalibrate</button>
          </div>`
        : html`<div class="decision-calibration-row">
            <div class="decision-calibration-main">
              ${state === "failed"
                ? html`<div class="decision-calibration-warn">Calibration failed. ${status?.error ?? ""}</div>`
                : state === "cancelled"
                ? html`<div class="decision-calibration-text">Calibration cancelled.</div>`
                : null}
              <div class="decision-calibration-warn">Thresholds were tuned on TypeSafe's Jev. Calibrate this model so they mean the same thing.</div>
              <div class="decision-calibration-meta">${cost}</div>
            </div>
            <button type="button" class="btn-secondary" disabled=${busy} onClick=${start}>${state === "failed" ? "Try again" : "Calibrate"}</button>
          </div>`}
      ${error ? html`<div class="field-error" role="alert">${error}</div>` : null}
    </div>
  `;
}

// ── Backends page ───────────────────────────────────────────────────────────

/** The configured decision backends, shown only when there is one. */
export function DecisionBackendsSection({ overview, onEdit, onRemove }) {
  const entries = Object.entries(decisionBackends(overview)).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return null;
  const assigned = assignedDecisionBackend(overview);
  return html`
    <div class="detail-section decision-backends-section">
      <div class="detail-section-head"><h2>Decision backends</h2></div>
      <p class="detail-sub">Serve only the Decision model. Add one from Decision model → Choose model.</p>
      ${entries.map(([key, backend]) => {
        const preset = presetForBackend(overview, backend);
        const calibrated = Object.keys(backend.calibrations ?? {}).length;
        return html`<div class="backend-item" key=${key}>
          <div class="backend-item-main">
            <div class="backend-item-title">
              <${ProviderMark} provider=${preset ?? CUSTOM_DECISION_PROVIDER} />
              ${preset && key === preset.id ? preset.name : key}
              ${preset && key !== preset.id ? html`<span class="decision-form-sub">${preset.name}</span>` : null}
            </div>
            <div class="backend-item-meta">
              <code>${backend.url}</code>
              ${backend.hasApiKey ? html`<span class="backend-pill">Key set</span>` : null}
              ${calibrated ? html`<span>${plural(calibrated, "calibrated model")}</span>` : null}
              ${assigned?.key === key ? html`<span>Decision model: ${assigned.model}</span>` : null}
              ${backend.apiKeySecretError ? html`<span class="decision-note-danger">${backend.apiKeySecretError}</span>` : null}
            </div>
          </div>
          <div class="backend-item-actions">
            <button class="btn-tiny" aria-label=${`Edit decision backend ${key}`} onClick=${() => onEdit(key)}>Edit</button>
            <button class="btn-tiny danger" aria-label=${`Remove decision backend ${key}`} onClick=${() => onRemove(key)}>Remove</button>
          </div>
        </div>`;
      })}
    </div>
  `;
}
