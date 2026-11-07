// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { readFilterPreview } from "../../components/source-filter-requests.js";
import { RuleFilterSummaries } from "../../components/source-filters.js";
import { scopeDisplayLabel, useScopeLabelVersion } from "../../components/source-filter-labels.js";
import {
  isSourceAllowed,
  sourceId,
  sourceLabel,
  policyFamilyId,
  policyFamilyName,
} from "../../components/grant-builder-state.js";
import { sourceAccountOf } from "../../lib/source-id.js";
import { changedLevelDecisions, sourceBoundarySummary } from "./level-flow-state.js";

export const DECISION_TITLES = {
  permissions: "Permissions",
  "answer-data": "Answer data",
  "direct-data": "Direct data",
  future: "New sources",
  release: "Answer privacy",
};
function OptionalCounts({ rule, sources }) {
  const [open, setOpen] = useState(false);
  return html`<details open=${open} onToggle=${(event) => setOpen(event.currentTarget.open)}>
    <summary>Counts and saved rule details</summary>
    ${open ? html`<${RuleFilterSummaries} rule=${rule} sources=${sources} />` : null}
  </details>`;
}
export function LevelDecisionSummary({ decision, rules, sources, policies, counts = false }) {
  useScopeLabelVersion();
  const dataRule =
    decision === "answer-data" ? rules.answer : decision === "direct-data" ? rules.direct : null;
  const identity = JSON.stringify(dataRule?.scopePolicies ?? []);
  useEffect(() => {
    const controller = new AbortController();
    // Resolve saved names through fresh bounded reads. These display hints do
    // not validate a filter or affect whether the level can be saved.
    for (const policy of dataRule?.scopePolicies ?? [])
      readFilterPreview(policy.sourceId, policy, controller.signal).catch(() => {});
    return () => controller.abort();
  }, [identity]);
  if (decision === "permissions")
    return html`<p>
      ${[rules.answer && "Ask through Omnesis", rules.direct && "Read original records", rules.notes && "Save new notes"].filter(Boolean).join(" · ") || "No permissions"}
    </p>`;
  if (decision === "future")
    return html`<ul class="guided-summary-list">
      ${["answer", "direct"].map((capability) => (rules[capability] ? html`<li><strong>${capability === "answer" ? "Answer" : "Direct"}</strong><span>${rules[capability].sources.mode === "allowlist" ? "New sources stay blocked" : "New sources are allowed automatically"}</span></li>` : null))}
    </ul>`;
  if (decision === "release") {
    if (!rules.answer) return html`<p>Answer is not granted.</p>`;
    const release = rules.answer.release;
    return html`<p>
      ${release.mode === "unreviewed" ? "Answers are released without privacy review." : `Answers are reviewed with ${policyFamilyName(policies.find((policy) => policyFamilyId(policy) === release.policyFamilyId))}.`}
    </p>`;
  }
  const capability = decision === "answer-data" ? "answer" : "direct",
    rule = rules[capability];
  if (!rule) return html`<p>Not granted.</p>`;
  const listed = sources.filter(
    (source) =>
      isSourceAllowed(rule, sourceId(source)) ||
      rule.scopePolicies?.some((policy) => policy.sourceId === sourceId(source)),
  );
  const unseen = (rule.scopePolicies ?? []).filter(
    (policy) => !sources.some((source) => sourceId(source) === policy.sourceId),
  );
  return html`<div class="guided-data-summary">
    <ul class="guided-summary-list">
      ${listed.map((source) => {
        const id = sourceId(source),
          policy = rule.scopePolicies?.find((item) => item.sourceId === id);
        return html`<li>
          <div>
            <strong>${sourceLabel(source)}</strong><small>${sourceAccountOf(id)}</small
            ><span>${sourceBoundarySummary(rule, source)}</span>${
              policy
                ? html`<ul class="guided-match-names">
                    ${policy.rules.flatMap((entry) => entry.match.map((ref) => html`<li>${scopeDisplayLabel(id, ref, source).label}</li>`))}
                  </ul>`
                : null
            }
          </div>
        </li>`;
      })}${unseen.map(() => html`<li>Unavailable account · saved restriction retained</li>`)}
    </ul>
    ${!listed.length && !unseen.length ? html`<p>No accounts selected.</p>` : null}${counts && rule.scopePolicies?.length ? html`<${OptionalCounts} rule=${rule} sources=${sources} />` : null}
  </div>`;
}
export function LevelReview({ rules, initial, sources, policies, onChange, isNew = false }) {
  const all = [
    "permissions",
    ...(rules.answer || initial?.answer ? ["answer-data"] : []),
    ...(rules.direct || initial?.direct ? ["direct-data"] : []),
    ...(rules.answer || rules.direct || initial?.answer || initial?.direct ? ["future"] : []),
    ...(rules.answer || initial?.answer ? ["release"] : []),
  ];
  const changes = isNew ? all : changedLevelDecisions(initial, rules, sources);
  const unchanged = all.filter((key) => !changes.includes(key));
  const summary = (key, values, counts) =>
    html`<${LevelDecisionSummary}
      decision=${key}
      rules=${values}
      sources=${sources}
      policies=${policies}
      counts=${counts}
    />`;
  return html`<section class="guided-level-review">
    ${!isNew && !changes.length ? html`<p class="guided-empty-change">No permissions have changed.</p>` : null}
    ${changes.map(
      (key) =>
        html`<article class="guided-review-decision" key=${key}>
          <header>
            <h4>${DECISION_TITLES[key]}</h4>
            <button type="button" class="btn-secondary" onClick=${() => onChange(key)}>
              Change
            </button>
          </header>
          ${
            isNew
              ? summary(key, rules, true)
              : html`<div class="guided-change-pair">
                  <section><strong>Before</strong>${summary(key, initial, false)}</section>
                  <section><strong>After</strong>${summary(key, rules, true)}</section>
                </div>`
          }
        </article>`,
    )}
    ${
      !isNew && unchanged.length
        ? html`<details class="guided-unchanged">
            <summary>
              ${unchanged.length} unchanged ${unchanged.length === 1 ? "setting" : "settings"}
            </summary>
            ${unchanged.map(
              (key) =>
                html`<section>
                  <h4>${DECISION_TITLES[key]}</h4>
                  ${summary(key, rules, false)}
                </section>`,
            )}
          </details>`
        : null
    }
    <p class="guided-count-note">
      Rules shown above determine access. Optional record counts may change as your sources sync.
    </p>
  </section>`;
}
