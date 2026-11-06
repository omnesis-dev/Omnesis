// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { SourceFilterEditor } from "./source-filter-editor.js";
import { SourcePolicySummary } from "./source-filter-preview.js";
import { sourcePolicy, setSourcePolicy, copyRuleFilters } from "./source-filter-state.js";
import { isSourceAllowed, sourceId, sourceLabel } from "./grant-builder-state.js";

export function RuleFilterSummaries({ rule, sources = [] }) {
  if (!rule?.scopePolicies?.length)
    return html`<small class="source-filter-unrestricted"
      >No per-source filters: all records within the selected sources.</small
    >`;
  return (rule?.scopePolicies ?? []).map(
    (policy) =>
      html`<${SourcePolicySummary}
        key=${policy.sourceId}
        policy=${policy}
        source=${sources.find((source) => sourceId(source) === policy.sourceId)}
        capability=${rule.capability === "answer" ? "Answer" : "Direct"}
      />`,
  );
}

/** Filter linking is an independent draft choice; source boundary copies never copy filters. */
export function SourceFilters({
  value,
  onChange,
  sources = [],
  enabled = false,
  disabled = false,
  accessLevel = "new",
  isNew = false,
  linkFilters = isNew,
  onLinkFilters = () => {},
}) {
  const [editing, setEditing] = useState(null);
  const both = Boolean(value.answer && value.direct);
  const update = (capability, id, policy) => {
    if (capability === "direct" && linkFilters) onLinkFilters(false);
    const next = { ...value, [capability]: setSourcePolicy(value[capability], id, policy) };
    if (linkFilters && capability === "answer" && next.direct)
      next.direct = copyRuleFilters(next.direct, next.answer, accessLevel);
    onChange(next);
    setEditing(null);
  };
  const listed = (capability) => {
    const rule = value[capability];
    const known = sources.filter(
      (source) =>
        (enabled && source.scopes?.items?.length && isSourceAllowed(rule, sourceId(source))) ||
        sourcePolicy(rule, sourceId(source)),
    );
    const retained = (rule.scopePolicies ?? [])
      .filter((policy) => !sources.some((source) => sourceId(source) === policy.sourceId))
      .map((policy) => ({ id: policy.sourceId, name: policy.sourceId, available: false }));
    return [...known, ...retained];
  };
  if (!enabled && ![value.answer, value.direct].some((rule) => rule?.scopePolicies?.length))
    return null;
  return html`<section class="source-filters" aria-label="Per-source filters">
    <h3>Filter records within a source</h3>
    <p>
      Whole-source access stays above. These decisions narrow matching records in each source
      account.
    </p>
    ${
      both && enabled
        ? html`<div class="source-filter-link">
            ${
              isNew
                ? html`<label
                    ><input
                      type="checkbox"
                      checked=${linkFilters}
                      disabled=${disabled}
                      onChange=${(event) => {
                        const next = event.currentTarget.checked;
                        onLinkFilters(next);
                        if (next)
                          onChange({
                            ...value,
                            direct: copyRuleFilters(value.direct, value.answer, accessLevel),
                          });
                      }}
                    />Use the same filters as Answer for this new Direct draft</label
                  >`
                : html`<p>Answer and Direct filters are independent.</p>`
            }
            <button
              type="button"
              class="btn-secondary"
              disabled=${disabled}
              onClick=${() => {
                onLinkFilters(false);
                onChange({
                  ...value,
                  direct: copyRuleFilters(value.direct, value.answer, accessLevel),
                });
              }}
            >
              Copy Answer filters to Direct once
            </button>
          </div>`
        : null
    }
    ${["answer", "direct"].map((capability) =>
      value[capability]
        ? html`<section class="source-filter-capability" key=${capability}>
            <h4>${capability === "answer" ? "Answer" : "Direct"} filters</h4>
            ${listed(capability).map((source) => {
              const id = sourceId(source),
                policy = sourcePolicy(value[capability], id),
                allowed = isSourceAllowed(value[capability], id);
              return html`<div class="source-filter-source" key=${id}>
                <span
                  ><strong>${sourceLabel(source)}</strong><code>${id}</code
                  ><small
                    >${policy ? `${policy.rules?.reduce((sum, rule) => sum + (rule.match?.length ?? 0), 0) ?? 0} selected items${allowed ? "" : " · Source blocked — restore it or remove its filter"}` : "All records in this source"}</small
                  ></span
                >
                <button
                  type="button"
                  class="btn-secondary"
                  disabled=${disabled || (!policy && (!enabled || !allowed))}
                  onClick=${() => setEditing({ source, capability })}
                >
                  ${policy ? (enabled ? "Edit filter" : "Inspect saved filter") : "Add filter"}
                </button>
              </div>`;
            })}
          </section>`
        : null,
    )}
    ${editing ? html`<${SourceFilterEditor} key=${`${sourceId(editing.source)}:${editing.capability}`} source=${editing.source} capability=${editing.capability} accessLevel=${accessLevel} savedPolicy=${sourcePolicy(value[editing.capability], sourceId(editing.source))} enabled=${enabled && !disabled} onClose=${() => setEditing(null)} onApply=${(policy) => update(editing.capability, sourceId(editing.source), policy)} onRemove=${() => update(editing.capability, sourceId(editing.source), null)} />` : null}
  </section>`;
}
