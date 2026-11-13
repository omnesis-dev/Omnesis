// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import {
  CapabilityPills,
  FilterModePill,
  filterModeLabel,
} from "../../components/access-pills.js";
import {
  CountsUnavailable,
  useSourceFilterPreview,
} from "../../components/source-filter-preview.js";
import { CountingRecords, SourceFilterTable } from "../../components/source-filter-table.js";
import { SourceAccountHeader } from "../../components/source-account-header.js";
import {
  blocksNewSources,
  capabilityName,
  findPolicyFamily,
  isSourceAllowed,
  sharedScopePolicies,
  sourceId,
  policyFamilyName,
} from "../../components/grant-builder-state.js";
import { scopePolicyIntent } from "../../components/grant-intent.js";
import {
  editableSourcePolicy,
  scopeRefKey,
  sourcePolicy,
} from "../../components/source-filter-state.js";
import {
  changedLevelDecisions,
  dataDecisionCapability,
  levelDecisions,
  sourceBoundarySummary,
  sameDecision,
  levelSourceInventory,
} from "./level-flow-state.js";

export const DECISION_TITLES = {
  name: "Name",
  permissions: "Permissions",
  "answer-data": "Answer data",
  "direct-data": "Direct data",
  future: "New sources",
  release: "Answer release",
};

/** What stands for a decision, or an account, of a capability the level does not hold. */
const NOT_GRANTED = "Not granted";
function NotGranted() {
  return html`<p class="guided-not-granted">${NOT_GRANTED}</p>`;
}

/**
 * An account's status in an account list, as a toned pill: "All content",
 * "Share matching content · 1 item" in the share tone, "Hide matching
 * content · 2 items" in the hide tone, "Not shared" muted.
 */
export function AccountStatusPill({ rule, source }) {
  const id = sourceId(source);
  const shared = Boolean(rule && isSourceAllowed(rule, id));
  const policy = shared ? sourcePolicy(rule, id) : null;
  const tone = !shared
    ? "off"
    : !policy
      ? "all"
      : editableSourcePolicy(policy) && policy.rules[0].action === "hide"
        ? "hide"
        : "only";
  return html`<span class=${`guided-readable-boundary access-pill is-${tone}`}
    >${rule ? sourceBoundarySummary(rule, source) : NOT_GRANTED}</span
  >`;
}

/** One status pill per account: what the boundary is, toned by how much it shares. */
function BoundaryPill({ rule, source, policy, active }) {
  const single = active && policy && editableSourcePolicy(policy) ? policy.rules[0] : null;
  const tone = !active ? "off" : !policy ? "all" : "only";
  if (single) return html`<${FilterModePill} action=${single.action} className="guided-readable-boundary" />`;
  return html`<span class=${`guided-readable-boundary access-pill is-${tone}`}
    >${rule ? sourceBoundarySummary(rule, source) : NOT_GRANTED}</span
  >`;
}

/**
 * The filter an account holds under one capability, with its live match
 * counts. A filter a draft keeps on an account that is not shared is not in
 * effect and is not saved, so it is not one the account holds.
 */
function useAccountPolicy(rule, source) {
  const id = sourceId(source);
  const active = Boolean(rule && isSourceAllowed(rule, id));
  const policy = active ? sourcePolicy(rule, id) : null;
  // An account that is no longer connected has nothing to count.
  const preview = useSourceFilterPreview(id, source.available === false ? null : policy);
  return {
    policy,
    preview,
    active,
    editable: Boolean(policy && editableSourcePolicy(policy)),
    refs: (policy?.rules ?? []).flatMap((item) => item.match ?? []),
    items: preview.data?.items ?? [],
  };
}

