// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Shared in-portal replacement for `window.confirm` / `window.alert` /
// `window.prompt`. The native dialogs block the JS event loop — which
// freezes Preact updates, prevents the WS bridge from servicing pings,
// and looks jarring against the rest of the dark-themed portal.
//
// Render-prop modals: caller owns the open/close state. Both components
// trap Escape (cancel), focus the cancel/cancel-equivalent on mount so
// accidentally hitting Enter doesn't fire a destructive action, and
// click-outside cancels too. Backdrop + inner styling reuse the
// `.confirm-modal-*` CSS that already exists in `style.css`.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

/**
 * Confirm-style modal. Use `destructive` for delete-flavoured actions —
 * the primary button paints red. Pass `confirmLabel="OK"` and wire
 * `onCancel` to `onConfirm` for info-only one-button dialogs (the
 * Cancel button is hidden in that mode).
 *
 * Pass `secondaryLabel` + `onSecondary` for a third, alternative action next
 * to the primary confirm (e.g. a default "graceful" primary with an explicit
 * "hard cutover" opt-in). `secondaryDestructive` paints that button red.
 *
 *   <ConfirmModal
 *     open=${showDelete}
 *     title="Delete source"
 *     body="This deletes all data for gmail:foo@bar.com."
 *     confirmLabel="Delete"
 *     destructive
 *     onConfirm=${handleDelete}
 *     onCancel=${() => setShowDelete(false)}
 *   />
 */
export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  destructive = false,
  confirmDisabled = false,
  cancelDisabled = false,
  hideCancel = false,
  secondaryLabel = null,
  secondaryDestructive = false,
  onConfirm,
  onSecondary,
  onCancel,
}) {
  const cancelRef = useRef(null);
  const confirmRef = useRef(null);
  const modalRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    // Default focus → cancel (or confirm if cancel is hidden) so Enter
    // doesn't immediately fire the destructive action.
    if (hideCancel) confirmRef.current?.focus();
    else cancelRef.current?.focus();

    const onKey = (e) => {
      if (e.key === "Escape" && !cancelDisabled) onCancel?.();
      if (e.key !== "Tab") return;
      const focusable = [...(modalRef.current?.querySelectorAll(
        "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ) ?? [])];
      if (focusable.length === 0) {
        e.preventDefault();
        modalRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [open, hideCancel, cancelDisabled]);

  if (!open) return null;

  return html`
    <div
      class="confirm-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      onClick=${cancelDisabled ? undefined : onCancel}
    >
      <div ref=${modalRef} tabindex="-1" class="confirm-modal" onClick=${(e) => e.stopPropagation()}>
        <div id="confirm-modal-title" class="confirm-modal-title">${title}</div>
        ${body
          ? html`<div class="confirm-modal-body">${body}</div>`
          : null}
        <div class="confirm-modal-actions">
          ${hideCancel
            ? null
            : html`<button
                type="button"
                class="btn-ghost"
                ref=${cancelRef}
                disabled=${cancelDisabled}
                onClick=${onCancel}
              >
                ${cancelLabel}
              </button>`}
          ${secondaryLabel
            ? html`<button
                type="button"
                class="btn-secondary ${secondaryDestructive ? "danger" : ""}"
                disabled=${cancelDisabled}
                onClick=${onSecondary}
              >
                ${secondaryLabel}
              </button>`
            : null}
          <button
            type="button"
            class="btn-primary ${destructive ? "danger" : ""}"
            ref=${confirmRef}
            disabled=${confirmDisabled}
            onClick=${onConfirm}
          >
            ${confirmLabel}
          </button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Single-line text-input modal. Submit on Enter, cancel on Escape.
 * `defaultValue` seeds the input; `onSubmit(value)` only fires when
 * the user actually presses confirm/Enter with a non-empty trimmed
 * value (matches `prompt()`'s "null on cancel, empty string treated as
 * cancel by callers" convention).
 */
export function PromptModal({
  open,
  title,
  body,
  placeholder = "",
  defaultValue = "",
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  onSubmit,
  onCancel,
}) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef(null);

  // Reset the input each time the modal opens so a previously typed
  // value doesn't leak across separate prompts.
  useEffect(() => {
    if (open) setValue(defaultValue);
  }, [open, defaultValue]);

  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();
    inputRef.current?.select?.();
    const onKey = (e) => {
      if (e.key === "Escape") onCancel?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  function handleSubmit(e) {
    if (e) e.preventDefault();
    const trimmed = (value ?? "").trim();
    if (!trimmed) return;
    onSubmit?.(trimmed);
  }

  return html`
    <div
      class="confirm-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prompt-modal-title"
      onClick=${onCancel}
    >
      <div class="confirm-modal" onClick=${(e) => e.stopPropagation()}>
        <div id="prompt-modal-title" class="confirm-modal-title">${title}</div>
        ${body
          ? html`<div class="confirm-modal-body">${body}</div>`
          : null}
        <form onSubmit=${handleSubmit}>
          <input
            ref=${inputRef}
            type="text"
            class="search-input"
            placeholder=${placeholder}
            value=${value}
            onInput=${(e) => setValue(e.target.value)}
            style="width:100%;margin-bottom:12px;"
          />
          <div class="confirm-modal-actions">
            <button
              type="button"
              class="btn-ghost"
              onClick=${onCancel}
            >${cancelLabel}</button>
            <button
              type="submit"
              class="btn-primary"
              disabled=${!(value ?? "").trim()}
            >${confirmLabel}</button>
          </div>
        </form>
      </div>
    </div>
  `;
}
