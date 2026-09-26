// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Generic overlay modal — a backdrop + centred panel that the caller fills
 * with arbitrary children (a form, a picker, anything). It owns only the
 * shell behaviour every modal in the portal needs:
 *
 *   - Escape closes (calls `onClose`).
 *   - Click on the backdrop closes; clicks inside the panel don't bubble out.
 *   - On open, focus moves to the first focusable control in the body — the
 *     ✕ Close button is chrome, and landing on it announces the way out
 *     before the thing being opened — falling back to the panel itself when
 *     the body has none. Tab is kept inside the panel (a lightweight focus
 *     trap) so focus can't wander to the page behind the overlay.
 *   - On close, focus returns to whatever held it when the modal opened, so
 *     dismissing a dialog opened from a button leaves the keyboard where the
 *     reader left it rather than at the top of the document.
 *
 * It's the render-prop sibling of `ConfirmModal` (which bakes in title +
 * confirm/cancel buttons). Reach for `Modal` when the body is custom — e.g.
 * the add-backend form or the model picker.
 */

import { html } from "htm/preact";
import { useEffect, useRef } from "preact/hooks";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose      fired on Esc / backdrop click / ✕.
 * @param {string} [props.title]          rendered in the header when set.
 * @param {string} [props.subtitle]       muted line under the title.
 * @param {string} [props.size="md"]      "sm" | "md" | "lg" → panel width.
 * @param {*} props.children              the modal body.
 */
export function Modal({ open, onClose, title, subtitle, size = "md", children }) {
  const panelRef = useRef(null);
  const bodyRef = useRef(null);

  // Move focus into the panel exactly once when it opens — keyed on `open`
  // alone. An incidental parent re-render (e.g. the models view's 1s
  // download/probe poll, which re-creates the `onClose` arrow) must not re-run
  // this and yank focus back to the first field while the user is typing in a
  // later one. Closing hands focus back to the element that opened the modal;
  // an element gone from the document with the page behind it is skipped.
  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    const panel = panelRef.current;
    const first = bodyRef.current?.querySelector(FOCUSABLE);
    (first ?? panel)?.focus?.();
    return () => {
      if (opener?.isConnected === false) return;
      opener?.focus?.();
    };
  }, [open]);

  // Esc-to-close and the Tab focus-trap. Separate effect so it can depend on
  // `onClose` (re-registering the listener when it changes is cheap) without
  // re-triggering the focus-on-open above.
  useEffect(() => {
    if (!open) return undefined;
    const panel = panelRef.current;

    const onKey = (e) => {
      // A confirmation above this panel owns keyboard dismissal and focus.
      if (document.querySelector(".confirm-modal-backdrop")) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose?.();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      // Trap Tab within the panel.
      const focusable = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusable.length === 0) {
        e.preventDefault();
        panel.focus?.();
        return;
      }
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return html`
    <div class="modal-backdrop" onClick=${onClose}>
      <div
        class="modal-panel modal-panel--${size}"
        role="dialog"
        aria-modal="true"
        aria-label=${title ?? "Dialog"}
        tabindex="-1"
        ref=${panelRef}
        onClick=${(e) => e.stopPropagation()}
      >
        ${title
          ? html`<div class="modal-head">
              <div>
                <div class="modal-title">${title}</div>
                ${subtitle ? html`<div class="modal-subtitle">${subtitle}</div>` : null}
              </div>
              <button class="modal-close" aria-label="Close" onClick=${onClose}>✕</button>
            </div>`
          : null}
        <div class="modal-body" ref=${bodyRef}>${children}</div>
      </div>
    </div>
  `;
}
