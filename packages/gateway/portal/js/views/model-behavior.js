// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

const CONTROL_KEYS = ["reasoningEnabled", "reasoningEffort", "reasoningBudgetTokens"];

function definedValues(values) {
  return Object.fromEntries(
    CONTROL_KEYS.filter((key) => values?.[key] !== undefined && values?.[key] !== null)
      .map((key) => [key, values[key]]),
  );
}

function staleValues(values, controls) {
  return Object.entries(definedValues(values)).some(([key, value]) => {
    const control = controls.find((entry) => entry.key === key);
    if (!control) return true;
    if (control.type === "boolean") return typeof value !== "boolean";
    if (control.type === "enum") return !control.values?.includes(value);
    if (control.type === "integer") return !Number.isInteger(value) || value < (control.min ?? 0) ||
      (control.max !== undefined && value > control.max);
    return true;
  });
}

/** Summarize only saved model-native settings; absent values use the model default. */
export function modelBehaviorSummary(settings, model) {
  if (!settings?.assignment || !model) return null;
  if (model.source === "unknown") return Object.keys(definedValues(settings.values)).length
    ? "Saved behavior: controls unavailable" : null;
  if (!model.controls?.length) {
    if (Object.keys(definedValues(settings.values)).length) return "Saved behavior: controls unavailable";
    return null;
  }
  const values = definedValues(settings.values);
  const parts = [];
  if (values.reasoningEnabled !== undefined) parts.push(`Reasoning ${values.reasoningEnabled ? "on" : "off"}`);
  if (values.reasoningEffort !== undefined) parts.push(`Effort ${values.reasoningEffort}`);
  if (values.reasoningBudgetTokens !== undefined) parts.push(values.reasoningBudgetTokens === -1
    ? "No reasoning budget enforcement" : `Budget ${values.reasoningBudgetTokens} tokens`);
  return parts.length ? parts.join(" · ") : null;
}

function controlValue(values, key) {
  return values[key] === undefined ? "" : String(values[key]);
}

function ChoiceButtons({ control, options, value, onChange, disabled }) {
  return html`<div class="model-behavior-control model-behavior-choice-control">
    <span>${control.label}</span>
    <div class="model-behavior-options" role="group" aria-label=${control.label}>
      ${options.map((option) => html`<button key=${option.value} type="button" class=${value === option.value ? "active" : ""}
        aria-pressed=${value === option.value} disabled=${disabled} onClick=${() => onChange(control.key, option.setting)}>${option.label}</button>`)}
    </div>
  </div>`;
}

function BehaviorControl({ control, values, onChange, disabled }) {
  const value = controlValue(values, control.key);
  if (control.type === "boolean") {
    return html`<${ChoiceButtons} control=${control} value=${value} onChange=${onChange} disabled=${disabled} options=${[
      { value: "", label: "Model default", setting: undefined },
      { value: "true", label: "On", setting: true },
      { value: "false", label: "Off", setting: false },
    ]} />`;
  }
  if (control.type === "enum") {
    const options = [{ value: "", label: "Model default", setting: undefined },
      ...(control.values ?? []).map((option) => ({ value: option, label: option, setting: option }))];
    if (options.length <= 4) {
      return html`<${ChoiceButtons} control=${control} options=${options} value=${value} onChange=${onChange} disabled=${disabled} />`;
    }
    return html`<label class="model-behavior-control model-behavior-menu-control">
      <span>${control.label}</span>
      <select aria-label=${control.label} value=${value} disabled=${disabled} onChange=${(event) => onChange(control.key, event.currentTarget.value || undefined)}>
        <option value="">Model default</option>
        ${(control.values ?? []).map((option) => html`<option key=${option} value=${option}>${option}</option>`)}
      </select>
    </label>`;
  }
  if (control.type === "integer") {
    const automatic = value === "";
    const noEnforcement = control.min === -1 && value === "-1";
    const numericMin = control.min === -1 ? 0 : control.min ?? 1;
    return html`<div class="model-behavior-control">
      <label for=${`behavior-${control.key}`}>${control.label}</label>
      <div class="model-behavior-number">
        <input id=${`behavior-${control.key}`} type="number" inputMode="numeric" min=${numericMin} max=${control.max ?? undefined} step="1" value=${automatic || noEnforcement ? "" : value} disabled=${disabled || automatic || noEnforcement} onInput=${(event) => {
          const raw = event.currentTarget.value;
          onChange(control.key, raw === "" ? undefined : Number(raw));
        }} />
        <label><input type="checkbox" checked=${automatic} disabled=${disabled} onChange=${(event) => onChange(control.key, event.currentTarget.checked ? undefined : numericMin)} /> Model default</label>
        ${control.min === -1 ? html`<label><input type="checkbox" checked=${noEnforcement} disabled=${disabled} onChange=${(event) => onChange(control.key, event.currentTarget.checked ? -1 : numericMin)} /> No reasoning budget enforcement</label>` : null}
      </div>
    </div>`;
  }
  return null;
}

