// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { sourceInstanceIcon } from "../../components/grant-builder.js";
import { SourceFilterEditor } from "../../components/source-filter-editor.js";
import { sourcePolicy, setSourcePolicy } from "../../components/source-filter-state.js";
import { sourceAccountOf } from "../../lib/source-id.js";
import {
  isSourceAllowed,
  sourceId,
  sourceLabel,
  setSourceAllowed,
  setAllSourcesAllowed,
  sourceBoundaryBlocksSavedFilter,
  SAVED_FILTER_SOURCE_MESSAGE,
} from "../../components/grant-builder-state.js";
import { levelSourceInventory } from "./level-flow-state.js";
import { ReadableBoundary } from "./level-review.js";

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
  const ids = sources.map(sourceId);
  const all = levelSourceInventory(sources, rule);
  const visible = all.filter((source) =>
    `${sourceLabel(source)} ${sourceAccountOf(sourceId(source))}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const blocked = (candidate) => sourceBoundaryBlocksSavedFilter(candidate, enabled);
  const updatePolicy = (source, policy) => {
    onChange(setSourcePolicy(rule, sourceId(source), policy));
    setEditing(null);
  };
  return html`<section
    class="guided-data-decision"
    aria-label=${`${capability === "answer" ? "Answer" : "Direct"} source selection`}
  >
    ${
      all.length > 5
        ? html`<label class="guided-source-search"
              >Find an account<input
                type="search"
                value=${query}
                onInput=${(event) => setQuery(event.currentTarget.value)}
                placeholder="Search accounts"
            /></label>
            <div class="guided-source-tools">
              <span
                >${all.filter((source) => isSourceAllowed(rule, sourceId(source))).length}
                selected</span
              ><button
                type="button"
                class="btn-secondary"
                disabled=${disabled || blocked(setAllSourcesAllowed(rule, ids, true))}
                onClick=${() => onChange(setAllSourcesAllowed(rule, ids, true))}
              >
                Select all</button
              ><button
                type="button"
                class="btn-secondary"
                disabled=${disabled || blocked(setAllSourcesAllowed(rule, ids, false))}
                onClick=${() => onChange(setAllSourcesAllowed(rule, ids, false))}
              >
                Clear
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
            /><span>${sourceInstanceIcon(source, id)}</span
            ><span
              ><strong>${sourceLabel(source)}</strong
              ><small class="guided-account">${sourceAccountOf(id) || "Connected account"}</small
              >${source.available === false ? html`<small>Unavailable · saved decision retained</small>` : null}</span
            ></label
          >
          <div class="guided-source-boundary">
            <${ReadableBoundary}
              rule=${rule}
              source=${source}
            />${(allowed && enabled && source.scopes?.items?.length) || policy ? html`<button type="button" class="btn-secondary" disabled=${disabled} aria-label=${`${enabled ? "Change" : "Inspect"} ${sourceLabel(source)} content`} onClick=${() => setEditing(source)}>${enabled ? "Change" : "Inspect"}</button>` : null}
          </div>
          ${locked ? html`<p class="source-filter-notice">${SAVED_FILTER_SOURCE_MESSAGE}</p>` : null}
        </article>`;
      })}
    </div>
    ${!all.length ? html`<p>No connected accounts are available. Connect a source before granting data access.</p>` : !visible.length ? html`<p>No accounts match this search.</p>` : null}
    ${editing ? html`<${SourceFilterEditor} key=${`${sourceId(editing)}:${capability}`} source=${editing} capability=${capability} accessLevel=${accessLevel} savedPolicy=${sourcePolicy(rule, sourceId(editing))} enabled=${enabled && !disabled} onClose=${() => setEditing(null)} onApply=${(policy) => updatePolicy(editing, policy)} onRemove=${() => updatePolicy(editing, null)} />` : null}
  </section>`;
}
