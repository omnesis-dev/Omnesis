// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { sourceAccountOf } from "../lib/source-id.js";
import { Modal } from "./modal.js";
import { SourceFilterPicker, ExactIdentifierInput } from "./source-filter-picker.js";
import { SourceFilterTable } from "./source-filter-table.js";
import { SourceAccountHeader } from "./source-account-header.js";
import { CapabilityPill, FilterModePill } from "./access-pills.js";
import { FilterPreview, useSourceFilterPreview } from "./source-filter-preview.js";
import { rememberScopeLabels, useScopeLabelGeneration } from "./source-filter-labels.js";
import {
  cloneFilter,
  newSourcePolicy,
  editableSourcePolicy,
  filterDraftError,
  filterModeAction,
  policyFilterMode,
  setFilterMode,
  toggleScopeRef,
  unreadyKinds,
  addProposedIdentifiers,
} from "./source-filter-state.js";
import { capabilityName, sourceId as accountIdOf, sourceLabel } from "./grant-builder-state.js";

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
  const sourceId = accountIdOf(source);
  const [draft, setDraft] = useState(() =>
    savedPolicy ? cloneFilter(savedPolicy) : newSourcePolicy(sourceId, capability, accessLevel),
  );
  const [step, setStep] = useState("mode");
  const [mode, setMode] = useState(savedPolicy ? policyFilterMode(savedPolicy) : "all");
  const [openKind, setOpenKind] = useState(null);
  const [pickerReadiness, setPickerReadiness] = useState(null);
  const heading = useRef(null);
  const pickerMemory = useRef(new Map());
  const initialSource = useRef(sourceId);
  const generation = useScopeLabelGeneration();
  const initialGeneration = useRef(generation);
  const currentSource =
    initialSource.current === sourceId && initialGeneration.current === generation;
  const editable = editableSourcePolicy(draft);
  const readOnly = !enabled || !editable;
  const selected = editable
    ? draft.rules[0].match
    : (draft.rules ?? []).flatMap((rule) => rule.match ?? []);
  // An account that is no longer connected has nothing to count.
  const connected = source.available !== false;
  const preview = useSourceFilterPreview(
    sourceId,
    connected && currentSource && mode !== "all" && selected.length && (step === "builder" || readOnly)
      ? draft
      : null,
  );
  // The selected kinds whose counts the account is still working out.
  const counting =
    unreadyKinds(draft, preview.data?.readiness ?? source.scopeReadiness).length > 0;
  const error =
    mode === "all"
      ? null
      : filterDraftError(draft, {
          ...source,
          scopeReadiness: preview.data?.readiness ?? pickerReadiness ?? source.scopeReadiness,
        });
  const kinds = source.scopes?.items ?? [];
  const identifiers = kinds.find((item) => item.kind === "participant")?.identifiers ?? [];
  // A filter of an account that is gone can only lose items: there is nothing
  // to count, so removing some of what was saved is all that Apply needs.
  const narrowed =
    Boolean(savedPolicy) &&
    editable &&
    draft.rules[0].action === savedPolicy.rules?.[0]?.action &&
    selected.length > 0 &&
    selected.length < (savedPolicy.rules?.[0]?.match?.length ?? 0);
  const applyBlocked = connected
    ? Boolean(error) || preview.pending || !preview.data || Boolean(preview.error)
    : !narrowed;
  const title = readOnly
    ? "Saved source filter"
    : step === "mode"
      ? "What should be shared?"
      : "Choose matching content";
  const freshItems =
    !preview.pending && !preview.error && !error && !counting
      ? (preview.data?.items ?? [])
      : [];
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
  const toggle = (ref, item) => {
    if (item) rememberScopeLabels(sourceId, [item]);
    setDraft((current) => toggleScopeRef(current, ref));
  };
  if (!currentSource) return null;
  return html`<${Modal}
    open
    onClose=${onClose}
    title=${title}
    ariaLabel=${`${title}: ${sourceLabel(source) || "Source"}, ${sourceAccountOf(sourceId) || "Connected account"}, ${capabilityName(capability)}`}
    size="lg"
  >
    <div class="source-filter-editor guided-filter-editor">
      <div class="filter-task-context">
        <${SourceAccountHeader} source=${source} />${step === "builder" && editable ? html`<${FilterModePill} action=${filterModeAction(mode)} />` : null}<${CapabilityPill}
          capability=${capability}
        />
      </div>
      <div class="filter-task-scroll">
        <h3 ref=${heading} tabindex="-1" class="sr-only">${title}</h3>
        ${readOnly ? html`<p class="source-filter-notice" role="status">${!enabled ? "Source filter editing requires experimental mode. This saved filter remains enforced and is shown here." : "This filter uses settings this editor cannot change. The complete saved policy is preserved."}</p>` : null}
        ${
          !readOnly && step === "mode"
            ? html`<div class="source-filter-mode">
                ${[
                  ["all", "All content", "Allow all content from this account."],
                  ["only", "Only matching content", "Continue to select filters that define which content gets shared."],
                  ["except", "Everything except matching content", "Continue to select filters that define which content never gets shared."],
                ].map(
                  ([id, label, detail]) =>
                    html`<label
                      ><input
                        type="radio"
                        name="source-filter-mode"
                        checked=${mode === id}
                        onChange=${() => chooseMode(id)}
                      /><span><strong>${label}</strong><small>${detail}</small></span></label
                    >`,
                )}
                ${savedPolicy && mode === "all" ? html`<p class="source-filter-mode-note">This removes the saved filter for this account.</p>` : null}
              </div>`
            : null
        }
        ${
          step === "builder" || readOnly
            ? html`<div class="filter-builder-stage">
                ${
                  !readOnly
                    ? html`<div class="filter-builder-inputs">
                        <div class="filter-builder-searches">
                          ${kinds.map(
                            (item) =>
                              html`<${SourceFilterPicker}
                                key=${`${sourceId}:${item.kind}`}
                                source=${source}
                                kind=${item.kind}
                                selected=${selected}
                                onToggle=${toggle}
                                overlay
                                open=${openKind === item.kind}
                                onOpen=${() => setOpenKind(item.kind)}
                                onClose=${() => setOpenKind(null)}
                                showExact=${false}
                                memory=${pickerMemory.current}
                                readiness=${pickerReadiness}
                                onReadiness=${setPickerReadiness}
                              />`,
                          )}
                        </div>
                        ${identifiers.length ? html`<${ExactIdentifierInput} types=${identifiers} selected=${selected} onToggle=${toggle} />` : null}
                        ${!kinds.length ? html`<p class="source-filter-notice" role="status">This account is no longer connected. Saved filters can be removed but not added.</p>` : null}
                      </div>`
                    : null
                }
                <div class="filter-selection-heading">
                  <strong>Selected filters</strong><span>${selected.length} selected</span>
                </div>
                <${SourceFilterTable}
                  source=${source}
                  refs=${selected}
                  items=${freshItems}
                  pending=${preview.pending || counting}
                  onRemove=${readOnly ? undefined : (ref) => toggle(ref)}
                />
                ${!selected.length ? html`<p class="filter-selection-empty">Search above to choose matching content.</p>` : null}
                ${selected.length && connected ? html`<${FilterPreview} preview=${preview} policy=${draft} />` : null}
                ${!readOnly && preview.data?.identifierProposals?.length ? html`<div class="source-filter-proposals">${preview.data.identifierProposals.map((proposal) => html`<div><span>Other addresses for ${proposal.label}: ${proposal.identifiers.map((id) => id.value).join(", ")}</span><button type="button" class="btn-secondary" aria-label=${`Add other addresses for ${proposal.label}`} onClick=${() => setDraft(addProposedIdentifiers(draft, proposal))}>Add</button></div>`)}</div>` : null}
                ${!readOnly && connected && error && selected.length && !counting ? html`<p class="access-field-error" role="alert">${error}</p>` : null}
              </div>`
            : null
        }
      </div>
      <footer class="source-filter-actions guided-filter-footer">
        <button type="button" class=${readOnly ? "btn-secondary" : "btn-ghost"} onClick=${onClose}>
          ${readOnly ? "Close" : "Cancel"}
        </button>
        ${
          !readOnly
            ? html`<span>
                ${
                  step === "builder"
                    ? html`<button
                        type="button"
                        class="btn-secondary"
                        onClick=${() => {
                          setOpenKind(null);
                          setStep("mode");
                        }}
                      >
                        Back
                      </button>`
                    : null
                }
                ${
                  step === "mode" && mode !== "all"
                    ? html`<button
                        type="button"
                        class="btn-primary"
                        onClick=${() => setStep("builder")}
                      >
                        Continue
                      </button>`
                    : html`<button
                        type="button"
                        class="btn-primary"
                        disabled=${mode !== "all" && applyBlocked}
                        onClick=${() => {
                          if (mode === "all") {
                            if (savedPolicy) onRemove();
                            else onClose();
                          } else if (!applyBlocked) onApply(draft);
                        }}
                      >
                        ${mode === "all" ? "Done" : "Apply filter"}
                      </button>`
                }
              </span>`
            : null
        }
      </footer>
    </div>
  <//>`;
}
