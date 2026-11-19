// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The Resync dialog of the Sources page: what to resync, when the source has
// several devices on their own cursors, and how — in place or from scratch —
// with what each does in plain words. Renders inside the same
// `.confirm-modal-*` chrome as `ConfirmModal`; the scope list reuses the
// member picker's rows.
//
// The whole source and "In place" are selected on opening, so confirming
// without choosing anything deletes nothing. The confirm button paints red
// only while "From scratch" is selected. Escape and click-outside cancel.
// Mounted only while open: the caller renders it under a condition and gives
// it a key per source, so every opening starts from that default.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { KindIcon } from "../lib/device-kind-icon.js";
import { RESYNC_FROM_SCRATCH, defaultResyncMode } from "../lib/resync-options.js";

/**
 * @param {object} props
 * @param {string} props.title
 * @param {Array<{id: string, name: string, kind: string|null, hint?: string, icon?: unknown}>} props.scopes —
 *   what can be resynced, the whole source first. A single entry is not drawn.
 * @param {(scope: object) => {modes: Array<{id: string, title: string, body: string, note: string|null}>, footnote: string|null}} props.optionsFor —
 *   the modes one scope offers (`resyncOptions`).
 * @param {(choice: {scopeId: string, mode: string}) => void} props.onConfirm
 * @param {() => void} props.onCancel
 */
export function ResyncModal({ title, scopes, optionsFor, onConfirm, onCancel }) {
  const [scopeId, setScopeId] = useState(scopes[0]?.id ?? null);
  // A device that left the source while the dialog was open takes its scope
  // with it; the whole source is always listed.
  const scope = scopes.find((s) => s.id === scopeId) ?? scopes[0] ?? null;
  const { modes, footnote } = scope ? optionsFor(scope) : { modes: [], footnote: null };
  const [chosenMode, setChosenMode] = useState(null);
  const mode = modes.some((m) => m.id === chosenMode) ? chosenMode : defaultResyncMode(modes);
  const cancelRef = useRef(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") onCancel?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return html`
    <div
      class="confirm-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="resync-modal-title"
      onClick=${onCancel}
    >
      <div class="confirm-modal resync-modal" onClick=${(e) => e.stopPropagation()}>
        <div id="resync-modal-title" class="confirm-modal-title">${title}</div>
        ${scopes.length > 1 &&
        html`
          <div class="resync-section-label" id="resync-scope-label">What to resync</div>
          <div class="member-picker-list" role="radiogroup" aria-labelledby="resync-scope-label">
            ${scopes.map(
              (s) => html`
                <button
                  type="button"
                  role="radio"
                  aria-checked=${s.id === scope?.id}
                  class=${`member-picker-item${s.id === scope?.id ? " selected" : ""}`}
                  onClick=${() => setScopeId(s.id)}
                >
                  ${s.icon ?? html`<${KindIcon} kind=${s.kind} size=${14} class="member-picker-item-icon" />`}
                  <span class="member-picker-item-name">${s.name}</span>
                  ${s.hint && html`<span class="member-picker-item-hint">${s.hint}</span>`}
                </button>
              `,
            )}
          </div>
          <div class="resync-section-label" id="resync-mode-label">How</div>
        `}
        ${modes.length === 1
          ? html`<div class="confirm-modal-body resync-single-mode">${modes[0].body}</div>`
          : html`
              <div
                class="resync-mode-list"
                role="radiogroup"
                aria-label="How to resync"
              >
                ${modes.map(
                  (m) => html`
                    <button
                      type="button"
                      role="radio"
                      aria-checked=${m.id === mode}
                      data-mode=${m.id}
                      class=${`resync-mode${m.id === mode ? " selected" : ""}`}
                      onClick=${() => setChosenMode(m.id)}
                    >
                      <span class="resync-mode-dot" aria-hidden="true"></span>
                      <span class="resync-mode-text">
                        <span class="resync-mode-title">${m.title}</span>
                        <span class="resync-mode-body">${m.body}</span>
                        ${m.note && html`<span class="resync-mode-note">${m.note}</span>`}
                      </span>
                    </button>
                  `,
                )}
              </div>
            `}
        ${footnote && html`<div class="resync-footnote">${footnote}</div>`}
        <div class="confirm-modal-actions">
          <button type="button" class="btn-ghost" ref=${cancelRef} onClick=${onCancel}>Cancel</button>
          <button
            type="button"
            class="btn-primary ${mode === RESYNC_FROM_SCRATCH ? "danger" : ""}"
            disabled=${!scope || !mode}
            onClick=${() => scope && mode && onConfirm?.({ scopeId: scope.id, mode })}
          >
            ${mode === RESYNC_FROM_SCRATCH ? "Delete and resync" : "Resync"}
          </button>
        </div>
      </div>
    </div>
  `;
}
