// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The Decision model's setup pieces, used by the Models flows in
// `model-config.js` and `models.js`:
//
//   • DecisionProviderPicker  — the Decision model's picker: backends that
//                               serve decisions, backends whose provider
//                               offers them (with their existing key),
//                               TypeSafe, then "Add a provider".
//   • DecisionModelPane       — pick the model on one existing backend; for a
//                               backend not serving decisions yet, Save also
//                               adds its provider's decision API.
//   • DecisionModelField      — the model input and its suggestions, shared
//                               with the add-backend form.
//   • DecisionCheckLine       — the answer of a test decision.
//   • DecisionCalibrationPanel — maps the assigned model's scores onto Jev's
//                               scale, so the decision thresholds keep their
//                               meaning.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  probeBackendDecisionModels,
  probeDecisionEndpoint,
  getDecisionCalibration,
  startDecisionCalibration,
  cancelDecisionCalibration,
} from "../api.js";
import { BackendOptionCard, Monogram, ProviderLogo, LOCAL_GLYPH, TYPESAFE_GLYPH, ADD_GLYPH } from "../components/backend-option-card.js";
import { CloudInferenceConsentModal } from "../components/cloud-inference-consent.js";
import { endpointConsent, inferenceAssignmentPatch, remoteAssignmentConsent } from "../lib/cloud-inference.js";
import { useVisiblePoll } from "../lib/use-visible-poll.js";
import { backendDisplayName, backendPreset, enableDecisionPatch, fillDecisionUrl, presetLogoId } from "../lib/backend-setup.js";
import {
  assignedCalibration,
  assignedDecisionBackend,
  calibrationFraction,
  calibrationPanelState,
  calibrationProgressText,
  calibrationSummary,
  canProbeDecisionModels,
  currentDecisionAssignment,
  decisionModelHint,
  decisionModelOptions,
  decisionPickerGroups,
  decisionVerifyText,
  decisionWhere,
} from "../lib/decision-models.js";

/** A preset note with `code` spans, e.g. "Pull a model with `ollaya pull <model>` first." */
function NoteText({ text }) {
  const parts = String(text ?? "").split("`");
  return html`${parts.map((part, i) => (i % 2 ? html`<code key=${i}>${part}</code>` : part))}`;
}

/** A preset decision API's note and docs link, when it has either. */
export function PresetNote({ decision }) {
  if (!decision?.note && !decision?.docsUrl) return null;
  return html`<p class="field-note">
    ${decision.note ? html`<${NoteText} text=${decision.note} />` : null}
    ${decision.docsUrl ? html` <a href=${decision.docsUrl} target="_blank" rel="noreferrer">Docs</a>` : null}
  </p>`;
}

/** A preset's logo, its initial when the gateway has none, or the server glyph. */
export function PresetMark({ preset, name }) {
  const logo = presetLogoId(preset);
  return logo
    ? html`<${ProviderLogo} providerId=${logo} fallback=${html`<${Monogram} name=${preset.name ?? name} />`} size=${22} />`
    : LOCAL_GLYPH;
}

// ── Provider picker ─────────────────────────────────────────────────────────

/**
 * The Decision model's picker. `chatGrid`, when given, is the experimental
 * chat-model grid shown under its own heading.
 */
