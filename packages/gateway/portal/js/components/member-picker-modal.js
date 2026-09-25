// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Pick one device from a short list, then confirm. Used by the Sources page
// to join a device to a source, to detach one from it and to choose which
// device a resync applies to. Renders inside the same `.confirm-modal-*`
// chrome as `ConfirmModal`, with a device list between the title and the
// buttons; the body text and the confirm button's danger colour may depend on
// the selected entry, so a confirmation can name what it is about to do and
// paint red only for the choices that delete something.
//
// An entry need not be a device: a caller may list a synthetic choice (the
// Sources page's "Whole source") with its own `icon` in place of the
// device-kind glyph.
//
// Escape and click-outside cancel; the confirm button stays disabled until a
// device is selected. An empty list renders `emptyText` instead of the list.
// Mounted only while open: the caller renders it under a condition and gives
// it a key per subject, so every opening starts from a fresh selection.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { KindIcon } from "../lib/device-kind-icon.js";

/**
 * @param {object} props
 * @param {string} props.title
 * @param {string | ((device: object) => string)} [props.body] — a sentence, or
 *   one derived from the selected device (rendered only once one is selected).
 * @param {Array<{id: string, name: string, kind: string|null, hint?: string, icon?: unknown}>} props.devices —
 *   `icon` is a vnode drawn instead of the device-kind glyph.
 * @param {string} [props.emptyText]
 * @param {string} [props.confirmLabel]
 * @param {boolean | ((device: object) => boolean)} [props.destructive] — paints
 *   the confirm button red; a function decides per selected entry.
 * @param {(deviceId: string) => void} props.onConfirm
 * @param {() => void} props.onCancel
 */
export function MemberPickerModal({
  title,
  body,
  devices,
  emptyText = "No eligible device.",
  confirmLabel = "OK",
  destructive = false,
  onConfirm,
  onCancel,
}) {
  // The only device is preselected; the selection is dropped if the list
  // stops holding it (a member detached elsewhere while the modal was open).
  const [selectedId, setSelectedId] = useState(devices.length === 1 ? devices[0].id : null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onCancel?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selected = devices.find((d) => d.id === selectedId) ?? null;
  const bodyText = typeof body === "function" ? (selected ? body(selected) : null) : body;
  const danger = typeof destructive === "function" ? !!selected && destructive(selected) : destructive;

  return html`
    <div
      class="confirm-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="member-picker-title"
      onClick=${onCancel}
    >
      <div class="confirm-modal" onClick=${(e) => e.stopPropagation()}>
        <div id="member-picker-title" class="confirm-modal-title">${title}</div>
        ${devices.length === 0
          ? html`<div class="confirm-modal-body">${emptyText}</div>`
          : html`
              <div class="member-picker-list" role="radiogroup" aria-label=${title}>
                ${devices.map(
                  (d) => html`
                    <button
                      type="button"
                      role="radio"
                      aria-checked=${d.id === selectedId}
                      class=${`member-picker-item${d.id === selectedId ? " selected" : ""}`}
                      onClick=${() => setSelectedId(d.id)}
                    >
                      ${d.icon ?? html`<${KindIcon} kind=${d.kind} size=${14} class="member-picker-item-icon" />`}
                      <span class="member-picker-item-name">${d.name}</span>
                      ${d.hint && html`<span class="member-picker-item-hint">${d.hint}</span>`}
                    </button>
                  `,
                )}
              </div>
            `}
        ${bodyText && html`<div class="confirm-modal-body">${bodyText}</div>`}
        <div class="confirm-modal-actions">
          <button class="btn-ghost" onClick=${onCancel}>Cancel</button>
          <button
            class="btn-primary ${danger ? "danger" : ""}"
            disabled=${!selected}
            onClick=${() => selected && onConfirm?.(selected.id)}
          >
            ${confirmLabel}
          </button>
        </div>
      </div>
    </div>
  `;
}