/** The status line of a boundary: its counts when filtered, then its pill. */
function BoundaryLine({ rule, source, state, header = null }) {
  const { policy, preview, active, editable } = state;
  return html`<div class="compact-account-line">
    ${header}
    <span class="compact-account-state">
      ${
        policy
          ? html`<span class="compact-policy-impact" role="status">
              ${preview.pending ? html`<${CountingRecords} />` : preview.error ? html`<${CountsUnavailable} onRetry=${preview.retry} />` : Number.isFinite(preview.data?.visible) && Number.isFinite(preview.data?.hidden) ? html`<span><strong>${preview.data.visible.toLocaleString()}</strong> shared</span><span><strong>${preview.data.hidden.toLocaleString()}</strong> hidden</span>` : null}
              ${!editable ? html`<span>Other content: ${policy.otherwise === "share" ? "shared" : "hidden"}</span>` : null}
            </span>`
          : null
      }
      <${BoundaryPill} rule=${rule} source=${source} policy=${policy} active=${active} />
    </span>
  </div>`;
}

/** The typed table of each saved rule. */
function PolicyTables({ source, state, comparisonRefs = [] }) {
  const { policy, preview, editable, items } = state;
  if (!policy) return null;
  return html`<div class="compact-policy-summary">
    ${(policy.rules ?? []).map(
      (item, index) =>
        html`<section key=${index}>
          ${!editable ? html`<div class="compact-policy-mode">${filterModeLabel(item.action)}</div>` : null}
          <${SourceFilterTable}
            source=${source}
            refs=${item.match ?? []}
            comparisonRefs=${comparisonRefs}
            items=${items}
            pending=${preview.pending}
          />
        </section>`,
    )}
    ${!editable ? html`<span class="compact-retained-notice">Advanced saved filter · retained</span>` : null}
  </div>`;
}

/** An account's boundary: its status line, then the typed table of any saved filter. */
function AccountBoundary({ rule, source, header }) {
  const state = useAccountPolicy(rule, source);
  return html`<div class="compact-account-boundary">
    <${BoundaryLine} rule=${rule} source=${source} state=${state} header=${header} />
    <${PolicyTables} source=${source} state=${state} />
  </div>`;
}

/**
 * One account's change: the boundary before and after, each with the filter
 * it holds directly under it. When both sides hold a filter this editor
 * expresses, one table after the pair marks what the change adds and removes
 * instead; a filter it cannot express keeps its own table under its side.
 */
function AccountChange({ before, after, source }) {
  const left = useAccountPolicy(before, source);
  const right = useAccountPolicy(after, source);
  const merged = left.editable && right.editable;
  const kept = new Set(right.refs.map(scopeRefKey));
  const had = new Set(left.refs.map(scopeRefKey));
  const removed = left.refs.filter((ref) => !kept.has(scopeRefKey(ref)));
  const marks = new Map([
    ...removed.map((ref) => [scopeRefKey(ref), "removed"]),
    ...right.refs.filter((ref) => !had.has(scopeRefKey(ref))).map((ref) => [scopeRefKey(ref), "added"]),
  ]);
  // What the change touches leads; the filters it keeps follow.
  const refs = [
    ...right.refs.filter((ref) => marks.has(scopeRefKey(ref))),
    ...removed,
    ...right.refs.filter((ref) => !marks.has(scopeRefKey(ref))),
  ];
  const side = (label, rule, state, other) => html`<section>
    <strong>${label}</strong>
    <div class="compact-account-boundary">
      <${BoundaryLine} rule=${rule} source=${source} state=${state} />
      ${!merged ? html`<${PolicyTables} source=${source} state=${state} comparisonRefs=${other.refs} />` : null}
    </div>
  </section>`;
  return html`<section class="guided-account-delta">
    <header><${SourceAccountHeader} source=${source} /></header>
    <div class="guided-change-pair">
      ${side("Before", before, left, right)}${side("After", after, right, left)}
    </div>
    ${
      merged && refs.length
        ? html`<div class="compact-policy-summary guided-change-filters">
            <${SourceFilterTable}
              source=${source}
              refs=${refs}
              marks=${marks}
              items=${[...right.items, ...left.items.filter((item) => !kept.has(scopeRefKey(item.ref)))]}
              pending=${left.preview.pending || right.preview.pending}
            />
          </div>`
        : null
    }
  </section>`;
}

