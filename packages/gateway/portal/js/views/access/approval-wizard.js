// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The steps of approving a connection: Connection, Permissions, Data, Review.
//
// The Connection step is the approval's own: what the connection is called and
// which access level it uses. Choosing an existing level or replacing a
// connection settles the permissions, so that path goes straight to the
// review. A new access level is set up with the same decisions, in the same
// order, as a level created from the Access page: Permissions is the first of
// them and Data walks the rest, one question per screen.

import { html } from "htm/preact";
import { LevelDecision, useDecisionStep } from "./level-decisions.js";

export const CONNECTION_STEP = "connection";
const REVIEW_STEP = "review";
const PHASE_LABELS = ["Connection", "Permissions", "Data", "Review"];

/** The chip a step belongs to: every decision after Permissions is Data. */
function phaseOf(step) {
  if (step === CONNECTION_STEP) return 0;
  if (step === "permissions") return 1;
  return step === REVIEW_STEP ? 3 : 2;
}

/**
 * @param {object} props
 * @param {string} props.step  `CONNECTION_STEP`, a level decision, or "review".
 * @param {{
 *   heading: string, blurb?: string, content: unknown,
 *   canContinue: boolean, skipsToReview: boolean,
 * }} props.leadStep  the Connection step.
 * @param {object} props.walk  the new level's decisions, from `useNewLevelWalk`.
 * @param {object} props.memory  from `useLevelDecisionMemory`.
 */
export function ApprovalWizard({
  leadStep,
  step,
  onStep,
  walk,
  memory,
  rules,
  onRules,
  sources = [],
  policies = [],
  sourceFiltersEnabled = false,
  linkDirect,
  onLinkDirect,
  disabled = false,
  requiresAnswer = false,
  review = null,
  leadAction = null,
  finalAction = null,
  error = "",
}) {
  // The first render is not a move, and stealing focus there would fight the
  // page's own heading.
  const {
    attempted,
    headingRef: stepHeadingRef,
    alertRef,
    pass,
  } = useDecisionStep(step, { focusOnMount: false });

  const steps = [CONNECTION_STEP, ...(leadStep.skipsToReview ? [REVIEW_STEP] : walk.path)];
  const phase = phaseOf(step);
  const phases = [...new Set(steps.map(phaseOf))];
  const move = (next) => {
    if (next === CONNECTION_STEP) walk.reset();
    onStep(next);
  };
  const next = () => {
    if (step === CONNECTION_STEP) {
      onStep(steps[1]);
      return;
    }
    if (pass(rules, sources)) walk.advance();
  };
  const back = () => {
    if (leadStep.skipsToReview || walk.previous === null) move(CONNECTION_STEP);
    else walk.retreat();
  };

  return html`<div class="access-request access-request--page">
    <nav class="access-wizard-steps" aria-label="Progress">
      ${phases.map(
        (candidate, index) =>
          html`<button
            type="button"
            key=${PHASE_LABELS[candidate]}
            class=${candidate === phase ? "is-current" : candidate < phase ? "is-complete" : ""}
            aria-current=${candidate === phase ? "step" : undefined}
            disabled=${disabled || candidate > phase}
            onClick=${() =>
              candidate < phase && move(steps.find((key) => phaseOf(key) === candidate))}
          >
            <span>${candidate < phase ? "✓" : index + 1}</span>${PHASE_LABELS[candidate]}
          </button>`,
      )}
    </nav>

    <div class="access-wizard-panel">
      ${
        step === CONNECTION_STEP
          ? html`
              <div class="access-wizard-copy">
                <h3 ref=${stepHeadingRef} tabindex="-1">${leadStep.heading}</h3>
                ${leadStep.blurb ? html`<p>${leadStep.blurb}</p>` : null}
              </div>
              ${leadStep.content}
            `
          : step === REVIEW_STEP
            ? html`
                <div class="access-wizard-copy">
                  <h3 ref=${stepHeadingRef} tabindex="-1">Review access</h3>
                </div>
                ${review}
              `
            : html`<section class="guided-level-flow">
                <${LevelDecision}
                  step=${step}
                  rules=${rules}
                  onRules=${onRules}
                  sources=${sources}
                  policies=${policies}
                  sourceFiltersEnabled=${sourceFiltersEnabled}
                  accessLevel="new"
                  isNew
                  linkDirect=${linkDirect}
                  onLinkDirect=${onLinkDirect}
                  disabled=${disabled}
                  requiresAnswer=${requiresAnswer}
                  memory=${memory}
                  attempted=${attempted}
                  headingRef=${stepHeadingRef}
                  alertRef=${alertRef}
                />
              </section>`
      }
    </div>
    ${error && html`<p class="access-error" role="alert">${error}</p>`}
    <div class="access-request-actions">
      ${leadAction}
      <span class="access-wizard-nav">
        ${step !== CONNECTION_STEP && html`<button type="button" class="btn-secondary" disabled=${disabled} onClick=${back}>Back</button>`}
        ${
          step === REVIEW_STEP
            ? finalAction
            : html`<button
                type="button"
                class="btn-primary"
                disabled=${disabled || (step === CONNECTION_STEP && !leadStep.canContinue)}
                onClick=${next}
              >
                Continue
              </button>`
        }
      </span>
    </div>
  </div>`;
}
