// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { CapabilityPicker, AnswerRelease } from "../../components/grant-builder.js";
import {
  copyRuleSources,
  setFutureSourcesAllowed,
  hasCapability,
  releaseError,
  sourceId,
  sourceBoundaryBlocksSavedFilter,
  sourceBoundaryError,
} from "../../components/grant-builder-state.js";
import { copyRuleFilters } from "../../components/source-filter-state.js";
import { LevelDataDecision } from "./level-data-decision.js";
import { LevelDecisionSummary, LevelReview, DECISION_TITLES } from "./level-review.js";
import { levelDecisionPath, sameDecision } from "./level-flow-state.js";

const QUESTIONS = {
  permissions: ["What may this connection do?", "Choose the actions you want to allow."],
  "answer-data": [
    "Which data may Answer use?",
    "Choose accounts, then narrow their content if needed.",
  ],
  "direct-data": [
    "Which originals may Direct read?",
    "Direct reads matching original records without privacy review.",
  ],
  "direct-choice": [
    "What may Direct read?",
    "Reuse Answer’s data for this draft, or choose a separate boundary.",
  ],
  future: ["What about new sources?", "Choose what happens when you connect another source."],
  release: [
    "How should answers be released?",
    "Choose whether a privacy policy reviews each answer.",
  ],
  review: [
    "Ready to create this access level?",
    "Check the boundaries and give this level a name.",
  ],
  overview: [
    "What would you like to change?",
    "Existing permissions stay in place until you review and save.",
  ],
  changes: ["Review your changes", "Only changed decisions are shown first."],
};
function decisionError(step, rules, sources) {
  if (step === "permissions") return hasCapability(rules) ? "" : "Choose at least one permission.";
  if (step === "release") return releaseError(rules) || "";
  if (step === "answer-data" || step === "direct-data") {
    const capability = step === "answer-data" ? "answer" : "direct";
    return (
      sourceBoundaryError(
        rules[capability],
        capability === "answer" ? "Answer" : "Direct",
        sources,
      ) || ""
    );
  }
  return "";
}
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
  linkSources,
  onLinkSources,
  linkFilters,
  onLinkFilters,
  disabled,
  review,
  finalAction,
  leadAction,
  error = "",
  impact = null,
}) {
  const [attempted, setAttempted] = useState(false);
  const heading = useRef(null),
    alert = useRef(null);
  const path = levelDecisionPath(rules, !linkSources || !linkFilters);
  const current = isNew ? (path.includes(step) ? step : path[0]) : step;
  const title = QUESTIONS[current] ?? QUESTIONS.overview;
  const position = path.indexOf(current);
  const decisionValidation = decisionError(current, rules, sources);
  useEffect(() => {
    setAttempted(false);
    heading.current?.focus?.();
  }, [current]);
  useEffect(() => {
    if (error) alert.current?.focus?.();
  }, [error]);
  const move = (next) => {
    onStep(next);
  };
  const update = (capability, next) => {
    const value = { ...rules, [capability]: next };
    if (isNew && capability === "answer" && value.direct && linkSources && linkFilters)
      value.direct = copyRuleFilters(copyRuleSources(value.direct, next), next, accessLevel);
    onRules(value);
  };
  const copyBlocked =
    !sourceFiltersEnabled &&
    [rules.answer, rules.direct].some((rule) => rule?.scopePolicies?.length);
  const reuse = () => {
    if (copyBlocked) return;
    onRules({
      ...rules,
      direct: copyRuleFilters(
        copyRuleSources(rules.direct, rules.answer),
        rules.answer,
        accessLevel,
      ),
    });
    onLinkSources(true);
    onLinkFilters(true);
  };
  const separate = () => {
    onLinkSources(false);
    onLinkFilters(false);
  };
  const next = () => {
    setAttempted(true);
    if (decisionValidation) {
      alert.current?.focus?.();
      return;
    }
    if (!isNew) {
      move(current === "overview" ? "changes" : "overview");
      return;
    }
    move(path[position + 1] ?? "review");
  };
  const back = () => move(isNew ? path[Math.max(position - 1, 0)] : "overview");
  const decisions = [
    "permissions",
    ...(rules.answer ? ["answer-data"] : []),
    ...(rules.direct ? ["direct-data"] : []),
    ...(rules.answer || rules.direct ? ["future"] : []),
    ...(rules.answer ? ["release"] : []),
  ];
  return html`<section class="guided-level-flow">
    <div class="guided-progress" aria-label="Progress">
      ${isNew ? `Step ${Math.max(position + 1, 1)} of ${path.length}` : current === "overview" ? "Edit access level" : current === "changes" ? "Final review" : "Edit decision"}
    </div>
    <header class="guided-question">
      <h3 ref=${heading} tabindex="-1">${title[0]}</h3>
      <p>${title[1]}</p>
    </header>
    ${error ? html`<div class="access-error guided-task-error" role="alert" tabindex="-1" ref=${alert}>${error}</div>` : attempted && decisionValidation ? html`<p class="access-field-error" role="alert" tabindex="-1" ref=${alert}>${decisionValidation}</p>` : null}
    <div class="guided-decision-body">
      ${current === "permissions" ? html`<${CapabilityPicker} value=${rules} onChange=${onRules} policies=${policies} disabled=${disabled} hideLegend isNew=${isNew} linkFilters=${linkFilters} accessLevel=${accessLevel} sourceFiltersEnabled=${sourceFiltersEnabled} />` : null}
      ${current === "answer-data" || current === "direct-data" ? html`<${LevelDataDecision} capability=${current === "answer-data" ? "answer" : "direct"} rule=${rules[current === "answer-data" ? "answer" : "direct"]} onChange=${(value) => update(current === "answer-data" ? "answer" : "direct", value)} sources=${sources} enabled=${sourceFiltersEnabled} disabled=${disabled} accessLevel=${accessLevel} />` : null}
      ${
        current === "direct-choice"
          ? html`<div class="guided-choices">
              <label class=${`guided-choice${linkSources && linkFilters ? " is-selected" : ""}`}
                ><input
                  type="radio"
                  name="direct-data-choice"
                  checked=${linkSources && linkFilters}
                  disabled=${disabled || copyBlocked}
                  onChange=${reuse}
                /><span
                  ><strong>Use Answer’s data for this draft</strong
                  ><small>Copy the same accounts and content restrictions.</small></span
                ></label
              ><label class=${`guided-choice${!linkSources || !linkFilters ? " is-selected" : ""}`}
                ><input
                  type="radio"
                  name="direct-data-choice"
                  checked=${!linkSources || !linkFilters}
                  onChange=${separate}
                /><span
                  ><strong>Choose Direct data separately</strong
                  ><small>Keep an independent boundary for original records.</small></span
                ></label
              >${linkSources && linkFilters ? html`<div class="guided-reuse-summary"><${LevelDecisionSummary} decision="answer-data" rules=${rules} sources=${sources} policies=${policies} /></div>` : null}
            </div>`
          : null
      }
      ${
        current === "future"
          ? html`<div class="guided-future-choices">
              ${["answer", "direct"].map((capability) =>
                rules[capability] &&
                !(isNew && capability === "direct" && rules.answer && linkSources && linkFilters)
                  ? html`<fieldset disabled=${disabled}>
                      <legend>
                        ${isNew && rules.answer && rules.direct && linkSources && linkFilters ? "Answer and Direct" : capability === "answer" ? "Answer" : "Direct"}
                      </legend>
                      ${[
                        [
                          false,
                          "Keep new sources blocked",
                          "I will allow each new source when I am ready.",
                        ],
                        [
                          true,
                          "Allow new sources automatically",
                          "Future sources will be included without another approval.",
                        ],
                      ].map(
                        ([allowed, label, detail]) =>
                          html`<label
                            class=${`guided-choice${(rules[capability].sources.mode !== "allowlist") === allowed ? " is-selected" : ""}`}
                            ><input
                              type="radio"
                              name=${`future-${capability}`}
                              disabled=${sourceBoundaryBlocksSavedFilter(setFutureSourcesAllowed(rules[capability], allowed, sources.map(sourceId)), sourceFiltersEnabled)}
                              checked=${(rules[capability].sources.mode !== "allowlist") === allowed}
                              onChange=${() => update(capability, setFutureSourcesAllowed(rules[capability], allowed, sources.map(sourceId)))}
                            /><span><strong>${label}</strong><small>${detail}</small></span></label
                          >`,
                      )}
                    </fieldset>`
                  : null,
              )}
            </div>`
          : null
      }
      ${current === "release" ? html`<${AnswerRelease} rule=${rules.answer} policies=${policies} disabled=${disabled} onChange=${(value) => update("answer", value)} idPrefix="level-release" />` : null}
      ${
        current === "overview"
          ? html`<div class="guided-edit-overview">
              ${decisions.map(
                (key) =>
                  html`<section class="guided-overview-decision">
                    <header>
                      <h4>${DECISION_TITLES[key]}</h4>
                      <button type="button" class="btn-secondary" onClick=${() => move(key)}>
                        Change
                      </button>
                    </header>
                    <${LevelDecisionSummary}
                      decision=${key}
                      rules=${rules}
                      sources=${sources}
                      policies=${policies}
                    />${key === "direct-data" && rules.answer ? html`<button type="button" class="btn-secondary" onClick=${() => move("direct-choice")}>Use Answer’s data once</button>` : null}
                  </section>`,
              )}
            </div>`
          : null
      }
      ${current === "review" || current === "changes" ? html`${review}<${LevelReview} rules=${rules} initial=${initial ?? rules} sources=${sources} policies=${policies} isNew=${isNew} onChange=${move} />${impact}` : null}
    </div>
    <footer class="guided-task-footer">
      <div>${leadAction}</div>
      <span
        >${(isNew && position > 0) || (!isNew && current !== "overview") ? html`<button type="button" class="btn-secondary" disabled=${disabled} onClick=${back}>Back</button>` : null}${current === "review" || current === "changes" ? finalAction : html`<button type="button" class="btn-primary" disabled=${disabled || (!isNew && current === "overview" && sameDecision(initial, rules))} onClick=${next}>${!isNew && current === "overview" ? "Review changes" : !isNew ? "Done" : "Continue"}</button>`}</span
      >
    </footer>
  </section>`;
}