/** "2 accounts selected · 1 filtered": a data decision in one line. */
export function dataSelectionLabel(rule, sources) {
  const selected = rule
    ? levelSourceInventory(sources, rule).filter((source) =>
        isSourceAllowed(rule, sourceId(source)),
      )
    : [];
  const restricted = sharedScopePolicies(rule).length;
  return `${selected.length} ${selected.length === 1 ? "account" : "accounts"} selected${restricted ? ` · ${restricted} filtered` : selected.length ? " · all content" : ""}`;
}

/** How a Direct that follows Answer's sources and filters is summarised. */
export const LINKED_DIRECT_SUMMARY = "Same sources and filters as Answer";

/** A decision in a line or two, for the settings a review lists as unchanged. */
export function LevelTopicSummary({ decision, rules, sources, policies, linked = false }) {
  if (decision === "direct-data" && linked)
    return html`<div class="compact-topic-summary">
      <p class="compact-topic-count">${LINKED_DIRECT_SUMMARY}</p>
    </div>`;
  if (dataDecisionCapability(decision)) {
    const rule = rules[dataDecisionCapability(decision)];
    const retained = rule
      ? levelSourceInventory(sources, rule).filter(
          (source) => source.available === false && isSourceAllowed(rule, sourceId(source)),
        )
      : [];
    return html`<div class="compact-topic-summary">
      <p class="compact-topic-count">${dataSelectionLabel(rule, sources)}</p>
      ${retained.map((source) => html`<div class="compact-retained-account"><${SourceAccountHeader} source=${source} /><${AccountStatusPill} rule=${rule} source=${source} /></div>`)}
    </div>`;
  }
  return html`<${LevelDecisionSummary}
    decision=${decision}
    rules=${rules}
    sources=${sources}
    policies=${policies}
  />`;
}

function AccountDelta({ decision, before, after, sources }) {
  const capability = dataDecisionCapability(decision);
  const left = before[capability],
    right = after[capability];
  const inventory = levelSourceInventory(sources, left, right);
  const ids = new Set(inventory.map(sourceId));
  // What an account shares; one that is not read at all shares nothing,
  // whether its capability is off or the account is not selected.
  const boundary = (rule, id) =>
    rule && isSourceAllowed(rule, id) ? scopePolicyIntent(sourcePolicy(rule, id)) : false;
  const changed = [...ids].filter((id) => !sameDecision(boundary(left, id), boundary(right, id)));
  return html`<div class="guided-account-deltas">
    ${changed.map((id) => {
      const source = inventory.find((item) => sourceId(item) === id);
      return html`<${AccountChange} key=${id} before=${left} after=${right} source=${source} />`;
    })}
    ${!changed.length ? html`<p>Account availability changed.</p>` : null}
  </div>`;
}

/** "Answer: Blocked / Direct: Automatic": what happens to new sources, per reading capability. */
export function newSourcesSummary(rules) {
  return ["answer", "direct"]
    .filter((capability) => rules[capability])
    .map(
      (capability) =>
        `${capabilityName(capability)}: ${blocksNewSources(rules[capability]) ? "Blocked" : "Automatic"}`,
    )
    .join(" / ");
}

/** "Privacy review · Everyday privacy" or "No privacy review". */
export function releaseSummary(answer, policies) {
  return answer.release.mode === "unreviewed"
    ? "No privacy review"
    : `Privacy review · ${policyFamilyName(findPolicyFamily(policies, answer.release.policyFamilyId))}`;
}

