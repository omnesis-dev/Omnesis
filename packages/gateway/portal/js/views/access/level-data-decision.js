// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { SourceAccountHeader } from "../../components/source-account-header.js";
import { SourceFilterEditor } from "../../components/source-filter-editor.js";
import { sourcePolicy, setSourcePolicy } from "../../components/source-filter-state.js";
import { sourceAccountOf } from "../../lib/source-id.js";
import {
  capabilityName,
  isSourceAllowed,
  sourceId,
  sourceLabel,
  setSourceAllowed,
  sourceBoundaryBlocksSavedFilter,
  SAVED_FILTER_SOURCE_MESSAGE,
} from "../../components/grant-builder-state.js";
import { levelSourceInventory } from "./level-flow-state.js";
import { AccountStatusPill } from "./level-review.js";

/**
 * The accounts one capability reads, each with its checkbox, its status and
 * the Change that opens its filter. The level editor and the approval sheet
 * both render this list.
 */
export function LevelDataDecision({
  capability,
  rule,
  sources,
  enabled,
  disabled,
  accessLevel,
  onChange,
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(null);
  const all = levelSourceInventory(sources, rule);
  const visible = all.filter((source) =>
    `${sourceLabel(source)} ${sourceAccountOf(sourceId(source))}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const blocked = (candidate) => sourceBoundaryBlocksSavedFilter(candidate, enabled);
  // Bulk actions reach the accounts the search shows and leave the rest as chosen.
  const setVisible = (allowed) =>
    visible.reduce(
      (next, source) =>
        isSourceAllowed(next, sourceId(source)) === allowed
          ? next
          : setSourceAllowed(next, sourceId(source), allowed),
      rule,
    );
  const updatePolicy = (source, policy) => {
    onChange(setSourcePolicy(rule, sourceId(source), policy));
    setEditing(null);
  };
  return html`<section
    class="guided-data-decision"
    aria-label=${`${capabilityName(capability)} source selection`}
  >
    ${
      all.length
        ? html`<label class="guided-source-search"
              >Find an account<input
                type="search"
                value=${query}
                onInput=${(event) => setQuery(event.currentTarget.value)}
                placeholder="Search accounts"
            /></label>
            <div class="guided-source-tools">
              <span
                >${`${all.filter((source) => isSourceAllowed(rule, sourceId(source))).length} of ${all.length} allowed`}</span
              ><button
                type="button"
                class="btn-secondary"
                disabled=${disabled || blocked(setVisible(true))}
                onClick=${() => onChange(setVisible(true))}
              >
                Allow all</button
              ><button
                type="button"
                class="btn-secondary"
                disabled=${disabled || blocked(setVisible(false))}
                onClick=${() => onChange(setVisible(false))}
              >
                Block all
              </button>
            </div>`
        : null
    }
    <div class="guided-source-list">
      ${visible.map((source) => {
        const id = sourceId(source),
          allowed = isSourceAllowed(rule, id),
          policy = sourcePolicy(rule, id);
        const candidate = setSourceAllowed(rule, id, !allowed);
        const locked = blocked(candidate);
        return html`<article class=${`guided-source-row${allowed ? " is-selected" : ""}`} key=${id}>
          <label class="guided-source-select"
            ><input
              type="checkbox"
              checked=${allowed}
              disabled=${disabled || locked}
              aria-label=${`Share ${sourceLabel(source)} ${sourceAccountOf(id) || "account"}`}
              onChange=${() => onChange(candidate)}
            /><${SourceAccountHeader}
              source=${source}
            /></label
          >
          <div class="guided-source-boundary">
            <${AccountStatusPill}
              rule=${rule}
              source=${source}
            />${(allowed && enabled && source.filterable) || policy ? html`<button type="button" class="btn-secondary" disabled=${disabled} aria-label=${`${enabled ? "Change" : "View"} ${sourceLabel(source)} content`} onClick=${() => setEditing(source)}>${enabled ? "Change" : "View"}</button>` : null}
          </div>
          ${locked ? html`<p class="source-filter-notice">${SAVED_FILTER_SOURCE_MESSAGE}</p>` : null}
        </article>`;
      })}
    </div>
    ${!all.length ? html`<p>No connected accounts are available. Connect a source before granting data access.</p>` : !visible.length ? html`<p>No accounts match this search.</p>` : null}
    ${editing ? html`<${SourceFilterEditor} key=${`${sourceId(editing)}:${capability}`} source=${editing} capability=${capability} accessLevel=${accessLevel} savedPolicy=${sourcePolicy(rule, sourceId(editing))} enabled=${enabled && !disabled} onClose=${() => setEditing(null)} onApply=${(policy) => updatePolicy(editing, policy)} onRemove=${() => updatePolicy(editing, null)} />` : null}
  </section>`;
}
