// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { scopeDisplayLabel, scopeLevelNoun, useScopeLabelVersion } from "./source-filter-labels.js";
import { scopeRefKey } from "./source-filter-state.js";
import { sourceId } from "./grant-builder-state.js";

/** Stands where a count will appear. */
export function CountSpinner() {
  return html`<span class="source-filter-spinner" role="img" aria-label="Counting"></span>`;
}

/** What stands for a filter's counts while they are worked out. */
export function CountingRecords() {
  return html`<${CountSpinner} />Counting matching records…`;
}

/** The button that asks again for counts that could not be read. */
export const RETRY_COUNTS_LABEL = "Retry counts";

function exactIdentifier(ref) {
  const identifier =
    ref.kind === "participant" && ref.identifiers?.length === 1 ? ref.identifiers[0] : null;
  return identifier && ref.label === identifier.value ? identifier : null;
}
/** A row's type: the source's word for the item, by its level when the source names the levels of a tree. */
export function sourceFilterKindLabel(source, ref, depth) {
  const identifier = exactIdentifier(ref);
  const name = identifier ? identifier.type : scopeLevelNoun(source, ref.kind, depth);
  return name ? name.charAt(0).toLocaleUpperCase() + name.slice(1) : "Filter";
}

/**
 * Counts and names describe selections; this component never validates a grant.
 * `marks` tags a row, by its reference key, as "added" or "removed".
 */
export function SourceFilterTable({
  source,
  refs = [],
  comparisonRefs = [],
  items = [],
  onRemove,
  disabled = false,
  pending = false,
  marks,
}) {
  useScopeLabelVersion();
  const id = sourceId(source);
  const byRef = new Map(items.map((item) => [scopeRefKey(item.ref), item]));
  const identitiesByName = new Map();
  for (const ref of [...refs, ...comparisonRefs]) {
    if (typeof ref.id !== "string") continue;
    const display = scopeDisplayLabel(id, ref, source);
    const item = byRef.get(scopeRefKey(ref));
    const name =
      item?.label && !(item.missing && item.label === ref.id)
        ? item.label
        : display.unavailable
          ? null
          : display.label;
    if (!name) continue;
    const key = JSON.stringify([ref.kind, name]);
    if (!identitiesByName.has(key)) identitiesByName.set(key, new Set());
    identitiesByName.get(key).add(ref.id);
  }
  return html`<div class="compact-filter-table-wrap">
    <table class="compact-filter-table" aria-label="Selected filters">
      <thead>
        <tr>
          <th scope="col">Type</th>
          <th scope="col">Value</th>
          <th scope="col" class="compact-filter-count">Matches</th>
          ${onRemove ? html`<th scope="col"><span class="sr-only">Actions</span></th>` : null}
        </tr>
      </thead>
      <tbody>
        ${refs.map((ref) => {
          const item = byRef.get(scopeRefKey(ref));
          const display = scopeDisplayLabel(id, ref, source);
          const exact = exactIdentifier(ref);
          const label =
            exact?.value ||
            (item?.label && !(item.missing && item.label === ref.id) ? item.label : display.label);
          const identifiers =
            ref.kind === "participant" && !exact
              ? (ref.identifiers ?? [])
                  .map((identifier) => identifier.value)
                  .filter((value) => value !== label)
              : [];
          const ambiguous =
            typeof ref.id === "string" &&
            identitiesByName.get(JSON.stringify([ref.kind, label]))?.size > 1;
          const count = Number.isFinite(item?.count) && item.count >= 0 ? item.count : null;
          const mark = marks?.get(scopeRefKey(ref));
          return html`<tr key=${scopeRefKey(ref)} class=${mark ? `is-${mark}` : undefined}>
            <td class="compact-filter-kind">${sourceFilterKindLabel(source, ref, Number.isInteger(item?.depth) ? item.depth : display.depth)}</td>
            <td class="compact-filter-value">
              <span class="compact-filter-name">${label}</span>${mark ? html`<span class="compact-filter-diff">${mark === "added" ? "Added" : "Removed"}</span>` : null}${ambiguous ? html`<small class="compact-filter-ref">Selection ID: ${ref.id}</small>` : null}${identifiers.length ? html`<span class="compact-filter-identifiers">${identifiers.join(" · ")}</span>` : null}${item?.missing ? html`<small>Unavailable · selection retained</small>` : display.unavailable ? html`<small>${pending ? "Loading name…" : "Name unavailable · saved selection"}</small>` : null}
            </td>
            <td
              class="compact-filter-count"
              aria-label=${count == null ? "Matching count unavailable" : undefined}
            >
              ${count == null ? (pending ? html`<${CountSpinner} />` : "—") : count.toLocaleString()}
            </td>
            ${
              onRemove
                ? html`<td class="compact-filter-action">
                    <button
                      type="button"
                      class="compact-filter-remove"
                      disabled=${disabled}
                      aria-label=${`Remove ${label}`}
                      title="Remove"
                      onClick=${() => {
                        if (!disabled) onRemove(ref);
                      }}
                    >
                      <svg
                        aria-hidden="true"
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.6"
                        stroke-linecap="round"
                      >
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  </td>`
                : null
            }
          </tr>`;
        })}
        ${
          !refs.length
            ? html`<tr>
                <td colspan=${onRemove ? 4 : 3} class="compact-filter-empty">
                  No filters selected
                </td>
              </tr>`
            : null
        }
      </tbody>
    </table>
  </div>`;
}