export function LevelDecisionSummary({ decision, rules, sources, policies }) {
  if (decision === "permissions") return html`<${CapabilityPills} rules=${rules} />`;
  if (decision === "future" && !rules.answer && !rules.direct)
    return html`<${NotGranted} />`;
  if (decision === "future")
    return html`<p class="compact-setting-value">${newSourcesSummary(rules)}</p>`;
  if (decision === "release") {
    if (!rules.answer) return html`<${NotGranted} />`;
    return html`<p class="compact-setting-value compact-release-summary">
      ${releaseSummary(rules.answer, policies)}
    </p>`;
  }
  const rule = rules[dataDecisionCapability(decision)];
  if (!rule) return html`<${NotGranted} />`;
  const listed = levelSourceInventory(sources, rule).filter(
    (source) =>
      isSourceAllowed(rule, sourceId(source)) ||
      (source.available === false && rule.sources.sourceIds?.includes(sourceId(source))),
  );
  return html`<div class="guided-data-summary compact-source-summaries">
    ${listed.map(
      (source) =>
        html`<section class="compact-source-summary" key=${sourceId(source)}>
          <${AccountBoundary}
            rule=${rule}
            source=${source}
            header=${html`<span class="compact-account-identity"
              ><${SourceAccountHeader} source=${source}
            /></span
            >`}
          />
        </section>`,
    )}
    ${!listed.length ? html`<p>No accounts selected.</p>` : null}
  </div>`;
}

/**
 * A level's decisions, one section each: every decision of a new level, or
 * the changed ones of an edit followed by the unchanged ones in brief. Each
 * section offers Change when `onChange(decision)` is given; without it the
 * review only reports.
 */
export function LevelReview({
  rules,
  initial,
  sources,
  policies,
  onChange = null,
  isNew = false,
  disabled = false,
  linked = false,
  name = null,
}) {
  // An edit reviews the level's name with its decisions; a new level names itself above them.
  const named = !isNew && name;
  const all = [...(named ? ["name"] : []), ...levelDecisions(rules, initial)];
  const changes = isNew
    ? all
    : [
        ...(named && name.before !== name.after ? ["name"] : []),
        ...changedLevelDecisions(initial, rules, sources),
      ];
  const unchanged = all.filter((key) => !changes.includes(key));
  const summary = (key, values, before = false) =>
    key === "name"
      ? html`<p class="compact-setting-value">${before ? name.before : name.after}</p>`
      : html`<${LevelDecisionSummary}
      decision=${key}
      rules=${values}
      sources=${sources}
      policies=${policies}
    />`;
  return html`<section class="guided-level-review compact-level-review">
    ${!isNew && !changes.length ? html`<p class="guided-empty-change">No permissions have changed.</p>` : null}
    ${changes.map(
      (key) =>
        html`<article class=${`guided-review-decision compact-review-${key}`} key=${key}>
          <header>
            <h4>${DECISION_TITLES[key]}</h4>
            ${
              onChange
                ? html`<button
                    type="button"
                    class="btn-secondary"
                    disabled=${disabled}
                    onClick=${() => {
                      if (!disabled) onChange(key);
                    }}
                  >
                    Change
                  </button>`
                : null
            }
          </header>
          ${
            isNew
              ? key === "direct-data" && linked
                ? html`<p>${LINKED_DIRECT_SUMMARY}</p>`
                : summary(key, rules)
              : dataDecisionCapability(key)
                ? html`<${AccountDelta}
                    decision=${key}
                    before=${initial}
                    after=${rules}
                    sources=${sources}
                  />`
                : html`<div class="guided-change-pair">
                    <section><strong>Before</strong>${summary(key, initial, true)}</section>
                    <section><strong>After</strong>${summary(key, rules)}</section>
                  </div>`
          }
        </article>`,
    )}
    ${
      !isNew && unchanged.length
        ? html`<section
            class="guided-unchanged compact-unchanged-settings"
            aria-label="Unchanged settings"
          >
            <h4>Unchanged</h4>
            <div>
              ${unchanged.map(
                (key) =>
                  html`<section>
                    <h5>${DECISION_TITLES[key]}</h5>
                    ${
                      key === "name"
                        ? html`<p class="compact-setting-value">${name.after}</p>`
                        : html`<${LevelTopicSummary}
                            decision=${key}
                            rules=${rules}
                            sources=${sources}
                            policies=${policies}
                            linked=${linked}
                          />`
                    }
                  </section>`,
              )}
            </div>
          </section>`
        : null
    }
  </section>`;
}