export function DecisionProviderPicker({ overview, chatGrid, onPickBackend, onPickTypeSafe, onAddProvider }) {
  const { ready, enable } = decisionPickerGroups(overview);
  const card = ({ key, backend, preset }, subtitle) => html`<${BackendOptionCard}
    key=${key}
    compact
    providerId=${presetLogoId(preset)}
    fallbackGlyph=${preset ? html`<${Monogram} name=${preset.name} />` : LOCAL_GLYPH}
    title=${backendDisplayName(key, preset)}
    subtitle=${subtitle ?? [preset && key !== preset.id ? preset.name : null, decisionWhere(backend.decision)].filter(Boolean).join(" · ")}
    onClick=${() => onPickBackend(key)}
  />`;
  return html`
    <div class="decision-provider-picker">
      ${ready.length || enable.length
        ? html`<section class="decision-provider-group">
            <h3 class="decision-provider-heading">Your backends</h3>
            <div class="backend-opt-grid">
              ${ready.map((entry) => card(entry))}
              ${enable.map((entry) => card(entry, "Uses your existing key"))}
            </div>
          </section>`
        : null}
      <section class="decision-provider-group">
        <h3 class="decision-provider-heading">${ready.length || enable.length ? "Other providers" : "Providers"}</h3>
        <div class="backend-opt-grid">
          <${BackendOptionCard} compact fallbackGlyph=${TYPESAFE_GLYPH} title="TypeSafe" subtitle="Built in" onClick=${onPickTypeSafe} />
          <${BackendOptionCard} compact fallbackGlyph=${ADD_GLYPH} title="Add a provider" subtitle="Hosted or your own server" onClick=${onAddProvider} />
        </div>
      </section>
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

// ── Model field ─────────────────────────────────────────────────────────────

/**
 * Asks a decision server which models it has. `run(ask)` keeps only the
 * latest answer; a gateway without the route (404) suggests the preset's
 * models only.
 */
export function useDecisionModelProbe() {
  const [probe, setProbe] = useState(null); // null | {state: "busy"} | result
  const seq = useRef(0);
  useEffect(() => () => { seq.current += 1; }, []);
  const run = async (ask) => {
    const mine = ++seq.current;
    setProbe({ state: "busy" });
    try {
      const result = await ask();
      if (mine === seq.current) setProbe(result);
    } catch (e) {
      if (mine !== seq.current) return;
      if (e?.status === 404) setProbe(null);
      else setProbe({ ok: false, models: [], listed: false, reason: e?.serverMessage ?? e?.message ?? String(e) });
    }
  };
  const reset = () => { seq.current += 1; setProbe(null); };
  return { probe, run, reset };
}

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
 * The decision model input: the server's installed models (`probe`) and the
 * preset's suggestions with their context and price, or a typed id. `quiet`
 * leaves out why the server could not list its models, when a failed test
 * decision already says more.
 */
export function DecisionModelField({ preset, value, probe, quiet = false, onChange }) {
  const options = decisionModelOptions(preset, probe?.ok ? probe.models : []);
  return html`<div class="field decision-model-field">
    <label class="field">
      <span class="field-label">Model</span>
      <input
        class="field-input field-input--mono"
        type="text"
        placeholder=${options.length ? "Pick one below, or type a model id" : "Model id"}
        value=${value}
        onInput=${(e) => onChange(e.target.value)}
      />
    </label>
    ${probe?.state === "busy" ? html`<span class="field-note">Checking which models the server has…</span>` : null}
    ${probe && probe.state !== "busy" && !probe.ok && probe.reason && !quiet ? html`<span class="field-note decision-note-warn">Could not list the server's models: ${probe.reason}</span>` : null}
    <${ModelSuggestions} options=${options} value=${value.trim()} onPick=${onChange} />
  </div>`;
}

// ── One existing backend ────────────────────────────────────────────────────

/**
 * Pick the Decision model on an existing backend. A backend that serves
 * decisions is used as it is; one whose provider offers decisions it does not
 * use yet gets its provider's decision API in the same write, with the key it
 * already has. `onSave(patch, {key, decisionModel})` resolves to
 * `{ok, error?}`; a null patch only checks the model again.
 */
export function DecisionModelPane({ overview, backendKey, checks = {}, onVerify, onSave, onBack, onDone }) {
  const backend = overview.inference.backends?.[backendKey];
  const preset = backendPreset(overview, backend);
  const [enabling] = useState(() => !backend?.decision);
  const assigned = assignedDecisionBackend(overview);
  const [model, setModel] = useState(() => (assigned?.key === backendKey ? assigned.model : ""));
  const [params, setParams] = useState({});
  const [phase, setPhase] = useState("edit"); // edit | saving | saved
  const [error, setError] = useState(null);
  const [consent, setConsent] = useState(null);
  const { probe, run } = useDecisionModelProbe();

  const urlParams = enabling ? preset?.decision?.urlParams ?? [] : [];
  const target = enabling ? fillDecisionUrl(preset?.decision, params) : { url: backend?.decision?.url };
  const trimmed = model.trim();
  const assignment = trimmed ? `${backendKey}/${trimmed}` : null;
  const check = assignment ? checks[assignment] : null;
  const canProbe = canProbeDecisionModels(preset);

  useEffect(() => {
    if (!canProbe) return;
    if (!enabling) void run(() => probeBackendDecisionModels(backendKey));
    else if (target.url) {
      void run(() => probeDecisionEndpoint({
        url: target.url, preset: preset.id, protocol: preset.decision.protocol, auth: preset.decision.auth, backendKey,
      }));
    }
  }, []);

  const save = async (enableRemote) => {
    setConsent(null);
    setPhase("saving");
    setError(null);
    const patch = enabling
      ? enableDecisionPatch({ key: backendKey, preset, decisionUrl: target.url, model: trimmed, enableRemote })
      : assignment === currentDecisionAssignment(overview) && !enableRemote
      ? null
      : inferenceAssignmentPatch("decision", assignment, enableRemote);
    const res = await onSave(patch, { key: backendKey, decisionModel: trimmed });
    if (!res.ok) { setPhase("edit"); setError(res.error ?? "Could not save."); return; }
    setPhase("saved");
  };

  const canSave = phase !== "saving" && !!trimmed && !!target.url;
  const onSubmit = (e) => {
    e?.preventDefault?.();
    if (phase === "saved") { onDone?.(); return; }
    if (!canSave) {
      if (target.error) setError(target.error);
      return;
    }
    const ask = enabling
      ? endpointConsent(overview, [target.url], { providerLabel: preset?.name, modelName: trimmed })
      : remoteAssignmentConsent(overview, backendKey, trimmed, "decision");
    if (ask) { setConsent(ask); return; }
    void save(false);
  };
  const edit = (setter) => (value) => {
    setter(value);
    if (phase === "saved") setPhase("edit");
    setError(null);
  };

  return html`
    <form class="backend-form decision-form" onSubmit=${onSubmit}>
      <div class="picker-pane-head">
        ${onBack ? html`<button type="button" class="btn-back" onClick=${onBack}>← Back</button>` : null}
        <div class="picker-pane-title">
          <${PresetMark} preset=${preset} name=${backendKey} />
          ${backendDisplayName(backendKey, preset)}
          <span class="decision-form-sub">${enabling ? "Uses your existing key" : decisionWhere(backend?.decision)}</span>
        </div>
      </div>
      ${enabling ? html`<${PresetNote} decision=${preset?.decision} />` : null}
      ${urlParams.map((param) => html`<label class="field" key=${param.key}>
        <span class="field-label">${param.label}</span>
        <input
          class="field-input"
          type="text"
          placeholder=${param.placeholder}
          value=${params[param.key] ?? ""}
          aria-label=${param.label}
          onInput=${(e) => edit((v) => setParams((p) => ({ ...p, [param.key]: v })))(e.target.value)}
        />
      </label>`)}
      <${DecisionModelField} preset=${preset} value=${model} probe=${probe} quiet=${check?.state === "fail"} onChange=${edit(setModel)} />
      <${DecisionCheckLine} check=${check} model=${trimmed} />
      ${error ? html`<div class="modal-error" role="alert">${error}</div>` : null}
      <${CloudInferenceConsentModal}
        open=${!!consent}
        modelName=${consent?.modelName}
        providerLabel=${consent?.providerLabel}
        onConfirm=${() => save(true)}
        onCancel=${() => setConsent(null)}
      />
      <div class="modal-actions">
        ${enabling && phase !== "saved"
          ? null
          : html`<button type="button" class="btn-secondary" disabled=${!trimmed || check?.state === "checking"} onClick=${() => onVerify?.(backendKey, trimmed)}>Verify</button>`}
        <button type="submit" class="btn-primary" disabled=${phase === "saved" ? false : !canSave}>
          ${phase === "saving" ? "Saving…" : phase === "saved" ? "Done" : enabling ? "Save and use" : "Use"}
        </button>
      </div>
    </form>
  `;
}

// ── Calibration ─────────────────────────────────────────────────────────────

const CALIBRATION_POLL_MS = 2000;
/** While nothing runs, the panel still looks now and then for a run started elsewhere (the CLI). */
const CALIBRATION_IDLE_POLL_MS = 10_000;

/**
 * Calibration of the model assigned on a backend's decision API onto Jev's
 * scale.
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