/** Controls are gateway-authored from the active provider/model catalog entry. */
export function ModelBehaviorEditor({ settings, model, onSave }) {
  const settingsValues = JSON.stringify(definedValues(settings?.values));
  const observedProps = useRef({ assignment: settings?.assignment, values: settingsValues, revision: 0 });
  if (observedProps.current.assignment !== settings?.assignment || observedProps.current.values !== settingsValues) {
    observedProps.current = { assignment: settings?.assignment, values: settingsValues, revision: observedProps.current.revision + 1 };
  }
  const [draft, setDraft] = useState(() => definedValues(settings?.values));
  const [saved, setSaved] = useState(() => definedValues(settings?.values));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    setDraft(definedValues(settings?.values));
    setSaved(definedValues(settings?.values));
    setError(null);
  }, [settings?.assignment, settingsValues]);

  const controls = model?.controls ?? [];
  const changed = JSON.stringify(definedValues(draft)) !== JSON.stringify(definedValues(saved));
  const hasSaved = Object.keys(definedValues(saved)).length > 0;
  const hasStaleSaved = staleValues(saved, controls);
  const hasRemovedSaved = Object.keys(definedValues(saved)).some((key) => !controls.some((control) => control.key === key));
  const hasStaleDraft = staleValues(draft, controls);
  useEffect(() => {
    if (!settings?.assignment || busy || !changed || hasStaleDraft) return;
    const timer = setTimeout(() => { void submit(definedValues(draft)); }, 250);
    return () => clearTimeout(timer);
  }, [settings?.assignment, draft, saved, busy, hasStaleDraft]);

  if (!settings?.assignment || (!controls.length && !hasSaved)) return null;
  const update = (key, value) => {
    setDraft((prior) => {
      const next = { ...prior };
      if (value === undefined) delete next[key];
      else {
        next[key] = value;
        const descriptor = controls.find((control) => control.key === key);
        for (const excluded of descriptor?.exclusiveWith ?? []) delete next[excluded];
        if (key === "reasoningEnabled" && value === false) {
          delete next.reasoningEffort;
          delete next.reasoningBudgetTokens;
        } else if (key !== "reasoningEnabled") {
          if (next.reasoningEnabled === false) delete next.reasoningEnabled;
        }
      }
      return next;
    });
    setError(null);
  };
  const submit = async (values) => {
    const revision = observedProps.current.revision;
    setBusy(true);
    setError(null);
    try {
      await onSave(settings.assignment, values, saved);
      if (observedProps.current.revision === revision) {
        setSaved(values);
        setDraft(values);
      }
    } catch (cause) {
      setError(cause?.serverMessage ?? cause?.message ?? String(cause));
      if (observedProps.current.revision === revision) setDraft(saved);
    } finally {
      setBusy(false);
    }
  };
  const reset = () => submit({});

  return html`<section class="model-behavior" aria-label="Model behavior">
    ${controls.length ? html`<div class="model-behavior-fields">
          ${controls.map((control) => html`<${BehaviorControl} key=${control.key} control=${control} values=${draft} onChange=${update}
            disabled=${busy || hasRemovedSaved || (draft.reasoningEnabled === false && control.key !== "reasoningEnabled")} />`)}
        </div>` : null}
    ${hasRemovedSaved ? html`<p>Some saved controls are no longer offered for this model. Reset to model default to clear them.</p>`
      : hasStaleSaved ? html`<p>A saved choice is no longer offered for this model. Choose Model default or another available value.</p>` : null}
    ${hasStaleDraft && !hasStaleSaved ? html`<p>Choose a value within this model's available range.</p>` : null}
    ${error ? html`<p class="model-behavior-error" role="alert">${error}</p>` : null}
    ${busy ? html`<span class="model-behavior-saving" role="status">Saving…</span>` : null}
    ${hasRemovedSaved ? html`<div class="model-behavior-actions">
      <button class="btn-secondary" disabled=${busy} onClick=${reset}>Reset to model default</button>
    </div>` : null}
  </section>`;
}
