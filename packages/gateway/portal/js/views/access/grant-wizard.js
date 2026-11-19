// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The one wizard every permissions decision runs through.
//
// Three surfaces decide what an agent may reach: approving an OAuth request
// (which is also where the consent redirect lands a signed-in browser),
// editing an access level, and creating one. They ask the same two questions —
// which capabilities, then which sources and under which policy — and differ
// only in what they call the steps, what the review confirms, and what the
// final button does. Those are the props; everything else lives here, so a
// change to how permissions are chosen lands in one place rather than in three
// that drift.
//
// An approval asks one question first — what the connection is called and
// which access level it uses — through `leadStep`. Choosing an existing level
// or replacing a connection settles the permissions, so that path goes from
// the lead step straight to the review.

import { html } from "htm/preact";

import { StepNav, useStepFocus } from "../../components/step-nav.js";
import { CapabilityPicker, GrantDataPrivacy } from "../../components/grant-builder.js";
import {
  hasCapability,
  releaseError,
  rulesShareSources,
  validateGrantRules,
} from "../../components/grant-builder-state.js";

/**
 * @param {object} props
 * @param {string[]} props.steps  labels of the permissions, data and review steps.
 * @param {null | {
 *   label: string, heading: string, blurb?: string, content: unknown,
 *   canContinue: boolean, skipsToReview: boolean,
 * }} [props.leadStep]  the step before permissions, numbered 0.
 */
export function GrantWizard({
  steps,
  leadStep = null,
  step,
  onStep,
  rules,
  onRules,
  sources = [],
  policies = [],
  linkSources = true,
  onLinkSources = () => {},
  disabled = false,
  requiresAnswer = false,
  idPrefix,
  copy,
  review = null,
  leadAction = null,
  finalAction = null,
  error = "",
}) {
  // Focus follows the step so a keyboard move forward lands on the new
  // heading rather than staying where the pressed button used to be.
  const stepHeadingRef = useStepFocus(step);
  const ruleError = validateGrantRules(rules, sources);

  // Data & privacy asks which sources a capability may read and how its
  // answers are released. Permissions that only write notes have neither
  // question, so that step is left out of the path rather than shown empty;
  // the apps derive the same path from the same rule, so the chips count the
  // same way everywhere. `step` keeps its fixed meaning (0 lead, 1 permissions,
  // 2 data, 3 review) and the path decides which of them are visited.
  const readsSources = Boolean(rules.answer || rules.direct || requiresAnswer);
  const tail = leadStep?.skipsToReview ? [3] : readsSources ? [1, 2, 3] : [1, 3];
  const path = leadStep ? [0, ...tail] : tail;
  const position = Math.max(path.indexOf(step), 0);
  const previous = path[position - 1];
  const next = path[position + 1];
  const label = (phase) => (phase === 0 ? leadStep.label : steps[phase - 1]);

  return html`<div class="access-request access-request--page">
    <${StepNav}
      items=${path.map((phase) => ({ key: label(phase), label: label(phase), current: phase === step, complete: phase < step }))}
      disabled=${disabled}
      onSelect=${(key) => onStep(path.find((phase) => label(phase) === key))}
    />

    <div class="access-wizard-panel">
      ${step === 0 && leadStep && html`
        <div class="access-wizard-copy">
          <h3 ref=${stepHeadingRef} tabIndex="-1">${leadStep.heading}</h3>
          ${leadStep.blurb ? html`<p>${leadStep.blurb}</p>` : null}
        </div>
        ${leadStep.content}
      `}

      ${step === 1 && html`
        <div class="access-wizard-copy">
          <h3 ref=${stepHeadingRef} tabIndex="-1">${copy.one.heading}</h3>
          ${copy.one.blurb ? html`<p>${copy.one.blurb}</p>` : null}
        </div>
        <${CapabilityPicker} value=${rules} onChange=${(nextRules) => {
          onRules(nextRules);
          if (nextRules.answer && nextRules.direct) onLinkSources(rulesShareSources(nextRules));
        }} policies=${policies} disabled=${disabled} requiresAnswer=${requiresAnswer}
          hideLegend idPrefix=${idPrefix} />
      `}

      ${step === 2 && html`
        <div class="access-wizard-copy">
          <h3 ref=${stepHeadingRef} tabIndex="-1">${copy.two.heading}</h3>
          ${copy.two.blurb ? html`<p>${copy.two.blurb}</p>` : null}
        </div>
        <${GrantDataPrivacy} value=${rules} onChange=${onRules} sources=${sources}
          policies=${policies} disabled=${disabled}
          linkSources=${linkSources} onLinkSources=${onLinkSources} idPrefix=${idPrefix} />
        ${releaseError(rules) && html`<p class="access-field-error" role="alert">${releaseError(rules)}</p>`}
      `}

      ${step === 3 && html`
        <div class="access-wizard-copy">
          <h3 ref=${stepHeadingRef} tabIndex="-1">${copy.three.heading}</h3>
          ${copy.three.blurb ? html`<p>${copy.three.blurb}</p>` : null}
        </div>
        ${review}
      `}
    </div>
    ${error && html`<p class="access-error" role="alert">${error}</p>`}
    <div class="access-request-actions">
      ${leadAction}
      <span class="access-wizard-nav">
        ${position > 0 && html`<button type="button" class="btn-secondary" disabled=${disabled} onClick=${() => onStep(previous)}>Back</button>`}
        ${step < 3 && html`<button type="button" class="btn-primary"
          disabled=${disabled
            || (step === 0 && !leadStep?.canContinue)
            || (step === 1 && !hasCapability(rules) && !requiresAnswer)
            || (step === 2 && Boolean(ruleError))}
          onClick=${() => onStep(next)}>Continue</button>`}
        ${step === 3 ? finalAction : null}
      </span>
    </div>
  </div>`;
}
