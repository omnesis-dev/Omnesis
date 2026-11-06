// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { Modal } from "./modal.js";
import { SourceFilterPicker } from "./source-filter-picker.js";
import { FilterPreview, FilterReadiness, useSourceFilterPreview } from "./source-filter-preview.js";
import {
  cloneFilter,
  newSourcePolicy,
  editableSourcePolicy,
  filterDraftError,
  setFilterMode,
  toggleScopeRef,
  scopeRefKey,
  scopeRefLabel,
  addProposedIdentifiers,
} from "./source-filter-state.js";

/** Tentative edits stay inside the dialog until an exact current preview is reviewed and applied. */
export function SourceFilterEditor({
  source,
  capability,
  accessLevel = "new",
  savedPolicy,
  enabled,
  onApply,
  onRemove,
  onClose,
}) {
  const sourceId = source.id ?? source.sourceId;
  const [draft, setDraft] = useState(() =>
    savedPolicy ? cloneFilter(savedPolicy) : newSourcePolicy(sourceId, capability, accessLevel),
  );
  const kinds = source.scopes?.items ?? [];
  const [kind, setKind] = useState(
    kinds[0]?.kind ?? savedPolicy?.rules?.[0]?.match?.[0]?.kind ?? "conversation",
  );
  const editable = editableSourcePolicy(draft);
  const readOnly = !enabled || !editable;
  const selected = editable
    ? draft.rules[0].match
    : (draft.rules ?? []).flatMap((rule) => rule.match ?? []);
  const preview = useSourceFilterPreview(sourceId, selected.length ? draft : null);
  const error = filterDraftError(draft, {
    ...source,
    scopeReadiness: preview.data?.readiness ?? source.scopeReadiness,
  });
  const labels = preview.data?.items ?? [];
  const mode = editable && draft.rules[0].action === "share" ? "only" : "except";
  return html`<${Modal}
    open
    onClose=${onClose}
    title=${`${capability === "answer" ? "Answer" : "Direct"} filter`}
    subtitle=${source.displayName || source.name || sourceId}
    size="lg"
  >
    <div class="source-filter-editor">
      <code class="source-filter-account">${sourceId}</code>
      ${!enabled ? html`<p class="source-filter-notice" role="status">Source filter editing requires experimental mode. This saved restriction remains enforced and can be inspected here.</p>` : null}
      ${!editable ? html`<p class="source-filter-notice" role="status">This filter uses settings this editor cannot change. The complete saved policy is preserved.</p>` : null}
      <${FilterReadiness} readiness=${source.scopeReadiness} />
      ${
        editable
          ? html`<fieldset class="source-filter-mode" disabled=${readOnly}>
              <legend>What to share from this source</legend>
              <label
                ><input
                  type="radio"
                  name="source-filter-mode"
                  checked=${mode === "only"}
                  onChange=${() => setDraft(setFilterMode(draft, "only"))}
                />Only matching records</label
              >
              <label
                ><input
                  type="radio"
                  name="source-filter-mode"
                  checked=${mode === "except"}
                  onChange=${() => setDraft(setFilterMode(draft, "except"))}
                />Everything except matching records</label
              >
            </fieldset>`
          : null
      }
      <section class="source-filter-selected" aria-label="Selected filter items">
        <h4>Selected items (${selected.length})</h4>
        <p>
          Any listed conversation, participant, label or folder can match (OR). Required facts must
          be known for every kind used.
        </p>
        ${
          selected.length
            ? html`<ul>
                ${selected.map((ref) => {
                  const item = labels.find((entry) => scopeRefKey(entry.ref) === scopeRefKey(ref));
                  return html`<li key=${scopeRefKey(ref)}>
                    <span
                      ><strong>${item?.label || scopeRefLabel(ref)}</strong
                      ><small
                        >${ref.kind}${ref.kind === "participant" ? ` · ${ref.identifiers.map((id) => id.value).join(" or ")}` : ""}${item ? ` · ${item.count} matching records` : ""}${item?.missing ? " · Missing — decision retained" : ""}</small
                      ></span
                    >${!readOnly ? html`<button type="button" class="btn-tiny" aria-label=${`Remove ${item?.label || scopeRefLabel(ref)}`} onClick=${() => setDraft(toggleScopeRef(draft, ref))}>Remove</button>` : null}
                  </li>`;
                })}
              </ul>`
            : html`<p>No items selected. An empty filter cannot be applied.</p>`
        }
      </section>
      <${FilterPreview} preview=${preview} />
      ${
        preview.data?.identifierProposals?.length
          ? html`<section class="source-filter-proposals">
              <h4>Additional identifiers available</h4>
              <p>Nothing changes unless you add these exact identifiers.</p>
              ${preview.data.identifierProposals.map((proposal) => html`<div><span>${proposal.label}: ${proposal.identifiers.map((id) => id.value).join(", ")}</span><button type="button" class="btn-tiny" disabled=${readOnly} onClick=${() => setDraft(addProposedIdentifiers(draft, proposal))}>Add identifiers</button></div>`)}
            </section>`
          : null
      }
      ${
        kinds.length
          ? html`<nav class="source-filter-kinds" aria-label="Filter item kind">
                ${kinds.map((item) => html`<button type="button" aria-pressed=${kind === item.kind} class=${kind === item.kind ? "btn-primary" : "btn-secondary"} onClick=${() => setKind(item.kind)}>${item.noun?.many || item.kind}</button>`)}
              </nav>
              <${SourceFilterPicker}
                key=${`${sourceId}:${kind}`}
                source=${source}
                kind=${kind}
                selected=${selected}
                onToggle=${(ref) => setDraft(toggleScopeRef(draft, ref))}
                disabled=${readOnly}
              />`
          : html`<p>The source descriptor is unavailable. Saved decisions are retained.</p>`
      }
      ${!readOnly && error ? html`<p class="access-field-error" role="alert">${error}</p>` : null}
      <footer class="source-filter-actions">
        ${savedPolicy && enabled ? html`<button type="button" class="btn-secondary btn-danger" onClick=${onRemove}>Remove this source filter</button>` : null}
        <button type="button" class="btn-secondary" onClick=${onClose}>
          ${readOnly ? "Close" : "Cancel"}
        </button>
        ${!readOnly ? html`<button type="button" class="btn-primary" disabled=${Boolean(error) || preview.pending || !preview.data || Boolean(preview.error)} onClick=${() => onApply(draft)}>Use this filter</button>` : null}
      </footer>
    </div>
  <//>`;
}
