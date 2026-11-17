// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { StepNav } from "../../components/step-nav.js";
import { STEP_LABELS } from "./model.js";

/**
 * One screen of the Connectivity setup: the step bar, one question, its
 * answers, and the way on. A review shows the same screens with what is set now,
 * and can be left at any step with Cancel.
 */
export function StepFrame({ flow, steps, heading, blurb, headingRef, error, actions, onStep, onCancel = null, children }) {
  const index = steps.indexOf(flow.step);
  return html`<div class="access-request access-request--page remote-access-setup">
    <${StepNav}
      items=${steps.map((key, position) => ({
        key,
        label: STEP_LABELS[key],
        current: key === flow.step,
        complete: position < index,
        // A review can open any question; a setup the next one too, as Continue would.
        reachable: flow.mode === "review" || position === index + 1,
      }))}
      onSelect=${onStep}
    />
    <div class="access-wizard-panel">
      <div class="access-wizard-copy">
        <h3 ref=${headingRef} tabIndex="-1">${heading}</h3>
        ${blurb && html`<p>${blurb}</p>`}
      </div>
      ${children}
    </div>
    ${error && html`<p class="access-error" role="alert">${error}</p>`}
    <div class="access-request-actions remote-access-actions">
      ${onCancel && html`<button type="button" class="btn-ghost" onClick=${onCancel}>Cancel</button>`}
      <span class="access-wizard-nav">${actions}</span>
    </div>
  </div>`;
}

/** The Back button, when there is a step before this one. */
export function BackButton({ onBack, disabled = false }) {
  return onBack && html`<button type="button" class="btn-secondary" disabled=${disabled} onClick=${onBack}>Back</button>`;
}

/** The label of the button that moves on: the last step finishes. */
export function nextLabel(last) {
  return last ? "Finish" : "Continue";
}
