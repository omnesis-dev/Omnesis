// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Kebab (⋯) popover menu for per-row actions in a table.
 *
 * Positioned `fixed` rather than absolutely, so the popover escapes the
 * horizontal-overflow clipping every wide table wrapper sets, and flipped
 * above the trigger when there is no room below. Closes on outside click,
 * Escape, scroll and resize — a popover pinned to a viewport coordinate is
 * wrong the moment the row moves under it.
 *
 * The caller supplies items; this owns only the shell. `label` is what the
 * item reads, `onSelect` is what it does, `danger` tints it, `disabled`
 * greys it out, and `hint` is a short line under the label — the reason a
 * disabled item cannot be chosen, read as part of its name.
 *
 * A disabled item with a hint is marked `aria-disabled` rather than disabled,
 * so it stays focusable and the arrow keys still reach it: a reason the
 * keyboard cannot land on is never read. Choosing it does nothing.
 */

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

/** Approximate rendered height of one item — used only to decide flip. */
const ITEM_HEIGHT_PX = 36;

/** Roving arrow-key navigation inside an open menu. */
function handleMenuKeyNav(event, onClose) {
  const items = Array.from(event.currentTarget.querySelectorAll("[role='menuitem']:not(:disabled)"));
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement);
  if (event.key === "ArrowDown") {
    event.preventDefault();
    items[(index + 1) % items.length]?.focus();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    items[(index - 1 + items.length) % items.length]?.focus();
  } else if (event.key === "Home") {
    event.preventDefault();
    items[0]?.focus();
  } else if (event.key === "End") {
    event.preventDefault();
    items[items.length - 1]?.focus();
  } else if (event.key === "Escape") {
    event.preventDefault();
    onClose();
  }
}

/**
 * @param {object} props
 * @param {Array<{label: string, onSelect: () => void, danger?: boolean, disabled?: boolean, hint?: string}>} props.items
 * @param {string} [props.label="Actions"]  accessible name for the trigger.
 */
export function RowActionMenu({ items, label = "Actions" }) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current.getBoundingClientRect();
    const menuHeight = items.length * ITEM_HEIGHT_PX;
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipped = spaceBelow < menuHeight && rect.top > menuHeight;
    const right = window.innerWidth - rect.right;
    setStyle(
      flipped
        ? { bottom: `${window.innerHeight - rect.top + 4}px`, right: `${right}px` }
        : { top: `${rect.bottom + 4}px`, right: `${right}px` },
    );
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onDocMouse = (e) => {
      if (menuRef.current?.contains(e.target)) return;
      if (triggerRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onReflow = () => setOpen(false);
    document.addEventListener("mousedown", onDocMouse);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      document.removeEventListener("mousedown", onDocMouse);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open]);

  const run = (fn) => () => {
    setOpen(false);
    fn();
  };
  const styleStr = style
    ? Object.entries(style)
        .map(([k, v]) => `${k}:${v}`)
        .join(";")
    : "";

  return html`
    <div class="row-action-menu">
      <button
        ref=${triggerRef}
        class="btn-tiny row-action-trigger"
        title=${label}
        aria-label=${label}
        aria-haspopup="menu"
        aria-expanded=${open}
        onClick=${toggle}
      >
        ⋯
      </button>
      ${open &&
      html`<div
        ref=${menuRef}
        class="row-action-popover"
        role="menu"
        style=${styleStr}
        onKeyDown=${(e) => handleMenuKeyNav(e, () => setOpen(false))}
      >
        ${items.map((item) => {
          const explained = Boolean(item.disabled && item.hint);
          return html`
            <button
              class=${`row-action-item${item.danger ? " danger" : ""}`}
              role="menuitem"
              onClick=${explained ? undefined : run(item.onSelect)}
              disabled=${item.disabled && !explained}
              aria-disabled=${explained ? "true" : undefined}
            >
              ${item.label}
              ${item.hint ? html`<small class="row-action-item-hint">${item.hint}</small>` : null}
            </button>
          `;
        })}
      </div>`}
    </div>
  `;
}
