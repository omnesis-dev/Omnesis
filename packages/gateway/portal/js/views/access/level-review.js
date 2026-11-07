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
import { editableSourcePolicy } from "../../components/source-filter-state.js";
import { sourceAccountOf } from "../../lib/source-id.js";
import {
  changedLevelDecisions,
  sourceBoundarySummary,
  sameDecision,
  levelSourceInventory,
} from "./level-flow-state.js";

export const DECISION_TITLES = {
  permissions: "Permissions",
  "answer-data": "Answer data",
  "direct-data": "Direct data",
  future: "New sources",
  release: "Answer release",
};
function OptionalCounts({ rule, sources }) {
  const [open, setOpen] = useState(false);
  return html`<details open=${open} onToggle=${(event) => setOpen(event.currentTarget.open)}>
    <summary>Counts and saved rule details</summary>
    ${open ? html`<${RuleFilterSummaries} rule=${rule} sources=${sources} />` : null}
  </details>`;
}
function useRuleLabels(rule) {
  useScopeLabelVersion();
  const identity = JSON.stringify(rule?.scopePolicies ?? []);
  useEffect(() => {
    const controller = new AbortController();
    // Display labels never validate an editable filter or authorize Apply.
    for (const policy of rule?.scopePolicies ?? [])
      readFilterPreview(policy.sourceId, policy, controller.signal).catch(() => {});
    return () => controller.abort();
  }, [identity]);
}
export function ReadableBoundary({ rule, source }) {
  const id = sourceId(source),
    policy = rule?.scopePolicies?.find((item) => item.sourceId === id);
  useRuleLabels({ scopePolicies: policy ? [policy] : [] });
  if (!rule || !isSourceAllowed(rule, id) || !policy || !editableSourcePolicy(policy))
    return html`<span>${rule ? sourceBoundarySummary(rule, source) : "Not granted"}</span>`;
  const refs = policy.rules[0].match;
  const names = refs.slice(0, 2).map((ref) => {
    const kind =
      source.scopes?.items?.find((item) => item.kind === ref.kind)?.noun?.one || ref.kind;
    const display = scopeDisplayLabel(id, ref, source);
    return `${kind}: ${display.unavailable ? "name unavailable (saved restriction retained)" : display.label}`;
  });
  return html`<span class="guided-readable-boundary"
    >${policy.rules[0].action === "share" ? "Only " : "Everything except "}${names.join("; ")}${refs.length > 2 ? `; and ${refs.length - 2} more` : ""}</span
  >`;
}
export function LevelTopicSummary({ decision, rules, sources, policies }) {
  if (decision === "answer-data" || decision === "direct-data") {
    const rule = rules[decision === "answer-data" ? "answer" : "direct"];
    const count = rule
      ? levelSourceInventory(sources, rule).filter((source) =>
          isSourceAllowed(rule, sourceId(source)),
        ).length
      : 0;
    const summary = `${count} ${count === 1 ? "account" : "accounts"} selected${rule?.scopePolicies?.length ? ` · ${rule.scopePolicies.length} with restricted content` : " · all content in selected accounts"}`;
    return html`<p>${summary}</p>`;
  }
  if (decision === "future") {
    const summary = ["answer", "direct"]
      .filter((capability) => rules[capability])
      .map(
        (capability) =>
          `${capability === "answer" ? "Answer" : "Direct"}: ${rules[capability].sources.mode === "allowlist" ? "blocked" : "automatic"}`,
      )
      .join(" · ");
    return html`<p>${summary}</p>`;
  }
  return html`<${LevelDecisionSummary}
    decision=${decision}
    rules=${rules}
    sources=${sources}
    policies=${policies}
  />`;
}
function AccountDelta({ decision, before, after, sources }) {
  const capability = decision === "answer-data" ? "answer" : "direct";
  const left = before[capability],
    right = after[capability];
  const inventory = levelSourceInventory(sources, left, right);
  const ids = new Set(inventory.map(sourceId));
  const boundary = (rule, id) => ({
    granted: Boolean(rule),
    allowed: Boolean(rule && isSourceAllowed(rule, id)),
    policy: rule?.scopePolicies?.find((policy) => policy.sourceId === id) ?? null,
  });
  const changed = [...ids].filter((id) => !sameDecision(boundary(left, id), boundary(right, id)));
  const unchanged = ids.size - changed.length;
  return html`<div class="guided-account-deltas">
    ${changed.map((id) => {
      const source = inventory.find((item) => sourceId(item) === id) ?? {
        id,
        displayName: "Unavailable account",
      };
      return html`<section class="guided-account-delta">
        <header>
          <strong>${sourceLabel(source)}</strong
          ><small>${sourceAccountOf(id) || "Connected account"}</small>
        </header>
        <div class="guided-change-pair">
          <section>
            <strong>Before</strong><${ReadableBoundary} rule=${left} source=${source} />
          </section>
          <section>
            <strong>After</strong><${ReadableBoundary} rule=${right} source=${source} />
          </section>
        </div>
      </section>`;
    })}
    ${!changed.length ? html`<p>Account availability has changed. Check the source and new-source decisions.</p>` : null}
    ${
      unchanged
        ? html`<details class="guided-unchanged-accounts">
            <summary>${unchanged} unchanged ${unchanged === 1 ? "account" : "accounts"}</summary>
            <${LevelDecisionSummary}
              decision=${decision}
              onlySourceIds=${[...ids].filter((id) => !changed.includes(id))}
              rules=${{ ...after, [capability]: right ? { ...right, scopePolicies: (right.scopePolicies ?? []).filter((policy) => !changed.includes(policy.sourceId)) } : null }}
              sources=${sources.filter((source) => !changed.includes(sourceId(source)))}
              policies=${[]}
            />
          </details>`
        : null
    }
  </div>`;
}
export function LevelDecisionSummary({
  decision,
  rules,
  sources,
  policies,
  counts = false,
  onlySourceIds,
}) {
  const dataRule =
    decision === "answer-data" ? rules.answer : decision === "direct-data" ? rules.direct : null;
  useRuleLabels(dataRule);
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
  const listed = levelSourceInventory(sources, rule).filter(
    (source) =>
      (!onlySourceIds || onlySourceIds.includes(sourceId(source))) &&
      (isSourceAllowed(rule, sourceId(source)) ||
        rule.scopePolicies?.some((policy) => policy.sourceId === sourceId(source)) ||
        (source.available === false && rule.sources.sourceIds?.includes(sourceId(source)))),
  );
  return html`<div class="guided-data-summary">
    <ul class="guided-summary-list">
      ${listed.map((source) => {
        const id = sourceId(source),
          policy = rule.scopePolicies?.find((item) => item.sourceId === id);
        return html`<li>
          <div>
            <strong>${sourceLabel(source)}</strong><small>${sourceAccountOf(id)}</small
            ><span>${sourceBoundarySummary(rule, source)}</span
            >${source.available === false ? html`<small>Unavailable · saved decision retained</small>` : null}${
              policy
                ? html`<ul class="guided-match-names">
                    ${policy.rules.flatMap((entry) => entry.match.map((ref) => html`<li>${scopeDisplayLabel(id, ref, source).label}</li>`))}
                  </ul>`
                : null
            }
          </div>
        </li>`;
      })}
    </ul>
    ${!listed.length ? html`<p>No accounts selected.</p>` : null}${counts && rule.scopePolicies?.length ? html`<${OptionalCounts} rule=${rule} sources=${sources} />` : null}
  </div>`;
}
export function LevelReview({
  rules,
  initial,
  sources,
  policies,
  onChange,
  isNew = false,
  disabled = false,
}) {
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
            <button
              type="button"
              class="btn-secondary"
              disabled=${disabled}
              onClick=${() => {
                if (!disabled) onChange(key);
              }}
            >
              Change
            </button>
          </header>
          ${
            isNew
              ? summary(key, rules, true)
              : key === "answer-data" || key === "direct-data"
                ? html`<${AccountDelta}
                    decision=${key}
                    before=${initial}
                    after=${rules}
                    sources=${sources}
                  />`
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
