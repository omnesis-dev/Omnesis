// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Modal } from "./modal.js";
import { SourceFilterPicker } from "./source-filter-picker.js";
import { FilterPreview, FilterReadiness, useSourceFilterPreview } from "./source-filter-preview.js";
import {
  scopeDisplayLabel,
  rememberScopeLabels,
  useScopeLabelGeneration,
} from "./source-filter-labels.js";
import {
  cloneFilter,
  newSourcePolicy,
  editableSourcePolicy,
  filterDraftError,
  setFilterMode,
  toggleScopeRef,
  scopeRefKey,
  addProposedIdentifiers,
} from "./source-filter-state.js";

/** A child draft never changes its parent until its exact current preview is applied. */
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
  const [step, setStep] = useState("mode");
  const [mode, setMode] = useState(savedPolicy?.rules?.[0]?.action === "hide" ? "except" : "only");
  const [kind, setKind] = useState(
    source.scopes?.items?.[0]?.kind ?? savedPolicy?.rules?.[0]?.match?.[0]?.kind ?? "conversation",
  );
  const [attempted, setAttempted] = useState(false);
  const [pickerVisited, setPickerVisited] = useState(false);
  const heading = useRef(null);
  const initialSource = useRef(sourceId);
  const generation = useScopeLabelGeneration();
  const initialGeneration = useRef(generation);
  const editable = editableSourcePolicy(draft);
  const readOnly = !enabled || !editable;
  const selected = editable
    ? draft.rules[0].match
    : (draft.rules ?? []).flatMap((rule) => rule.match ?? []);
  const preview = useSourceFilterPreview(
    sourceId,
    mode !== "all" && selected.length && (step === "review" || readOnly) ? draft : null,
  );
  const error =
    mode === "all"
      ? null
      : filterDraftError(draft, {
          ...source,
          scopeReadiness: preview.data?.readiness ?? source.scopeReadiness,
        });
  const kinds = source.scopes?.items ?? [];
  useEffect(() => {
    heading.current?.focus?.();
  }, [step]);
  useEffect(() => {
    if (initialSource.current !== sourceId || initialGeneration.current !== generation) onClose();
  }, [sourceId, generation]);
  const chooseMode = (next) => {
    setMode(next);
    if (next !== "all") setDraft(setFilterMode(draft, next));
  };
  const next = () => {
    if (step === "mode") {
      if (mode !== "all") setPickerVisited(true);
      setStep(mode === "all" ? "review" : "picker");
      return;
    }
    setAttempted(true);
    if (!error) setStep("review");
  };
  const title = readOnly
    ? "Saved source restriction"
    : step === "mode"
      ? "What should be shared?"
      : step === "picker"
        ? "Choose matching content"
        : "Review this filter";
  const progress = step === "mode" ? 1 : step === "picker" ? 2 : 3;
  return html`<${Modal}
    open
    onClose=${onClose}
    title=${title}
    subtitle=${`${source.displayName || source.name || "Source account"} · ${capability === "answer" ? "Answer" : "Direct"}`}
    size="lg"
  >
    <div class="source-filter-editor guided-filter-editor">
      <div class="filter-task-context">
        <span
          >${readOnly ? "Saved restriction" : `Step ${mode === "all" && step === "review" ? 2 : progress} of ${mode === "all" ? 2 : 3}`}</span
        >
      </div>
      <div class="filter-task-scroll">
        <h3 ref=${heading} tabindex="-1" class="sr-only">${title}</h3>
        ${readOnly ? html`<p class="source-filter-notice" role="status">${!enabled ? "Source filter editing requires experimental mode. This saved restriction remains enforced and can be inspected here." : "This filter uses settings this editor cannot change. The complete saved policy is preserved."}</p>` : null}
        ${
          !readOnly && step === "mode"
            ? html`<div class="source-filter-mode guided-choices">
                ${[
                  [
                    "all",
                    "All content",
                    savedPolicy
                      ? "Remove this restriction and allow all content in this account."
                      : "No restriction within this account.",
                  ],
                  ["only", "Only matching content", "Share only the matches you choose."],
                  ["except", "Everything except matches", "Keep your chosen matches private."],
                ].map(
                  ([id, label, detail]) =>
                    html`<label class=${`guided-choice${mode === id ? " is-selected" : ""}`}
                      ><input
                        type="radio"
                        name="source-filter-mode"
                        checked=${mode === id}
                        onChange=${() => chooseMode(id)}
                      /><span><strong>${label}</strong><small>${detail}</small></span></label
                    >`,
                )}
              </div>`
            : null
        }
        <div class="filter-picker-stage" hidden=${readOnly || step !== "picker"}>
          <div class="filter-selection-strip">
            <span>${selected.length} selected</span>
            <details>
              <summary>View selection</summary>
              <ul>
                ${selected.map((ref) => html`<li key=${scopeRefKey(ref)}><span>${scopeDisplayLabel(sourceId, ref, source).label}</span><button type="button" class="btn-secondary" aria-label=${`Remove ${scopeDisplayLabel(sourceId, ref, source).label}`} onClick=${() => setDraft(toggleScopeRef(draft, ref))}>Remove</button></li>`)}
              </ul>
            </details>
          </div>
          ${kinds.length > 1 ? html`<nav class="source-filter-kinds" aria-label="Filter item kind">${kinds.map((item) => html`<button type="button" aria-pressed=${kind === item.kind} class=${kind === item.kind ? "btn-primary" : "btn-secondary"} onClick=${() => setKind(item.kind)}>${item.noun?.many || item.kind}</button>`)}</nav>` : null}
          ${
            pickerVisited && kinds.length
              ? html`<${SourceFilterPicker}
                  key=${`${sourceId}:${kind}`}
                  source=${source}
                  kind=${kind}
                  selected=${selected}
                  onToggle=${(ref, item) => {
                    if (item) rememberScopeLabels(sourceId, [item]);
                    setDraft(toggleScopeRef(draft, ref));
                  }}
                  disabled=${readOnly}
                />`
              : !kinds.length
                ? html`<p>The source descriptor is unavailable. Saved decisions are retained.</p>`
                : null
          }
          ${attempted && error ? html`<p class="access-field-error" role="alert">${error}</p>` : null}
        </div>
        ${
          step === "review" || readOnly
            ? html`<section class="filter-review-stage">
                ${
                  mode === "all" && !readOnly
                    ? html`<div class="guided-review-intro">
                        <strong>All content in this account</strong>
                        <p>
                          ${savedPolicy ? "The saved restriction will be removed. This expands access to all content in the allowed account." : "All content in the allowed account will be available."}
                        </p>
                      </div>`
                    : html`<div class="guided-review-intro">
                          <strong
                            >${draft.rules?.[0]?.action === "share" ? "Only matching content" : "Everything except these matches"}</strong
                          >
                          <ul class="source-filter-selected">
                            ${selected.map((ref) => {
                              const item = preview.data?.items?.find(
                                (entry) => scopeRefKey(entry.ref) === scopeRefKey(ref),
                              );
                              const label = item ?? scopeDisplayLabel(sourceId, ref, source);
                              return html`<li key=${scopeRefKey(ref)}>
                                ${label.label}${label.missing ? " · Missing — decision retained" : label.unavailable ? " · Name unavailable; restriction retained" : ""}
                              </li>`;
                            })}
                          </ul>
                          <p>
                            Any selected item may match. Required facts must be known for every
                            selected kind.
                          </p>
                        </div>
                        <${FilterPreview} preview=${preview} /><${FilterReadiness}
                          readiness=${preview.data?.readiness ?? source.scopeReadiness}
                        />${
                          preview.data?.identifierProposals?.length
                            ? html`<details class="source-filter-proposals">
                                <summary>Additional identifiers available</summary>
                                <p>Additions only take effect if you choose them.</p>
                                ${preview.data.identifierProposals.map((proposal) => html`<div><span>${proposal.label}: ${proposal.identifiers.map((id) => id.value).join(", ")}</span><button type="button" class="btn-secondary" disabled=${readOnly} onClick=${() => setDraft(addProposedIdentifiers(draft, proposal))}>Add identifiers</button></div>`)}
                              </details>`
                            : null
                        }${!readOnly && error ? html`<p class="access-field-error" role="alert">${error}</p>` : null}`
                }
              </section>`
            : null
        }
      </div>
      <footer class="source-filter-actions guided-filter-footer">
        <button type="button" class="btn-secondary" onClick=${onClose}>
          ${readOnly ? "Close" : "Cancel"}
        </button>
        ${!readOnly ? html`<span>${step !== "mode" ? html`<button type="button" class="btn-secondary" onClick=${() => setStep(step === "review" && mode !== "all" ? "picker" : "mode")}>Back</button>` : null}${step === "review" ? html`<button type="button" class="btn-primary" disabled=${mode !== "all" && (Boolean(error) || preview.pending || !preview.data || Boolean(preview.error))} onClick=${() => (mode === "all" ? (savedPolicy ? onRemove() : onClose()) : onApply(draft))}>${mode === "all" ? "Share all content" : "Apply filter"}</button>` : html`<button type="button" class="btn-primary" onClick=${next}>${step === "picker" ? "Review filter" : "Continue"}</button>`}</span>` : null}
      </footer>
    </div>
  <//>`;
}
