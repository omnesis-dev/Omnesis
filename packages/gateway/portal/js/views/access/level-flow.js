// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect } from "preact/hooks";
import {
  LevelDecision,
  useDecisionStep,
  useLevelDecisionMemory,
  useNewLevelWalk,
} from "./level-decisions.js";
import {
  LevelDecisionSummary,
  LevelReview,
  DECISION_TITLES,
  dataSelectionLabel,
  LINKED_DIRECT_SUMMARY,
} from "./level-review.js";
import {
  dataDecisionCapability,
  directFollowsAnswer,
  levelDecisions,
  sameDecision,
} from "./level-flow-state.js";

/** The headings of the pages that are not a single decision. */
const PAGE_TITLES = {
  review: "Ready to create this access level?",
  overview: "What would you like to change?",
  changes: "Review your changes",
};

/**
 * An access level's own page: a new level walks its decisions to a final
 * review; an existing one opens on an overview, where each decision is changed
 * on its own and the changes are reviewed before saving.
 */
export function LevelFlow({
  step,
  onStep,
  rules,
  initial,
  onRules,
  sources,
  policies,
  sourceFiltersEnabled,
  accessLevel,
  isNew,
  linkDirect,
  onLinkDirect,
  disabled,
  isLocked,
  review,
  finalAction,
  leadAction,
  error = "",
  recovery = null,
  impact = null,
}) {
  const memory = useLevelDecisionMemory();
  const walk = useNewLevelWalk({ step, onStep, rules, linkDirect });
  const current = isNew ? walk.current : step;
  const page = PAGE_TITLES[current];
  const { attempted, headingRef: heading, alertRef: alert, pass } = useDecisionStep(current);
  useEffect(() => {
    if (error) alert.current?.focus?.();
  }, [error]);
  const locked = () => disabled || isLocked?.() === true;
  const move = (next) => {
    if (locked()) return;
    onStep(next);
  };
  const changeFromReview = (target) => {
    if (locked()) return;
    if (isNew) walk.change(target);
    else onStep(target);
  };
  const next = () => {
    if (locked() || !pass(rules, sources)) return;
    if (isNew) walk.advance();
    else onStep(current === "overview" ? "changes" : "overview");
  };
  const back = () => {
    if (locked()) return;
    if (isNew) walk.retreat();
    else onStep("overview");
  };
  const linked = directFollowsAnswer(rules, linkDirect);
  const notice = error
    ? html`<div class="access-error guided-task-error" role="alert" tabindex="-1" ref=${alert}>${error}${recovery}</div>`
    : null;
  return html`<section class="guided-level-flow">
    <div class="guided-progress" aria-label="Progress">
      ${isNew ? (current === "review" ? "Final review" : walk.correcting ? "Update your decision" : "Create access level") : current === "overview" ? "Edit access level" : current === "changes" ? "Final review" : "Edit decision"}
    </div>
    ${
      !page
        ? html`<${LevelDecision}
            step=${current}
            rules=${rules}
            onRules=${onRules}
            sources=${sources}
            policies=${policies}
            sourceFiltersEnabled=${sourceFiltersEnabled}
            accessLevel=${accessLevel}
            isNew=${isNew}
            linkDirect=${linkDirect}
            onLinkDirect=${onLinkDirect}
            disabled=${disabled}
            isLocked=${isLocked}
            memory=${memory}
            attempted=${attempted}
            notice=${notice}
            headingRef=${heading}
            alertRef=${alert}
          />`
        : html`<header class="guided-question">
              <h3 ref=${heading} tabindex="-1">${page}</h3>
            </header>
            ${notice}
            <div class="guided-decision-body">
      ${
        current === "overview"
          ? html`<div class="guided-edit-overview">
              ${levelDecisions(rules).map((key) => {
                const data = dataDecisionCapability(key);
                const follows = key === "direct-data" && linked;
                return html`<section
                  class=${`guided-overview-decision ${data ? "is-data" : "is-setting"}`}
                >
                  <header>
                    <h4>${DECISION_TITLES[key]}</h4>
                    ${data ? html`<p class="compact-topic-count">${follows ? LINKED_DIRECT_SUMMARY : dataSelectionLabel(rules[data], sources)}</p>` : null}
                    <span class="guided-overview-actions"
                      ><button
                        type="button"
                        class="btn-secondary"
                        disabled=${disabled}
                        onClick=${() => move(key)}
                      >
                        Change
                      </button></span
                    >
                  </header>
                  ${
                    follows
                      ? null
                      : html`<div class="guided-overview-value">
                          <${LevelDecisionSummary}
                            decision=${key}
                            rules=${rules}
                            sources=${sources}
                            policies=${policies}
                          />
                        </div>`
                  }
                </section>`;
              })}
            </div>`
          : null
      }
      ${current === "review" || current === "changes" ? html`${review}<${LevelReview} rules=${rules} initial=${initial ?? rules} sources=${sources} policies=${policies} isNew=${isNew} linked=${linked} disabled=${disabled} onChange=${changeFromReview} />${impact}` : null}
            </div>`
    }
    <footer class="guided-task-footer">
      <div>${leadAction}</div>
      <span
        >${(isNew && walk.position > 0) || (!isNew && current === "changes") ? html`<button type="button" class="btn-secondary" disabled=${disabled} onClick=${back}>Back</button>` : null}${current === "review" || current === "changes" ? finalAction : html`<button type="button" class="btn-primary" disabled=${disabled || (!isNew && current === "overview" && sameDecision(initial, rules))} onClick=${next}>${!isNew && current === "overview" ? "Review changes" : !isNew ? "Done" : "Continue"}</button>`}</span
      >
    </footer>
  </section>`;
}
