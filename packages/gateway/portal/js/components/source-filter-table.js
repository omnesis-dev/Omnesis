// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { scopeDisplayLabel, useScopeLabelVersion } from "./source-filter-labels.js";
import { isDeviceRef, refField, scopeRefKey } from "./source-filter-state.js";
import {
  exactIdentifier,
  fieldNoun,
  refTypeLabel,
  useSourceFilterEditor,
  useTreeRootDepth,
} from "./source-filter-fields.js";
import { sourceId } from "./grant-builder-state.js";

/** Stands where a count will appear. */
export function CountSpinner() {
  return html`<span class="source-filter-spinner" role="img" aria-label="Counting"></span>`;
}

/** What stands for a filter's counts while they are worked out. */
export function CountingRecords() {
  return html`<${CountSpinner} />Counting…`;
}

/** The name a saved entry is shown by when no list has named it yet. */
function entryDisplay(id, ref, editor) {
  const field = refField(editor, ref);
  const display = scopeDisplayLabel(id, ref, field ? fieldNoun(field) : null);
  if (display.unavailable && isDeviceRef(ref)) {
    const device = editor?.devices?.find((item) => item.id === ref.device);
    if (device) return { ...display, label: device.name, unavailable: false };
  }
  return display;
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
  const { data: editor } = useSourceFilterEditor(id);
  const byRef = new Map(items.map((item) => [scopeRefKey(item.ref), item]));
  const knownDepth = (ref) => {
    const depth = byRef.get(scopeRefKey(ref))?.depth ?? entryDisplay(id, ref, editor).depth;
    return Number.isInteger(depth) ? depth : undefined;
  };
  const rootDepth = useTreeRootDepth(id, editor, refs, knownDepth);
  const identitiesByName = new Map();
  for (const ref of [...refs, ...comparisonRefs]) {
    if (typeof ref.id !== "string") continue;
    const display = entryDisplay(id, ref, editor);
    const item = byRef.get(scopeRefKey(ref));
    const name =
      item?.label && !(item.missing && item.label === ref.id)
        ? item.label
        : display.unavailable
          ? null
          : display.label;
    if (!name) continue;
    const key = JSON.stringify([ref.field, name]);
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
          const display = entryDisplay(id, ref, editor);
          const exact = exactIdentifier(ref);
          const label =
            exact?.value ||
            (item?.label && !(item.missing && item.label === ref.id) ? item.label : display.label);
          const identifiers =
            ref.capability === "person" && !exact
              ? (ref.identifiers ?? [])
                  .map((identifier) => identifier.value)
                  .filter((value) => value !== label)
              : [];
          const ambiguous =
            typeof ref.id === "string" &&
            identitiesByName.get(JSON.stringify([ref.field, label]))?.size > 1;
          const count = Number.isFinite(item?.count) && item.count >= 0 ? item.count : null;
          const mark = marks?.get(scopeRefKey(ref));
          return html`<tr key=${scopeRefKey(ref)} class=${mark ? `is-${mark}` : undefined}>
            <td class="compact-filter-kind">${refTypeLabel(refField(editor, ref), ref, knownDepth(ref) ?? rootDepth(ref))}</td>
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
