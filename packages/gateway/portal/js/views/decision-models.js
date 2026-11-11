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

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { probeBackendDecisionModels, probeDecisionEndpoint } from "../api.js";
import { BackendOptionCard, Monogram, ProviderLogo, LOCAL_GLYPH, TYPESAFE_GLYPH, ADD_GLYPH } from "../components/backend-option-card.js";
import { CloudInferenceConsentModal } from "../components/cloud-inference-consent.js";
import { endpointConsent, inferenceAssignmentPatch, remoteAssignmentConsent } from "../lib/cloud-inference.js";
import { backendDisplayName, backendPreset, enableDecisionPatch, fillDecisionUrl, presetLogoId } from "../lib/backend-setup.js";
import {
  assignedDecisionBackend,
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
              ${enable.map((entry) => card(entry, entry.backend.hasApiKey ? "Uses your existing key" : "Needs a key"))}
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
 * already has — or, when it has none and the provider needs one, the key
 * typed here, which becomes its key for both APIs.
 * `onSave(patch, {key, decisionModel})` resolves to `{ok, error?}`; a null
 * patch only checks the model again.
 */
export function DecisionModelPane({ overview, backendKey, checks = {}, onVerify, onSave, onBack, onDone }) {
  const backend = overview.inference.backends?.[backendKey];
  const preset = backendPreset(overview, backend);
  const [enabling] = useState(() => !backend?.decision);
  const assigned = assignedDecisionBackend(overview);
  const [model, setModel] = useState(() => (assigned?.key === backendKey ? assigned.model : ""));
  const [params, setParams] = useState({});
  const [apiKey, setApiKey] = useState("");
  const [phase, setPhase] = useState("edit"); // edit | saving | saved
  const [error, setError] = useState(null);
  const [consent, setConsent] = useState(null);
  const { probe, run } = useDecisionModelProbe();

  const urlParams = enabling ? preset?.decision?.urlParams ?? [] : [];
  const [asksKey] = useState(() => enabling && preset?.decision?.keyRequired === true && !backend?.hasApiKey);
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
      ? enableDecisionPatch({ key: backendKey, preset, decisionUrl: target.url, model: trimmed, apiKey: asksKey ? apiKey : undefined, enableRemote })
      : assignment === currentDecisionAssignment(overview) && !enableRemote
      ? null
      : inferenceAssignmentPatch("decision", assignment, enableRemote);
    const res = await onSave(patch, { key: backendKey, decisionModel: trimmed });
    if (!res.ok) { setPhase("edit"); setError(res.error ?? "Could not save."); return; }
    setPhase("saved");
  };

  const canSave = phase !== "saving" && !!trimmed && !!target.url && (!asksKey || phase === "saved" || !!apiKey.trim());
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
          <span class="decision-form-sub">${asksKey ? "Needs a key" : enabling ? "Uses your existing key" : decisionWhere(backend?.decision)}</span>
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
      ${asksKey
        ? html`<label class="field">
            <span class="field-label decision-field-label">
              <span>API key</span>
              ${preset.decision.keyUrl ? html`<a href=${preset.decision.keyUrl} target="_blank" rel="noreferrer">Get a key</a>` : null}
            </span>
            <input
              class="field-input"
              type="password"
              autocomplete="off"
              aria-label="API key"
              placeholder="Paste your key"
              value=${apiKey}
              disabled=${phase === "saved"}
              onInput=${(e) => edit(setApiKey)(e.target.value)}
            />
            <span class="field-note">It becomes this backend's key for its OpenAI-compatible and decision APIs.</span>
          </label>`
        : null}
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
